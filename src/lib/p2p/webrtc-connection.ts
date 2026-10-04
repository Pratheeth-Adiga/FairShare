import { encodeSignaling, decodeSignaling } from './signaling-codec';
import type { SignalingData } from './signaling-codec';
import { deserializeMessage, isNewerProtocolMessage, serializeMessage } from './message-protocol';
import type { P2PMessage } from './message-protocol';
import { p2pLog } from './debug-log';

export type ConnectionState = 'new' | 'gathering' | 'waiting' | 'connecting' | 'connected' | 'disconnected' | 'failed';

// allow deployments to replace the default STUN server list.
// only stun: urls here, a turn: url without credentials makes RTCPeerConnection throw.
function readStunServersFromEnv(): string[] {
  const raw = (import.meta.env?.VITE_STUN_SERVERS as string | undefined) || '';
  return raw.split(',').map(s => s.trim()).filter(s => /^stuns?:/i.test(s));
}

// self-hosters can add a TURN relay for symmetric NATs.
function readTurnServerFromEnv(): RTCIceServer[] {
  const urls = ((import.meta.env?.VITE_TURN_URL as string | undefined) || '')
    .split(',').map(s => s.trim()).filter(s => /^turns?:/i.test(s));
  const username = (import.meta.env?.VITE_TURN_USER as string | undefined) || '';
  const credential = (import.meta.env?.VITE_TURN_CREDENTIAL as string | undefined) || '';
  if (urls.length === 0 || !username || !credential) return [];
  return [{ urls, username, credential }];
}

const ICE_SERVERS: RTCIceServer[] = (() => {
  const override = readStunServersFromEnv();
  const stun = override.length > 0
    ? override.map(urls => ({ urls }))
    : [
      { urls: 'stun:stun.cloudflare.com:3478' },
      { urls: 'stun:stun.l.google.com:19302' },
      { urls: 'stun:global.stun.twilio.com:3478' },
    ];
  return [...stun, ...readTurnServerFromEnv()];
})();

// Allow slow WebViews enough time to finish ICE gathering.
const ICE_GATHER_TIMEOUT = 20000;
const PING_INTERVAL = 15000;
// anything bigger than this goes out as binary chunks. Well under the
// SCTP max-message-size (262144) our rebuilt SDP advertises.
const CHUNK_THRESHOLD = 64 * 1024;
const CHUNK_PAYLOAD = 60 * 1024;
const CHUNK_HEADER = 10;
// matches the 2 MB payload cap in message-protocol, plus room for the envelope
const MAX_TRANSFER_BYTES = 2_100_000;
const MAX_CHUNKS = Math.ceil(MAX_TRANSFER_BYTES / CHUNK_PAYLOAD);
const MAX_OPEN_TRANSFERS = 4;
const TRANSFER_TIMEOUT = 30000;
// pause sending once this much is queued in the data channel buffer
const SEND_HIGH_WATER = 1024 * 1024;
const SEND_LOW_WATER = 256 * 1024;
const MAX_MISSED_PINGS = 3;

// Give transient ICE disconnects time to recover before closing.
const ICE_DISCONNECT_GRACE = 8000;

// if ICE negotiation never completes (remote peer crashed, firewall blocks
// all candidates), don't let the connection sit in 'connecting' forever.
const CONNECTING_TIMEOUT = 30000;
// the answering side starts waiting before the other person has even
// scanned our answer, so it needs room for the human part of the exchange.
const ANSWER_CONNECTING_TIMEOUT = 3 * 60 * 1000;

interface IncomingTransfer {
  total: number;
  parts: (Uint8Array | undefined)[];
  received: number;
  bytes: number;
  timer: ReturnType<typeof setTimeout>;
}

// the last a=fingerprint line wins, same as signaling-codec's parseSDP
function fingerprintOf(sdp: string | undefined): string {
  const matches = Array.from((sdp || '').matchAll(/^a=fingerprint:\S+ (\S+)/gim));
  return matches.length > 0 ? matches[matches.length - 1][1].toUpperCase() : '';
}

export class WebRTCConnection {
  readonly peerId: string;
  private pc: RTCPeerConnection;
  private dataChannel: RTCDataChannel | null = null;
  private localPeerId: string;
  private groupId: string = '';
  private state: ConnectionState = 'new';
  private messageHandlers: ((msg: P2PMessage) => void)[] = [];
  private stateHandlers: ((state: ConnectionState) => void)[] = [];
  private sendFailedHandlers: ((reason: string) => void)[] = [];
  private protocolMismatchHandlers: (() => void)[] = [];
  private pingInterval: number | null = null;
  private missedPings = 0;
  private pendingPong = false;
  private connectingTimeoutMs = CONNECTING_TIMEOUT;
  private sendQueue: (string | Uint8Array<ArrayBuffer>)[] = [];
  private nextTransferId = 1;
  private incoming = new Map<number, IncomingTransfer>();

  // Collect candidates from construction because ICE may start before gathering.
  private iceCandidates: RTCIceCandidateInit[] = [];
  private iceGatheringDone = false;
  private iceHasSrflx = false;
  private iceDoneWaiters: (() => void)[] = [];
  // Tracked so close() can cancel gathering timers that were armed inside a
  // promise it does not await.
  private iceGatherTimers = new Set<ReturnType<typeof setTimeout>>();
  private iceDisconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private connectingTimer: ReturnType<typeof setTimeout> | null = null;
  private closed = false;

  constructor(localPeerId: string, remotePeerId: string) {
    this.localPeerId = localPeerId;
    this.peerId = remotePeerId;
    this.pc = new RTCPeerConnection({ iceServers: ICE_SERVERS });

    this.pc.oniceconnectionstatechange = () => {
      const iceState = this.pc.iceConnectionState;
      p2pLog(`[P2P ${this.peerId}] iceConnectionState -> ${iceState}`);
      if (iceState === 'connected' || iceState === 'completed') {
        if (this.iceDisconnectTimer) {
          clearTimeout(this.iceDisconnectTimer);
          this.iceDisconnectTimer = null;
        }
      } else if (iceState === 'failed') {
        if (this.iceDisconnectTimer) {
          clearTimeout(this.iceDisconnectTimer);
          this.iceDisconnectTimer = null;
        }
        this.handleDisconnect();
      } else if (iceState === 'disconnected' && !this.iceDisconnectTimer) {
        this.iceDisconnectTimer = setTimeout(() => {
          this.iceDisconnectTimer = null;
          const state = this.pc.iceConnectionState;
          if (state === 'disconnected' || state === 'failed') {
            this.handleDisconnect();
          }
        }, ICE_DISCONNECT_GRACE);
      }
    };
    this.pc.onicegatheringstatechange = () => {
      p2pLog(`[P2P ${this.peerId}] iceGatheringState -> ${this.pc.iceGatheringState}`);
    };
    this.pc.onicecandidateerror = (event) => {
      const e = event as RTCPeerConnectionIceErrorEvent;
      p2pLog(`[P2P ${this.peerId}] icecandidateerror: code=${e.errorCode} text=${e.errorText} url=${e.url}`);
    };
    this.pc.onicecandidate = (event) => {
      if (event.candidate) {
        this.iceCandidates.push(event.candidate.toJSON());
        if (event.candidate.candidate?.includes('typ srflx')) this.iceHasSrflx = true;
      } else if (!this.iceGatheringDone) {
        this.iceGatheringDone = true;
        this.iceDoneWaiters.splice(0).forEach(fn => fn());
      }
    };
  }

  getState(): ConnectionState {
    return this.state;
  }

  async createOffer(groupId: string): Promise<string> {
    this.ensureOpen();
    this.groupId = groupId;
    this.setState('gathering');

    this.dataChannel = this.pc.createDataChannel('fairshare-sync', {
      ordered: true,
    });
    this.setupDataChannel(this.dataChannel);

    const offer = await this.pc.createOffer();
    this.ensureOpen();
    await this.pc.setLocalDescription(offer);

    const iceCandidates = await this.gatherICECandidates();

    const signalingData: SignalingData = {
      sdp: this.pc.localDescription!.sdp,
      ice: iceCandidates,
      peerId: this.localPeerId,
      groupId,
      type: 'offer',
    };

    this.setState('waiting');
    return encodeSignaling(signalingData);
  }

  async acceptOffer(blob: string): Promise<string> {
    const offerData = decodeSignaling(blob);
    this.groupId = offerData.groupId;
    this.setState('gathering');
    p2pLog(`[P2P ${this.peerId}] acceptOffer: received ${offerData.ice.length} remote candidates: ${offerData.ice.map(c => c.candidate).join(' | ')}`);

    this.pc.ondatachannel = (event) => {
      this.dataChannel = event.channel;
      this.setupDataChannel(this.dataChannel);
    };

    await this.pc.setRemoteDescription({ type: 'offer', sdp: offerData.sdp });

    for (const ice of offerData.ice) {
      await this.pc.addIceCandidate(ice);
    }

    const answer = await this.pc.createAnswer();
    await this.pc.setLocalDescription(answer);

    const iceCandidates = await this.gatherICECandidates();

    const answerData: SignalingData = {
      sdp: this.pc.localDescription!.sdp,
      ice: iceCandidates,
      peerId: this.localPeerId,
      groupId: this.groupId,
      type: 'answer',
    };

    this.connectingTimeoutMs = ANSWER_CONNECTING_TIMEOUT;
    this.setState('connecting');
    return encodeSignaling(answerData);
  }

  async acceptAnswer(blob: string): Promise<void> {
    const answerData = decodeSignaling(blob);
    this.setState('connecting');
    p2pLog(`[P2P ${this.peerId}] acceptAnswer: received ${answerData.ice.length} remote candidates: ${answerData.ice.map(c => c.candidate).join(' | ')}`);

    await this.pc.setRemoteDescription({ type: 'answer', sdp: answerData.sdp });

    for (const ice of answerData.ice) {
      await this.pc.addIceCandidate(ice);
    }
  }

  send(msg: P2PMessage): void {
    if (this.dataChannel?.readyState !== 'open') return;
    const serialized = serializeMessage(msg);
    // Count encoded bytes, not UTF-16 code units.
    const bytes = new TextEncoder().encode(serialized);
    if (bytes.length <= CHUNK_THRESHOLD) {
      this.enqueue(serialized);
      return;
    }
    if (bytes.length > MAX_TRANSFER_BYTES) {
      this.reportSendFailed(`message too large to sync (${bytes.length} bytes)`);
      return;
    }
    // split into binary frames: 'F','S', transfer id (4), index (2), total (2), data
    const transferId = this.nextTransferId++ >>> 0;
    const total = Math.ceil(bytes.length / CHUNK_PAYLOAD);
    for (let index = 0; index < total; index++) {
      const piece = bytes.subarray(index * CHUNK_PAYLOAD, (index + 1) * CHUNK_PAYLOAD);
      const frame = new Uint8Array(new ArrayBuffer(CHUNK_HEADER + piece.length));
      const view = new DataView(frame.buffer);
      frame[0] = 0x46;
      frame[1] = 0x53;
      view.setUint32(2, transferId);
      view.setUint16(6, index);
      view.setUint16(8, total);
      frame.set(piece, CHUNK_HEADER);
      this.enqueue(frame);
    }
  }

  onSendFailed(handler: (reason: string) => void): void {
    this.sendFailedHandlers.push(handler);
  }

  // fires when the peer on the other end is running a newer, incompatible protocol version
  onProtocolMismatch(handler: () => void): void {
    this.protocolMismatchHandlers.push(handler);
  }

  // the connection manager signs these so a relayed proof can't be reused on another link
  getFingerprints(): { local: string; remote: string } {
    return {
      local: fingerprintOf(this.pc.localDescription?.sdp),
      remote: fingerprintOf(this.pc.remoteDescription?.sdp),
    };
  }

  private reportSendFailed(reason: string): void {
    p2pLog(`[P2P ${this.peerId}] send failed: ${reason}`);
    this.sendFailedHandlers.forEach(h => h(reason));
  }

  private enqueue(frame: string | Uint8Array<ArrayBuffer>): void {
    this.sendQueue.push(frame);
    this.flushSendQueue();
  }

  // stop at the high-water mark and pick up again on bufferedamountlow
  private flushSendQueue(): void {
    const dc = this.dataChannel;
    while (dc && dc.readyState === 'open' && this.sendQueue.length > 0 && dc.bufferedAmount < SEND_HIGH_WATER) {
      const frame = this.sendQueue.shift()!;
      try {
        if (typeof frame === 'string') dc.send(frame);
        else dc.send(frame);
      } catch (err) {
        this.sendQueue = [];
        this.reportSendFailed(String(err));
        return;
      }
    }
  }

  private handleChunk(buffer: ArrayBuffer): void {
    if (buffer.byteLength <= CHUNK_HEADER) return;
    const view = new DataView(buffer);
    if (view.getUint8(0) !== 0x46 || view.getUint8(1) !== 0x53) return;
    const transferId = view.getUint32(2);
    const index = view.getUint16(6);
    const total = view.getUint16(8);
    if (total < 2 || total > MAX_CHUNKS || index >= total) return;

    let transfer = this.incoming.get(transferId);
    if (!transfer) {
      if (this.incoming.size >= MAX_OPEN_TRANSFERS) return;
      transfer = {
        total,
        parts: new Array(total),
        received: 0,
        bytes: 0,
        timer: setTimeout(() => this.incoming.delete(transferId), TRANSFER_TIMEOUT),
      };
      this.incoming.set(transferId, transfer);
    }
    if (transfer.total !== total || transfer.parts[index]) return;

    const piece = new Uint8Array(buffer, CHUNK_HEADER);
    transfer.bytes += piece.length;
    if (transfer.bytes > MAX_TRANSFER_BYTES) {
      clearTimeout(transfer.timer);
      this.incoming.delete(transferId);
      return;
    }
    transfer.parts[index] = piece;
    transfer.received++;
    if (transfer.received < total) return;

    clearTimeout(transfer.timer);
    this.incoming.delete(transferId);
    const whole = new Uint8Array(transfer.bytes);
    let offset = 0;
    for (const part of transfer.parts) {
      whole.set(part!, offset);
      offset += part!.length;
    }
    this.handleText(new TextDecoder().decode(whole));
  }

  private handleText(text: string): void {
    const msg = deserializeMessage(text);
    if (!msg) {
      if (isNewerProtocolMessage(text)) this.protocolMismatchHandlers.forEach(h => h());
      return;
    }

    if (msg.type === 'ping') {
      this.send({ ...msg, type: 'pong', from: this.localPeerId });
      return;
    }

    if (msg.type === 'pong') {
      this.pendingPong = false;
      this.missedPings = 0;
      return;
    }

    this.messageHandlers.forEach(h => h(msg));
  }

  close(): void {
    if (this.closed) return;
    this.closed = true;
    this.stopPingInterval();
    if (this.iceDisconnectTimer) {
      clearTimeout(this.iceDisconnectTimer);
      this.iceDisconnectTimer = null;
    }
    if (this.connectingTimer) {
      clearTimeout(this.connectingTimer);
      this.connectingTimer = null;
    }
    // ICE-gathering timers are armed inside a promise that close() does not
    // await, so they have to be cancelled explicitly or they keep this object
    // alive for up to ICE_GATHER_TIMEOUT after teardown.
    for (const timer of this.iceGatherTimers) clearTimeout(timer);
    this.iceGatherTimers.clear();
    this.iceDoneWaiters = [];
    for (const transfer of this.incoming.values()) clearTimeout(transfer.timer);
    this.incoming.clear();
    this.sendQueue = [];
    this.dataChannel?.close();
    this.pc.close();
    this.setState('disconnected');
  }

  onMessage(handler: (msg: P2PMessage) => void): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
    };
  }

  onStateChange(handler: (state: ConnectionState) => void): () => void {
    this.stateHandlers.push(handler);
    return () => {
      this.stateHandlers = this.stateHandlers.filter(h => h !== handler);
    };
  }

  // Call when the app returns to the foreground: a backgrounded WebView can freeze
  // our ping timer and falsely trip the disconnect threshold. Also fires an
  // immediate ping instead of waiting for the next scheduled one.
  resetPingState(): void {
    this.missedPings = 0;
    this.pendingPong = false;
    if (this.dataChannel?.readyState === 'open') {
      this.sendPing();
    } else if (this.state === 'connected') {
      this.handleDisconnect();
    }
  }

  private setState(state: ConnectionState): void {
    p2pLog(`[P2P ${this.peerId}] state -> ${state}`);
    this.state = state;

    if (this.connectingTimer) {
      clearTimeout(this.connectingTimer);
      this.connectingTimer = null;
    }
    if (state === 'connecting') {
      this.connectingTimer = setTimeout(() => {
        this.connectingTimer = null;
        if (this.state === 'connecting') {
          p2pLog(`[P2P ${this.peerId}] stuck in 'connecting' for ${this.connectingTimeoutMs}ms, giving up`);
          this.handleDisconnect();
        }
      }, this.connectingTimeoutMs);
    }

    this.stateHandlers.forEach(h => h(state));
  }

  private ensureOpen(): void {
    if (this.closed || this.pc.signalingState === 'closed') {
      throw new Error('Connection was closed before negotiation could start. Please try connecting again.');
    }
  }

  private setupDataChannel(dc: RTCDataChannel): void {
    dc.binaryType = 'arraybuffer';
    dc.bufferedAmountLowThreshold = SEND_LOW_WATER;
    dc.onbufferedamountlow = () => this.flushSendQueue();

    dc.onopen = () => {
      this.setState('connected');
      this.startPingInterval();
    };

    dc.onclose = () => {
      this.handleDisconnect();
    };

    dc.onmessage = (event) => {
      if (typeof event.data === 'string') this.handleText(event.data);
      else if (event.data instanceof ArrayBuffer) this.handleChunk(event.data);
    };
  }

  private async gatherICECandidates(): Promise<RTCIceCandidateInit[]> {
    if (!this.iceGatheringDone && this.pc.iceGatheringState !== 'complete') {
      await new Promise<void>((resolve) => {
        // Clear both timers on every completion path.
        let settled = false;
        const finish = () => {
          if (settled) return;
          settled = true;
          clearTimeout(earlyResolve);
          clearTimeout(hardTimeout);
          this.iceGatherTimers.delete(earlyResolve);
          this.iceGatherTimers.delete(hardTimeout);
          resolve();
        };

        // Resolve early once we have at least one srflx (internet-routable) candidate
        const earlyResolve = setTimeout(() => {
          if (this.iceHasSrflx) finish();
        }, 4000);
        const hardTimeout = setTimeout(finish, ICE_GATHER_TIMEOUT);
        this.iceGatherTimers.add(earlyResolve);
        this.iceGatherTimers.add(hardTimeout);

        this.iceDoneWaiters.push(finish);
      });
    }

    let all = this.iceCandidates;

    // Fall back to candidates embedded in localDescription for unreliable WebViews.
    if (all.length === 0) {
      all = this.extractCandidatesFromLocalDescription();
    }

    // Keep usable UDP host/srflx candidates; IPv6 host candidates count too.
    const isUdp = (c: RTCIceCandidateInit) => / udp /i.test(c.candidate || '');
    const srflxCandidates = all.filter(c => c.candidate?.includes('typ srflx') && isUdp(c));
    const hostCandidates = all.filter(c => c.candidate?.includes('typ host') && isUdp(c));
    // keep one TURN relay candidate when a TURN server is configured
    const relayCandidates = all.filter(c => c.candidate?.includes('typ relay') && isUdp(c));

    // Rewrite with proper priorities so ICE engine prioritizes correctly. Operates
    // on the space-delimited candidate fields (priority is always the 4th token)
    // instead of an IPv4-shaped regex, so it also works for IPv6 addresses.
    const withProperPriority = (c: RTCIceCandidateInit, priority: number): RTCIceCandidateInit => {
      const parts = c.candidate!.split(' ');
      parts[3] = String(priority);
      return { ...c, candidate: parts.join(' ') };
    };

    const selected = [
      ...srflxCandidates.slice(0, 2).map(c => withProperPriority(c, 1686052863)),
      ...hostCandidates.slice(0, 2).map(c => withProperPriority(c, 2122252543)),
      ...relayCandidates.slice(0, 1).map(c => withProperPriority(c, 16777215)),
    ];

    p2pLog(`[P2P ${this.peerId}] gathered ${all.length} candidates (${srflxCandidates.length} srflx, ${hostCandidates.length} host, ${relayCandidates.length} relay), selected: ${selected.map(c => c.candidate).join(' | ')}`);

    return selected.length > 0 ? selected : all.slice(0, 3);
  }

  // Last-resort fallback when onicecandidate never delivered anything: pull
  // candidate lines directly out of the current local SDP.
  private extractCandidatesFromLocalDescription(): RTCIceCandidateInit[] {
    const sdp = this.pc.localDescription?.sdp;
    if (!sdp) return [];
    return sdp
      .split(/\r\n|\n/)
      .filter(line => line.startsWith('a=candidate:'))
      .map(line => ({ candidate: line.slice(2), sdpMid: '0', sdpMLineIndex: 0 }));
  }

  private handleDisconnect(): void {
    this.stopPingInterval();
    if (this.iceDisconnectTimer) {
      clearTimeout(this.iceDisconnectTimer);
      this.iceDisconnectTimer = null;
    }
    if (this.state === 'disconnected' || this.state === 'failed') return;
    this.setState('disconnected');
    // Close the transport so the remote peer sees the disconnect.
    this.dataChannel?.close();
    this.pc.close();
  }

  private sendPing(): void {
    if (this.pendingPong) {
      this.missedPings++;
      if (this.missedPings >= MAX_MISSED_PINGS) {
        this.handleDisconnect();
        return;
      }
    }

    this.pendingPong = true;
    this.send({
      id: crypto.randomUUID(),
      type: 'ping',
      // retain groupId for debug logging and future routing.
      groupId: this.groupId,
      from: this.localPeerId,
      hopCount: 0,
      timestamp: new Date().toISOString(),
    });
  }

  private startPingInterval(): void {
    this.pingInterval = window.setInterval(() => this.sendPing(), PING_INTERVAL);
  }

  private stopPingInterval(): void {
    if (this.pingInterval !== null) {
      clearInterval(this.pingInterval);
      this.pingInterval = null;
    }
  }
}
