import { useState } from 'react';
import { Header } from '@/components/layout/Header';
import { Card, CardContent } from '@/components/ui/card';
import { useGroupsStore } from '@/stores/groups.store';
import { useIdentityStore } from '@/stores/identity.store';
import { formatCents } from '@/lib/utils/currency';
import { toLocalDate } from '@/lib/utils/date';
import type { Expense } from '@/types';
import {
  startOfWeek, endOfWeek, subWeeks,
  startOfMonth, endOfMonth, subMonths,
  startOfYear, endOfYear, subYears,
  isWithinInterval, format,
} from 'date-fns';

type Granularity = 'week' | 'month' | 'year';

const RANGE_OPTIONS: Record<Granularity, number[]> = {
  week: [6, 12],
  month: [6, 12],
  year: [3, 5],
};

export function Stats() {
  const identity = useIdentityStore(s => s.identity);
  // re-render on document changes only, not on every store field
  const groupList = useGroupsStore(s => s.groupList);
  useGroupsStore(s => s.documents);
  const { getDocument, getExpenses: getGroupExpenses } = useGroupsStore.getState();
  const [granularity, setGranularity] = useState<Granularity>('month');
  const [rangeCount, setRangeCount] = useState<number>(6);

  if (!identity) {
    return (
      <div className="flex flex-col">
        <Header title="Stats" />
        <div className="flex items-center justify-center py-16">
          <div className="w-8 h-8 border-4 border-primary border-t-transparent rounded-full animate-spin" />
        </div>
      </div>
    );
  }

  let totalPaid = 0;
  let totalShare = 0;
  let totalExpenses = 0;
  // unlike paidByCurrency/shareByCurrency below, these two assume a single
  // currency across all of the user's groups and don't split by currency.
  const categoryTotals: Record<string, number> = {};
  const spentWithMap: Record<string, { name: string; amount: number; count: number }> = {};
  const myExpenses: Expense[] = [];
  // track per-currency totals to avoid mixing currencies
  const paidByCurrency: Record<string, number> = {};
  const shareByCurrency: Record<string, number> = {};

  for (const group of groupList) {
    const doc = getDocument(group.id);
    if (!doc) continue;
    const groupCurrency = doc.meta.settings.defaultCurrency || 'INR';

    const expenses = getGroupExpenses(group.id);

    for (const e of expenses) {
      let myPaid = 0;
      let myShare = 0;
      for (const p of e.payers) {
        if (p.userId === identity.peerId) myPaid += p.amount;
      }
      for (const s of e.splits) {
        if (s.userId === identity.peerId) myShare += s.amount;
      }
      totalPaid += myPaid;
      totalShare += myShare;
      paidByCurrency[groupCurrency] = (paidByCurrency[groupCurrency] || 0) + myPaid;
      shareByCurrency[groupCurrency] = (shareByCurrency[groupCurrency] || 0) + myShare;

      const cat = e.category || 'other';
      categoryTotals[cat] = (categoryTotals[cat] || 0) + e.totalAmount;

      const involvedInExpense = e.splits.some(s => s.userId === identity.peerId) ||
                                 e.payers.some(p => p.userId === identity.peerId);
      if (involvedInExpense) {
        myExpenses.push(e);
        const otherMembers = new Set<string>();
        for (const s of e.splits) {
          if (s.userId !== identity.peerId) otherMembers.add(s.userId);
        }
        for (const p of e.payers) {
          if (p.userId !== identity.peerId) otherMembers.add(p.userId);
        }
        for (const memberId of otherMembers) {
          if (!spentWithMap[memberId]) {
            const name = doc.members[memberId]?.displayName || 'Unknown';
            spentWithMap[memberId] = { name, amount: 0, count: 0 };
          }
          spentWithMap[memberId].amount += e.totalAmount;
          spentWithMap[memberId].count += 1;
        }
      }
    }

    totalExpenses += expenses.length;
  }

  const netBalance = totalPaid - totalShare;
  const sortedCategories = Object.entries(categoryTotals).sort((a, b) => b[1] - a[1]);
  const topSpentWith = Object.values(spentWithMap).sort((a, b) => b.amount - a.amount);

  // determine if all groups share a single currency
  const currencies = Object.keys(paidByCurrency);
  const allSameCurrency = currencies.length <= 1;
  const singleCurrency = currencies[0] || 'INR';

  // show empty state when there are no expenses at all
  if (totalExpenses === 0) {
    return (
      <div className="flex flex-col">
        <Header title="Statistics" />
        <div className="flex flex-col items-center justify-center py-16 px-4">
          <p className="text-muted-foreground text-center">No expenses yet. Add some expenses to see your statistics.</p>
        </div>
      </div>
    );
  }

  const now = new Date();
  const bucketRange = (offset: number) => {
    if (granularity === 'week') {
      const d = subWeeks(now, offset);
      return { start: startOfWeek(d), end: endOfWeek(d), label: format(startOfWeek(d), 'MMM d') };
    }
    if (granularity === 'year') {
      const d = subYears(now, offset);
      return { start: startOfYear(d), end: endOfYear(d), label: format(d, 'yyyy') };
    }
    const d = subMonths(now, offset);
    return { start: startOfMonth(d), end: endOfMonth(d), label: format(d, 'MMM') };
  };
  const histogram = Array.from({ length: rangeCount }, (_, i) => {
    const { start, end, label } = bucketRange(rangeCount - 1 - i);
    const total = myExpenses
      .filter(e => isWithinInterval(toLocalDate(e.date), { start, end }))
      .reduce((s, e) => s + e.totalAmount, 0);
    return { label, total };
  });
  const maxHistogram = Math.max(...histogram.map(h => h.total), 1);

  return (
    <div className="flex flex-col">
      <Header title="Statistics" />

      <div className="p-4 space-y-4">
        <div className="grid grid-cols-2 gap-3">
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-xs text-muted-foreground">Total Paid</p>
              {allSameCurrency ? (
                <p className="text-lg font-bold">{formatCents(totalPaid, singleCurrency)}</p>
              ) : (
                <div>{currencies.map(c => <p key={c} className="text-sm font-bold">{formatCents(paidByCurrency[c], c)}</p>)}</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-xs text-muted-foreground">Your Share</p>
              {allSameCurrency ? (
                <p className="text-lg font-bold">{formatCents(totalShare, singleCurrency)}</p>
              ) : (
                <div>{currencies.map(c => <p key={c} className="text-sm font-bold">{formatCents(shareByCurrency[c], c)}</p>)}</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-xs text-muted-foreground">Net Balance</p>
              {allSameCurrency ? (
                <p className={`text-lg font-bold ${netBalance >= 0 ? 'text-success' : 'text-destructive'}`}>
                  {netBalance >= 0 ? '+' : ''}{formatCents(netBalance, singleCurrency)}
                </p>
              ) : (
                <div>{currencies.map(c => {
                  const net = (paidByCurrency[c] || 0) - (shareByCurrency[c] || 0);
                  return <p key={c} className={`text-sm font-bold ${net >= 0 ? 'text-success' : 'text-destructive'}`}>{net >= 0 ? '+' : ''}{formatCents(net, c)}</p>;
                })}</div>
              )}
            </CardContent>
          </Card>
          <Card>
            <CardContent className="p-3 text-center">
              <p className="text-xs text-muted-foreground">Expenses</p>
              <p className="text-lg font-bold">{totalExpenses}</p>
            </CardContent>
          </Card>
        </div>

        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex items-center justify-between">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Expenses Over Time
              </h3>
              <div className="flex gap-1">
                {(['week', 'month', 'year'] as Granularity[]).map(g => (
                  <button
                    key={g}
                    type="button"
                    onClick={() => { setGranularity(g); setRangeCount(RANGE_OPTIONS[g][0]); }}
                    className={`rounded-md px-2 py-1 text-xs font-medium border capitalize ${
                      granularity === g
                        ? 'bg-primary text-primary-foreground border-primary'
                        : 'bg-background border-input text-muted-foreground'
                    }`}
                  >
                    {g}
                  </button>
                ))}
              </div>
            </div>
            <div className="flex gap-1 justify-end">
              {RANGE_OPTIONS[granularity].map(n => (
                <button
                  key={n}
                  type="button"
                  onClick={() => setRangeCount(n)}
                  className={`rounded-md px-2 py-0.5 text-[11px] font-medium border ${
                    rangeCount === n
                      ? 'bg-secondary border-secondary-foreground/20'
                      : 'bg-background border-input text-muted-foreground'
                  }`}
                >
                  Last {n}
                </button>
              ))}
            </div>
            <div className="flex items-end justify-between gap-1.5 h-32">
              {histogram.map((h, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-1 h-full justify-end min-w-0">
                  <div
                    className="w-full rounded-t-sm bg-primary min-h-[2px]"
                    style={{ height: `${Math.max((h.total / maxHistogram) * 100, h.total > 0 ? 4 : 0)}%` }}
                    title={formatCents(h.total)}
                  />
                  <span className="text-[9px] text-muted-foreground truncate w-full text-center">{h.label}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {topSpentWith.length > 0 && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Most Spent With
              </h3>
              {topSpentWith.slice(0, 5).map((person, i) => (
                <div key={i} className="flex items-center justify-between">
                  <div className="flex items-center gap-2">
                    <div className="w-8 h-8 rounded-full bg-primary/10 flex items-center justify-center text-xs font-medium text-primary">
                      {person.name[0]?.toUpperCase()}
                    </div>
                    <div>
                      <p className="text-sm font-medium">{person.name}</p>
                      <p className="text-xs text-muted-foreground">{person.count} expense{person.count !== 1 ? 's' : ''} together</p>
                    </div>
                  </div>
                  <p className="text-sm font-semibold">{formatCents(person.amount)}</p>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {sortedCategories.length > 0 && (
          <Card>
            <CardContent className="p-4 space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Spending by Category
              </h3>
              {sortedCategories.map(([category, amount]) => {
                const total = Object.values(categoryTotals).reduce((a, b) => a + b, 0);
                const pct = total > 0 ? Math.round(amount * 100 / total) : 0;
                return (
                  <div key={category} className="space-y-1">
                    <div className="flex justify-between text-sm">
                      <span className="capitalize">{category}</span>
                      <span className="font-medium">{formatCents(amount)} ({pct}%)</span>
                    </div>
                    <div className="h-2 rounded-full bg-muted overflow-hidden">
                      <div
                        className="h-full rounded-full bg-primary"
                        style={{ width: `${pct}%` }}
                      />
                    </div>
                  </div>
                );
              })}
            </CardContent>
          </Card>
        )}

        {sortedCategories.length === 0 && topSpentWith.length === 0 && (
          <div className="text-center py-8">
            <p className="text-muted-foreground">Add some expenses to see stats</p>
          </div>
        )}
      </div>
    </div>
  );
}
