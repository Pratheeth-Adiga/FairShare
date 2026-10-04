// local mutations must keep document, groupList, and db.groups aligned
import { describe, it, expect, vi, beforeEach } from 'vitest';

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

const flush = () => new Promise(resolve => setTimeout(resolve, 0));

async function seedGroup() {
  useGroupsStore.setState({ documents: {}, groupList: [] } as never);
  const id = await useGroupsStore.getState().createGroup('Trip', 'USD', 'peer-a', 'Alice', 'ab'.repeat(32));
  saveDocument.mockClear();
  saveDocumentAndGroup.mockClear();
  broadcastDocument.mockClear();
  return id;
}

beforeEach(() => {
  saveDocument.mockClear();
  saveDocumentAndGroup.mockClear();
  broadcastDocument.mockClear();
  useGroupsStore.setState({ documents: {}, groupList: [] } as never);
});

describe('createGroup threads the creator public key through', () => {
  it('stores the creator publicKey on their member profile', async () => {
    // CreateGroupDialog has always passed identity.publicKey as a 5th argument,
    // but createGroup only declared four parameters, so it was silently dropped
    // and joiners had no key to verify the creator's signed messages against.
    const id = await seedGroup();
    const doc = useGroupsStore.getState().documents[id];
    expect(doc.members['peer-a'].publicKey).toBe('ab'.repeat(32));
  });

  it('still works when no public key is supplied', async () => {
    const id = await useGroupsStore.getState().createGroup('NoKey', 'USD', 'peer-a', 'Alice');
    expect(useGroupsStore.getState().documents[id].members['peer-a'].publicKey).toBeUndefined();
  });
});

describe('renameGroup keeps all three copies of the name in sync', () => {
  it('updates the CRDT document', async () => {
    const id = await seedGroup();
    useGroupsStore.getState().renameGroup(id, 'Iceland 2026');
    expect(useGroupsStore.getState().documents[id].meta.name).toBe('Iceland 2026');
  });

  it('updates the in-memory groupList that Dashboard renders', async () => {
    const id = await seedGroup();
    useGroupsStore.getState().renameGroup(id, 'Iceland 2026');
    expect(useGroupsStore.getState().groupList.find(g => g.id === id)?.name).toBe('Iceland 2026');
  });

  it('persists db.groups, not just db.documents', async () => {
    const id = await seedGroup();
    useGroupsStore.getState().renameGroup(id, 'Iceland 2026');
    // A bare saveDocument() would leave loadGroups() returning the old name.
    expect(saveDocumentAndGroup).toHaveBeenCalled();
    const [, , group] = saveDocumentAndGroup.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(group.name).toBe('Iceland 2026');
  });

  it('stamps nameUpdatedAt so the rename can win a merge on other peers', async () => {
    const id = await seedGroup();
    useGroupsStore.getState().renameGroup(id, 'Iceland 2026');
    expect(useGroupsStore.getState().documents[id].meta.nameUpdatedAt).toBeTruthy();
  });

  it('gossips the rename to peers', async () => {
    const id = await seedGroup();
    useGroupsStore.getState().renameGroup(id, 'Iceland 2026');
    await flush();
    expect(broadcastDocument).toHaveBeenCalledWith(id);
  });

  it('is a no-op for an unknown group instead of throwing', () => {
    expect(() => useGroupsStore.getState().renameGroup('nope', 'X')).not.toThrow();
  });
});

describe('changeState keeps the persisted group state in sync', () => {
  it('updates the document and the groupList entry', async () => {
    const id = await seedGroup();
    useGroupsStore.getState().changeState(id, 'archived');
    expect(useGroupsStore.getState().documents[id].meta.state).toBe('archived');
    expect(useGroupsStore.getState().groupList.find(g => g.id === id)?.state).toBe('archived');
  });

  it('persists db.groups so the archive survives a restart', async () => {
    const id = await seedGroup();
    useGroupsStore.getState().changeState(id, 'archived');
    expect(saveDocumentAndGroup).toHaveBeenCalled();
    const [, , group] = saveDocumentAndGroup.mock.calls[0] as [string, string, Record<string, unknown>];
    expect(group.state).toBe('archived');
  });
});
