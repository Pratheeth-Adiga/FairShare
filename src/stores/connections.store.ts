import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import { getP2PNode } from '@/lib/p2p/node';
import type { ConnectionState } from '@/lib/p2p/webrtc-connection';
import { loadKnownPeersForGroup, type StoredPeer } from '@/lib/storage/database';

export interface PeerConnectionInfo {
  peerId: string;
  state: ConnectionState;
  groups: string[];
}

interface ConnectionsState {
  activePeers: PeerConnectionInfo[];
  knownPeers: StoredPeer[];
  isCreatingOffer: boolean;
  isAcceptingOffer: boolean;
  offerBlob: string | null;
  answerBlob: string | null;
  pendingPeerId: string | null;
  pendingGroupId: string | null;
  // real peerId once an answer is scanned, so the dialog can wait for that exact peer
  connectingPeerId: string | null;
  connectedGroupId: string | null;
  error: string | null;
  // Keyed by target peerId - tracks in-flight/failed peer-introduction attempts
  // so the UI can show a spinner or a retry affordance per member.
  introductions: Record<string, 'pending' | 'failed'>;

  createOffer: (groupId: string) => Promise<void>;
  acceptOffer: (blob: string) => Promise<{ groupId: string } | null>;
  completeConnection: (answerBlob: string) => Promise<void>;
  reset: () => void;
  refreshPeers: () => void;
  loadKnownPeers: (groupId: string) => Promise<void>;
  requestIntroduction: (groupId: string, bridgePeerId: string, targetPeerId: string, requesterDisplayName?: string) => void;
  clearIntroductionStatus: (targetPeerId: string) => void;
}

export const useConnectionsStore = create<ConnectionsState>()(immer((set, get) => ({
  activePeers: [],
  knownPeers: [],
  isCreatingOffer: false,
  isAcceptingOffer: false,
  offerBlob: null,
  answerBlob: null,
  pendingPeerId: null,
  pendingGroupId: null,
  connectingPeerId: null,
  connectedGroupId: null,
  error: null,
  introductions: {},

  createOffer: async (groupId) => {
    const node = getP2PNode();
    if (!node?.connectionManager) {
      set({ error: 'P2P node not initialized' });
      return;
    }

    set({ isCreatingOffer: true, error: null, offerBlob: null, connectingPeerId: null });

    try {
      const { blob, peerId } = await node.connectionManager.createOffer(groupId);
      set({ offerBlob: blob, pendingPeerId: peerId, pendingGroupId: groupId, isCreatingOffer: false });
    } catch (err) {
      set({ error: `Failed to create offer: ${err instanceof Error ? err.message : String(err)}`, isCreatingOffer: false });
    }
  },

  acceptOffer: async (blob) => {
    const node = getP2PNode();
    if (!node?.connectionManager) {
      set({ error: 'P2P node not initialized' });
      return null;
    }

    set({ isAcceptingOffer: true, error: null, answerBlob: null });

    try {
      const { answerBlob, groupId } = await node.connectionManager.acceptOffer(blob);
      set({ answerBlob, connectedGroupId: groupId, isAcceptingOffer: false });
      return { groupId };
    } catch (err) {
      set({ error: `Failed to accept offer: ${err instanceof Error ? err.message : String(err)}`, isAcceptingOffer: false });
      return null;
    }
  },

  completeConnection: async (answerBlob) => {
    const node = getP2PNode();
    const { pendingPeerId, pendingGroupId } = get();
    if (!node?.connectionManager || !pendingPeerId) {
      set({ error: 'No pending connection' });
      return;
    }

    try {
      const realPeerId = await node.connectionManager.completeConnection(answerBlob, pendingPeerId);
      // the user just scanned this person's answer, so let them add themselves
      if (pendingGroupId) node.admitPeer(realPeerId, pendingGroupId);
      set({ pendingPeerId: null, pendingGroupId: null, offerBlob: null, answerBlob: null, connectingPeerId: realPeerId });
      get().refreshPeers();
    } catch (err) {
      set({ error: `Failed to complete connection: ${err instanceof Error ? err.message : String(err)}` });
    }
  },

  reset: () => {
    set({
      isCreatingOffer: false,
      isAcceptingOffer: false,
      offerBlob: null,
      answerBlob: null,
      pendingPeerId: null,
      pendingGroupId: null,
      connectingPeerId: null,
      connectedGroupId: null,
      error: null,
    });
  },

  refreshPeers: () => {
    const node = getP2PNode();
    if (!node?.connectionManager) {
      set({ activePeers: [] });
      return;
    }

    const peers = node.connectionManager.getConnectedPeers();
    set({
      activePeers: peers.map(peerId => ({
        peerId,
        state: node.connectionManager!.getConnectionState(peerId) || 'disconnected',
        groups: node.connectionManager!.getPeerGroups(peerId),
      })),
    });
  },

  loadKnownPeers: async (groupId) => {
    const knownPeers = await loadKnownPeersForGroup(groupId);
    set({ knownPeers });
  },

  requestIntroduction: (groupId, bridgePeerId, targetPeerId, requesterDisplayName) => {
    const node = getP2PNode();
    if (!node) {
      set({ error: 'P2P node not initialized' });
      return;
    }

    set(state => { state.introductions[targetPeerId] = 'pending'; });

    // settle once so timeout and peer:connect cannot both finish the flow
    let settled = false;
    let timeoutId: ReturnType<typeof setTimeout>;
    const unsubscribe = node.onPeerEvent((event) => {
      if (settled) return;
      if (event.type === 'peer:connect' && event.peerId === targetPeerId) {
        settled = true;
        try {
          clearTimeout(timeoutId);
          get().clearIntroductionStatus(targetPeerId);
          get().refreshPeers();
        } finally {
          unsubscribe();
        }
      }
    });

    timeoutId = setTimeout(() => {
      if (settled) return;
      settled = true;
      try {
        set(state => { state.introductions[targetPeerId] = 'failed'; });
      } finally {
        unsubscribe();
      }
    }, 15000);

    node.requestIntroduction(groupId, bridgePeerId, targetPeerId, requesterDisplayName).catch((err) => {
      if (settled) return;
      settled = true;
      try {
        clearTimeout(timeoutId);
        set(state => {
          state.introductions[targetPeerId] = 'failed';
          state.error = `Introduction failed: ${err instanceof Error ? err.message : String(err)}`;
        });
      } finally {
        unsubscribe();
      }
    });
  },

  clearIntroductionStatus: (targetPeerId) => {
    set(state => {
      delete state.introductions[targetPeerId];
    });
  },
})));
