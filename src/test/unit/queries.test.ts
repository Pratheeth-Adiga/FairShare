import { describe, it, expect } from 'vitest';
import { createGroupDocument } from '@/lib/crdt/document';
import { addExpense, addMember, addSettlement, deleteExpense } from '@/lib/crdt/operations';
import {
  getExpenses,
  getSettlements,
  getBalances,
  getSimplifiedDebts,
  getMemberNames,
  getGroupStats,
  filterExpenses,
  getPairwiseBalances,
  getExpenseCategories,
} from '@/lib/crdt/queries';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';
import type { Expense, Settlement } from '@/types';

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
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
}

function baseDoc() {
  const doc = createGroupDocument('g1', 'Trip', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);
  return addMember(doc, { peerId: 'peer-bob', displayName: 'Bob', avatar: '', joinedAt: '2026-01-01T00:00:00Z' });
}

describe('getExpenseCategories', () => {
  it('falls back to [category] when categories is absent', () => {
    expect(getExpenseCategories(makeExpense())).toEqual(['food']);
  });

  it('prefers categories[] when present', () => {
    expect(getExpenseCategories(makeExpense({ categories: ['food', 'travel'] }))).toEqual(['food', 'travel']);
  });
});

describe('getExpenses / getSettlements', () => {
  it('excludes deleted (tombstoned) expenses', () => {
    let doc = addExpense(baseDoc(), makeExpense({ id: 'e1' }));
    doc = addExpense(doc, makeExpense({ id: 'e2', date: '2026-01-02T00:00:00Z' }));
    doc = deleteExpense(doc, 'e1');
    const expenses = getExpenses(doc);
    expect(expenses.map(e => e.id)).toEqual(['e2']);
  });

  it('sorts expenses newest-first by date', () => {
    let doc = addExpense(baseDoc(), makeExpense({ id: 'e1', date: '2026-01-01T00:00:00Z' }));
    doc = addExpense(doc, makeExpense({ id: 'e2', date: '2026-03-01T00:00:00Z' }));
    doc = addExpense(doc, makeExpense({ id: 'e3', date: '2026-02-01T00:00:00Z' }));
    expect(getExpenses(doc).map(e => e.id)).toEqual(['e2', 'e3', 'e1']);
  });

  it('sorts settlements newest-first by date', () => {
    const s1: Settlement = { id: 's1', groupId: 'g1', from: 'peer-bob', to: 'peer-alice', amount: 100, date: '2026-01-01T00:00:00Z', note: '', settlesExpenses: [] };
    const s2: Settlement = { id: 's2', groupId: 'g1', from: 'peer-bob', to: 'peer-alice', amount: 100, date: '2026-02-01T00:00:00Z', note: '', settlesExpenses: [] };
    let doc = addSettlement(baseDoc(), s1);
    doc = addSettlement(doc, s2);
    expect(getSettlements(doc).map(s => s.id)).toEqual(['s2', 's1']);
  });
});

describe('getBalances / getSimplifiedDebts', () => {
  it('computes balances and a simplified debt graph consistent with each other', () => {
    const doc = addExpense(baseDoc(), makeExpense());
    const balances = getBalances(doc);
    expect(balances['peer-alice']).toBe(1000);
    expect(balances['peer-bob']).toBe(-1000);

    const debts = getSimplifiedDebts(doc);
    expect(debts).toEqual([{ from: 'peer-bob', to: 'peer-alice', amount: 1000 }]);
  });
});

describe('getMemberNames', () => {
  it('maps peerId to displayName', () => {
    const doc = baseDoc();
    expect(getMemberNames(doc)).toEqual({ 'peer-alice': 'Alice', 'peer-bob': 'Bob' });
  });

  it('retains the display name of a removed member', () => {
    const doc = baseDoc();
    doc.formerMembers = {
      'peer-carol': { peerId: 'peer-carol', displayName: 'Carol', avatar: '', joinedAt: '2026-01-01T00:00:00Z' },
    };

    expect(getMemberNames(doc)['peer-carol']).toBe('Carol');
  });
});

describe('getGroupStats', () => {
  it('computes totals, per-member contributions, and category breakdown in one pass', () => {
    let doc = addExpense(baseDoc(), makeExpense({ id: 'e1', totalAmount: 2000, category: 'food' }));
    doc = addExpense(doc, makeExpense({
      id: 'e2', totalAmount: 1000, category: 'transport',
      payers: [{ userId: 'peer-bob', amount: 1000 }],
      splits: [{ userId: 'peer-alice', amount: 500 }, { userId: 'peer-bob', amount: 500 }],
    }));

    const stats = getGroupStats(doc, 'peer-alice');
    expect(stats.totalGroupSpend).toBe(3000);
    expect(stats.yourPaid).toBe(2000);
    expect(stats.yourShare).toBe(1500);
    expect(stats.netBalance).toBe(500);
    expect(stats.expenseCount).toBe(2);
    expect(stats.categoryBreakdown).toEqual({ food: 2000, transport: 1000 });
    expect(stats.memberContributions['peer-alice'].paid).toBe(2000);
    expect(stats.memberContributions['peer-bob'].paid).toBe(1000);
    expect(stats.avgExpense).toBe(1500);
  });

  it('returns zeroed stats for a group with no expenses', () => {
    const stats = getGroupStats(baseDoc(), 'peer-alice');
    expect(stats.totalGroupSpend).toBe(0);
    expect(stats.contributionPercent).toBe(0);
    expect(stats.avgExpense).toBe(0);
  });
});

describe('filterExpenses', () => {
  function docWithExpenses() {
    let doc = addExpense(baseDoc(), makeExpense({
      id: 'e1', description: 'Pizza night', category: 'food', totalAmount: 1000, date: '2026-01-01T00:00:00Z',
      payers: [{ userId: 'peer-alice', amount: 1000 }],
      splits: [{ userId: 'peer-alice', amount: 500 }, { userId: 'peer-bob', amount: 500 }],
    }));
    doc = addExpense(doc, makeExpense({
      id: 'e2', description: 'Uber ride', category: 'transport', totalAmount: 500, date: '2026-01-10T00:00:00Z',
      payers: [{ userId: 'peer-bob', amount: 500 }], splits: [{ userId: 'peer-bob', amount: 500 }],
    }));
    return doc;
  }

  it('filters by search text (description or notes)', () => {
    const result = filterExpenses(docWithExpenses(), { search: 'pizza' });
    expect(result.map(e => e.id)).toEqual(['e1']);
  });

  it('filters by category', () => {
    const result = filterExpenses(docWithExpenses(), { category: 'transport' });
    expect(result.map(e => e.id)).toEqual(['e2']);
  });

  it('filters by payerId', () => {
    const result = filterExpenses(docWithExpenses(), { payerId: 'peer-bob' });
    expect(result.map(e => e.id)).toEqual(['e2']);
  });

  it('filters by date range', () => {
    const result = filterExpenses(docWithExpenses(), { dateFrom: '2026-01-05T00:00:00Z' });
    expect(result.map(e => e.id)).toEqual(['e2']);
  });

  it('filters by amount range', () => {
    const result = filterExpenses(docWithExpenses(), { minAmount: 600, maxAmount: 2000 });
    expect(result.map(e => e.id)).toEqual(['e1']);
  });

  it('filters by involvesUser (payer or split participant)', () => {
    const result = filterExpenses(docWithExpenses(), { involvesUser: 'peer-bob' });
    // peer-bob is a split participant on e1 and payer+split on e2
    expect(result.map(e => e.id).sort()).toEqual(['e1', 'e2']);
  });

  it('combines multiple filters (AND semantics)', () => {
    const result = filterExpenses(docWithExpenses(), { category: 'food', payerId: 'peer-bob' });
    expect(result).toEqual([]);
  });
});

describe('getPairwiseBalances', () => {
  it('reflects raw payer/split balances between two members', () => {
    const doc = addExpense(baseDoc(), makeExpense());
    const balances = getPairwiseBalances(doc, 'peer-alice');
    expect(balances).toEqual([{ peerId: 'peer-bob', amount: 1000 }]);
  });

  it('nets out a settlement payment', () => {
    let doc = addExpense(baseDoc(), makeExpense());
    doc = addSettlement(doc, { id: 's1', groupId: 'g1', from: 'peer-bob', to: 'peer-alice', amount: 1000, date: '2026-01-02T00:00:00Z', note: '', settlesExpenses: [] });
    const balances = getPairwiseBalances(doc, 'peer-alice');
    expect(balances).toEqual([]);
  });

  it('omits pairs with a zero net balance', () => {
    const doc = baseDoc();
    expect(getPairwiseBalances(doc, 'peer-alice')).toEqual([]);
  });
});
