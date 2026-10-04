// shared form state machine for AddExpense and EditExpense
import type { Expense, PeerId, SplitType } from '@/types';

export const SPLIT_TYPES: { value: SplitType; label: string; description: string }[] = [
  { value: 'equal', label: 'Equal', description: 'Split equally between selected members' },
  { value: 'exact', label: 'Exact', description: 'Enter exact amounts for each person' },
  { value: 'percentage', label: 'Percentage', description: 'Split by percentage' },
  { value: 'shares', label: 'Shares', description: 'Split by number of shares' },
  // by_weight is the same shape as shares; keep it in the same map
  { value: 'by_weight', label: 'Weights', description: 'Split proportionally by weight (e.g. nights stayed)' },
];

// itemized stays read-only for edits because the app has no per-item editor
export const ITEMIZED_SPLIT_TYPE: { value: SplitType; label: string; description: string } = {
  value: 'itemized',
  label: 'Itemized (read-only)',
  description: 'Per-item assignment. Item editing is not supported yet - the existing breakdown is preserved on save.',
};

// Split types whose per-member input is a plain proportional number.
export const WEIGHTED_SPLIT_TYPES: SplitType[] = ['shares', 'by_weight'];

// percentages are stored in splitInputs too, so they have to survive a reload exactly
export function splitInputsFor(splitType: SplitType, selectedMembers: PeerId[], percentages: Record<string, string>, shares: Record<string, string>): Record<string, number> | undefined {
  if (splitType === 'percentage') return Object.fromEntries(selectedMembers.map(id => [id, parseFloat(percentages[id] || '0')]));
  if (WEIGHTED_SPLIT_TYPES.includes(splitType)) return Object.fromEntries(selectedMembers.map(id => [id, parseFloat(shares[id] || '0')]));
  return undefined;
}

export interface ExpenseFormState {
  description: string;
  amount: string;
  categories: string[];
  payerId: string;
  multiPayer: boolean;
  payerAmounts: Record<string, string>;
  splitType: SplitType;
  selectedMembers: PeerId[];
  notes: string;
  date: string;
  exactAmounts: Record<string, string>;
  percentages: Record<string, string>;
  shares: Record<string, string>;
  // Loaded expense id, or null for a blank form.
  loadedExpenseId: string | null;
}

export type ExpenseFormMapField = 'payerAmounts' | 'exactAmounts' | 'percentages' | 'shares';
export type ExpenseFormArrayField = 'categories' | 'selectedMembers';

export type ExpenseFormAction =
  | { type: 'SET_FIELD'; field: 'description' | 'amount' | 'notes' | 'date' | 'payerId'; value: string }
  | { type: 'SET_MULTI_PAYER'; value: boolean }
  // resetParams clears the per-member split inputs, since a new split type needs fresh ones
  | { type: 'SET_SPLIT_TYPE'; value: SplitType; resetParams?: boolean; memberIds?: PeerId[] }
  | { type: 'SET_MAP_VALUE'; field: ExpenseFormMapField; memberId: string; value: string }
  | { type: 'TOGGLE_ARRAY_ITEM'; field: ExpenseFormArrayField; value: string; checked: boolean }
  | { type: 'INIT_SELECTED_MEMBERS'; memberIds: PeerId[] }
  | { type: 'INIT_MISSING_SHARES'; memberIds: string[] }
  | { type: 'PRUNE_REMOVED_MEMBERS'; currentMemberIds: PeerId[] }
  | { type: 'LOAD_EXPENSE'; expense: Expense };

export function createInitialExpenseFormState(payerId: string, today: string, defaultSplitType?: string): ExpenseFormState {
  // new expenses start from the group's "Default split type" setting
  const splitType = SPLIT_TYPES.find(t => t.value === defaultSplitType)?.value ?? 'equal';
  return {
    description: '',
    amount: '',
    categories: ['other'],
    payerId,
    multiPayer: false,
    payerAmounts: {},
    splitType,
    selectedMembers: [],
    notes: '',
    // default to the LOCAL calendar date, not the UTC date, so users near
    // midnight do not see yesterday or tomorrow pre-filled.
    date: today,
    exactAmounts: {},
    percentages: {},
    shares: {},
    loadedExpenseId: null,
  };
}

// Rehydrate form state from a stored expense.
export function expenseFormStateFromExpense(expense: Expense): ExpenseFormState {
  const state: ExpenseFormState = {
    description: expense.description,
    amount: (expense.totalAmount / 100).toFixed(2),
    categories: expense.categories && expense.categories.length > 0
      ? expense.categories
      : [expense.category],
    payerId: '',
    multiPayer: expense.payers.length > 1,
    payerAmounts: {},
    splitType: expense.splitType,
    // an old claim can leave the same person on two split rows
    selectedMembers: Array.from(new Set(expense.splits.map(s => s.userId))),
    notes: expense.notes || '',
    // date is a bare YYYY-MM-DD string throughout the CRDT. Splitting on
    // the T keeps legacy rows loading correctly - those were written as full ISO
    // timestamps before the format was settled.
    date: expense.date.split('T')[0] ?? '',
    exactAmounts: {},
    percentages: {},
    shares: {},
    loadedExpenseId: expense.id,
  };

  // sum duplicate payer rows for one person instead of letting the last one win
  const paidBy = new Map<string, number>();
  for (const p of expense.payers) paidBy.set(p.userId, (paidBy.get(p.userId) || 0) + p.amount);
  state.multiPayer = paidBy.size > 1;
  if (paidBy.size > 1) {
    for (const [userId, cents] of paidBy) {
      state.payerAmounts[userId] = (cents / 100).toFixed(2);
    }
  } else {
    state.payerId = expense.payers[0]?.userId || '';
  }

  if (expense.splitType === 'exact') {
    const owedBy = new Map<string, number>();
    for (const s of expense.splits) owedBy.set(s.userId, (owedBy.get(s.userId) || 0) + s.amount);
    for (const [userId, cents] of owedBy) state.exactAmounts[userId] = (cents / 100).toFixed(2);
  } else if (expense.splitType === 'percentage') {
    const total = expense.totalAmount;
    for (const s of expense.splits) {
      const typed = expense.splitInputs?.[s.userId];
      // prefer what was typed. Older rows rebuild at 4dp, 1dp didn't sum to 100.
      // Guard the zero total so a corrupted row doesn't render NaN.
      state.percentages[s.userId] = typed !== undefined
        ? String(typed)
        : total > 0 ? String(Number(((s.amount / total) * 100).toFixed(4))) : '0';
    }
  } else if (WEIGHTED_SPLIT_TYPES.includes(expense.splitType)) {
    // restore the raw weights originally typed if the expense carries them;
    // fall back to 1 for rows written before splitInputs existed.
    for (const s of expense.splits) {
      const w = expense.splitInputs?.[s.userId];
      state.shares[s.userId] = w === undefined ? '1' : String(w);
    }
  }

  return state;
}

export function expenseFormReducer(state: ExpenseFormState, action: ExpenseFormAction): ExpenseFormState {
  switch (action.type) {
    case 'SET_FIELD':
      return { ...state, [action.field]: action.value };
    case 'SET_MULTI_PAYER':
      return { ...state, multiPayer: action.value };
    case 'SET_SPLIT_TYPE': {
      if (!action.resetParams) return { ...state, splitType: action.value };
      // a new split type gets fresh inputs, otherwise amounts typed for
      // "exact" would be silently reinterpreted as percentages. Weighted types
      // seed to 1 so the default is an even distribution rather than a total of 0.
      const memberIds = action.memberIds ?? state.selectedMembers;
      return {
        ...state,
        splitType: action.value,
        exactAmounts: Object.fromEntries(memberIds.map(id => [id, ''])),
        percentages: Object.fromEntries(memberIds.map(id => [id, ''])),
        shares: Object.fromEntries(memberIds.map(id => [id, '1'])),
      };
    }
    case 'SET_MAP_VALUE':
      return { ...state, [action.field]: { ...state[action.field], [action.memberId]: action.value } };
    case 'TOGGLE_ARRAY_ITEM': {
      const current = state[action.field];
      const next = action.checked
        ? [...current, action.value]
        : current.filter(v => v !== action.value);
      const updated = { ...state, [action.field]: next };
      // Ticking a member into a weighted split has to give them a weight, or the
      // checkbox looks like it did nothing (a missing entry reads as 0).
      if (action.field === 'selectedMembers' && action.checked && updated.shares[action.value] === undefined) {
        updated.shares = { ...updated.shares, [action.value]: '1' };
      }
      return updated;
    }
    case 'INIT_SELECTED_MEMBERS':
      return state.selectedMembers.length === 0 && action.memberIds.length > 0
        ? { ...state, selectedMembers: action.memberIds }
        : state;
    case 'INIT_MISSING_SHARES': {
      // Default new members to 1 share, but never overwrite a value already set
      // by the user, including 0 or empty.
      const missing = action.memberIds.filter(id => state.shares[id] === undefined);
      if (missing.length === 0) return state;
      return { ...state, shares: { ...Object.fromEntries(missing.map(id => [id, '1'])), ...state.shares } };
    }
    // a peer can remove a group member while this form is open; without this a
    // removed member's id lingers and handleSubmit saves a split for someone gone.
    case 'PRUNE_REMOVED_MEMBERS': {
      const current = new Set(action.currentMemberIds);
      const dropStale = (map: Record<string, string>) =>
        Object.fromEntries(Object.entries(map).filter(([id]) => current.has(id)));
      const next: ExpenseFormState = {
        ...state,
        selectedMembers: state.selectedMembers.filter(id => current.has(id)),
        payerAmounts: dropStale(state.payerAmounts),
        exactAmounts: dropStale(state.exactAmounts),
        percentages: dropStale(state.percentages),
        shares: dropStale(state.shares),
        payerId: current.has(state.payerId) ? state.payerId : '',
      };
      // a removed payer who wasn't in the split still has to be pruned
      const changed = next.selectedMembers.length !== state.selectedMembers.length
        || next.payerId !== state.payerId
        || (['payerAmounts', 'exactAmounts', 'percentages', 'shares'] as const)
          .some(field => Object.keys(next[field]).length !== Object.keys(state[field]).length);
      return changed ? next : state;
    }
    case 'LOAD_EXPENSE':
      return expenseFormStateFromExpense(action.expense);
    default:
      return state;
  }
}
