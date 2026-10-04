import { describe, it, expect } from 'vitest';
import { isSplitValid, isPayerValid } from '@/lib/balance/validation';

describe('isSplitValid', () => {
  const members = ['a', 'b', 'c'];

  it('rejects zero or negative amount', () => {
    expect(isSplitValid('equal', members, 0, {})).toBe(false);
    expect(isSplitValid('equal', members, -100, {})).toBe(false);
    expect(isSplitValid('equal', members, NaN, {})).toBe(false);
  });

  it('rejects an empty member selection', () => {
    expect(isSplitValid('equal', [], 1000, {})).toBe(false);
  });

  it('equal split is valid for any positive amount + non-empty members', () => {
    expect(isSplitValid('equal', members, 1000, {})).toBe(true);
  });

  it('exact split requires the per-member cents to sum to the total', () => {
    expect(
      isSplitValid('exact', members, 3000, {
        exactAmounts: { a: '10', b: '10', c: '10' },
      })
    ).toBe(true);
    expect(
      isSplitValid('exact', members, 3000, {
        exactAmounts: { a: '10', b: '10', c: '9' },
      })
    ).toBe(false);
  });

  it('exact split treats missing entries as zero', () => {
    // b + c missing → treated as 0; totals to only ₹10 (1000c) instead of ₹30.
    expect(
      isSplitValid('exact', members, 3000, {
        exactAmounts: { a: '10' },
      })
    ).toBe(false);
  });

  it('percentage split accepts a total within 0.01 of 100', () => {
    expect(
      isSplitValid('percentage', members, 1000, {
        percentages: { a: '33.33', b: '33.33', c: '33.34' },
      })
    ).toBe(true);
    expect(
      isSplitValid('percentage', members, 1000, {
        percentages: { a: '33', b: '33', c: '33' },
      })
    ).toBe(false);
  });

  it('shares split needs at least one positive share', () => {
    // Matches AddExpense semantics: user can zero someone out to exclude them,
    // but at least one member must have a positive share.
    expect(
      isSplitValid('shares', members, 1000, {
        shares: { a: '1', b: '0', c: '0' },
      })
    ).toBe(true);
    expect(
      isSplitValid('shares', members, 1000, {
        shares: { a: '0', b: '0', c: '0' },
      })
    ).toBe(false);
  });
});

describe('isPayerValid', () => {
  it('single-payer needs a truthy payerId', () => {
    expect(isPayerValid(false, 'peer-a', {}, 1000)).toBe(true);
    expect(isPayerValid(false, '', {}, 1000)).toBe(false);
  });

  it('multi-payer requires the amounts to sum to the total in cents', () => {
    expect(isPayerValid(true, '', { a: '10', b: '5' }, 1500)).toBe(true);
    expect(isPayerValid(true, '', { a: '10', b: '4.99' }, 1500)).toBe(false);
  });

  it('multi-payer treats missing / blank entries as zero', () => {
    expect(isPayerValid(true, '', { a: '', b: '15' }, 1500)).toBe(true);
    expect(isPayerValid(true, '', {}, 1500)).toBe(false);
  });
});
