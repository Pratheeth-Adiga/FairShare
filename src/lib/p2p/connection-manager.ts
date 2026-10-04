import { WebRTCConnection } from './webrtc-connection';
import type { ConnectionState } from './webrtc-connection';
import { decodeSignaling } from './signaling-codec';
import { shouldRelay, incrementHop } from './message-protocol';
import type { P2PMessage } from './message-protocol';
import { verifySignature } from '@/lib/crypto/identity';
import { p2pLog } from './debug-log';

export type PeerEventType = 'peer:connected' | 'peer:disconnected' | 'send:failed' | 'protocol-mismatch';

// unanswered offers get reaped, but only after enough time for the
// human QR round trip (show code, friend scans, friend shows answer, we scan)
const PENDING_CONNECTION_TIMEOUT = 3 * 60 * 1000;
// how long the other side gets to prove its peerId once the channel opens
const HANDSHAKE_TIMEOUT = 10000;

export interface PeerEvent {
  type: PeerEventType;
  peerId: string;
  reason?: string;
}

export interface PeerAuth {
  sign: (content: string) => Promise<string>;
  resolveKey: (peerId: string) => string | null;
}

// one object per connection instead of three maps kept in step by hand
interface PeerSession {
  key: string;
  conn: WebRTCConnection;
  // taken from the signalling blob, so nothing proves it until the hello check passes
  claimedId: string | null;
  groups: Set<string>;
  authenticated: boolean;
  nonce: string;
  timers: ReturnType<typeof setTimeout>[];
}

// binding both DTLS fingerprints stops a middleman from relaying one
// side's proof onto a different connection
function helloContent(nonce: string, signerId: string, verifierId: string, signerFp: string, verifierFp: string): string {
  return JSON.stringify(['fairshare-hello', nonce, signerId, verifierId, signerFp, verifierFp]);
}

function randomNonce(): string {
  return Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join('');
}

export class ConnectionManager {
  private localPeerId: string;
  private auth: PeerAuth;
  // every live connection, authenticated or not
  private sessions = new Map<string, PeerSession>();
  // only sessions whose peerId was proven by the hello handshake
  private byPeer = new Map<string, PeerSession>();
  private messageHandlers: ((peerId: string, msg: P2PMessage) => void)[] = [];
  private peerEventHandlers: ((event: PeerEvent) => void)[] = [];
  private outboundFilter: (peerId: string, groupId: string) => boolean = () => true;
  // three rotating sets so there's no replay gap at the swap boundary
  private seenMessageIdsCurrent = new Set<string>();
  private seenMessageIdsPrevious = new Set<string>();
  private seenMessageIdsRetiring = new Set<string>();
  private lastSeenBucketSwap = Date.now();
  private maxSeenAge = 5 * 60 * 1000;

  constructor(localPeerId: string, auth: PeerAuth) {
    this.localPeerId = localPeerId;
    this.auth = auth;
  }

  // lets the node stop sends to ex-members without the manager knowing about groups docs
  setOutboundFilter(filter: (peerId: string, groupId: string) => boolean): void {
    this.outboundFilter = filter;
  }

  async createOffer(groupId: string, expectedPeerId?: string): Promise<{ blob: string; peerId: string }> {
    const conn = new WebRTCConnection(this.localPeerId, expectedPeerId || 'pending');
    // track the session before the slow ICE gather so nothing can orphan it
    const session = this.newSession(conn, expectedPeerId ?? null, groupId);
    try {
      const blob = await conn.createOffer(groupId);
      return { blob, peerId: session.key };
    } catch (err) {
      conn.close();
      this.dropSession(session);
      throw err;
    }
  }

  async acceptOffer(blob: string, expected?: { peerId?: string; groupId?: string }): Promise<{ answerBlob: string; peerId: string; groupId: string }> {
    const offer = decodeSignaling(blob);
    if (offer.type !== 'offer') throw new Error('That code is a response, not a connection offer.');
    if (offer.peerId === this.localPeerId) throw new Error('That is your own connection code.');
    if (expected?.peerId && offer.peerId !== expected.peerId) throw new Error('Offer came from a different peer than expected');
    if (expected?.groupId && offer.groupId !== expected.groupId) throw new Error('Offer is for a different group than expected');

    // an existing connection for this peer is left alone until the new one proves itself
    const conn = new WebRTCConnection(this.localPeerId, offer.peerId);
    const session = this.newSession(conn, offer.peerId, offer.groupId);
    try {
      const answerBlob = await conn.acceptOffer(blob);
      return { answerBlob, peerId: offer.peerId, groupId: offer.groupId };
    } catch (err) {
      conn.close();
      this.dropSession(session);
      throw err;
    }
  }

  // pendingKey is the key createOffer returned, or the expected peerId for an introduction
  async completeConnection(answerBlob: string, pendingKey: string): Promise<string> {
    const answer = decodeSignaling(answerBlob);
    if (answer.type !== 'answer') throw new Error('That code is an offer, not a connection response.');
    const session = this.sessions.get(pendingKey) ?? this.findPendingOffer(pendingKey);
    if (!session || session.authenticated) throw new Error('This connection code expired. Close the dialog and start again.');
    if (session.claimedId && session.claimedId !== answer.peerId) throw new Error('Response came from a different peer than expected');
    if (!session.groups.has(answer.groupId)) throw new Error('Response is for a different group');

    const previous = session.claimedId;
    session.claimedId = answer.peerId;
    try {
      await session.conn.acceptAnswer(answerBlob);
    } catch (err) {
      session.claimedId = previous;
      throw err;
    }
    return answer.peerId;
  }

  broadcast(groupId: string, msg: P2PMessage): void {
    for (const [peerId, session] of this.byPeer) {
      if (!session.groups.has(groupId) || session.conn.getState() !== 'connected') continue;
      if (!this.outboundFilter(peerId, groupId)) continue;
      session.conn.send(msg);
    }
  }

  sendTo(peerId: string, msg: P2PMessage): void {
    const session = this.byPeer.get(peerId);
    if (session && session.conn.getState() === 'connected') {
      session.conn.send(msg);
    }
  }

  // the node calls this after the message verified, never before
  relay(msg: P2PMessage, viaPeerId: string): void {
    if (msg.to || !shouldRelay(msg)) return;
    const relayed = incrementHop(msg);
    for (const [peerId, session] of this.byPeer) {
      if (peerId === viaPeerId || peerId === msg.from) continue;
      if (!session.groups.has(msg.groupId) || session.conn.getState() !== 'connected') continue;
      if (!this.outboundFilter(peerId, msg.groupId)) continue;
      session.conn.send(relayed);
    }
  }

  hasSeen(id: string): boolean {
    this.rotateSeen();
    return this.seenMessageIdsCurrent.has(id) || this.seenMessageIdsPrevious.has(id) || this.seenMessageIdsRetiring.has(id);
  }

  // returns false when the id was already recorded
  markSeen(id: string): boolean {
    if (this.hasSeen(id)) return false;
    this.seenMessageIdsCurrent.add(id);
    return true;
  }

  getConnectedPeers(): string[] {
    return Array.from(this.byPeer.entries())
      .filter(([, session]) => session.conn.getState() === 'connected')
      .map(([peerId]) => peerId);
  }

  getConnectionState(peerId: string): ConnectionState | null {
    return this.byPeer.get(peerId)?.conn.getState() ?? null;
  }

  getPeerGroups(peerId: string): string[] {
    return Array.from(this.byPeer.get(peerId)?.groups ?? []);
  }

  // returns true if the group was new for this peer
  addPeerGroup(peerId: string, groupId: string): boolean {
    const session = this.byPeer.get(peerId);
    if (!session || session.groups.has(groupId)) return false;
    session.groups.add(groupId);
    return true;
  }

  disconnectPeer(peerId: string): void {
    this.byPeer.get(peerId)?.conn.close();
  }

  disconnectAll(): void {
    for (const session of Array.from(this.sessions.values())) {
      session.conn.close();
      this.dropSession(session);
    }
    this.byPeer.clear();
  }

  notifyForegroundResume(): void {
    for (const session of this.byPeer.values()) {
      session.conn.resetPingState();
    }
  }

  onMessage(handler: (peerId: string, msg: P2PMessage) => void): () => void {
    this.messageHandlers.push(handler);
    return () => {
      this.messageHandlers = this.messageHandlers.filter(h => h !== handler);
    };
  }

  onPeerEvent(handler: (event: PeerEvent) => void): () => void {
    this.peerEventHandlers.push(handler);
    return () => {
      this.peerEventHandlers = this.peerEventHandlers.filter(h => h !== handler);
    };
  }

  private emit(event: PeerEvent): void {
    this.peerEventHandlers.forEach(h => h(event));
  }

  private newSession(conn: WebRTCConnection, claimedId: string | null, groupId: string): PeerSession {
    const session: PeerSession = {
      key: `pending-${crypto.randomUUID()}`,
      conn,
      claimedId,
      groups: new Set([groupId]),
      authenticated: false,
      nonce: '',
      timers: [],
    };
    this.sessions.set(session.key, session);
    conn.onMessage(msg => this.handleIncomingMessage(session, msg));
    conn.onStateChange(state => this.handleStateChange(session, state));
    conn.onSendFailed(reason => {
      if (session.authenticated && session.claimedId) this.emit({ type: 'send:failed', peerId: session.claimedId, reason });
    });
    conn.onProtocolMismatch(() => {
      this.emit({ type: 'protocol-mismatch', peerId: session.claimedId ?? 'unknown', reason: 'Peer is running an incompatible app version.' });
    });
    session.timers.push(setTimeout(() => {
      if (!session.authenticated) {
        conn.close();
        this.dropSession(session);
      }
    }, PENDING_CONNECTION_TIMEOUT));
    return session;
  }

  private dropSession(session: PeerSession): void {
    session.timers.forEach(clearTimeout);
    session.timers = [];
    this.sessions.delete(session.key);
    if (session.claimedId && this.byPeer.get(session.claimedId) === session) {
      this.byPeer.delete(session.claimedId);
    }
  }

  private findPendingOffer(peerId: string): PeerSession | undefined {
    for (const session of this.sessions.values()) {
      if (!session.authenticated && session.claimedId === peerId) return session;
    }
    return undefined;
  }

  private rotateSeen(): void {
    const now = Date.now();
    if (now - this.lastSeenBucketSwap > this.maxSeenAge / 3) {
      this.seenMessageIdsRetiring = this.seenMessageIdsPrevious;
      this.seenMessageIdsPrevious = this.seenMessageIdsCurrent;
      this.seenMessageIdsCurrent = new Set();
      this.lastSeenBucketSwap = now;
    }
  }

  private handleIncomingMessage(session: PeerSession, msg: P2PMessage): void {
    if (msg.type === 'hello') {
      void this.answerHello(session, msg);
      return;
    }
    if (msg.type === 'hello-proof') {
      void this.checkProof(session, msg);
      return;
    }
    if (!session.authenticated || !session.claimedId || this.byPeer.get(session.claimedId) !== session) return;
    // cheap duplicate check only, ids get recorded once the node has verified them
    if (this.hasSeen(msg.id)) return;
    const peerId = session.claimedId;
    this.messageHandlers.forEach(h => h(peerId, msg));
  }

  private handleStateChange(session: PeerSession, state: ConnectionState): void {
    if (state === 'connected') {
      this.startHandshake(session);
    } else if (state === 'disconnected' || state === 'failed') {
      const peerId = session.claimedId;
      const wasLive = session.authenticated && !!peerId && this.byPeer.get(peerId) === session;
      if (wasLive) this.emit({ type: 'peer:disconnected', peerId });
      this.dropSession(session);
    }
  }

  private startHandshake(session: PeerSession): void {
    session.nonce = randomNonce();
    session.conn.send(this.controlMessage('hello', session.nonce));
    session.timers.push(setTimeout(() => {
      if (!session.authenticated) {
        p2pLog(`[P2P ${session.claimedId}] no hello proof within ${HANDSHAKE_TIMEOUT}ms, closing`);
        // connected but never got a proof back at all - most likely the other
        // device is on an incompatible app version and doesn't speak this handshake
        this.emit({ type: 'protocol-mismatch', peerId: session.claimedId ?? 'unknown', reason: 'Connected, but the other device never completed the handshake. It may be running an incompatible app version.' });
        session.conn.close();
      }
    }, HANDSHAKE_TIMEOUT));
  }

  private async answerHello(session: PeerSession, msg: P2PMessage): Promise<void> {
    const remoteId = session.claimedId;
    if (!remoteId || !msg.payload || msg.payload.length > 64) return;
    const fp = session.conn.getFingerprints();
    try {
      const signature = await this.auth.sign(helloContent(msg.payload, this.localPeerId, remoteId, fp.local, fp.remote));
      session.conn.send(this.controlMessage('hello-proof', signature));
    } catch (err) {
      p2pLog(`[P2P ${remoteId}] could not sign hello: ${String(err)}`);
    }
  }

  private async checkProof(session: PeerSession, msg: P2PMessage): Promise<void> {
    if (session.authenticated || !session.nonce || !msg.payload) return;
    const claimed = session.claimedId;
    const key = claimed ? this.auth.resolveKey(claimed) : null;
    const fp = session.conn.getFingerprints();
    const ok = !!claimed && !!key && msg.from === claimed
      && await verifySignature(key, helloContent(session.nonce, claimed, this.localPeerId, fp.remote, fp.local), msg.payload);
    if (!ok) {
      p2pLog(`[P2P ${claimed}] failed the hello check, closing`);
      this.emit({ type: 'protocol-mismatch', peerId: claimed ?? 'unknown', reason: 'Connected, but the other device failed the identity check. It may be running an incompatible app version.' });
      session.conn.close();
      return;
    }
    this.promote(session, claimed!);
  }

  private promote(session: PeerSession, peerId: string): void {
    session.authenticated = true;
    const existing = this.byPeer.get(peerId);
    this.byPeer.set(peerId, session);
    if (existing && existing !== session) {
      // re-pairing through another group keeps the groups the old link carried
      existing.groups.forEach(g => session.groups.add(g));
      existing.conn.close();
      this.dropSession(existing);
    }
    this.emit({ type: 'peer:connected', peerId });
  }

  private controlMessage(type: 'hello' | 'hello-proof', payload: string): P2PMessage {
    return {
      id: crypto.randomUUID(),
      type,
      groupId: '',
      from: this.localPeerId,
      hopCount: 0,
      timestamp: new Date().toISOString(),
      payload,
    };
  }
}
