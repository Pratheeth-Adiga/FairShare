import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGroupDocument } from '@/lib/crdt/document';
import type { GroupDocument } from '@/lib/crdt/document';
import type { GroupSettings } from '@/types';

// The store's persistence layer talks to Dexie; stub it out so tests run in
// pure memory. Every mutation path calls one of these.
const saveDocument = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const saveDocumentAndGroup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const loadDocument = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const loadGroups = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const deleteGroupFromDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/lib/storage/database', () => ({
  saveDocument,
  saveDocumentAndGroup,
  loadDocument,
  loadGroups,
  deleteGroup: deleteGroupFromDB,
}));// notifySync dynamically imports sync.store; mock it so nothing tries to boot
// a real P2P node during tests.
const leaveGroup = vi.hoisted(() => vi.fn());
vi.mock('@/stores/sync.store', () => ({
  useSyncStore: {
    getState: () => ({ broadcastDocument: vi.fn(), leaveGroup, subscribeToGroup: vi.fn() }),
  },
}));

// Imported after the mocks so the store binds to the stubbed persistence.
const { useGroupsStore, getGroupMemberCount, useGroupMemberCount } = await import('@/stores/groups.store');

const settings: GroupSettings = {
  defaultCurrency: 'USD',
  defaultSplitType: 'equal',
  simplifyDebts: true,
  settleThreshold: 100,
  roundingAssignee: 'payer',
  requireApproval: false,
  invitePermission: 'any_member',
  customCategories: [],
  disabledCategories: [],
};

function makeDoc(id: string, memberIds: string[]): GroupDocument {
  const [creator, ...rest] = memberIds;
  const doc = createGroupDocument(id, `Group ${id}`, creator, `User ${creator}`, settings);
  for (const m of rest) {
    doc.members[m] = { peerId: m, displayName: `User ${m}`, avatar: '', joinedAt: new Date().toISOString() };
  }
  return doc;
}

function resetStore() {
  useGroupsStore.setState({
    documents: {},
    groupList: [],
    activeGroupId: null,
    isLoading: false,
  });
}

describe('groups.store (mergeRemoteDocument)', () => {
  beforeEach(() => {
    resetStore();
    saveDocument.mockClear();
    saveDocumentAndGroup.mockClear();
  });

  it('creates a new groupList entry for an unknown group', () => {
    const doc = makeDoc('group-1', ['peer-a', 'peer-b']);
    useGroupsStore.getState().mergeRemoteDocument('group-1', doc);

    const { groupList, documents } = useGroupsStore.getState();
    expect(groupList).toHaveLength(1);
    expect(groupList[0].id).toBe('group-1');
    expect(documents['group-1']).toBeDefined();
    // Fresh receive should persist both doc and metadata together.
    expect(saveDocumentAndGroup).toHaveBeenCalledTimes(1);
  });

  it('does not duplicate the groupList entry on repeated merges of the same group', () => {
    const doc = makeDoc('group-1', ['peer-a']);
    useGroupsStore.getState().mergeRemoteDocument('group-1', doc);
    useGroupsStore.getState().mergeRemoteDocument('group-1', doc);

    expect(useGroupsStore.getState().groupList).toHaveLength(1);
  });

  // group names use their own last-write-wins timestamp
  it('updates the group name when a remote rename arrives', () => {
    const local = makeDoc('group-1', ['peer-a']);
    useGroupsStore.getState().mergeRemoteDocument('group-1', local);

    const renamed: GroupDocument = {
      ...local,
      meta: {
        ...local.meta,
        name: 'Renamed',
        nameUpdatedAt: new Date().toISOString(),
      },
      version: (local.version ?? 0) + 1,
    };
    useGroupsStore.getState().mergeRemoteDocument('group-1', renamed);

    expect(useGroupsStore.getState().groupList[0].name).toBe('Renamed');
    expect(useGroupsStore.getState().documents['group-1'].meta.name).toBe('Renamed');
  });

  it('derives member count from documents rather than a mirror field', () => {
    const doc = makeDoc('group-1', ['peer-a', 'peer-b', 'peer-c']);
    useGroupsStore.getState().mergeRemoteDocument('group-1', doc);
    expect(getGroupMemberCount('group-1')).toBe(3);

    // After a locally-driven remove, count reflects the new document even though
    // no in-memory mirror is updated anywhere.
    useGroupsStore.getState().removeMember('group-1', 'peer-c');
    expect(getGroupMemberCount('group-1')).toBe(2);
  });
});

describe('groups.store (deleteGroup)', () => {
  beforeEach(() => {
    resetStore();
    deleteGroupFromDB.mockClear();
  });

  it('removes the group from state and clears activeGroupId if it was active', async () => {
    const doc = makeDoc('group-1', ['peer-a']);
    useGroupsStore.setState({ documents: { 'group-1': doc }, groupList: [{ id: 'group-1', name: 'x', topic: 'group-1', createdAt: '', state: 'active', memberCount: 1, currency: 'USD' }], activeGroupId: 'group-1', isLoading: false });

    await useGroupsStore.getState().deleteGroup('group-1');

    const s = useGroupsStore.getState();
    expect(s.groupList).toHaveLength(0);
    expect(s.documents['group-1']).toBeUndefined();
    expect(s.activeGroupId).toBeNull();
    expect(deleteGroupFromDB).toHaveBeenCalledWith('group-1');
    // sync is torn down so a peer's next push can't bring it back
    expect(leaveGroup).toHaveBeenCalledWith('group-1');
  });
});

// import merges instead of overwriting
describe('groups.store (importDocument)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('keeps an expense added after the export was taken', async () => {
    const exported = makeDoc('group-1', ['peer-a', 'peer-b']);
    useGroupsStore.setState({ documents: { 'group-1': exported }, groupList: [], activeGroupId: null, isLoading: false });
    useGroupsStore.getState().addExpense('group-1', {
      groupId: 'group-1', friendId: null, description: 'Late', totalAmount: 100, currency: 'USD',
      payers: [{ userId: 'peer-a', amount: 100 }], splitType: 'equal',
      splits: [{ userId: 'peer-a', amount: 50 }, { userId: 'peer-b', amount: 50 }],
      items: [], category: 'other', date: '2026-01-01', createdAt: '2026-01-01T00:00:00Z', createdBy: 'peer-a', notes: '',
    });

    await useGroupsStore.getState().importDocument(exported);

    const expenses = Object.values(useGroupsStore.getState().documents['group-1'].expenses);
    expect(expenses.map(e => e.description)).toEqual(['Late']);
  });
});

// nothing that the loader would refuse gets committed
describe('groups.store (write-side validation)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('refuses a display name longer than the schema allows and leaves the doc alone', () => {
    const doc = makeDoc('group-1', ['peer-a']);
    useGroupsStore.setState({ documents: { 'group-1': doc }, groupList: [], activeGroupId: null, isLoading: false });

    const ok = useGroupsStore.getState().updateMemberProfile('group-1', 'peer-a', { displayName: 'x'.repeat(51) });

    expect(ok).toBe(false);
    expect(useGroupsStore.getState().documents['group-1']).toBe(doc);
  });
});

describe('groups.store (member mutations no longer drift)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('addMember keeps the groupList copy in step with the document', () => {
    const doc = makeDoc('group-1', ['peer-a']);
    useGroupsStore.setState({
      documents: { 'group-1': doc },
      groupList: [{ id: 'group-1', name: 'g', topic: 'group-1', createdAt: '', state: 'active', memberCount: 999, currency: 'USD' }],
      activeGroupId: null,
      isLoading: false,
    });

    useGroupsStore.getState().addMember('group-1', {
      peerId: 'peer-b',
      displayName: 'B',
      avatar: '',
      joinedAt: new Date().toISOString(),
    });

    expect(getGroupMemberCount('group-1')).toBe(2);
    // every mutation now refreshes the StoredGroup copy, so it can't drift
    expect(useGroupsStore.getState().groupList[0].memberCount).toBe(2);
  });

  it('useGroupMemberCount hook returns the same value as the plain getter', () => {
    // Sanity: the two accessors must not disagree.
    const doc = makeDoc('group-1', ['peer-a', 'peer-b']);
    useGroupsStore.setState({
      documents: { 'group-1': doc },
      groupList: [],
      activeGroupId: null,
      isLoading: false,
    });
    // Simulate a selector call (not a real render): match the hook body.
    const s = useGroupsStore.getState();
    const viaSelector = s.documents['group-1'] ? Object.keys(s.documents['group-1'].members).length : 0;
    expect(viaSelector).toBe(getGroupMemberCount('group-1'));
    expect(typeof useGroupMemberCount).toBe('function');
  });
});

// getPairwiseBalances used to recompute from scratch on every call
describe('groups.store (getPairwiseBalances memoization)', () => {
  beforeEach(() => {
    resetStore();
  });

  it('returns the same array reference for repeated calls on an unchanged doc', () => {
    const doc = makeDoc('group-1', ['peer-a', 'peer-b']);
    useGroupsStore.setState({ documents: { 'group-1': doc }, groupList: [], activeGroupId: null, isLoading: false });

    const first = useGroupsStore.getState().getPairwiseBalances('group-1', 'peer-a');
    const second = useGroupsStore.getState().getPairwiseBalances('group-1', 'peer-a');
    expect(second).toBe(first);
  });

  it('caches separately per user on the same document', () => {
    const doc = makeDoc('group-1', ['peer-a', 'peer-b']);
    useGroupsStore.setState({ documents: { 'group-1': doc }, groupList: [], activeGroupId: null, isLoading: false });

    const forA = useGroupsStore.getState().getPairwiseBalances('group-1', 'peer-a');
    const forB = useGroupsStore.getState().getPairwiseBalances('group-1', 'peer-b');
    expect(forA).not.toBe(forB);
  });

  it('recomputes once the document reference changes', () => {
    const doc = makeDoc('group-1', ['peer-a', 'peer-b']);
    useGroupsStore.setState({ documents: { 'group-1': doc }, groupList: [], activeGroupId: null, isLoading: false });
    const before = useGroupsStore.getState().getPairwiseBalances('group-1', 'peer-a');

    useGroupsStore.getState().addMember('group-1', {
      peerId: 'peer-c', displayName: 'C', avatar: '', joinedAt: new Date().toISOString(),
    });
    const after = useGroupsStore.getState().getPairwiseBalances('group-1', 'peer-a');
    expect(after).not.toBe(before);
  });
});

describe('groups.store (initialize resilience)', () => {
  beforeEach(() => {
    resetStore();
    loadGroups.mockReset();
    loadDocument.mockReset();
    saveDocument.mockClear();
  });

  it('skips a corrupted document instead of crashing the whole load', async () => {
    const good = makeDoc('good', ['peer-a']);
    loadGroups.mockResolvedValue([
      { id: 'good', name: 'Good', topic: 'good', createdAt: '', state: 'active', memberCount: 1, currency: 'USD' },
      { id: 'bad', name: 'Bad', topic: 'bad', createdAt: '', state: 'active', memberCount: 0, currency: 'USD' },
    ]);
    loadDocument.mockImplementation(async (id: string) => {
      if (id === 'good') return JSON.stringify(good);
      if (id === 'bad') return '{"meta":"not-a-real-doc"}';
      return undefined;
    });

    // Suppress the expected corruption log.
    const err = vi.spyOn(console, 'error').mockImplementation(() => {});
    await useGroupsStore.getState().initialize();
    err.mockRestore();

    const s = useGroupsStore.getState();
    // The good doc must survive, the bad one must be dropped from documents.
    expect(s.documents.good).toBeDefined();
    expect(s.documents.bad).toBeUndefined();
    // groupList still contains both stored group metadata entries; the app
    // won't lose the row, but the invalid doc simply won't hydrate.
    expect(s.groupList).toHaveLength(2);
    expect(s.isLoading).toBe(false);
  });

  it('skips a document that fails JSON.parse without throwing', async () => {
    loadGroups.mockResolvedValue([
      { id: 'trash', name: 'Trash', topic: 'trash', createdAt: '', state: 'active', memberCount: 0, currency: 'USD' },
    ]);
    loadDocument.mockResolvedValue('not-valid-json{');

    // Should complete cleanly, no throw, no doc loaded.
    await useGroupsStore.getState().initialize();

    expect(useGroupsStore.getState().documents.trash).toBeUndefined();
    expect(useGroupsStore.getState().isLoading).toBe(false);
  });
});
