// shared expense-form state transitions
import { describe, it, expect } from 'vitest';
import {
  SPLIT_TYPES,
  ITEMIZED_SPLIT_TYPE,
  WEIGHTED_SPLIT_TYPES,
  expenseFormReducer,
  createInitialExpenseFormState,
  expenseFormStateFromExpense,
} from '@/lib/forms/expense-form';
import type { ExpenseFormState } from '@/lib/forms/expense-form';
import type { Expense } from '@/types';

function makeExpense(over: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-1', groupId: 'g1', friendId: null, description: 'Dinner',
    totalAmount: 10000, currency: 'USD',
    payers: [{ userId: 'peer-a', amount: 10000 }],
    splitType: 'equal',
    splits: [{ userId: 'peer-a', amount: 5000 }, { userId: 'peer-b', amount: 5000 }],
    items: [], category: 'food', date: '2026-01-15',
    createdAt: '2026-01-15T10:00:00.000Z', createdBy: 'peer-a', notes: '',
    ...over,
  };
}

const blank = () => createInitialExpenseFormState('peer-a', '2026-03-04');

describe('date is kept as a bare YYYY-MM-DD string', () => {
  it('hydrates a bare date unchanged', () => {
    expect(expenseFormStateFromExpense(makeExpense({ date: '2026-01-15' })).date)
      .toBe('2026-01-15');
  });

  it('normalises a legacy full ISO timestamp down to the calendar day', () => {
    // Rows written by the old EditExpense look like this. They must load into
    // the date input as a plain day, not as an ISO string the input rejects.
    expect(expenseFormStateFromExpense(makeExpense({ date: '2026-01-15T12:00:00.000Z' })).date)
      .toBe('2026-01-15');
  });

  it('produces a value the HTML date input accepts (exactly 10 chars)', () => {
    const { date } = expenseFormStateFromExpense(makeExpense({ date: '2026-01-15T12:00:00.000Z' }));
    expect(date).toHaveLength(10);
    expect(date).toMatch(/^\d{4}-\d{2}-\d{2}$/);
  });

  it('round-trips: hydrating an already-edited expense is a fixed point', () => {
    const once = expenseFormStateFromExpense(makeExpense({ date: '2026-01-15' })).date;
    const twice = expenseFormStateFromExpense(makeExpense({ date: once })).date;
    expect(twice).toBe(once);
  });
});

describe('split types reachable from the UI', () => {
  it('offers by_weight, which calculateSplits has always implemented', () => {
    expect(SPLIT_TYPES.map(s => s.value)).toContain('by_weight');
  });

  it('offers the four original types too', () => {
    for (const t of ['equal', 'exact', 'percentage', 'shares']) {
      expect(SPLIT_TYPES.map(s => s.value)).toContain(t);
    }
  });

  it('does NOT offer itemized for new expenses (no item editor exists yet)', () => {
    expect(SPLIT_TYPES.map(s => s.value)).not.toContain('itemized');
  });

  it('exposes itemized separately so an existing itemized expense renders truthfully', () => {
    // Without this the select would show "Equal" while state said "itemized",
    // and saving would silently destroy the item breakdown.
    expect(ITEMIZED_SPLIT_TYPE.value).toBe('itemized');
  });

  it('treats shares and by_weight as the same weighted input family', () => {
    expect(WEIGHTED_SPLIT_TYPES).toEqual(['shares', 'by_weight']);
  });

  it('hydrates by_weight expenses from splitInputs like shares', () => {
    const state = expenseFormStateFromExpense(makeExpense({
      splitType: 'by_weight',
      splitInputs: { 'peer-a': 3, 'peer-b': 1 },
    }));
    expect(state.shares).toEqual({ 'peer-a': '3', 'peer-b': '1' });
  });
});

describe('hydration from an existing expense', () => {
  it('fills the scalar fields', () => {
    const s = expenseFormStateFromExpense(makeExpense({ description: 'Taxi', notes: 'airport' }));
    expect(s.description).toBe('Taxi');
    expect(s.notes).toBe('airport');
    expect(s.amount).toBe('100.00');
  });

  it('records which expense it was hydrated from', () => {
    expect(expenseFormStateFromExpense(makeExpense({ id: 'exp-9' })).loadedExpenseId).toBe('exp-9');
  });

  it('prefers the categories array over the single legacy category field', () => {
    expect(expenseFormStateFromExpense(makeExpense({
      category: 'food', categories: ['travel', 'fun'],
    })).categories).toEqual(['travel', 'fun']);
  });

  it('falls back to the single category when the array is absent or empty', () => {
    expect(expenseFormStateFromExpense(makeExpense({ category: 'food' })).categories).toEqual(['food']);
    expect(expenseFormStateFromExpense(makeExpense({ category: 'food', categories: [] })).categories)
      .toEqual(['food']);
  });

  it('detects a single payer', () => {
    const s = expenseFormStateFromExpense(makeExpense());
    expect(s.multiPayer).toBe(false);
    expect(s.payerId).toBe('peer-a');
  });

  it('detects multiple payers and converts cents to decimal strings', () => {
    const s = expenseFormStateFromExpense(makeExpense({
      payers: [{ userId: 'peer-a', amount: 6000 }, { userId: 'peer-b', amount: 4000 }],
    }));
    expect(s.multiPayer).toBe(true);
    expect(s.payerAmounts).toEqual({ 'peer-a': '60.00', 'peer-b': '40.00' });
  });

  it('restores exact amounts', () => {
    const s = expenseFormStateFromExpense(makeExpense({
      splitType: 'exact',
      splits: [{ userId: 'peer-a', amount: 7500 }, { userId: 'peer-b', amount: 2500 }],
    }));
    expect(s.exactAmounts).toEqual({ 'peer-a': '75.00', 'peer-b': '25.00' });
  });

  it('restores percentages', () => {
    const s = expenseFormStateFromExpense(makeExpense({
      splitType: 'percentage',
      splits: [{ userId: 'peer-a', amount: 7500 }, { userId: 'peer-b', amount: 2500 }],
    }));
    expect(s.percentages).toEqual({ 'peer-a': '75', 'peer-b': '25' });
  });

  // 1dp rebuilt 33.34/33.33/33.33 as 33.3 x3, which failed validation
  it('rebuilds older percentage rows precisely enough to still sum to 100', () => {
    const s = expenseFormStateFromExpense(makeExpense({
      splitType: 'percentage',
      totalAmount: 10000,
      splits: [{ userId: 'peer-a', amount: 3334 }, { userId: 'peer-b', amount: 3333 }, { userId: 'peer-c', amount: 3333 }],
    }));
    const total = Object.values(s.percentages).reduce((sum, p) => sum + parseFloat(p), 0);
    expect(Math.abs(total - 100)).toBeLessThan(0.01);
  });

  it('prefers the typed percentages stored in splitInputs', () => {
    const s = expenseFormStateFromExpense(makeExpense({
      splitType: 'percentage',
      splits: [{ userId: 'peer-a', amount: 1234 }, { userId: 'peer-b', amount: 8766 }],
      splitInputs: { 'peer-a': 12.34, 'peer-b': 87.66 },
    }));
    expect(s.percentages).toEqual({ 'peer-a': '12.34', 'peer-b': '87.66' });
  });

  // an old claim could leave one person on two rows
  it('folds duplicate payer and split rows for the same person', () => {
    const s = expenseFormStateFromExpense(makeExpense({
      splitType: 'exact',
      payers: [{ userId: 'peer-a', amount: 5000 }, { userId: 'peer-a', amount: 5000 }],
      splits: [{ userId: 'peer-b', amount: 5000 }, { userId: 'peer-b', amount: 5000 }],
    }));
    expect(s.multiPayer).toBe(false);
    expect(s.payerId).toBe('peer-a');
    expect(s.selectedMembers).toEqual(['peer-b']);
    expect(s.exactAmounts).toEqual({ 'peer-b': '100.00' });
  });

  it('does not emit NaN percentages for a zero-total expense', () => {
    // A corrupted or legacy row with totalAmount 0 would otherwise render the
    // literal string "NaN" into the percentage inputs.
    const s = expenseFormStateFromExpense(makeExpense({
      splitType: 'percentage', totalAmount: 0,
      splits: [{ userId: 'peer-a', amount: 0 }],
    }));
    expect(s.percentages).toEqual({ 'peer-a': '0' });
  });

  it('restores raw share weights from splitInputs', () => {
    const s = expenseFormStateFromExpense(makeExpense({
      splitType: 'shares', splitInputs: { 'peer-a': 2, 'peer-b': 0 },
    }));
    expect(s.shares).toEqual({ 'peer-a': '2', 'peer-b': '0' });
  });

  it('defaults to 1 share for expenses predating splitInputs', () => {
    const s = expenseFormStateFromExpense(makeExpense({ splitType: 'shares' }));
    expect(s.shares).toEqual({ 'peer-a': '1', 'peer-b': '1' });
  });

  it('selects exactly the members named in the splits', () => {
    expect(expenseFormStateFromExpense(makeExpense()).selectedMembers).toEqual(['peer-a', 'peer-b']);
  });
});

describe('reducer transitions', () => {
  const run = (state: ExpenseFormState, ...actions: Parameters<typeof expenseFormReducer>[1][]) =>
    actions.reduce(expenseFormReducer, state);

  it('SET_FIELD updates one field and leaves the rest alone', () => {
    const next = run(blank(), { type: 'SET_FIELD', field: 'description', value: 'Pizza' });
    expect(next.description).toBe('Pizza');
    expect(next.amount).toBe('');
  });

  it('SET_SPLIT_TYPE without resetParams preserves inputs (AddExpense behaviour)', () => {
    const seeded = { ...blank(), exactAmounts: { 'peer-a': '10.00' } };
    const next = run(seeded, { type: 'SET_SPLIT_TYPE', value: 'percentage' });
    expect(next.splitType).toBe('percentage');
    expect(next.exactAmounts).toEqual({ 'peer-a': '10.00' });
  });

  it('SET_SPLIT_TYPE with resetParams clears stale inputs', () => {
    // Without this, amounts typed as "exact" would be reinterpreted as percentages.
    const seeded = {
      ...blank(),
      selectedMembers: ['peer-a', 'peer-b'],
      exactAmounts: { 'peer-a': '10.00', 'peer-b': '90.00' },
    };
    const next = run(seeded, { type: 'SET_SPLIT_TYPE', value: 'percentage', resetParams: true });
    expect(next.exactAmounts).toEqual({ 'peer-a': '', 'peer-b': '' });
    expect(next.percentages).toEqual({ 'peer-a': '', 'peer-b': '' });
  });

  it('SET_SPLIT_TYPE with resetParams seeds weights to 1, never to 0', () => {
    // A total weight of 0 makes calculateSplits return {} - the form would look
    // like it silently dropped everyone from the split.
    const seeded = { ...blank(), selectedMembers: ['peer-a', 'peer-b'] };
    const next = run(seeded, { type: 'SET_SPLIT_TYPE', value: 'shares', resetParams: true });
    expect(next.shares).toEqual({ 'peer-a': '1', 'peer-b': '1' });
  });

  it('SET_MAP_VALUE sets one member without disturbing the others', () => {
    const seeded = { ...blank(), shares: { 'peer-a': '1', 'peer-b': '1' } };
    const next = run(seeded, { type: 'SET_MAP_VALUE', field: 'shares', memberId: 'peer-b', value: '0' });
    expect(next.shares).toEqual({ 'peer-a': '1', 'peer-b': '0' });
  });

  it('TOGGLE_ARRAY_ITEM adds and removes members', () => {
    let s = run(blank(), { type: 'TOGGLE_ARRAY_ITEM', field: 'selectedMembers', value: 'peer-a', checked: true });
    expect(s.selectedMembers).toEqual(['peer-a']);
    s = run(s, { type: 'TOGGLE_ARRAY_ITEM', field: 'selectedMembers', value: 'peer-a', checked: false });
    expect(s.selectedMembers).toEqual([]);
  });

  it('ticking a member into a weighted split gives them a weight', () => {
    // A missing entry parses as 0, so without this the checkbox looks inert.
    const s = run(blank(), { type: 'TOGGLE_ARRAY_ITEM', field: 'selectedMembers', value: 'peer-c', checked: true });
    expect(s.shares['peer-c']).toBe('1');
  });

  it('re-ticking a member does not clobber a weight they already had', () => {
    const seeded = { ...blank(), shares: { 'peer-c': '5' } };
    const s = run(seeded, { type: 'TOGGLE_ARRAY_ITEM', field: 'selectedMembers', value: 'peer-c', checked: true });
    expect(s.shares['peer-c']).toBe('5');
  });

  it('INIT_SELECTED_MEMBERS only seeds an empty selection', () => {
    const seeded = { ...blank(), selectedMembers: ['peer-a'] };
    const s = run(seeded, { type: 'INIT_SELECTED_MEMBERS', memberIds: ['peer-x', 'peer-y'] });
    expect(s.selectedMembers).toEqual(['peer-a']);
  });

  // the payer used to survive when they weren't also in the split
  it('PRUNE_REMOVED_MEMBERS clears a removed payer who was not in the split', () => {
    const seeded = { ...blank(), payerId: 'peer-gone', selectedMembers: ['peer-a'] };
    const s = run(seeded, { type: 'PRUNE_REMOVED_MEMBERS', currentMemberIds: ['peer-a'] });
    expect(s.payerId).toBe('');
    expect(s.selectedMembers).toEqual(['peer-a']);
  });

  it('seeds the split type from the group default', () => {
    expect(createInitialExpenseFormState('peer-a', '2026-01-01', 'shares').splitType).toBe('shares');
    expect(createInitialExpenseFormState('peer-a', '2026-01-01', 'nonsense').splitType).toBe('equal');
  });

  it('INIT_MISSING_SHARES never overwrites a deliberate 0', () => {
    const seeded = { ...blank(), shares: { 'peer-b': '0' } };
    const s = run(seeded, { type: 'INIT_MISSING_SHARES', memberIds: ['peer-a', 'peer-b'] });
    expect(s.shares).toEqual({ 'peer-a': '1', 'peer-b': '0' });
  });

  it('LOAD_EXPENSE replaces the whole form, discarding a previous expense', () => {
    // the router reuses this component when navigating e1/edit -> e2/edit
    const first = run(blank(), { type: 'LOAD_EXPENSE', expense: makeExpense({ id: 'exp-1', description: 'First' }) });
    const second = run(first, { type: 'LOAD_EXPENSE', expense: makeExpense({ id: 'exp-2', description: 'Second' }) });
    expect(second.description).toBe('Second');
    expect(second.loadedExpenseId).toBe('exp-2');
  });

  it('LOAD_EXPENSE clears inputs belonging to the previously loaded split type', () => {
    const exactFirst = run(blank(), {
      type: 'LOAD_EXPENSE',
      expense: makeExpense({ id: 'exp-1', splitType: 'exact' }),
    });
    expect(Object.keys(exactFirst.exactAmounts).length).toBeGreaterThan(0);
    const equalSecond = run(exactFirst, {
      type: 'LOAD_EXPENSE',
      expense: makeExpense({ id: 'exp-2', splitType: 'equal' }),
    });
    expect(equalSecond.exactAmounts).toEqual({});
  });

  it('is pure: it never mutates the state it is given', () => {
    const before = blank();
    const snapshot = JSON.stringify(before);
    expenseFormReducer(before, { type: 'SET_FIELD', field: 'description', value: 'x' });
    expenseFormReducer(before, { type: 'SET_MAP_VALUE', field: 'shares', memberId: 'p', value: '2' });
    expect(JSON.stringify(before)).toBe(snapshot);
  });

  it('ignores an unknown action instead of corrupting state', () => {
    const before = blank();
    expect(expenseFormReducer(before, { type: 'NOPE' } as never)).toBe(before);
  });
});
