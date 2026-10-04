import { describe, it, expect } from 'vitest';
import { simplifyDebts } from '@/lib/balance/simplify';

describe('simplifyDebts', () => {
  it('returns empty for balanced accounts', () => {
    const result = simplifyDebts({ alice: 0, bob: 0 });
    expect(result).toEqual([]);
  });

  it('creates single transaction for two people', () => {
    const result = simplifyDebts({ alice: 5000, bob: -5000 });
    expect(result).toHaveLength(1);
    expect(result[0]).toEqual({ from: 'bob', to: 'alice', amount: 5000 });
  });

  it('minimizes transactions for three people', () => {
    const result = simplifyDebts({ alice: 3000, bob: -2000, carol: -1000 });
    expect(result).toHaveLength(2);
    const totalTransferred = result.reduce((sum, t) => sum + t.amount, 0);
    expect(totalTransferred).toBe(3000);
  });

  it('all transaction amounts are positive', () => {
    const result = simplifyDebts({ a: 100, b: -50, c: -50 });
    result.forEach(t => expect(t.amount).toBeGreaterThan(0));
  });

  it('net effect is correct', () => {
    const balances = { a: 5000, b: -3000, c: -2000 };
    const result = simplifyDebts(balances);

    const netEffect: Record<string, number> = {};
    for (const t of result) {
      netEffect[t.from] = (netEffect[t.from] || 0) - t.amount;
      netEffect[t.to] = (netEffect[t.to] || 0) + t.amount;
    }

    // After all transactions, each person's net change should match their balance
    for (const [person, balance] of Object.entries(balances)) {
      if (balance > 0) {
        expect(netEffect[person]).toBe(balance);
      } else if (balance < 0) {
        expect(netEffect[person]).toBe(balance);
      }
    }
  });

  it('handles complex 5-person scenario', () => {
    const balances = { a: 4000, b: 2000, c: -3000, d: -2000, e: -1000 };
    const result = simplifyDebts(balances);
    // Should never need more than N-1 transactions
    expect(result.length).toBeLessThanOrEqual(4);

    const totalDebts = Object.values(balances).filter(v => v < 0).reduce((s, v) => s + Math.abs(v), 0);
    const totalTransferred = result.reduce((s, t) => s + t.amount, 0);
    expect(totalTransferred).toBe(totalDebts);
  });
});
