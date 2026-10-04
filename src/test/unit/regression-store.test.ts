// store-level regression tests with Dexie and sync mocked
import { describe, it, expect, vi, beforeEach } from 'vitest';
import { createGroupDocument } from '@/lib/crdt/document';
import { addExpense } from '@/lib/crdt/operations';
import type { GroupDocument } from '@/lib/crdt/document';
import type { Expense, GroupSettings } from '@/types';

const saveDocument = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const saveDocumentAndGroup = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const loadDocument = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const loadGroups = vi.hoisted(() => vi.fn().mockResolvedValue([]));
const deleteGroupFromDB = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));

vi.mock('@/lib/storage/database', () => ({
  saveDocument, saveDocumentAndGroup, loadDocument, loadGroups,
  deleteGroup: deleteGroupFromDB,
}));

const broadcastDocument = vi.hoisted(() => vi.fn());
vi.mock('@/stores/sync.store', () => ({
  useSyncStore: { getState: () => ({ broadcastDocument }) },
}));

const { useGroupsStore } = await import('@/stores/groups.store');

const settings: GroupSettings = {
  defaultCurrency: 'USD', defaultSplitType: 'equal', simplifyDebts: true, settleThreshold: 100,
  roundingAssignee: 'payer', requireApproval: false, invitePermission: 'any_member',
  customCategories: [], disabledCategories: [],
};

function makeDoc(id = 'g1'): GroupDocument {
  const doc = createGroupDocument(id, 'Trip', 'peer-a', 'User A', settings);
  doc.members['peer-b'] = {
    peerId: 'peer-b', displayName: 'User B', avatar: '',
    joinedAt: new Date().toISOString(),
  } as never;
  return doc;
}

// Dynamic gossip runs in a later microtask.
const flushMicrotasks = () => new Promise(resolve => setTimeout(resolve, 0));

function makeExpense(id: string, by: string): Expense {
  return {
    id, groupId: 'g1', friendId: null, description: 'E ' + id,
    totalAmount: 10000, currency: 'USD',
    payers: [{ userId: by, amount: 10000 }],
    splitType: 'equal',
    splits: [{ userId: 'peer-a', amount: 5000 }, { userId: 'peer-b', amount: 5000 }],
    items: [], category: 'food', date: '2026-01-15',
    createdAt: new Date().toISOString(), createdBy: by, notes: '',
  };
}

beforeEach(() => {
  saveDocument.mockClear();
  saveDocumentAndGroup.mockClear();
  broadcastDocument.mockClear();
  useGroupsStore.setState({ documents: {}, groupList: [] } as never);
});

// gossip must propagate equal-version remote changes
describe('gossip change-detection at equal versions', () => {
  it('propagates a remote expense that arrives at an equal version', async () => {
    // Local: base doc + our own expense  -> version 1
    const local = addExpense(makeDoc(), makeExpense('exp-local', 'peer-a'));
    // Remote: same base + their expense  -> also version 1
    const remote = addExpense(makeDoc(), makeExpense('exp-remote', 'peer-b'));
    expect(local.version).toBe(remote.version); // the trap

    useGroupsStore.setState({
      documents: { g1: local },
      groupList: [{
        id: 'g1', name: 'Trip', topic: 'g1', createdAt: local.meta.createdAt,
        state: local.meta.state, memberCount: 2, currency: 'USD',
      }],
    } as never);

    useGroupsStore.getState().mergeRemoteDocument('g1', remote);
    await flushMicrotasks();

    // The merge genuinely added a record, so this must be gossipped onward or
    // peers reachable only through us never see exp-remote.
    const merged = useGroupsStore.getState().documents['g1'];
    expect(Object.keys(merged.expenses)).toContain('exp-remote');
    expect(broadcastDocument).toHaveBeenCalledWith('g1');
  });

  it('does not gossip when the remote document adds nothing', async () => {
    const local = addExpense(makeDoc(), makeExpense('exp-1', 'peer-a'));
    useGroupsStore.setState({
      documents: { g1: local },
      groupList: [{
        id: 'g1', name: 'Trip', topic: 'g1', createdAt: local.meta.createdAt,
        state: local.meta.state, memberCount: 2, currency: 'USD',
      }],
    } as never);

    useGroupsStore.getState().mergeRemoteDocument('g1', local);
    await flushMicrotasks();
    expect(broadcastDocument).not.toHaveBeenCalled();
  });
});

// merges must persist group metadata as well as documents
describe('mergeRemoteDocument persists group metadata', () => {
  it('uses saveDocumentAndGroup for an existing group', () => {
    const local = makeDoc();
    useGroupsStore.setState({
      documents: { g1: local },
      groupList: [{
        id: 'g1', name: 'Trip', topic: 'g1', createdAt: local.meta.createdAt,
        state: local.meta.state, memberCount: 2, currency: 'USD',
      }],
    } as never);

    // Remote renamed the group and added a third member.
    const remote = JSON.parse(JSON.stringify(local)) as GroupDocument;
    remote.meta.name = 'Renamed Trip';
    remote.members['peer-c'] = {
      peerId: 'peer-c', displayName: 'User C', avatar: '',
      joinedAt: new Date().toISOString(),
    } as never;
    remote.version = (local.version || 0) + 1;

    useGroupsStore.getState().mergeRemoteDocument('g1', remote);

    // A bare saveDocument() leaves db.groups holding the old name and
    // memberCount, so loadGroups() returns stale data after a restart.
    expect(saveDocumentAndGroup).toHaveBeenCalled();
    const [, , group] = saveDocumentAndGroup.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(group.name).toBe('Renamed Trip');
    expect(group.memberCount).toBe(3);
  });

  it('still uses saveDocumentAndGroup for a brand-new group', () => {
    useGroupsStore.getState().mergeRemoteDocument('g2', makeDoc('g2'));
    expect(saveDocumentAndGroup).toHaveBeenCalled();
  });
});
