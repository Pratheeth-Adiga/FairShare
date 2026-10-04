const CURRENCY_SYMBOLS: Record<string, string> = {
  USD: '$',
  EUR: '€',
  GBP: '£',
  INR: '₹',
  JPY: '¥',
  CAD: 'C$',
  AUD: 'A$',
};

// every currency is stored in hundredths (all writers do x100). These just
// display whole units, so switching a group to or from JPY doesn't rescale anything.
const ZERO_DECIMAL_CURRENCIES = new Set(['JPY']);

export function formatCents(cents: number, currency: string = 'INR'): string {
  const symbol = CURRENCY_SYMBOLS[currency] || currency + ' ';
  // Amounts are integer cents by contract, but a non-integer or NaN produced
  // malformed output instead of failing loudly (formatCents(NaN) -> "INR NaN.NaN").
  if (!Number.isFinite(cents)) return `${symbol}0.00`;
  const rounded = Math.round(cents);
  const isNegative = rounded < 0;
  const abs = Math.abs(rounded);

  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    const formatted = `${symbol}${Math.round(abs / 100)}`;
    return isNegative ? `-${formatted}` : formatted;
  }

  const dollars = Math.floor(abs / 100);
  const remainingCents = abs % 100;
  const formatted = `${symbol}${dollars}.${remainingCents.toString().padStart(2, '0')}`;
  return isNegative ? `-${formatted}` : formatted;
}

export function parseCurrencyInput(input: string, currency: string = 'INR'): number | null {
  const s = input.trim();
  if (!s) return null;

  // locale-aware decimal detection - whichever separator (. or ,) appears
  // LAST is the decimal separator, unless only commas appear and the last one
  // isn't followed by exactly 1-2 digits (then they're all thousand separators).
  const lastDot = s.lastIndexOf('.');
  const lastComma = s.lastIndexOf(',');

  // swap by INDEX, not String.replace (which hits the FIRST separator,
  // not the LAST one we identified) - otherwise "1,234,56" normalized to
  // "1.23456" (123 cents) instead of 123456 - off by 1000x for that shape.
  const swapAt = (str: string, index: number) => str.slice(0, index) + '.' + str.slice(index + 1);

  let normalized: string;
  if (lastDot > lastComma && lastComma < 0 && (s.match(/[.]/g) || []).length > 1) {
    // Dots only, more than one: can't all be decimal points, so they're
    // thousands separators (parseFloat used to stop at the 2nd dot and
    // silently return a value 1000x too small).
    normalized = s.replace(/[.]/g, '');
  } else if (lastDot > lastComma && lastComma < 0 && s.slice(lastDot + 1).replace(/[^0-9]/g, '').length > 2) {
    // A single dot followed by 3+ digits ("1.234") is the grouped form too - the
    // same exception the comma branch below already applies.
    normalized = s.replace(/[.]/g, '');
  } else if (lastDot > lastComma) {
    // Dot is decimal - strip commas (thousand separators)
    normalized = s.replace(/,/g, '');
  } else if (lastComma >= 0 && lastDot >= 0) {
    // Both present, comma appears after dot -> comma is the decimal separator.
    // Dots are thousands separators here; stripping them shifts the comma's
    // index, so re-locate it on the stripped string before swapping.
    const withoutDots = s.replace(/[.]/g, '');
    normalized = swapAt(withoutDots, withoutDots.lastIndexOf(','));
  } else if (lastComma > -1) {
    // Only commas, no dots. If the last comma is followed by exactly 1-2 digits -> decimal.
    // Otherwise treat all commas as thousand separators.
    const afterLastComma = s.slice(lastComma + 1).replace(/[^0-9]/g, '');
    if (afterLastComma.length <= 2) {
      normalized = swapAt(s, lastComma);
    } else {
      normalized = s.replace(/,/g, '');
    }
  } else {
    // No separator ambiguity
    normalized = s;
  }

  // Strip any remaining non-numeric characters except leading minus and decimal point
  const cleaned = normalized.replace(/[^0-9.-]/g, '');
  const num = parseFloat(cleaned);
  // guard against Infinity (e.g. from very long digit strings) and NaN
  if (isNaN(num) || num < 0 || Object.is(num, -0) || !Number.isFinite(num)) return null;
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    return Math.round(num) * 100;
  }
  return Math.round(num * 100);
}

// real-time validation error for amount input fields. Returns null when
// the input is empty (no error shown) or valid. Returns a user-visible message
// for negative, zero, or non-numeric input.
export function getAmountValidationError(input: string): string | null {
  if (!input.trim()) return null;
  // Reuse parseCurrencyInput so locale formats and negative zero behave consistently.
  const trimmed = input.trim();
  const isNegative = trimmed.startsWith('-');
  const magnitude = parseCurrencyInput(isNegative ? trimmed.slice(1) : trimmed);
  if (magnitude === null) return 'Enter a valid number.';
  if (magnitude === 0) return 'Amount must be greater than zero.';
  if (isNegative) return 'Amount cannot be negative.';
  return null;
}

export function centsToDecimal(cents: number, currency: string = 'INR'): string {
  if (!Number.isFinite(cents)) return ZERO_DECIMAL_CURRENCIES.has(currency) ? '0' : '0.00';
  cents = Math.round(cents);
  if (ZERO_DECIMAL_CURRENCIES.has(currency)) {
    const whole = Math.round(Math.abs(cents) / 100);
    return cents < 0 ? `-${whole}` : `${whole}`;
  }
  const abs = Math.abs(cents);
  const dollars = Math.floor(abs / 100);
  const remaining = abs % 100;
  const result = `${dollars}.${remaining.toString().padStart(2, '0')}`;
  return cents < 0 ? `-${result}` : result;
}

export const SUPPORTED_CURRENCIES = [
  { code: 'INR', name: 'Indian Rupee', symbol: '₹' },
  { code: 'USD', name: 'US Dollar', symbol: '$' },
  { code: 'EUR', name: 'Euro', symbol: '€' },
  { code: 'GBP', name: 'British Pound', symbol: '£' },
  { code: 'JPY', name: 'Japanese Yen', symbol: '¥' },
  { code: 'CAD', name: 'Canadian Dollar', symbol: 'C$' },
  { code: 'AUD', name: 'Australian Dollar', symbol: 'A$' },
];
