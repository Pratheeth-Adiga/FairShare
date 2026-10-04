import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { PeerId, PeerSyncState, SyncStatus } from '@/types';
import { createP2PNode, type P2PNode } from '@/lib/p2p/node';
import type { GroupDocument } from '@/lib/crdt/document';
import { recordKnownPeer } from '@/lib/storage/database';
import { publicKeyFromPeerId } from '@/lib/crypto/identity';
import { clampFutureStamps, latestStamp, MAX_CLOCK_SKEW_MS } from '@/lib/crdt/merge';
import { nextStamp, observeStamp } from '@/lib/crdt/operations';
import { useGroupsStore } from './groups.store';
import { useIdentityStore } from './identity.store';
import { parseGroupDocument, formatZodError } from '@/lib/validation/schemas';

// register member keys; handles legacy profiles with new-format IDs too
function registerMemberKeys(node: P2PNode, groupId: string): void {
  const doc = useGroupsStore.getState().getDocument(groupId);
  if (!doc) return;
  for (const member of Object.values(doc.members)) {
    if (member.publicKey) {
      node.registerPeerKey(member.peerId, member.publicKey);
    }
  }
}

// re-running initializeP2P used to stack another listener each time
let unsubscribePeerEvents: (() => void) | null = null;
// deleteGroup has to be able to take the sync handler down again
const groupTeardowns = new Map<string, () => void>();
// groups the user is joining right now through the QR flow
const joiningGroups = new Set<string>();

function handleRemoteDocument(node: P2PNode, groupId: string, remoteData: string, fromPeerId: string): void {
  let parsed: unknown;
  try {
    parsed = JSON.parse(remoteData);
  } catch {
    return;
  }
  // validate P2P documents before merging; remote data is untrusted.
  // over-long strings from an older peer get shortened instead of killing sync.
  const result = parseGroupDocument(parsed);
  if (!result.success) {
    console.error(`[sync] Rejecting malformed remote document for group ${groupId}:`, formatZodError(result.error));
    return;
  }
  // the schema proves the shape; narrow its optional fields here.
  // a peer with a clock far ahead can't win every conflict with it.
  const remoteDoc = clampFutureStamps(result.data as GroupDocument, Date.now() + MAX_CLOCK_SKEW_MS);
  // a document for another group must not be merged under this id
  if (remoteDoc.meta.id !== groupId) {
    console.error(`[sync] Rejecting document for group ${remoteDoc.meta.id} sent as ${groupId}`);
    return;
  }
  observeStamp(latestStamp(remoteDoc));

  const groups = useGroupsStore.getState();
  const localDoc = groups.getDocument(groupId);

  if (localDoc && !localDoc.members[fromPeerId]) {
    // the verifier only lets this through for a joiner we just paired with.
    // Take its own "add me" record and nothing else.
    const joiner = remoteDoc.members[fromPeerId];
    const derivedKey = publicKeyFromPeerId(fromPeerId);
    if (joiner && derivedKey && joiner.publicKey?.toLowerCase() === derivedKey) {
      // restamp so a stale tombstone elsewhere can't beat the re-add on merge
      groups.addMember(groupId, { ...joiner, updatedAt: nextStamp() });
      registerMemberKeys(node, groupId);
    }
    return;
  }

  groups.mergeRemoteDocument(groupId, remoteDoc);
  // register keys for members received in the merge
  registerMemberKeys(node, groupId);

  // Join as a distinct member; display names are not identifiers.
  const doc = useGroupsStore.getState().getDocument(groupId);
  const identity = useIdentityStore.getState().identity;
  if (!doc || !identity) return;
  if (doc.members[identity.peerId]) {
    joiningGroups.delete(groupId);
    return;
  }
  // a device that was removed must not quietly put itself back. Only the
  // first copy of a group, or an explicit re-join through the QR flow, adds us.
  const wasRemoved = identity.peerId in doc.deleted || !!doc.formerMembers?.[identity.peerId];
  const firstCopy = !localDoc;
  if (!joiningGroups.has(groupId) && !(firstCopy && !wasRemoved)) return;
  joiningGroups.delete(groupId);
  useGroupsStore.getState().addMember(groupId, {
    peerId: identity.peerId,
    displayName: identity.displayName,
    avatar: identity.avatar || '',
    joinedAt: new Date().toISOString(),
    // include our public key so other peers can verify our signatures
    publicKey: identity.publicKey,
  });
}

interface SyncState {
  node: P2PNode | null;
  isConnected: boolean;
  peers: Record<string, PeerSyncState>;
  overallStatus: SyncStatus;
  // last send that didn't make it to a peer, shown in GroupDetail
  lastSendError: string | null;

  initializeP2P: (peerId: PeerId, privateKey?: string) => Promise<void>;
  shutdown: () => Promise<void>;
  subscribeToGroup: (groupId: string) => void;
  joinGroup: (groupId: string) => void;
  leaveGroup: (groupId: string) => void;
  unsubscribeFromGroup: (groupId: string) => void;
  broadcastDocument: (groupId: string) => void;
  clearSendError: () => void;
}

export const useSyncStore = create<SyncState>()(immer((set, get) => ({
  node: null,
  isConnected: false,
  peers: {},
  overallStatus: 'offline',
  lastSendError: null,

  initializeP2P: async (peerId, privateKey) => {
    const node = createP2PNode(peerId);
    await node.start(privateKey);

    // consult the live groups store on every message. An ex-member whose
    // signature still verifies is rejected because they're gone from doc.members.
    node.setMembershipVerifier((senderPeerId, groupId, messageType) => {
      const doc = useGroupsStore.getState().getDocument(groupId);
      // Bootstrap: a joiner with no copy yet takes the first document. Only reachable
      // while a sync handler exists for the group.
      if (!doc) return messageType === 'document';
      if (senderPeerId in doc.members) return true;
      // a QR-paired joiner can ask for the document and push its "add me" record
      return (messageType === 'document' || messageType === 'sync-request') && node.isAdmitted(senderPeerId, groupId);
    });

    unsubscribePeerEvents?.();
    unsubscribePeerEvents = node.onPeerEvent((event) => {
      const { peers } = get();
      const peerState: PeerSyncState = peers[event.peerId] || {
        peerId: event.peerId,
        status: 'offline',
        lastSynced: null,
        pendingChanges: 0,
      };
      // status follows direct connections, not whoever a relayed message came from
      const isDirect = node.connectedPeers.has(event.peerId);

      switch (event.type) {
        case 'peer:connect':
          set(state => {
            state.peers[event.peerId] = { ...peerState, status: 'synced' };
            state.overallStatus = 'synced';
          });
          // Remember this peer for this group so it survives an app restart
          if (event.groupId) {
            const member = useGroupsStore.getState().documents[event.groupId]?.members[event.peerId];
            recordKnownPeer(event.groupId, event.peerId, member?.displayName || 'Unknown', member?.avatar || '');
          }
          break;
        case 'peer:disconnect':
          set(state => {
            state.peers[event.peerId] = { ...peerState, status: 'offline' };
          });
          break;
        case 'sync:complete':
          if (!isDirect) break;
          set(state => {
            state.peers[event.peerId] = { ...peerState, status: 'synced', lastSynced: event.timestamp };
          });
          break;
        case 'sync:start':
          if (!isDirect) break;
          set(state => {
            state.peers[event.peerId] = { ...peerState, status: 'syncing' };
            state.overallStatus = 'syncing';
          });
          break;
        case 'sync:error':
          set(state => { state.lastSendError = event.reason || 'A change could not be sent to a peer.'; });
          break;
      }
    });

    set({ node, isConnected: true, overallStatus: 'synced' });
  },

  shutdown: async () => {
    const { node } = get();
    unsubscribePeerEvents?.();
    unsubscribePeerEvents = null;
    groupTeardowns.clear();
    if (node) await node.stop();
    set({ node: null, isConnected: false, overallStatus: 'offline' });
  },

  subscribeToGroup: (groupId) => {
    const { node } = get();
    if (!node) return;

    const teardown = node.setupGroupSync(groupId, {
      onRemote: (data, fromPeerId) => handleRemoteDocument(node, groupId, data, fromPeerId),
      getLocal: () => {
        const doc = useGroupsStore.getState().getDocument(groupId);
        return doc ? JSON.stringify(doc) : null;
      },
    });
    groupTeardowns.set(groupId, teardown);

    // register keys for members already present in the local document
    // (not just those brought in by future merges).
    registerMemberKeys(node, groupId);

    const doc = useGroupsStore.getState().getDocument(groupId);
    if (doc) {
      node.broadcastDocument(groupId, JSON.stringify(doc));
    }
  },

  joinGroup: (groupId) => {
    joiningGroups.add(groupId);
    get().subscribeToGroup(groupId);
  },

  leaveGroup: (groupId) => {
    joiningGroups.delete(groupId);
    groupTeardowns.get(groupId)?.();
    groupTeardowns.delete(groupId);
  },

  unsubscribeFromGroup: (groupId) => {
    const { node } = get();
    if (node) node.unsubscribeFromGroup(groupId);
  },

  broadcastDocument: (groupId) => {
    const { node } = get();
    if (!node) return;
    const doc = useGroupsStore.getState().getDocument(groupId);
    if (doc) {
      node.broadcastDocument(groupId, JSON.stringify(doc));
    }
  },

  clearSendError: () => set({ lastSendError: null }),
})));
