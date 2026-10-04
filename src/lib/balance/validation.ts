import type { SplitType } from '@/types';

// Pure validation predicates used by both AddExpense and EditExpense.
// Extracted so the form-wiring rules can be unit-tested without rendering.

export function isSplitValid(
  splitType: SplitType,
  selectedMembers: string[],
  amountCents: number,
  params: {
    exactAmounts?: Record<string, string>;
    percentages?: Record<string, string>;
    shares?: Record<string, string>;
  }
): boolean {
  if (!Number.isFinite(amountCents) || amountCents <= 0) return false;
  if (selectedMembers.length === 0) return false;
  if (splitType === 'equal') return true;
  if (splitType === 'exact') {
    const total = selectedMembers.reduce(
      (sum, id) => sum + Math.round(parseFloat(params.exactAmounts?.[id] || '0') * 100),
      0
    );
    return total === amountCents;
  }
  if (splitType === 'percentage') {
    const total = selectedMembers.reduce(
      (sum, id) => sum + parseFloat(params.percentages?.[id] || '0'),
      0
    );
    return Math.abs(total - 100) < 0.01;
  }
  // by_weight shares the same input map and the same rule as shares - calculateSplits
  // only needs the weights to sum to something non-zero, and 0 is a legit "exclude me"
  if (splitType === 'shares' || splitType === 'by_weight') {
    return selectedMembers.some(id => parseFloat(params.shares?.[id] || '0') > 0);
  }
  return true;
}

export function isPayerValid(
  multiPayer: boolean,
  payerId: string,
  payerAmounts: Record<string, string>,
  amountCents: number
): boolean {
  if (multiPayer) {
    const parsed = Object.values(payerAmounts).map(v => Math.round(parseFloat(v || '0') * 100));
    // Reject negatives here; AddExpense otherwise drops them before persistence.
    if (parsed.some(v => !Number.isFinite(v) || v < 0)) return false;
    return parsed.reduce((s, v) => s + v, 0) === amountCents;
  }
  return !!payerId;
}
