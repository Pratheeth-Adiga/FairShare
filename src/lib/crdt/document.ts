import type { Expense, Settlement, PeerId, GroupSettings, MemberProfile } from '@/types';
import type { GroupState } from '@/types';

export interface GroupDocument {
  meta: {
    id: string;
    name: string;
    settings: GroupSettings;
    state: GroupState;
    createdBy: PeerId;
    createdAt: string;
    settingsUpdatedAt?: string;
    // LWW stamp for state so archive/close changes survive sync.
    stateUpdatedAt?: string;
    // LWW stamp for the mutable group name; see mergeDocuments.
    nameUpdatedAt?: string;
  };
  members: Record<string, MemberProfile>;
  formerMembers?: Record<string, MemberProfile>;
  expenses: Record<string, Expense>;
  settlements: Record<string, Settlement>;
  // Tombstones: expenseId -> ISO deletion timestamp (enables tombstone expiry).
  deleted: Record<string, string>;
  // compare versions before serializing documents during sync
  version?: number;
}

export function createGroupDocument(
  id: string,
  name: string,
  creatorId: PeerId,
  creatorName: string,
  settings: GroupSettings,
  creatorPublicKey?: string
): GroupDocument {
  return {
    meta: {
      id,
      name,
      settings,
      state: 'active',
      createdBy: creatorId,
      createdAt: new Date().toISOString(),
    },
    members: {
      [creatorId]: {
        peerId: creatorId,
        displayName: creatorName,
        avatar: '',
        joinedAt: new Date().toISOString(),
        // omit publicKey when the creator has not published one
        ...(creatorPublicKey ? { publicKey: creatorPublicKey } : {}),
      },
    },
    formerMembers: {},
    expenses: {},
    settlements: {},
    deleted: {},
    version: 0,
  };
}
