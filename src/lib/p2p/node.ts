import type { PeerId } from '@/types';
import { ConnectionManager } from './connection-manager';
import { createMessage, deserializeMessage, incrementHop, shouldRelay, signP2PMessage, verifyP2PMessage } from './message-protocol';
import type { P2PMessage } from './message-protocol';
import { publicKeyFromPeerId, signMessage } from '@/lib/crypto/identity';
import { p2pLog } from './debug-log';

// Distinguishes THIS tab from a sibling tab of the same browser profile. Both
// load the same identity and therefore the same peerId, so peerId cannot be used
// to tell "my own echo" from "the other tab".
const LOCAL_INSTANCE_ID = crypto.randomUUID();

// how long a QR-paired joiner may push its "add me" record before it has to re-pair
const ADMISSION_TTL = 10 * 60 * 1000;
// an introduce-offer is only accepted this long after we asked for it
const INTRODUCTION_TTL = 60 * 1000;
const MAX_ANNOUNCED_GROUPS = 200;

export interface P2PConfig {
  bootstrapPeers: string[];
  stunServers: string[];
  relayNodes: string[];
}

export const DEFAULT_P2P_CONFIG: P2PConfig = {
  bootstrapPeers: [],
  // multiple STUN providers so no single one (Google in particular) sees
  // every FairShare device's public IP; actually used in webrtc-connection.ts.
  stunServers: [
    'stun:stun.cloudflare.com:3478',
    'stun:stun.l.google.com:19302',
    'stun:global.stun.twilio.com:3478',
  ],
  relayNodes: [],
};

export type PeerEventType = 'peer:connect' | 'peer:disconnect' | 'sync:start' | 'sync:complete' | 'sync:error';

export interface PeerEvent {
  type: PeerEventType;
  peerId: PeerId;
  timestamp: string;
  groupId?: string;
  reason?: string;
}

// consulted before any group message is accepted, relayed or sent.
export type MembershipVerifier = (peerId: string, groupId: string, messageType: P2PMessage['type']) => boolean;

export interface GroupSync {
  onRemote: (data: string, fromPeerId: string) => void;
  // answers a sync-request, null when we have nothing for this group yet
  getLocal: () => string | null;
}

export interface P2PNode {
  peerId: string;
  isStarted: boolean;
  connectedPeers: Set<string>;
  connectionManager: ConnectionManager | null;
  start: (privateKey?: string) => Promise<void>;
  stop: () => Promise<void>;
  subscribeToGroup: (groupId: string) => void;
  unsubscribeFromGroup: (groupId: string) => void;
  broadcastDocument: (groupId: string, documentData: string) => void | Promise<void>;
  setupGroupSync: (groupId: string, sync: GroupSync) => () => void;
  onPeerEvent: (callback: (event: PeerEvent) => void) => () => void;
  registerPeerKey: (peerId: string, publicKeyHex: string) => void;
  setMembershipVerifier: (verify: MembershipVerifier) => void;
  // the local user just finished a QR pairing with this peer for this group
  admitPeer: (peerId: string, groupId: string) => void;
  isAdmitted: (peerId: string, groupId: string) => boolean;
  // Asks bridgePeerId (a peer we're already directly connected to) to relay a
  // WebRTC signaling handshake between us and targetPeerId, so two devices that
  // share a common connected peer can pair without a direct QR scan.
  requestIntroduction: (groupId: string, bridgePeerId: string, targetPeerId: string, requesterDisplayName?: string) => Promise<void>;
  // Call when the app returns to the foreground so in-flight connections aren't
  // incorrectly torn down by stale keepalive state accumulated while backgrounded.
  notifyForegroundResume: () => void;
}

type EventCallback = (event: PeerEvent) => void;

const pairKey = (peerId: string, groupId: string) => `${peerId}|${groupId}`;

class FairShareP2PNode implements P2PNode {
  peerId: string;
  isStarted = false;
  connectedPeers = new Set<string>();
  connectionManager: ConnectionManager | null = null;
  private subscribedGroups = new Set<string>();
  private eventCallbacks: EventCallback[] = [];
  private groupSyncs = new Map<string, GroupSync>();
  private broadcastChannels = new Map<string, BroadcastChannel>();
  private privateKey: string | null = null;
  private knownPeerKeys = new Map<string, string>();
  private admitted = new Map<string, number>();
  private pendingIntroductions = new Map<string, number>();
  private offersInFlight = new Set<string>();
  // permissive until sync.store installs the real one, so bare node tests still work
  private membershipVerifier: MembershipVerifier = () => true;

  constructor(peerId: string) {
    this.peerId = peerId;
  }

  // derived peer IDs must match their registered public key.
  registerPeerKey(peerId: string, publicKeyHex: string): void {
    const derived = publicKeyFromPeerId(peerId);
    if (derived && derived.toLowerCase() !== publicKeyHex.toLowerCase()) return;
    // Legacy IDs use trust-on-first-use.
    if (!derived && this.knownPeerKeys.has(peerId)) return;
    this.knownPeerKeys.set(peerId, publicKeyHex);
  }

  // prefer a key derived from the peer ID, then a registered legacy key.
  private resolveSenderKey(peerId: string): string | null {
    const derived = publicKeyFromPeerId(peerId);
    if (derived) return derived;
    return this.knownPeerKeys.get(peerId) || null;
  }

  setMembershipVerifier(verify: MembershipVerifier): void {
    this.membershipVerifier = verify;
  }

  admitPeer(peerId: string, groupId: string): void {
    this.admitted.set(pairKey(peerId, groupId), Date.now() + ADMISSION_TTL);
  }

  isAdmitted(peerId: string, groupId: string): boolean {
    const expires = this.admitted.get(pairKey(peerId, groupId));
    return expires !== undefined && expires > Date.now();
  }

  async start(privateKey?: string): Promise<void> {
    // Re-entrant start updates credentials without replacing the live transport.
    this.privateKey = privateKey || null;
    if (this.isStarted && this.connectionManager) return;
    this.isStarted = true;
    const cm = new ConnectionManager(this.peerId, {
      sign: (content) => {
        if (!this.privateKey) return Promise.reject(new Error('no private key loaded'));
        return signMessage(this.privateKey, content);
      },
      resolveKey: (peerId) => this.resolveSenderKey(peerId),
    });
    this.connectionManager = cm;
    // nothing goes out to a peer that isn't (or is no longer) in the group
    cm.setOutboundFilter((peerId, groupId) => this.membershipVerifier(peerId, groupId, 'document'));

    cm.onPeerEvent((event) => {
      const timestamp = new Date().toISOString();
      if (event.type === 'peer:connected') {
        this.connectedPeers.add(event.peerId);
        const groups = cm.getPeerGroups(event.peerId);
        for (const groupId of groups) {
          this.emit({ type: 'peer:connect', peerId: event.peerId, timestamp, groupId });
          void this.sendSyncRequest(event.peerId, groupId);
        }
        void this.announceGroups(event.peerId);
      } else if (event.type === 'peer:disconnected') {
        this.connectedPeers.delete(event.peerId);
        this.emit({ type: 'peer:disconnect', peerId: event.peerId, timestamp });
      } else if (event.type === 'send:failed' || event.type === 'protocol-mismatch') {
        this.emit({ type: 'sync:error', peerId: event.peerId, timestamp, ...(event.reason ? { reason: event.reason } : {}) });
      }
    });

    cm.onMessage((peerId, msg) => {
      void this.handleP2PMessage(msg, peerId);
    });
  }

  async stop(): Promise<void> {
    this.isStarted = false;
    this.connectionManager?.disconnectAll();
    this.connectionManager = null;
    this.connectedPeers.clear();

    for (const channel of this.broadcastChannels.values()) {
      channel.close();
    }
    this.broadcastChannels.clear();

    // clear per-node state so a subsequent start() does not inherit
    // stale subscriptions, dead handlers, or old key material.
    this.subscribedGroups.clear();
    this.groupSyncs.clear();
    this.eventCallbacks = [];
    this.privateKey = null;
    this.knownPeerKeys.clear();
    this.admitted.clear();
    this.pendingIntroductions.clear();
    this.offersInFlight.clear();
    this.membershipVerifier = () => true;
  }

  subscribeToGroup(groupId: string): void {
    this.subscribedGroups.add(groupId);
    this.setupBroadcastChannel(groupId);
  }

  unsubscribeFromGroup(groupId: string): void {
    this.subscribedGroups.delete(groupId);
    const channel = this.broadcastChannels.get(groupId);
    if (channel) {
      channel.close();
      this.broadcastChannels.delete(groupId);
    }
  }

  async broadcastDocument(groupId: string, documentData: string): Promise<void> {
    if (!this.subscribedGroups.has(groupId)) return;
    const msg = await this.sign(createMessage('document', groupId, this.peerId, documentData));
    this.connectionManager?.broadcast(groupId, msg);
    // post the fully-formed signed message so the sibling tab runs the same checks
    this.broadcastToLocalChannel(groupId, msg);
  }

  setupGroupSync(groupId: string, sync: GroupSync): () => void {
    this.groupSyncs.set(groupId, sync);
    this.subscribeToGroup(groupId);

    return () => {
      if (this.groupSyncs.get(groupId) !== sync) return;
      this.groupSyncs.delete(groupId);
      this.unsubscribeFromGroup(groupId);
    };
  }

  onPeerEvent(callback: EventCallback): () => void {
    this.eventCallbacks.push(callback);
    return () => {
      this.eventCallbacks = this.eventCallbacks.filter(cb => cb !== callback);
    };
  }

  private emit(event: PeerEvent): void {
    this.eventCallbacks.forEach(cb => cb(event));
  }

  private async sign(msg: P2PMessage): Promise<P2PMessage> {
    return this.privateKey ? signP2PMessage(msg, this.privateKey) : msg;
  }

  // Both transports come through here: authenticate, then authorize, then dispatch.
  // `local` is the BroadcastChannel copy from a sibling tab.
  private async handleP2PMessage(msg: P2PMessage, viaPeerId: string, local = false): Promise<void> {
    const cm = this.connectionManager;
    if (!cm) return;

    // every message has to verify against a known key. No keyless exceptions.
    const senderKey = this.resolveSenderKey(msg.from);
    if (!senderKey || !msg.signature) return;
    if (!(await verifyP2PMessage(msg, senderKey))) return;

    if (local) {
      const sync = this.groupSyncs.get(msg.groupId);
      if (msg.type === 'document' && msg.payload && sync && this.membershipVerifier(msg.from, msg.groupId, msg.type)) {
        sync.onRemote(msg.payload, msg.from);
      }
      return;
    }

    // recorded only once verified, so junk can't pre-poison a real id
    if (!cm.markSeen(msg.id)) return;
    if (msg.from === this.peerId) return;

    if (msg.to && msg.to !== this.peerId) {
      // only hop an envelope between two members of that group
      if (shouldRelay(msg)
        && this.membershipVerifier(msg.from, msg.groupId, msg.type)
        && this.membershipVerifier(msg.to, msg.groupId, msg.type)) {
        cm.sendTo(msg.to, incrementHop(msg));
      }
      return;
    }

    switch (msg.type) {
      case 'peer-announce':
        if (msg.from === viaPeerId) this.handleAnnounce(msg);
        return;
      case 'introduce-request':
        await this.handleIntroduceRequest(msg, viaPeerId);
        return;
      case 'introduce-offer':
        await this.handleIntroduceOffer(msg, viaPeerId);
        return;
      case 'introduce-answer':
        await this.handleIntroduceAnswer(msg);
        return;
    }

    const sync = this.groupSyncs.get(msg.groupId);
    if (!sync) return;
    // a valid signature doesn't mean they're still in the group
    if (!this.membershipVerifier(msg.from, msg.groupId, msg.type)) return;

    if (msg.type === 'document' && msg.payload) {
      this.emit({ type: 'sync:start', peerId: viaPeerId, timestamp: new Date().toISOString(), groupId: msg.groupId });
      sync.onRemote(msg.payload, msg.from);
      this.emit({ type: 'sync:complete', peerId: viaPeerId, timestamp: new Date().toISOString(), groupId: msg.groupId });
      // an admitted joiner's push isn't worth relaying, nobody else counts it as a member yet
      if (this.membershipVerifier(msg.from, msg.groupId, 'peer-announce')) cm.relay(msg, viaPeerId);
    } else if (msg.type === 'sync-request') {
      const data = sync.getLocal();
      if (data) void this.sendDocumentTo(msg.from, viaPeerId, msg.groupId, data);
    }
  }

  private async sendDocumentTo(peerId: string, viaPeerId: string, groupId: string, data: string): Promise<void> {
    const msg = await this.sign({ ...createMessage('document', groupId, this.peerId, data), to: peerId });
    this.connectionManager?.sendTo(viaPeerId, msg);
  }

  // pull from the one peer that just connected instead of pushing to everyone
  private async sendSyncRequest(peerId: string, groupId: string): Promise<void> {
    if (!this.subscribedGroups.has(groupId)) return;
    try {
      const msg = await this.sign({ ...createMessage('sync-request', groupId, this.peerId), to: peerId });
      this.connectionManager?.sendTo(peerId, msg);
    } catch (err) {
      p2pLog('sync-request failed for group ' + groupId + ': ' + String(err));
    }
  }

  // tell a directly connected peer which of our groups it's a member of
  private async announceGroups(peerId: string, only?: string[]): Promise<void> {
    const groups = (only ?? Array.from(this.subscribedGroups))
      .filter(groupId => this.subscribedGroups.has(groupId) && this.membershipVerifier(peerId, groupId, 'peer-announce'))
      .slice(0, MAX_ANNOUNCED_GROUPS);
    if (groups.length === 0) return;
    const msg = await this.sign({ ...createMessage('peer-announce', '', this.peerId, JSON.stringify(groups)), to: peerId });
    this.connectionManager?.sendTo(peerId, msg);
  }

  private handleAnnounce(msg: P2PMessage): void {
    const cm = this.connectionManager;
    if (!cm || !msg.payload) return;
    let groups: unknown;
    try { groups = JSON.parse(msg.payload); } catch { return; }
    if (!Array.isArray(groups)) return;
    for (const groupId of groups.slice(0, MAX_ANNOUNCED_GROUPS)) {
      if (typeof groupId !== 'string' || !this.subscribedGroups.has(groupId)) continue;
      if (!this.membershipVerifier(msg.from, groupId, 'peer-announce')) continue;
      if (!cm.addPeerGroup(msg.from, groupId)) continue;
      this.emit({ type: 'peer:connect', peerId: msg.from, timestamp: new Date().toISOString(), groupId });
      void this.sendSyncRequest(msg.from, groupId);
    }
  }

  // We're the introduction target: a member asked (through a bridge) to be connected to us.
  private async handleIntroduceRequest(msg: P2PMessage, viaPeerId: string): Promise<void> {
    const cm = this.connectionManager;
    if (!cm || !this.subscribedGroups.has(msg.groupId)) return;
    // never gather ICE (and leak our addresses) for a non-member
    if (!this.membershipVerifier(msg.from, msg.groupId, msg.type)) return;

    if (cm.getConnectionState(msg.from) === 'connected') {
      // already linked through another group, so just share this one too
      if (cm.addPeerGroup(msg.from, msg.groupId)) {
        this.emit({ type: 'peer:connect', peerId: msg.from, timestamp: new Date().toISOString(), groupId: msg.groupId });
        void this.sendSyncRequest(msg.from, msg.groupId);
      }
      void this.announceGroups(msg.from, [msg.groupId]);
      return;
    }

    // both sides asked at the same time, the lower peerId's request wins
    const key = pairKey(msg.from, msg.groupId);
    if (this.pendingIntroductions.has(key)) {
      if (this.peerId < msg.from) return;
      this.pendingIntroductions.delete(key);
    }
    if (this.offersInFlight.has(msg.from)) return;

    this.offersInFlight.add(msg.from);
    try {
      const { blob } = await cm.createOffer(msg.groupId, msg.from);
      const offerMsg = await this.sign({ ...createMessage('introduce-offer', msg.groupId, this.peerId, blob), to: msg.from });
      cm.sendTo(viaPeerId, offerMsg);
    } catch (err) {
      // the requester times out on its side and can retry
      p2pLog('introduce-request handling failed: ' + String(err));
    } finally {
      this.offersInFlight.delete(msg.from);
    }
  }

  // We're the requester: the target sent back an offer through the bridge.
  private async handleIntroduceOffer(msg: P2PMessage, viaPeerId: string): Promise<void> {
    const cm = this.connectionManager;
    if (!cm || !msg.payload || !this.subscribedGroups.has(msg.groupId)) return;
    // only offers for introductions we actually asked for
    const key = pairKey(msg.from, msg.groupId);
    const expires = this.pendingIntroductions.get(key);
    if (expires === undefined || expires < Date.now()) return;
    if (!this.membershipVerifier(msg.from, msg.groupId, msg.type)) return;
    this.pendingIntroductions.delete(key);
    try {
      const { answerBlob } = await cm.acceptOffer(msg.payload, { peerId: msg.from, groupId: msg.groupId });
      const answerMsg = await this.sign({ ...createMessage('introduce-answer', msg.groupId, this.peerId, answerBlob), to: msg.from });
      cm.sendTo(viaPeerId, answerMsg);
    } catch (err) {
      p2pLog('introduce-offer handling failed: ' + String(err));
    }
  }

  // We're the target again: the requester's answer came back. ICE runs directly from here.
  private async handleIntroduceAnswer(msg: P2PMessage): Promise<void> {
    const cm = this.connectionManager;
    if (!cm || !msg.payload) return;
    if (!this.membershipVerifier(msg.from, msg.groupId, msg.type)) return;
    try {
      await cm.completeConnection(msg.payload, msg.from);
    } catch (err) {
      // stale or duplicate answer, or the offer was already reaped
      p2pLog('introduce-answer handling failed: ' + String(err));
    }
  }

  async requestIntroduction(groupId: string, bridgePeerId: string, targetPeerId: string, requesterDisplayName?: string): Promise<void> {
    if (!this.connectionManager) throw new Error('P2P node not started');
    this.pendingIntroductions.set(pairKey(targetPeerId, groupId), Date.now() + INTRODUCTION_TTL);
    const msg = await this.sign({
      ...createMessage(
        'introduce-request',
        groupId,
        this.peerId,
        requesterDisplayName ? JSON.stringify({ requesterDisplayName }) : undefined
      ),
      to: targetPeerId,
    });
    this.connectionManager.sendTo(bridgePeerId, msg);
  }

  notifyForegroundResume(): void {
    this.connectionManager?.notifyForegroundResume();
  }

  private setupBroadcastChannel(groupId: string): void {
    if (this.broadcastChannels.has(groupId)) return;

    try {
      const channel = new BroadcastChannel(`fairshare:${groupId}`);
      channel.onmessage = (event) => {
        if (typeof event.data !== 'string') return;
        try {
          const envelope = JSON.parse(event.data) as { _instanceId?: string };
          // Use a per-tab ID; multiple tabs share the same peerId.
          if (envelope._instanceId === LOCAL_INSTANCE_ID) return;
        } catch { return; }
        // same schema check and verify path as the WebRTC copy
        const msg = deserializeMessage(event.data);
        if (!msg || msg.groupId !== groupId) return;
        void this.handleP2PMessage(msg, this.peerId, true);
      };
      this.broadcastChannels.set(groupId, channel);
    } catch (err) {
      // could be genuinely unsupported, or a real construction error - log
      // either way under debug so a real bug isn't indistinguishable from the browser
      // just lacking the API.
      p2pLog('BroadcastChannel setup failed for ' + groupId + ': ' + String(err));
    }
  }

  private broadcastToLocalChannel(groupId: string, message: P2PMessage): void {
    try {
      const channel = this.broadcastChannels.get(groupId);
      if (channel) {
        channel.postMessage(JSON.stringify({ ...message, _instanceId: LOCAL_INSTANCE_ID }));
      }
    } catch (err) {
      p2pLog('BroadcastChannel send failed for ' + groupId + ': ' + String(err));
    }
  }
}

let nodeInstance: FairShareP2PNode | null = null;

export function createP2PNode(peerId: string): P2PNode {
  if (nodeInstance) {
    if (nodeInstance.peerId === peerId) return nodeInstance;
    // Stop the old node before switching identities.
    void nodeInstance.stop();
  }
  nodeInstance = new FairShareP2PNode(peerId);
  return nodeInstance;
}

export function getP2PNode(): P2PNode | null {
  return nodeInstance;
}
