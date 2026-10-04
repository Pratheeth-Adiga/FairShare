import Dexie, { type Table } from 'dexie';
import type { UserIdentity } from '@/types';

export interface StoredDocument {
  groupId: string;
  data: string;
  updatedAt: string;
}

export interface StoredGroup {
  id: string;
  name: string;
  topic: string;
  createdAt: string;
  state: string;
  memberCount: number;
  currency: string;
}

export interface StoredPeer {
  peerId: string;
  displayName: string;
  avatar: string;
  lastSeen: string;
  groupIds: string[];
}

// small key/value store for identity metadata that survives reloads
export interface StoredIdentityMeta {
  key: string;
  value: string;
}

export interface PendingProfileUpdate {
  displayName?: string;
  avatar?: string;
}

const PENDING_PROFILE_KEY = 'pendingProfileUpdate';

class FairShareDB extends Dexie {
  identity!: Table<UserIdentity, string>;
  documents!: Table<StoredDocument, string>;
  groups!: Table<StoredGroup, string>;
  peers!: Table<StoredPeer, string>;
  identityMeta!: Table<StoredIdentityMeta, string>;

  constructor() {
    super('fairshare');
    // Schema v1: initial schema. Future migrations use version(N).stores(...).upgrade(tx => ...).
    // See Dexie docs: https://dexie.org/docs/Dexie/Dexie.version()
    this.version(1).stores({
      identity: 'peerId',
      documents: 'groupId',
      groups: 'id, state, createdAt',
      peers: 'peerId, displayName',
    });

    // add the marker store; existing stores carry forward automatically
    this.version(2).stores({
      identityMeta: 'key',
    });
  }
}

export const db = new FairShareDB();

// Keep a single identity row even during restore/QR import flows.
export async function saveIdentity(identity: UserIdentity): Promise<void> {
  await db.transaction('rw', db.identity, async () => {
    await db.identity.clear();
    await db.identity.put(identity);
  });
}

export async function loadIdentity(): Promise<UserIdentity | undefined> {
  const all = await db.identity.toArray();
  return all[0];
}

// persist a marker before fan-out so interrupted profile updates resume
export async function savePendingProfileUpdate(update: PendingProfileUpdate | null): Promise<void> {
  if (update === null) {
    await db.identityMeta.delete(PENDING_PROFILE_KEY);
    return;
  }
  await db.identityMeta.put({ key: PENDING_PROFILE_KEY, value: JSON.stringify(update) });
}

export async function loadPendingProfileUpdate(): Promise<PendingProfileUpdate | null> {
  const row = await db.identityMeta.get(PENDING_PROFILE_KEY);
  if (!row) return null;
  try {
    const parsed: unknown = JSON.parse(row.value);
    // Guard against a corrupted or hand-edited row: a bad marker would otherwise
    // be replayed into updateProfile() on every single launch.
    if (!parsed || typeof parsed !== 'object' || Array.isArray(parsed)) return null;
    const { displayName, avatar } = parsed as Record<string, unknown>;
    const update: PendingProfileUpdate = {};
    if (typeof displayName === 'string') update.displayName = displayName;
    if (typeof avatar === 'string') update.avatar = avatar;
    return Object.keys(update).length > 0 ? update : null;
  } catch {
    return null;
  }
}

export async function saveDocument(groupId: string, data: string): Promise<void> {
  await db.documents.put({ groupId, data, updatedAt: new Date().toISOString() });
}

export async function loadDocument(groupId: string): Promise<string | undefined> {
  const doc = await db.documents.get(groupId);
  return doc?.data;
}

export async function saveGroup(group: StoredGroup): Promise<void> {
  await db.groups.put(group);
}

// Commit the document and group metadata together so they stay aligned.
export async function saveDocumentAndGroup(groupId: string, data: string, group: StoredGroup): Promise<void> {
  await db.transaction('rw', db.documents, db.groups, async () => {
    await db.documents.put({ groupId, data, updatedAt: new Date().toISOString() });
    await db.groups.put(group);
  });
}

export async function loadGroups(): Promise<StoredGroup[]> {
  return db.groups.toArray();
}

export async function deleteGroup(groupId: string): Promise<void> {
  // wrap group and document deletes in one transaction
  await db.transaction('rw', db.groups, db.documents, async () => {
    await db.groups.delete(groupId);
    await db.documents.delete(groupId);
  });
}

export async function savePeer(peer: StoredPeer): Promise<void> {
  await db.peers.put(peer);
}

export async function loadPeers(): Promise<StoredPeer[]> {
  return db.peers.toArray();
}

// Remembers a peer we've successfully connected to for a group, so the pairing
// survives a full app restart even though the live WebRTC session cannot.
export async function recordKnownPeer(
  groupId: string,
  peerId: string,
  displayName: string,
  avatar: string
): Promise<void> {
  // Keep the read and write atomic so concurrent group updates do not clobber IDs.
  await db.transaction('rw', db.peers, async () => {
    const existing = await db.peers.get(peerId);
    const groupIds = existing ? Array.from(new Set([...existing.groupIds, groupId])) : [groupId];
    await db.peers.put({
      peerId,
      displayName: displayName || existing?.displayName || 'Unknown',
      avatar: avatar || existing?.avatar || '',
      lastSeen: new Date().toISOString(),
      groupIds,
    });
  });
}

export async function loadKnownPeersForGroup(groupId: string): Promise<StoredPeer[]> {
  const all = await db.peers.toArray();
  return all.filter(p => p.groupIds.includes(groupId));
}
