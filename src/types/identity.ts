import type { PeerId } from './expense';

export interface UserIdentity {
  peerId: PeerId;
  publicKey: string;
  privateKey: string;
  displayName: string;
  avatar: string;
  createdAt: string;
}

export interface PeerInfo {
  peerId: PeerId;
  displayName: string;
  avatar: string;
  lastSeen: string;
  isOnline: boolean;
}

export type SyncStatus = 'synced' | 'syncing' | 'offline' | 'error';

export interface PeerSyncState {
  peerId: PeerId;
  status: SyncStatus;
  lastSynced: string | null;
  pendingChanges: number;
}
