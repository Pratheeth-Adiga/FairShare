import { describe, it, expect } from 'vitest';
import { calculateBalances, getCategoryBreakdown } from '@/lib/balance/calculator';
import type { Expense, Settlement } from '@/types';

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e1',
    groupId: 'g1',
    friendId: null,
    description: 'Test',
    totalAmount: 3000,
    currency: 'USD',
    payers: [{ userId: 'alice', amount: 3000 }],
    splitType: 'equal',
    splits: [
      { userId: 'alice', amount: 1000 },
      { userId: 'bob', amount: 1000 },
      { userId: 'carol', amount: 1000 },
    ],
    items: [],
    category: 'food',
    date: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'alice',
    notes: '',
    ...overrides,
  };
}

describe('calculateBalances', () => {
  it('computes correct balances for a single expense', () => {
    const expenses = [makeExpense()];
    const balances = calculateBalances(expenses, []);
    expect(balances['alice']).toBe(2000);  // paid 3000, owes 1000, net +2000
    expect(balances['bob']).toBe(-1000);   // paid 0, owes 1000, net -1000
    expect(balances['carol']).toBe(-1000); // paid 0, owes 1000, net -1000
  });

  it('net balances sum to zero', () => {
    const expenses = [
      makeExpense(),
      makeExpense({ id: 'e2', payers: [{ userId: 'bob', amount: 3000 }] }),
    ];
    const balances = calculateBalances(expenses, []);
    const sum = Object.values(balances).reduce((a, b) => a + b, 0);
    expect(sum).toBe(0);
  });

  it('applies settlements correctly', () => {
    const expenses = [makeExpense()];
    const settlements: Settlement[] = [{
      id: 's1',
      groupId: 'g1',
      from: 'bob',
      to: 'alice',
      amount: 1000,
      date: '2026-01-02T00:00:00Z',
      note: '',
      settlesExpenses: [],
    }];
    const balances = calculateBalances(expenses, settlements);
    expect(balances['alice']).toBe(1000);  // 2000 - 1000 received
    expect(balances['bob']).toBe(0);       // -1000 + 1000 paid
    expect(balances['carol']).toBe(-1000);
  });

  it('handles multi-payer expenses', () => {
    const expenses = [makeExpense({
      payers: [
        { userId: 'alice', amount: 2000 },
        { userId: 'bob', amount: 1000 },
      ],
    })];
    const balances = calculateBalances(expenses, []);
    expect(balances['alice']).toBe(1000);  // paid 2000, owes 1000
    expect(balances['bob']).toBe(0);       // paid 1000, owes 1000
    expect(balances['carol']).toBe(-1000); // paid 0, owes 1000
  });

  it('returns empty for no expenses', () => {
    const balances = calculateBalances([], []);
    expect(Object.keys(balances).length).toBe(0);
  });
});

describe('getCategoryBreakdown', () => {
  it('uses category scalar when categories[] is absent', () => {
    const e = makeExpense({ totalAmount: 3000, category: 'food' });
    const bd = getCategoryBreakdown([e]);
    expect(bd['food']).toBe(3000);
  });

  it('uses categories[] array when present, preferring it over category scalar', () => {
    const e = makeExpense({ totalAmount: 3000, category: 'food', categories: ['transport'] });
    const bd = getCategoryBreakdown([e]);
    expect(bd['transport']).toBe(3000);
    expect(bd['food']).toBeUndefined();
  });

  it('splits amount proportionally across multiple tags', () => {
    const e = makeExpense({ totalAmount: 3000, category: 'food', categories: ['food', 'transport'] });
    const bd = getCategoryBreakdown([e]);
    expect(bd['food']).toBe(1500);
    expect(bd['transport']).toBe(1500);
  });

  it('falls back to other when category is empty and categories[] is absent', () => {
    const e = makeExpense({ totalAmount: 1000, category: '' });
    const bd = getCategoryBreakdown([e]);
    expect(bd['other']).toBe(1000);
  });
});

