import { describe, it, expect } from 'vitest';
import { createGroupDocument } from '@/lib/crdt/document';
import { addMember, removeMember, deleteExpense, addExpense } from '@/lib/crdt/operations';
import { mergeDocuments } from '@/lib/crdt/merge';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';
import type { Expense, MemberProfile } from '@/types';

function makeMember(peerId: string, name: string): MemberProfile {
  return { peerId, displayName: name, avatar: '', joinedAt: '2026-01-01T00:00:00Z' };
}

function makeExpense(id: string): Expense {
  return {
    id,
    groupId: 'g1',
    friendId: null,
    description: id,
    totalAmount: 1000,
    currency: 'USD',
    payers: [{ userId: 'peer-alice', amount: 1000 }],
    splitType: 'equal',
    splits: [
      { userId: 'peer-alice', amount: 500 },
      { userId: 'peer-bob', amount: 500 },
    ],
    items: [],
    category: 'other',
    date: '2026-01-01',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'peer-alice',
    notes: '',
  };
}

// additions after deletion must win during merge
describe('add-after-tombstone survives the next merge (add-wins)', () => {
  it('re-adding a removed member propagates via merge to a peer who still had the removal', () => {
    // 1. Alice creates a group with Charlie.
    let alice = createGroupDocument('g1', 'Trip', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);
    alice = addMember(alice, makeMember('peer-charlie', 'Charlie'));

    // 2. Bob receives a copy.
    let bob = mergeDocuments(
      createGroupDocument('g1', 'Trip', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS),
      alice
    );
    expect(bob.members['peer-charlie']).toBeDefined();

    // 3. Alice removes Charlie (tombstone).
    alice = removeMember(alice, 'peer-charlie');
    expect(alice.deleted['peer-charlie']).toBeTruthy();

    // 4. Bob sees the removal.
    bob = mergeDocuments(bob, alice);
    expect(bob.members['peer-charlie']).toBeUndefined();
    expect(bob.deleted['peer-charlie']).toBeTruthy();

    // 5. Alice re-adds Charlie. Pass an explicit updatedAt strictly later than
    // the tombstone so the add-wins comparison is deterministic in a single tick.
    const tombstoneAt = alice.deleted['peer-charlie'];
    const laterAt = new Date(Date.parse(tombstoneAt) + 1000).toISOString();
    alice = addMember(alice, { ...makeMember('peer-charlie', 'Charlie'), updatedAt: laterAt });
    // Local tombstone is cleared immediately by addMember.
    expect(alice.members['peer-charlie']).toBeDefined();
    expect(alice.deleted['peer-charlie']).toBeUndefined();

    // 6. Merge back into Bob: the re-add must survive (add-wins).
    bob = mergeDocuments(bob, alice);
    expect(bob.members['peer-charlie']).toBeDefined();
    // And the stale tombstone is dropped, so a future merge cannot resurrect the deletion.
    expect(bob.deleted['peer-charlie']).toBeUndefined();
  });

  it('re-adding a deleted expense keeps it after a merge round-trip', () => {
    let doc = createGroupDocument('g1', 'Trip', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);
    doc = addMember(doc, makeMember('peer-bob', 'Bob'));
    doc = addExpense(doc, makeExpense('e1'));
    doc = deleteExpense(doc, 'e1');
    expect(doc.deleted['e1']).toBeTruthy();

    // Re-add with an explicit updatedAt after the tombstone.
    const laterAt = new Date(Date.parse(doc.deleted['e1']) + 1000).toISOString();
    doc = addExpense(doc, { ...makeExpense('e1'), updatedAt: laterAt });

    // Local tombstone is cleared.
    expect(doc.expenses['e1']).toBeDefined();
    expect(doc.deleted['e1']).toBeUndefined();

    // A merge (against another peer that also has the same doc) preserves the expense.
    const merged = mergeDocuments(doc, doc);
    expect(merged.expenses['e1']).toBeDefined();
    expect(merged.deleted['e1']).toBeUndefined();
  });

  it('when the tombstone is newer than the re-add, the delete still wins', () => {
    // Guards against blindly clearing tombstones: if a peer had a stale
    // pre-tombstone add and then received a more recent removal, the removal
    // must still take effect.
    let alice = createGroupDocument('g1', 'Trip', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);
    const oldAt = '2026-01-01T00:00:00Z';
    const laterAt = '2026-06-01T00:00:00Z';
    alice = addMember(alice, { ...makeMember('peer-charlie', 'Charlie'), updatedAt: oldAt });

    // A peer computed a removal much later than Alice's add. Simulate by
    // hand-crafting a doc that has ONLY the tombstone, no member entry.
    const removalDoc = { ...alice, members: {} as Record<string, MemberProfile>, deleted: { 'peer-charlie': laterAt } };

    const merged = mergeDocuments(alice, removalDoc);
    // The removal is newer than Charlie's updatedAt → tombstone wins.
    expect(merged.members['peer-charlie']).toBeUndefined();
    expect(merged.deleted['peer-charlie']).toBe(laterAt);
  });
});
