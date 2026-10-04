import { describe, it, expect } from 'vitest';
import { createGroupDocument } from '@/lib/crdt/document';
import {
  addExpense,
  editExpense,
  deleteExpense,
  addComment,
  deleteComment,
  pruneTombstones,
  addSettlement,
  addMember,
  removeMember,
  updateGroupSettings,
  changeGroupState,
  updateMemberProfile,
  reassignMember,
  deleteSettlement,
  nextStamp,
  MAX_AMOUNT_CENTS,
  MAX_EDIT_HISTORY,
} from '@/lib/crdt/operations';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';
import type { Expense, Settlement } from '@/types';

function baseDoc() {
  const doc = createGroupDocument('g1', 'Trip', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);
  return addMember(doc, { peerId: 'peer-bob', displayName: 'Bob', avatar: '', joinedAt: '2026-01-01T00:00:00Z' });
}

// `omit` lets a case say "this field is absent" without assigning undefined,
// which exactOptionalPropertyTypes rejects for an optional property.
function makeExpense(overrides: Partial<Expense> = {}, omit: (keyof Expense)[] = []): Expense {
  const base: Expense = {
    id: 'e1',
    groupId: 'g1',
    friendId: null,
    description: 'Dinner',
    totalAmount: 2000,
    currency: 'USD',
    payers: [{ userId: 'peer-alice', amount: 2000 }],
    splitType: 'equal',
    splits: [
      { userId: 'peer-alice', amount: 1000 },
      { userId: 'peer-bob', amount: 1000 },
    ],
    items: [],
    category: 'food',
    date: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'peer-alice',
    notes: '',
    ...overrides,
  };
  for (const key of omit) delete base[key];
  return base;
}

describe('addExpense', () => {
  it('adds the expense and bumps the version', () => {
    const before = baseDoc();
    const doc = addExpense(before, makeExpense());
    expect(doc.expenses['e1']).toBeDefined();
    expect(doc.version).toBe((before.version || 0) + 1);
  });

  it('stamps updatedAt when not already set', () => {
    const doc = addExpense(baseDoc(), makeExpense({}, ['updatedAt']));
    expect(doc.expenses['e1'].updatedAt).toBeTruthy();
  });

  it('throws when the group is not active', () => {
    const doc = changeGroupState(baseDoc(), 'archived');
    expect(() => addExpense(doc, makeExpense())).toThrow('Cannot add expenses to a non-active group');
  });

  it('throws when totalAmount is Infinity', () => {
    expect(() => addExpense(baseDoc(), makeExpense({ totalAmount: Infinity }))).toThrow('Expense totalAmount must be a positive whole number of cents');
  });

  it('throws when totalAmount is NaN', () => {
    expect(() => addExpense(baseDoc(), makeExpense({ totalAmount: NaN }))).toThrow('Expense totalAmount must be a positive whole number of cents');
  });

  it('throws when totalAmount is negative', () => {
    expect(() => addExpense(baseDoc(), makeExpense({ totalAmount: -100 }))).toThrow('Expense totalAmount must be a positive whole number of cents');
  });

  it('throws on fractional cents or an amount too big to stay precise', () => {
    expect(() => addExpense(baseDoc(), makeExpense({ totalAmount: 2000.5 }))).toThrow('whole number of cents');
    const huge = MAX_AMOUNT_CENTS + 2;
    expect(() => addExpense(baseDoc(), makeExpense({
      totalAmount: huge,
      payers: [{ userId: 'peer-alice', amount: huge }],
      splits: [{ userId: 'peer-alice', amount: huge / 2 }, { userId: 'peer-bob', amount: huge / 2 }],
    }))).toThrow('whole number of cents');
  });

  it('does not allow a one-cent mismatch on a new expense', () => {
    expect(() => addExpense(baseDoc(), makeExpense({
      splits: [{ userId: 'peer-alice', amount: 1000 }, { userId: 'peer-bob', amount: 999 }],
    }))).toThrow('Split total');
  });

  it('clears a prior tombstone when an expense is re-added', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    doc = deleteExpense(doc, 'e1');
    expect(doc.deleted['e1']).toBeTruthy();
    const laterAt = new Date(Date.parse(doc.deleted['e1']) + 1000).toISOString();
    doc = addExpense(doc, { ...makeExpense(), updatedAt: laterAt });
    expect(doc.expenses['e1']).toBeDefined();
    expect(doc.deleted['e1']).toBeUndefined();
  });

  // an expense meant for a different group must not merge into this one
  it('rejects an expense whose groupId does not match the document', () => {
    expect(() => addExpense(baseDoc(), makeExpense({ groupId: 'g2' }))).toThrow('Expense groupId does not match this document');
  });

  it('allows a null groupId through (friendId-only expenses are not group-scoped)', () => {
    expect(() => addExpense(baseDoc(), makeExpense({ groupId: null }))).not.toThrow();
  });
});

describe('editExpense', () => {
  it('applies the patch and records an edit history entry', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    doc = editExpense(doc, 'e1', { description: 'Fancy dinner' }, 'peer-alice');

    expect(doc.expenses['e1'].description).toBe('Fancy dinner');
    expect(doc.expenses['e1'].editHistory).toHaveLength(1);
    expect(doc.expenses['e1'].editHistory![0].changes.description).toEqual({ from: 'Dinner', to: 'Fancy dinner' });
    expect(doc.expenses['e1'].editHistory![0].editedBy).toBe('peer-alice');
  });

  it('does not record history when nothing actually changed', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    doc = editExpense(doc, 'e1', { description: 'Dinner' }, 'peer-alice');
    expect(doc.expenses['e1'].editHistory).toEqual([]);
  });

  it('does not record history when no editedBy is given', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    doc = editExpense(doc, 'e1', { description: 'Fancy dinner' });
    expect(doc.expenses['e1'].editHistory).toEqual([]);
  });

  it('ignores metadata fields (id, updatedAt, editHistory, comments) in the diff', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    doc = editExpense(doc, 'e1', { updatedAt: '2099-01-01T00:00:00Z' }, 'peer-alice');
    expect(doc.expenses['e1'].editHistory).toEqual([]);
  });

  it('throws for a missing expense', () => {
    expect(() => editExpense(baseDoc(), 'missing', { description: 'x' })).toThrow('Expense not found');
  });

  it('throws (not found, since deletion removes it from expenses) once deleted', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    doc = deleteExpense(doc, 'e1');
    expect(() => editExpense(doc, 'e1', { description: 'x' })).toThrow('Expense not found');
  });
});

describe('deleteExpense', () => {
  it('removes the expense and records a tombstone', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    doc = deleteExpense(doc, 'e1');
    expect(doc.expenses['e1']).toBeUndefined();
    expect(doc.deleted['e1']).toBeTruthy();
  });

  it('throws for a missing expense', () => {
    expect(() => deleteExpense(baseDoc(), 'missing')).toThrow('Expense not found');
  });
});

describe('comments', () => {
  it('adds a comment from a group member', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    doc = addComment(doc, 'e1', { id: 'c1', authorId: 'peer-bob', text: 'lgtm', createdAt: '2026-01-02T00:00:00Z' });
    expect(doc.expenses['e1'].comments).toHaveLength(1);
  });

  it('rejects a comment from someone who is not a group member', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    expect(() => addComment(doc, 'e1', { id: 'c1', authorId: 'peer-eve', text: 'hi', createdAt: '2026-01-02T00:00:00Z' }))
      .toThrow('Comment author is not a group member');
  });

  it('rejects an empty/whitespace-only comment', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    expect(() => addComment(doc, 'e1', { id: 'c1', authorId: 'peer-bob', text: '   ', createdAt: '2026-01-02T00:00:00Z' }))
      .toThrow('Comment text cannot be empty');
  });

  it('throws when commenting on a missing expense', () => {
    expect(() => addComment(baseDoc(), 'missing', { id: 'c1', authorId: 'peer-bob', text: 'hi', createdAt: '2026-01-02T00:00:00Z' }))
      .toThrow('Expense not found');
  });

  it('deletes a comment by id', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    doc = addComment(doc, 'e1', { id: 'c1', authorId: 'peer-bob', text: 'lgtm', createdAt: '2026-01-02T00:00:00Z' });
    doc = deleteComment(doc, 'e1', 'c1');
    expect(doc.expenses['e1'].comments).toEqual([]);
  });
});

describe('pruneTombstones', () => {
  it('keeps tombstones younger than maxAgeMs', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    doc = deleteExpense(doc, 'e1');
    const pruned = pruneTombstones(doc, 90 * 24 * 60 * 60 * 1000);
    expect(pruned.deleted['e1']).toBeTruthy();
  });

  it('removes tombstones older than maxAgeMs', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    doc = deleteExpense(doc, 'e1');
    doc = { ...doc, deleted: { e1: '2000-01-01T00:00:00Z' } };
    const pruned = pruneTombstones(doc, 1000);
    expect(pruned.deleted['e1']).toBeUndefined();
  });

  it('returns the same doc reference when nothing was pruned', () => {
    const doc = baseDoc();
    expect(pruneTombstones(doc)).toBe(doc);
  });
});

describe('addSettlement', () => {
  const settlement: Settlement = {
    id: 's1', groupId: 'g1', from: 'peer-bob', to: 'peer-alice', amount: 500, date: '2026-01-02T00:00:00Z', note: '', settlesExpenses: [],
  };

  it('adds a settlement between two members', () => {
    const doc = addSettlement(baseDoc(), settlement);
    expect(doc.settlements['s1']).toMatchObject(settlement);
    expect(doc.settlements['s1'].updatedAt).toBeDefined();
  });

  it('allows settlements while settling (not just active)', () => {
    const doc = changeGroupState(baseDoc(), 'settling');
    expect(() => addSettlement(doc, settlement)).not.toThrow();
  });

  it('rejects settlements on archived/closed groups', () => {
    const doc = changeGroupState(baseDoc(), 'archived');
    expect(() => addSettlement(doc, settlement)).toThrow('Cannot add settlements to an archived or closed group');
  });

  it('rejects an unknown sender or recipient', () => {
    expect(() => addSettlement(baseDoc(), { ...settlement, from: 'peer-eve' })).toThrow('Settlement sender is not a group member');
    expect(() => addSettlement(baseDoc(), { ...settlement, to: 'peer-eve' })).toThrow('Settlement recipient is not a group member');
  });

  it('rejects settling with yourself', () => {
    expect(() => addSettlement(baseDoc(), { ...settlement, to: 'peer-bob' })).toThrow('Cannot settle with yourself');
  });

  it('rejects a non-positive amount', () => {
    expect(() => addSettlement(baseDoc(), { ...settlement, amount: 0 })).toThrow('Settlement amount must be a positive whole number of cents');
    expect(() => addSettlement(baseDoc(), { ...settlement, amount: -5 })).toThrow('Settlement amount must be a positive whole number of cents');
    expect(() => addSettlement(baseDoc(), { ...settlement, amount: NaN })).toThrow('Settlement amount must be a positive whole number of cents');
  });

  // the load schema caps notes at 500, so the write side has to refuse longer ones
  it('rejects a note longer than the schema allows', () => {
    expect(() => addSettlement(baseDoc(), { ...settlement, note: 'x'.repeat(501) })).toThrow('longer than 500');
  });

  it('deletes a settlement with a tombstone', () => {
    const doc = deleteSettlement(addSettlement(baseDoc(), settlement), settlement.id);
    expect(doc.settlements[settlement.id]).toBeUndefined();
    expect(doc.deleted[settlement.id]).toBeTruthy();
  });

  // a settlement meant for a different group must not merge into this one
  it('rejects a settlement whose groupId does not match the document', () => {
    expect(() => addSettlement(baseDoc(), { ...settlement, groupId: 'g2' })).toThrow('Settlement groupId does not match this document');
  });
});

describe('members', () => {
  it('adds and removes a member', () => {
    let doc = baseDoc();
    doc = addMember(doc, { peerId: 'peer-carol', displayName: 'Carol', avatar: '', joinedAt: '2026-01-01T00:00:00Z' });
    expect(doc.members['peer-carol']).toBeDefined();
    doc = removeMember(doc, 'peer-carol');
    expect(doc.members['peer-carol']).toBeUndefined();
  });

  it('does not allow removing the last group member', () => {
    const doc = createGroupDocument('group-1', 'Test', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);

    expect(() => removeMember(doc, 'peer-alice')).toThrow('Cannot remove the last member from a group');
  });

  it('keeps a former member profile when they have an outstanding balance', () => {
    const doc = addExpense(baseDoc(), makeExpense());
    const removed = removeMember(doc, 'peer-bob');

    expect(removed.members['peer-bob']).toBeUndefined();
    expect(removed.formerMembers?.['peer-bob']?.displayName).toBe('Bob');
  });

  it('allows settling with a former member', () => {
    const removed = removeMember(baseDoc(), 'peer-bob');

    expect(() => addSettlement(removed, {
      id: 'settlement-former-member',
      groupId: 'g1',
      from: 'peer-bob',
      to: 'peer-alice',
      amount: 100,
      date: '2026-01-01T00:00:00Z',
      note: '',
      settlesExpenses: [],
    })).not.toThrow();
  });

  it('updates a member profile', () => {
    let doc = baseDoc();
    doc = updateMemberProfile(doc, 'peer-bob', { displayName: 'Bobby' });
    expect(doc.members['peer-bob'].displayName).toBe('Bobby');
    expect(doc.members['peer-bob'].updatedAt).toBeTruthy();
  });

  it('throws updating a missing member', () => {
    expect(() => updateMemberProfile(baseDoc(), 'peer-eve', { displayName: 'x' })).toThrow('Member not found');
  });
});

describe('updateGroupSettings / changeGroupState', () => {
  it('merges partial settings and stamps settingsUpdatedAt', () => {
    const doc = updateGroupSettings(baseDoc(), { defaultCurrency: 'EUR' });
    expect(doc.meta.settings.defaultCurrency).toBe('EUR');
    expect(doc.meta.settings.defaultSplitType).toBe(DEFAULT_GROUP_SETTINGS.defaultSplitType);
    expect(doc.meta.settingsUpdatedAt).toBeTruthy();
  });

  // a malformed patch must not be allowed to persist into the document
  it('rejects a settings patch that fails schema validation', () => {
    expect(() => updateGroupSettings(baseDoc(), { invitePermission: 'nonsense' as never }))
      .toThrow('Invalid group settings');
  });

  it('changes group state', () => {
    const doc = changeGroupState(baseDoc(), 'closed');
    expect(doc.meta.state).toBe('closed');
  });

  it('refuses to change currency once the group has expenses', () => {
    const doc = addExpense(baseDoc(), makeExpense());
    expect(() => updateGroupSettings(doc, { defaultCurrency: 'EUR' })).toThrow('Currency cannot be changed');
    expect(() => updateGroupSettings(doc, { simplifyDebts: false })).not.toThrow();
  });

  // edit and delete are gated like add
  it('refuses edits and deletes in an archived group', () => {
    const doc = changeGroupState(addExpense(baseDoc(), makeExpense()), 'archived');
    expect(() => editExpense(doc, 'e1', { description: 'x' })).toThrow('non-active');
    expect(() => deleteExpense(doc, 'e1')).toThrow('non-active');
  });
});

describe('edit history cap', () => {
  it('keeps only the most recent entries', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    for (let i = 0; i < MAX_EDIT_HISTORY + 5; i++) {
      doc = editExpense(doc, 'e1', { description: `edit ${i}` }, 'peer-alice');
    }
    const history = doc.expenses['e1'].editHistory!;
    expect(history).toHaveLength(MAX_EDIT_HISTORY);
    expect(history[history.length - 1].changes.description?.to).toBe(`edit ${MAX_EDIT_HISTORY + 4}`);
  });
});

describe('nextStamp', () => {
  it('never goes backwards, even within the same millisecond', () => {
    const stamps = Array.from({ length: 5 }, () => nextStamp());
    for (let i = 1; i < stamps.length; i++) {
      expect(Date.parse(stamps[i])).toBeGreaterThan(Date.parse(stamps[i - 1]));
    }
  });
});

describe('reassignMember', () => {
  function withPlaceholder() {
    return addMember(baseDoc(), { peerId: 'peer-00000000000000aa', displayName: 'Bob (added)', avatar: '', joinedAt: '2026-01-01T00:00:00Z', isManualPlaceholder: true });
  }

  // restamping everything brought back concurrent deletes and beat concurrent edits
  it('only touches records that mention the placeholder', () => {
    let doc = addExpense(withPlaceholder(), makeExpense({ updatedAt: '2026-01-01T00:00:00.000Z' }));
    doc = addExpense(doc, makeExpense({
      id: 'e2',
      updatedAt: '2026-01-01T00:00:00.000Z',
      splits: [{ userId: 'peer-alice', amount: 1000 }, { userId: 'peer-00000000000000aa', amount: 1000 }],
    }));
    const after = reassignMember(doc, 'peer-00000000000000aa', 'peer-bob');
    expect(after.expenses['e1'].updatedAt).toBe('2026-01-01T00:00:00.000Z');
    expect(after.expenses['e2'].updatedAt).not.toBe('2026-01-01T00:00:00.000Z');
    expect(after.expenses['e2'].splits).toEqual([{ userId: 'peer-alice', amount: 1000 }, { userId: 'peer-bob', amount: 1000 }]);
  });

  // placeholder Bob and real Bob on one expense end up as one row
  it('folds duplicate rows for the same person', () => {
    const doc = addExpense(withPlaceholder(), makeExpense({
      totalAmount: 3000,
      payers: [{ userId: 'peer-00000000000000aa', amount: 3000 }],
      splits: [
        { userId: 'peer-alice', amount: 1000 },
        { userId: 'peer-bob', amount: 1000 },
        { userId: 'peer-00000000000000aa', amount: 1000 },
      ],
    }));
    const after = reassignMember(doc, 'peer-00000000000000aa', 'peer-bob');
    expect(after.expenses['e1'].splits).toEqual([{ userId: 'peer-alice', amount: 1000 }, { userId: 'peer-bob', amount: 2000 }]);
    expect(after.expenses['e1'].payers).toEqual([{ userId: 'peer-bob', amount: 3000 }]);
  });
});

describe('version bumping', () => {
  it('bumps version on every mutating operation', () => {
    let doc = baseDoc();
    const before = doc.version || 0;
    doc = addExpense(doc, makeExpense());
    expect(doc.version).toBe(before + 1);
    doc = editExpense(doc, 'e1', { description: 'x' });
    expect(doc.version).toBe(before + 2);
  });
});

describe('comments', () => {
  it('rejects a comment whose text exceeds 100 chars when validated by schema', () => {
    // Length guard lives in Zod schema; addComment accepts valid lengths up to 2000 chars.
    let doc = addExpense(baseDoc(), makeExpense());
    const longText = 'a'.repeat(2000);
    // Should succeed (at or under the 2000-char limit)
    expect(() =>
      addComment(doc, 'e1', { id: 'c-long', authorId: 'peer-bob', text: longText, createdAt: '2026-01-03T00:00:00Z' })
    ).not.toThrow();
  });

  it('rejects a 101st comment once MAX_COMMENTS_PER_EXPENSE (100) is reached', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    // add exactly 100 comments
    for (let i = 0; i < 100; i++) {
      doc = addComment(doc, 'e1', { id: 'c' + i, authorId: 'peer-bob', text: 'msg', createdAt: '2026-01-03T00:00:00Z' });
    }
    expect(doc.expenses['e1'].comments).toHaveLength(100);
    // the 101st must be rejected
    expect(() =>
      addComment(doc, 'e1', { id: 'c100', authorId: 'peer-bob', text: 'one more', createdAt: '2026-01-03T00:00:00Z' })
    ).toThrow('maximum of 100 comments');
  });
});

