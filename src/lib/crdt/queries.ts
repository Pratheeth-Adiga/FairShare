import type { Expense, Settlement, PeerId } from '@/types';
import type { GroupDocument } from './document';
import { calculateBalances, type BalanceMap } from '../balance/calculator';
import { simplifyDebts, type Transaction } from '../balance/simplify';
import { apportionCents } from '@/lib/utils/apportion';

// An expense may carry multiple category tags (categories); category is kept
// as categories[0] for back-compat with documents/exports written before tagging existed.
export function getExpenseCategories(expense: Expense): string[] {
  return expense.categories && expense.categories.length > 0 ? expense.categories : [expense.category];
}

export function getExpenses(doc: GroupDocument): Expense[] {
  // Live records only. `deleteExpense` removes the record from `doc.expenses`
  // and `mergeDocuments` scrubs tombstoned records in the same pass, so an
  // extra filter against doc.deleted here would be defensive-only overhead.
  return Object.values(doc.expenses)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export function getSettlements(doc: GroupDocument): Settlement[] {
  return Object.values(doc.settlements)
    .sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());
}

export function getBalances(doc: GroupDocument): BalanceMap {
  const expenses = getExpenses(doc);
  const settlements = getSettlements(doc);
  return calculateBalances(expenses, settlements);
}

export function getSimplifiedDebts(doc: GroupDocument): Transaction[] {
  // with "Simplify debts" off, show who actually owes whom
  if (!doc.meta.settings.simplifyDebts) return getPairwiseDebts(doc);
  const balances = getBalances(doc);
  return simplifyDebts(balances);
}

export function getMemberNames(doc: GroupDocument): Record<string, string> {
  const names: Record<string, string> = {};
  for (const [peerId, member] of Object.entries(doc.formerMembers || {})) {
    names[peerId] = member.displayName;
  }
  for (const [peerId, member] of Object.entries(doc.members)) {
    names[peerId] = member.displayName;
  }
  return names;
}

export function getGroupStats(doc: GroupDocument, userId: PeerId) {
  const expenses = getExpenses(doc);

  // single pass over expenses instead of 4+ separate ones (previously
  // O(members * expenses) just for memberContributions).
  let totalGroupSpend = 0;
  let yourPaid = 0;
  let yourShare = 0;
  const categoryBreakdown: Record<string, number> = {};
  const paidByMember: Record<string, number> = {};
  for (const memberId of Object.keys(doc.members)) paidByMember[memberId] = 0;

  for (const e of expenses) {
    totalGroupSpend += e.totalAmount;

    for (const p of e.payers) {
      if (p.userId === userId) yourPaid += p.amount;
      paidByMember[p.userId] = (paidByMember[p.userId] || 0) + p.amount;
    }
    for (const s of e.splits) {
      if (s.userId === userId) yourShare += s.amount;
    }
    // split totalAmount evenly across all tags so multi-category expenses
    // don't inflate the breakdown. Each category gets its proportional share.
    const cats = getExpenseCategories(e);
    for (const [cat, share] of Object.entries(apportionCents(e.totalAmount, cats))) {
      categoryBreakdown[cat] = (categoryBreakdown[cat] || 0) + share;
    }
  }

  const memberContributions: Record<string, { paid: number; percentage: number }> = {};
  for (const memberId of Object.keys(doc.members)) {
    const paid = paidByMember[memberId] || 0;
    memberContributions[memberId] = {
      paid,
      percentage: totalGroupSpend > 0 ? Math.round(paid * 100 / totalGroupSpend) : 0,
    };
  }

  return {
    totalGroupSpend,
    yourPaid,
    yourShare,
    netBalance: yourPaid - yourShare,
    contributionPercent: totalGroupSpend > 0 ? Math.round(yourPaid * 100 / totalGroupSpend) : 0,
    categoryBreakdown,
    memberContributions,
    expenseCount: expenses.length,
    avgExpense: expenses.length > 0 ? Math.round(totalGroupSpend / expenses.length) : 0,
  };
}

export interface ExpenseFilter {
  search?: string;
  category?: string;
  payerId?: string;
  dateFrom?: string;
  dateTo?: string;
  minAmount?: number;
  maxAmount?: number;
  involvesUser?: string;
}

export function filterExpenses(doc: GroupDocument, filters: ExpenseFilter): Expense[] {
  let expenses = getExpenses(doc);

  if (filters.search) {
    const term = filters.search.toLowerCase();
    expenses = expenses.filter(e =>
      e.description.toLowerCase().includes(term) ||
      e.notes.toLowerCase().includes(term)
    );
  }

  if (filters.category) {
    expenses = expenses.filter(e => getExpenseCategories(e).includes(filters.category!));
  }

  if (filters.payerId) {
    expenses = expenses.filter(e => e.payers.some(p => p.userId === filters.payerId));
  }

  if (filters.dateFrom) {
    const from = filters.dateFrom.slice(0, 10);
    expenses = expenses.filter(e => e.date.slice(0, 10) >= from);
  }

  if (filters.dateTo) {
    // compare date prefixes so legacy same-day timestamps are included
    const to = filters.dateTo.slice(0, 10);
    expenses = expenses.filter(e => e.date.slice(0, 10) <= to);
  }

  if (filters.minAmount !== undefined) {
    expenses = expenses.filter(e => e.totalAmount >= filters.minAmount!);
  }

  if (filters.maxAmount !== undefined) {
    expenses = expenses.filter(e => e.totalAmount <= filters.maxAmount!);
  }

  if (filters.involvesUser) {
    expenses = expenses.filter(e =>
      e.splits.some(s => s.userId === filters.involvesUser) ||
      e.payers.some(p => p.userId === filters.involvesUser)
    );
  }

  return expenses;
}

export interface PairwiseBalance {
  peerId: PeerId;
  // Positive: peerId owes userId this amount. Negative: userId owes peerId -amount.
  amount: number;
}

// Non-simplified net per-person balances - who actually paid/owes whom, not
// the group-wide simplified debt graph from getSimplifiedDebts(). Lets someone
// settle with one specific person instead of only the netted-down suggestion.
export function getPairwiseBalances(doc: GroupDocument, userId: PeerId): PairwiseBalance[] {
  const owed = buildOwedMatrix(doc);
  const others = Object.keys({ ...(doc.formerMembers || {}), ...doc.members }).filter(id => id !== userId);
  const balances: PairwiseBalance[] = [];
  for (const other of others) {
    const userOwesOther = owed[userId]?.[other] || 0;
    const otherOwesUser = owed[other]?.[userId] || 0;
    const net = Math.round(otherOwesUser - userOwesOther);
    if (net !== 0) balances.push({ peerId: other, amount: net });
  }
  return balances;
}

// every pair netted once, sorted so each peer shows the same list
export function getPairwiseDebts(doc: GroupDocument): Transaction[] {
  const owed = buildOwedMatrix(doc);
  const ids = Object.keys({ ...(doc.formerMembers || {}), ...doc.members, ...owed }).sort();
  const debts: Transaction[] = [];
  for (let i = 0; i < ids.length; i++) {
    for (let j = i + 1; j < ids.length; j++) {
      const a = ids[i];
      const b = ids[j];
      const net = Math.round((owed[a]?.[b] || 0) - (owed[b]?.[a] || 0));
      if (net > 0) debts.push({ from: a, to: b, amount: net });
      else if (net < 0) debts.push({ from: b, to: a, amount: -net });
    }
  }
  return debts;
}

// owed[debtor][creditor] = cents debtor owes creditor, after settlements
function buildOwedMatrix(doc: GroupDocument): Record<string, Record<string, number>> {
  const expenses = getExpenses(doc);
  const settlements = getSettlements(doc);
  const owed: Record<string, Record<string, number>> = {};
  const add = (debtor: string, creditor: string, cents: number) => {
    if (debtor === creditor || cents === 0) return;
    owed[debtor] ??= {};
    owed[debtor][creditor] = (owed[debtor][creditor] || 0) + cents;
  };

  for (const e of expenses) {
    const totalPaid = e.payers.reduce((s, p) => s + p.amount, 0);
    if (totalPaid === 0) continue;
    for (const split of e.splits) {
      // Hamilton apportionment - split.amount distributed across payers in
      // integer cents so nothing fractional accumulates before the final round.
      const exact = e.payers.map(p => (split.amount * p.amount) / totalPaid);
      const floors = exact.map(Math.floor);
      let remainder = split.amount - floors.reduce((s, f) => s + f, 0);
      const order = e.payers.map((_, idx) => idx)
        .sort((a, b) => (exact[b] - floors[b]) - (exact[a] - floors[a]));
      const portions = [...floors];
      for (let k = 0; k < remainder; k++) portions[order[k]]++;
      for (let k = 0; k < e.payers.length; k++) {
        add(split.userId, e.payers[k].userId, portions[k]);
      }
    }
  }

  for (const s of settlements) {
    // A settlement payment reduces what `from` owes `to` (and may flip the sign).
    add(s.from, s.to, -s.amount);
  }
  return owed;
}
