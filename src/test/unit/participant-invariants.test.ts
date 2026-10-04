import { describe, it, expect } from 'vitest';
import { createGroupDocument } from '@/lib/crdt/document';
import type { GroupDocument } from '@/lib/crdt/document';
import { addComment, addExpense, addMember, addSettlement, editExpense, removeMember } from '@/lib/crdt/operations';
import { mergeDocuments } from '@/lib/crdt/merge';
import { exportGroupToJSON, importGroupFromJSON } from '@/lib/io/backup';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';
import type { Expense } from '@/types';

function makeExpense(): Expense {
  return {
    id: 'expense-1',
    groupId: 'group-1',
    friendId: null,
    description: 'Dinner',
    totalAmount: 1000,
    currency: 'INR',
    payers: [{ userId: 'peer-alice', amount: 1000 }],
    splitType: 'equal',
    splits: [{ userId: 'peer-alice', amount: 500 }, { userId: 'peer-bob', amount: 500 }],
    items: [],
    category: 'food',
    date: '2026-09-02',
    createdAt: '2026-09-02T00:00:00.000Z',
    createdBy: 'peer-alice',
    notes: '',
  };
}

function makeDocument(): GroupDocument {
  let doc = createGroupDocument('group-1', 'Trip', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);
  doc = addMember(doc, { peerId: 'peer-bob', displayName: 'Bob', avatar: '', joinedAt: '2026-09-02T00:00:00.000Z' });
  doc = addExpense(doc, makeExpense());
  doc = editExpense(doc, 'expense-1', { notes: 'Shared meal' }, 'peer-bob');
  return addComment(doc, 'expense-1', {
    id: 'comment-1', authorId: 'peer-bob', text: 'Thanks', createdAt: '2026-09-02T00:00:00.000Z',
  });
}

function participantIds(doc: GroupDocument): Set<string> {
  const ids = new Set<string>();
  for (const expense of Object.values(doc.expenses)) {
    ids.add(expense.createdBy);
    expense.payers.forEach(payer => ids.add(payer.userId));
    expense.splits.forEach(split => ids.add(split.userId));
    expense.comments?.forEach(comment => ids.add(comment.authorId));
    expense.editHistory?.forEach(record => ids.add(record.editedBy));
  }
  for (const settlement of Object.values(doc.settlements)) {
    ids.add(settlement.from);
    ids.add(settlement.to);
  }
  return ids;
}

function expectParticipantsToResolve(doc: GroupDocument) {
  const profiles = { ...(doc.formerMembers || {}), ...doc.members };
  for (const peerId of participantIds(doc)) {
    expect(profiles[peerId], `missing profile for ${peerId}`).toBeDefined();
  }
}

describe('participant profile invariants', () => {
  it('keeps every historical participant resolvable after member removal', () => {
    let doc = removeMember(makeDocument(), 'peer-bob');
    doc = addSettlement(doc, {
      id: 'settlement-1', groupId: 'group-1', from: 'peer-bob', to: 'peer-alice', amount: 500,
      date: '2026-09-02', note: 'Paid back', settlesExpenses: ['expense-1'],
    });

    expect(doc.members['peer-bob']).toBeUndefined();
    expect(doc.formerMembers?.['peer-bob']?.displayName).toBe('Bob');
    expectParticipantsToResolve(doc);
  });

  it('preserves historical profiles through merge and export/import', () => {
    // one base copy: with monotonic stamps a second makeDocument() is genuinely newer than the removal
    const base = makeDocument();
    const removed = removeMember(base, 'peer-bob');
    const merged = mergeDocuments(base, removed);
    const restored = importGroupFromJSON(exportGroupToJSON(merged));

    expect(restored.formerMembers?.['peer-bob']?.displayName).toBe('Bob');
    expectParticipantsToResolve(restored);
  });
});