import type { BalanceMap } from './calculator';

export interface Transaction {
  from: string;
  to: string;
  amount: number;
}

export function simplifyDebts(balances: BalanceMap): Transaction[] {
  const creditors: [string, number][] = [];
  const debtors: [string, number][] = [];

  for (const [userId, amount] of Object.entries(balances)) {
    if (amount > 0) {
      creditors.push([userId, amount]);
    } else if (amount < 0) {
      debtors.push([userId, -amount]);
    }
  }

  // Sort ties by userId so identical balances produce identical plans on every peer.
  creditors.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));
  debtors.sort((a, b) => b[1] - a[1] || (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0));

  const transactions: Transaction[] = [];
  let i = 0;
  let j = 0;

  while (i < creditors.length && j < debtors.length) {
    const [creditor, credit] = creditors[i];
    const [debtor, debt] = debtors[j];
    const transfer = Math.min(credit, debt);

    if (transfer > 0) {
      transactions.push({ from: debtor, to: creditor, amount: transfer });
    }

    creditors[i] = [creditor, credit - transfer];
    debtors[j] = [debtor, debt - transfer];

    if (creditors[i][1] === 0) i++;
    if (debtors[j][1] === 0) j++;
  }

  return transactions;
}
