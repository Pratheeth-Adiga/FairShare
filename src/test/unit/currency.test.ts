import { describe, it, expect } from 'vitest';
import { formatCents, parseCurrencyInput, getAmountValidationError, centsToDecimal } from '@/lib/utils/currency';

describe('formatCents', () => {
  it('formats a standard 2-decimal currency', () => {
    expect(formatCents(123456, 'USD')).toBe('$1234.56');
  });

  // JPY is stored in hundredths like every other currency, shown in whole yen
  it('formats a zero-decimal currency (JPY) without cents', () => {
    expect(formatCents(150000, 'JPY')).toBe('\u00a51500');
  });

  it('does not rescale an amount when a group switches to or from JPY', () => {
    expect(formatCents(150000, 'USD')).toBe('$1500.00');
    expect(formatCents(150000, 'JPY')).toBe('\u00a51500');
  });

  it('does not rescale an amount when a group switches to or from JPY', () => {
    expect(formatCents(150000, 'USD')).toBe('$1500.00');
    expect(formatCents(150000, 'JPY')).toBe('¥1500');
  });

  it('handles negative amounts', () => {
    expect(formatCents(-500, 'USD')).toBe('-$5.00');
  });

  it('pads single-digit cents', () => {
    expect(formatCents(105, 'USD')).toBe('$1.05');
  });

  it('falls back to the currency code as a symbol when unknown', () => {
    expect(formatCents(100, 'XYZ')).toBe('XYZ 1.00');
  });

  it('defaults to INR when no currency is given', () => {
    expect(formatCents(100)).toBe('₹1.00');
  });
});

describe('parseCurrencyInput', () => {
  it('parses a plain decimal string to cents', () => {
    expect(parseCurrencyInput('12.34', 'USD')).toBe(1234);
  });

  it('strips currency symbols and thousands separators', () => {
    expect(parseCurrencyInput('$1,234.56', 'USD')).toBe(123456);
  });

  it('treats comma as decimal separator when only one group separator is present', () => {
    expect(parseCurrencyInput('12,34', 'USD')).toBe(1234);
  });

  it('treats "1,000" as one thousand, not one', () => {
    expect(parseCurrencyInput('1,000', 'USD')).toBe(100000);
  });

  it('treats "1,234,567" as thousand-separated', () => {
    expect(parseCurrencyInput('1,234,567', 'USD')).toBe(123456700);
  });

  it('handles european "1.000,00" as 1000.00', () => {
    expect(parseCurrencyInput('1.000,00', 'EUR')).toBe(100000);
  });

  it('rounds a zero-decimal currency (JPY) to whole units', () => {
    expect(parseCurrencyInput('1500', 'JPY')).toBe(150000);
    expect(parseCurrencyInput('1500.4', 'JPY')).toBe(150000);
  });

  it('returns null for garbage input', () => {
    expect(parseCurrencyInput('abc', 'USD')).toBeNull();
  });

  it('returns null for negative input', () => {
    expect(parseCurrencyInput('-5', 'USD')).toBeNull();
  });

  it('returns null for negative zero', () => {
    expect(parseCurrencyInput('-0', 'USD')).toBeNull();
  });

  it('treats European "1.234,56" as 1234.56 (→ 123456 cents)', () => {
    expect(parseCurrencyInput('1.234,56', 'EUR')).toBe(123456);
  });

  it('returns null for a number too large to represent finitely (overflows to IEEE 754 Infinity)', () => {
    // 10^309 exceeds Number.MAX_VALUE and parseFloat returns Infinity; must be rejected.
    expect(parseCurrencyInput('1' + '0'.repeat(309), 'USD')).toBeNull();
  });

  it('returns null for the literal string "Infinity" (non-numeric after stripping)', () => {
    // Stripped to empty string → NaN → null.
    expect(parseCurrencyInput('Infinity', 'USD')).toBeNull();
  });
});

describe('getAmountValidationError', () => {
  it('returns null for empty input (no error shown until user types something)', () => {
    expect(getAmountValidationError('')).toBeNull();
    expect(getAmountValidationError('   ')).toBeNull();
  });

  it('returns null for a valid positive amount', () => {
    expect(getAmountValidationError('12.50')).toBeNull();
  });

  it('flags non-numeric input', () => {
    expect(getAmountValidationError('abc')).toBe('Enter a valid number.');
  });

  it('flags zero and negative zero', () => {
    expect(getAmountValidationError('0')).toBe('Amount must be greater than zero.');
    expect(getAmountValidationError('-0')).toBe('Amount must be greater than zero.');
  });

  it('flags negative amounts', () => {
    expect(getAmountValidationError('-5')).toBe('Amount cannot be negative.');
  });
});

describe('centsToDecimal', () => {
  it('formats standard currency cents as a decimal string', () => {
    expect(centsToDecimal(1234, 'USD')).toBe('12.34');
  });

  it('formats zero-decimal currency without a decimal point', () => {
    expect(centsToDecimal(150000, 'JPY')).toBe('1500');
  });

  it('handles negative values', () => {
    expect(centsToDecimal(-1234, 'USD')).toBe('-12.34');
  });
});
