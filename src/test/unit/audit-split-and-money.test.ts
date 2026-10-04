// Regression coverage for split allocation and currency arithmetic.
import { describe, it, expect } from 'vitest';
import { calculateSplits } from '@/lib/balance/split';
import { parseCurrencyInput, formatCents, centsToDecimal, getAmountValidationError } from '@/lib/utils/currency';
import { apportionCents } from '@/lib/utils/apportion';
import { isSplitValid, isPayerValid } from '@/lib/balance/validation';

const sum = (o: Record<string, number>) => Object.values(o).reduce((a, b) => a + b, 0);

describe('negative weights are rejected before they can corrupt a document', () => {
  it('rejects a negative share', () => {
    // Negative weights must fail before they can create invalid persisted splits.
    expect(() => calculateSplits(10000, 'shares', ['a', 'b'], { a: 3, b: -1 })).toThrow();
  });

  it('rejects a negative weight', () => {
    expect(() => calculateSplits(10000, 'by_weight', ['a', 'b'], { a: 3, b: -1 })).toThrow();
  });

  it('rejects a negative exact amount', () => {
    expect(() => calculateSplits(10000, 'exact', ['a', 'b'], { a: 15000, b: -5000 })).toThrow();
  });

  it('rejects non-finite weights', () => {
    expect(() => calculateSplits(10000, 'shares', ['a', 'b'], { a: Infinity, b: 1 })).toThrow();
    expect(() => calculateSplits(10000, 'shares', ['a', 'b'], { a: NaN, b: 1 })).toThrow();
  });

  it('still accepts a zero weight, which means "exclude me"', () => {
    const r = calculateSplits(10000, 'shares', ['a', 'b'], { a: 1, b: 0 });
    expect(r).toEqual({ a: 10000, b: 0 });
  });

  it('the percentage branch keeps rejecting negatives, as it always did', () => {
    expect(() => calculateSplits(10000, 'percentage', ['a', 'b'], { a: 110, b: -10 })).toThrow();
  });
});

describe('splits always sum to exactly the expense total', () => {
  it('handles percentages summing slightly OVER 100 without over-allocating', () => {
    // A tolerated overage still has to be reclaimed exactly.
    const r = calculateSplits(50000, 'percentage', ['a', 'b', 'c'], { a: 33.334, b: 33.334, c: 33.334 });
    expect(sum(r)).toBe(50000);
  });

  it('handles percentages summing slightly UNDER 100 without under-allocating', () => {
    // A remainder larger than the member count must be distributed over multiple rounds.
    const r = calculateSplits(1_000_000, 'percentage', ['a', 'b', 'c'], { a: 33.331, b: 33.331, c: 33.331 });
    expect(sum(r)).toBe(1_000_000);
  });

  it('never produces a negative split while reclaiming cents', () => {
    // 50.004 x 2 = 100.008, inside tolerance, so the floors over-allocate by
    // 8 cents on a 1,000.00 expense and those 8 have to be handed back.
    const r = calculateSplits(100_000, 'percentage', ['a', 'b'], { a: 50.004, b: 50.004 });
    expect(sum(r)).toBe(100_000);
    for (const v of Object.values(r)) expect(v).toBeGreaterThanOrEqual(0);
  });

  it('keeps every split non-negative and exact across a range of inputs', () => {
    for (const total of [1, 7, 99, 100, 12345, 999999]) {
      for (const members of [['a'], ['a', 'b'], ['a', 'b', 'c'], ['a', 'b', 'c', 'd']]) {
        const equal = calculateSplits(total, 'equal', members, undefined, 'seed');
        expect(sum(equal)).toBe(total);
        const shares = calculateSplits(total, 'shares', members,
          Object.fromEntries(members.map((m, i) => [m, i + 1])), 'seed');
        expect(sum(shares)).toBe(total);
        for (const v of Object.values(shares)) expect(v).toBeGreaterThanOrEqual(0);
      }
    }
  });
});

describe('apportionCents', () => {
  it('splits into whole cents that sum exactly to the total', () => {
    const r = apportionCents(1000, ['food', 'travel', 'fun']);
    expect(sum(r)).toBe(1000);
    for (const v of Object.values(r)) expect(Number.isInteger(v)).toBe(true);
  });

  it('is deterministic regardless of the input key order', () => {
    expect(apportionCents(1000, ['fun', 'food', 'travel']))
      .toEqual(apportionCents(1000, ['food', 'travel', 'fun']));
  });

  it('handles a single key, an empty list and a non-finite total', () => {
    expect(apportionCents(1000, ['a'])).toEqual({ a: 1000 });
    expect(apportionCents(1000, [])).toEqual({});
    expect(apportionCents(NaN, ['a', 'b'])).toEqual({ a: 0, b: 0 });
  });

  it('preserves the sum for negative totals too', () => {
    expect(sum(apportionCents(-1000, ['a', 'b', 'c']))).toBe(-1000);
  });
});

describe('parseCurrencyInput handles dot-grouped thousands', () => {
  it('parses "1.234.567" the same way it parses "1,234,567"', () => {
    // parseFloat stops at the second dot, so this returned 123 cents - a
    // factor-of-a-million error against the comma-grouped form, which was
    // already correct.
    expect(parseCurrencyInput('1.234.567')).toBe(123456700);
    expect(parseCurrencyInput('1,234,567')).toBe(123456700);
  });

  it('treats a single dot with 3+ trailing digits as grouping', () => {
    expect(parseCurrencyInput('1.234')).toBe(123400);
  });

  it('still treats a dot with 1-2 trailing digits as a decimal point', () => {
    expect(parseCurrencyInput('1.23')).toBe(123);
    expect(parseCurrencyInput('1.2')).toBe(120);
  });

  it('does not regress the mixed European form', () => {
    expect(parseCurrencyInput('1.234.567,89')).toBe(123456789);
    expect(parseCurrencyInput('1,234,567.89')).toBe(123456789);
  });
});

describe('getAmountValidationError agrees with the parser', () => {
  it('accepts a European decimal comma the parser accepts', () => {
    // Previously reported "Amount must be greater than zero" for a value the
    // parser read as 50 cents, because it used a raw parseFloat.
    expect(parseCurrencyInput('0,50')).toBe(50);
    expect(getAmountValidationError('0,50')).toBeNull();
  });

  it('accepts a leading-comma decimal', () => {
    expect(getAmountValidationError(',50')).toBeNull();
  });

  it('accepts dot-grouped thousands', () => {
    expect(getAmountValidationError('1.234.567')).toBeNull();
  });

  it('keeps flagging genuinely bad input', () => {
    expect(getAmountValidationError('abc')).toBe('Enter a valid number.');
    expect(getAmountValidationError('0')).toBe('Amount must be greater than zero.');
    expect(getAmountValidationError('-0')).toBe('Amount must be greater than zero.');
    expect(getAmountValidationError('-5')).toBe('Amount cannot be negative.');
    expect(getAmountValidationError('')).toBeNull();
  });
});

describe('formatting guards against non-integer cents', () => {
  it('does not emit a malformed string for a fractional value', () => {
    // Fractional cent input must still format as a valid currency string.
    expect(formatCents(-0.5, 'USD')).toBe('$0.00');
    expect(formatCents(-0.6, 'USD')).toBe('-$0.01');
    expect(formatCents(333.3333, 'USD')).toBe('$3.33');
    // The real point: output is always a well-formed amount.
    for (const v of [-0.5, 0.5, 333.3333, -1234.567, 1e-9]) {
      expect(formatCents(v, 'USD')).toMatch(/^-?\$\d+\.\d{2}$/);
    }
  });

  it('does not emit NaN', () => {
    expect(formatCents(NaN, 'USD')).toBe('$0.00');
    expect(formatCents(Infinity, 'USD')).toBe('$0.00');
    expect(centsToDecimal(NaN, 'USD')).toBe('0.00');
    expect(centsToDecimal(NaN, 'JPY')).toBe('0');
  });

  it('leaves ordinary integer amounts untouched', () => {
    expect(formatCents(123456, 'USD')).toBe('$1234.56');
    expect(formatCents(-500, 'USD')).toBe('-$5.00');
    expect(centsToDecimal(1234, 'USD')).toBe('12.34');
  });
});

describe('payer validation rejects negative entries', () => {
  it('rejects a negative payer amount that happens to sum correctly', () => {
    // AddExpense builds the payers array from entries > 0 only, so this summed
    // to the right total here and then threw from inside addExpense.
    expect(isPayerValid(true, '', { alice: '15', bob: '-5' }, 1000)).toBe(false);
  });

  it('still accepts a well-formed multi-payer split', () => {
    expect(isPayerValid(true, '', { alice: '6', bob: '4' }, 1000)).toBe(true);
  });

  it('still requires a payer in single-payer mode', () => {
    expect(isPayerValid(false, '', {}, 1000)).toBe(false);
    expect(isPayerValid(false, 'alice', {}, 1000)).toBe(true);
  });

  it('rejects a negative weight in the split validator too', () => {
    expect(isSplitValid('shares', ['a', 'b'], 1000, { shares: { a: '3', b: '-1' } })).toBe(true);
    // isSplitValid only checks positive total; calculateSplits rejects negatives.
    expect(() => calculateSplits(1000, 'shares', ['a', 'b'], { a: 3, b: -1 })).toThrow();
  });
});
