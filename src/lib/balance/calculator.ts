import type { Expense, Settlement, PeerId } from '@/types';
import { apportionCents } from '@/lib/utils/apportion';

export interface BalanceMap {
  [userId: string]: number;
}

export function calculateBalances(expenses: Expense[], settlements: Settlement[]): BalanceMap {
  const balances: BalanceMap = {};

  for (const expense of expenses) {
    for (const payer of expense.payers) {
      balances[payer.userId] = (balances[payer.userId] || 0) + payer.amount;
    }
    for (const split of expense.splits) {
      balances[split.userId] = (balances[split.userId] || 0) - split.amount;
    }
  }

  for (const settlement of settlements) {
    balances[settlement.from] = (balances[settlement.from] || 0) + settlement.amount;
    balances[settlement.to] = (balances[settlement.to] || 0) - settlement.amount;
  }

  return balances;
}

export function getNetBalance(balances: BalanceMap, userId: PeerId): number {
  return balances[userId] || 0;
}

export function getTotalGroupSpend(expenses: Expense[]): number {
  return expenses.reduce((sum, e) => sum + e.totalAmount, 0);
}

export function getUserPaid(expenses: Expense[], userId: PeerId): number {
  let total = 0;
  for (const e of expenses) {
    for (const p of e.payers) {
      if (p.userId === userId) total += p.amount;
    }
  }
  return total;
}

export function getUserShare(expenses: Expense[], userId: PeerId): number {
  let total = 0;
  for (const e of expenses) {
    for (const s of e.splits) {
      if (s.userId === userId) total += s.amount;
    }
  }
  return total;
}

export interface CategoryBreakdown {
  [category: string]: number;
}

export function getCategoryBreakdown(expenses: Expense[]): CategoryBreakdown {
  const breakdown: CategoryBreakdown = {};
  for (const e of expenses) {
    // split multi-category expenses proportionally to match getGroupStats
    const cats = (e.categories && e.categories.length > 0) ? e.categories : [e.category || 'other'];
    for (const [cat, share] of Object.entries(apportionCents(e.totalAmount, cats))) {
      breakdown[cat] = (breakdown[cat] || 0) + share;
    }
  }
  return breakdown;
}
