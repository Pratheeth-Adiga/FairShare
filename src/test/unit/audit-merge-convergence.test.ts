// Regression coverage for commutative, convergent document merges.
import { describe, it, expect } from 'vitest';
import { mergeDocuments } from '@/lib/crdt/merge';
import {
  addExpense, deleteExpense, addComment, deleteComment, editExpense,
  changeGroupState, updateGroupSettings,
} from '@/lib/crdt/operations';
import { createGroupDocument } from '@/lib/crdt/document';
import { groupDocumentSchema } from '@/lib/validation/schemas';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';
import type { GroupDocument } from '@/lib/crdt/document';
import type { Expense } from '@/types';

function baseDoc(): GroupDocument {
  const doc = createGroupDocument('g1', 'Trip', 'peer-a', 'Alice', DEFAULT_GROUP_SETTINGS);
  doc.members['peer-b'] = {
    peerId: 'peer-b', displayName: 'Bob', avatar: '', joinedAt: '2026-01-01T00:00:00Z',
  };
  return doc;
}

function makeExpense(over: Partial<Expense> = {}): Expense {
  return {
    id: 'e1', groupId: 'g1', friendId: null, description: 'Dinner',
    totalAmount: 10000, currency: 'USD',
    payers: [{ userId: 'peer-a', amount: 10000 }],
    splitType: 'equal',
    splits: [{ userId: 'peer-a', amount: 5000 }, { userId: 'peer-b', amount: 5000 }],
    items: [], category: 'food', date: '2026-01-15',
    createdAt: '2026-01-15T00:00:00Z', createdBy: 'peer-a', notes: '',
    ...over,
  };
}

describe('tombstones keep the LATEST deletion and converge', () => {
  const withTombstone = (at: string): GroupDocument => ({ ...baseDoc(), deleted: { X: at } });
  const withExpense = (updatedAt: string): GroupDocument => ({
    ...baseDoc(),
    expenses: { X: makeExpense({ id: 'X', updatedAt }) },
  });

  it('three-way merge reaches the same answer in either order', () => {
    // The newest tombstone must win regardless of merge association.
    const A = withTombstone('2026-01-01T00:00:00Z');
    const B = withTombstone('2026-01-03T00:00:00Z');
    const C = withExpense('2026-01-02T00:00:00Z');

    const order1 = mergeDocuments(mergeDocuments(A, B), C);
    const order2 = mergeDocuments(mergeDocuments(B, C), A);

    expect(Object.keys(order1.expenses)).toEqual(Object.keys(order2.expenses));
    expect(Object.keys(order1.expenses)).not.toContain('X');
    expect(order1.deleted['X']).toBe(order2.deleted['X']);
  });

  it('a re-add that postdates the newest deletion still wins (add-wins intact)', () => {
    const deleted = withTombstone('2026-01-01T00:00:00Z');
    const readded = withExpense('2026-06-01T00:00:00Z');
    expect(Object.keys(mergeDocuments(deleted, readded).expenses)).toContain('X');
    expect(Object.keys(mergeDocuments(readded, deleted).expenses)).toContain('X');
  });

  it('a malformed tombstone timestamp does not depend on merge order', () => {
    const bad = { ...baseDoc(), deleted: { Y: 'not-a-date' } };
    const good = { ...baseDoc(), deleted: { Y: '2026-01-01T00:00:00.000Z' } };
    expect(mergeDocuments(bad, good).deleted['Y'])
      .toBe(mergeDocuments(good, bad).deleted['Y']);
    // and a valid stamp must beat an unparseable one
    expect(mergeDocuments(bad, good).deleted['Y']).toBe('2026-01-01T00:00:00.000Z');
  });
});

describe('group state can actually be archived', () => {
  it('a stamped archive is not reverted by an unstamped peer', () => {
    // Fixed priority ranked `active` above `archived`, so the next sync with any
    // peer that had not archived silently reopened the group - and addExpense's
    // `state !== active` lock never engaged anywhere.
    const archived = changeGroupState(baseDoc(), 'archived');
    expect(mergeDocuments(baseDoc(), archived).meta.state).toBe('archived');
    expect(mergeDocuments(archived, baseDoc()).meta.state).toBe('archived');
  });

  it('closing then reopening converges on the later write, in either order', () => {
    const closed = changeGroupState(baseDoc(), 'closed');
    closed.meta.stateUpdatedAt = '2026-01-01T00:00:00Z';
    const reopened = changeGroupState(baseDoc(), 'active');
    reopened.meta.stateUpdatedAt = '2026-06-01T00:00:00Z';
    expect(mergeDocuments(closed, reopened).meta.state).toBe('active');
    expect(mergeDocuments(reopened, closed).meta.state).toBe('active');
  });

  it('stateUpdatedAt survives the persistence/wire schema', () => {
    const archived = changeGroupState(baseDoc(), 'archived');
    const parsed = groupDocumentSchema.safeParse(JSON.parse(JSON.stringify(archived)));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.meta.stateUpdatedAt).toBe(archived.meta.stateUpdatedAt);
  });
});

describe('unstamped metadata conflicts converge instead of ping-ponging', () => {
  const withCurrency = (c: string): GroupDocument => {
    const d = baseDoc();
    return { ...d, meta: { ...d.meta, settings: { ...DEFAULT_GROUP_SETTINGS, defaultCurrency: c } } };
  };

  it('two unstamped settings blocks resolve to the same winner on both peers', () => {
    // The rule was `remoteAt >= localAt ? remote : local`, which is not
    // commutative. Peer 1 computed merge(USD, EUR) = EUR while peer 2 computed
    // merge(EUR, USD) = USD; they exchanged again and swapped back, forever.
    const L = withCurrency('USD');
    const R = withCurrency('EUR');
    expect(mergeDocuments(L, R).meta.settings.defaultCurrency)
      .toBe(mergeDocuments(R, L).meta.settings.defaultCurrency);
  });

  it('two unstamped names resolve to the same winner on both peers', () => {
    const L = baseDoc();
    const R = { ...baseDoc(), meta: { ...baseDoc().meta, name: 'Other Name' } };
    expect(mergeDocuments(L, R).meta.name).toBe(mergeDocuments(R, L).meta.name);
  });

  it('a stamped settings change still beats an unstamped one', () => {
    const stamped = updateGroupSettings(baseDoc(), { defaultCurrency: 'GBP' });
    expect(mergeDocuments(withCurrency('USD'), stamped).meta.settings.defaultCurrency).toBe('GBP');
    expect(mergeDocuments(stamped, withCurrency('USD')).meta.settings.defaultCurrency).toBe('GBP');
  });

  it('the later of two stamped settings changes wins, in either order', () => {
    const older = updateGroupSettings(baseDoc(), { defaultCurrency: 'EUR' });
    older.meta.settingsUpdatedAt = '2026-01-01T00:00:00Z';
    const newer = updateGroupSettings(baseDoc(), { defaultCurrency: 'GBP' });
    newer.meta.settingsUpdatedAt = '2026-06-01T00:00:00Z';
    expect(mergeDocuments(older, newer).meta.settings.defaultCurrency).toBe('GBP');
    expect(mergeDocuments(newer, older).meta.settings.defaultCurrency).toBe('GBP');
  });
});

describe('comments survive a concurrent edit to the same expense', () => {
  const at = (iso: string) => new Date(iso).getTime();

  it('adding a comment re-stamps updatedAt', () => {
    // Without a fresh stamp, pickLatest compared the OLD updatedAt, so any
    // concurrent edit to another field won the merge and took the comment with
    // Deleting it on both peers.
    const withExp = addExpense(baseDoc(), makeExpense({ updatedAt: '2026-02-01T10:00:00Z' }));
    const commented = addComment(withExp, 'e1', {
      id: 'c1', authorId: 'peer-a', text: 'Split was wrong', createdAt: '2026-02-01T13:00:00Z',
    });
    expect(at(commented.expenses['e1'].updatedAt!)).toBeGreaterThan(at('2026-02-01T10:00:00Z'));
  });

  it('a comment beats an older concurrent description edit, in either order', () => {
    const start = addExpense(baseDoc(), makeExpense({ updatedAt: '2026-02-01T10:00:00Z' }));
    const withComment = addComment(start, 'e1', {
      id: 'c1', authorId: 'peer-a', text: 'Note', createdAt: '2026-02-01T13:00:00Z',
    });
    const edited = { ...start };
    edited.expenses = { e1: { ...start.expenses['e1'], description: 'Renamed', updatedAt: '2026-02-01T12:00:00Z' } };

    expect(mergeDocuments(withComment, edited).expenses['e1'].comments).toHaveLength(1);
    expect(mergeDocuments(edited, withComment).expenses['e1'].comments).toHaveLength(1);
  });

  it('deleting a comment re-stamps too, so the deletion is not resurrected', () => {
    let doc = addExpense(baseDoc(), makeExpense({ updatedAt: '2026-02-01T10:00:00Z' }));
    doc = addComment(doc, 'e1', {
      id: 'c1', authorId: 'peer-a', text: 'spam', createdAt: '2026-02-01T10:30:00Z',
    });
    const spamStamp = doc.expenses['e1'].updatedAt!;
    const cleaned = deleteComment(doc, 'e1', 'c1');
    expect(at(cleaned.expenses['e1'].updatedAt!)).toBeGreaterThanOrEqual(at(spamStamp));

    const concurrent = { ...doc };
    concurrent.expenses = { e1: { ...doc.expenses['e1'], description: 'Edited', updatedAt: '2026-02-01T10:45:00Z' } };
    expect(mergeDocuments(cleaned, concurrent).expenses['e1'].comments).toHaveLength(0);
    expect(mergeDocuments(concurrent, cleaned).expenses['e1'].comments).toHaveLength(0);
  });

  it('an ordinary edit still wins over an older comment', () => {
    let doc = addExpense(baseDoc(), makeExpense({ updatedAt: '2026-02-01T10:00:00Z' }));
    doc = addComment(doc, 'e1', {
      id: 'c1', authorId: 'peer-a', text: 'old', createdAt: '2026-02-01T10:30:00Z',
    });
    // Give the edit an explicitly later stamp: addComment and editExpense both
    // call Date.now(), so back-to-back calls land in the same millisecond and
    // pickLatest correctly falls through to its deterministic content tiebreak.
    const later = editExpense(doc, 'e1', { description: 'Final' });
    later.expenses['e1'] = { ...later.expenses['e1'], updatedAt: '2027-01-01T00:00:00Z' };
    expect(mergeDocuments(doc, later).expenses['e1'].description).toBe('Final');
    expect(mergeDocuments(later, doc).expenses['e1'].description).toBe('Final');
  });
});

describe('splitInputs survives validation', () => {
  it('preserves raw share weights through the document schema', () => {
    // expenseSchema had no splitInputs key and Zod strips unknown keys, so the
    // field was deleted on every IndexedDB load, every P2P ingest and every
    // backup import. Editing a 1:3 split and re-saving silently made it 1:1.
    const doc = addExpense(baseDoc(), makeExpense({
      splitType: 'shares',
      splits: [{ userId: 'peer-a', amount: 2500 }, { userId: 'peer-b', amount: 7500 }],
      splitInputs: { 'peer-a': 1, 'peer-b': 3 },
    }));
    const parsed = groupDocumentSchema.safeParse(JSON.parse(JSON.stringify(doc)));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.expenses['e1'].splitInputs).toEqual({ 'peer-a': 1, 'peer-b': 3 });
  });

  it('still accepts expenses that carry no splitInputs', () => {
    const doc = addExpense(baseDoc(), makeExpense());
    expect(groupDocumentSchema.safeParse(JSON.parse(JSON.stringify(doc))).success).toBe(true);
  });

  it('rejects non-finite weights at the boundary', () => {
    const doc = JSON.parse(JSON.stringify(addExpense(baseDoc(), makeExpense())));
    doc.expenses['e1'].splitInputs = { 'peer-a': null };
    expect(groupDocumentSchema.safeParse(doc).success).toBe(false);
  });
});

describe('deleteExpense/merge interplay is unchanged by the tombstone fix', () => {
  it('a deletion still propagates to a peer that has the expense', () => {
    const withExp = addExpense(baseDoc(), makeExpense());
    const deleted = deleteExpense(withExp, 'e1');
    expect(Object.keys(mergeDocuments(withExp, deleted).expenses)).not.toContain('e1');
    expect(Object.keys(mergeDocuments(deleted, withExp).expenses)).not.toContain('e1');
  });
});
