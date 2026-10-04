import { useState } from 'react';
import { useParams } from 'react-router-dom';
import { Header } from '@/components/layout/Header';
import { Card, CardContent } from '@/components/ui/card';
import { useGroupsStore } from '@/stores/groups.store';
import { formatCents } from '@/lib/utils/currency';
import { toLocalDate } from '@/lib/utils/date';
import { startOfMonth, endOfMonth, startOfYear, endOfYear, isWithinInterval, subMonths, format } from 'date-fns';

type Period = 'month' | 'year' | 'all';

export function GroupStats() {
  const { groupId } = useParams<{ groupId: string }>();
  const doc = useGroupsStore(s => (groupId ? s.documents[groupId] : undefined));
  const getExpenses = useGroupsStore(s => s.getExpenses);
  const [period, setPeriod] = useState<Period>('month');

  if (!groupId) return null;
  if (!doc) return <div className="p-4">Group not found</div>;

  const currency = doc.meta.settings.defaultCurrency;
  const allExpenses = getExpenses(groupId);
  const now = new Date();

  const periodRange = period === 'month'
    ? { start: startOfMonth(now), end: endOfMonth(now) }
    : period === 'year'
    ? { start: startOfYear(now), end: endOfYear(now) }
    : null;

  const periodExpenses = periodRange
    ? allExpenses.filter(e => isWithinInterval(toLocalDate(e.date), periodRange))
    : allExpenses;

  const periodTotal = periodExpenses.reduce((s, e) => s + e.totalAmount, 0);

  // Monthly trend for the last 6 months, independent of the period toggle
  const months = Array.from({ length: 6 }, (_, i) => subMonths(now, 5 - i));
  const monthlyTotals = months.map(m => {
    const range = { start: startOfMonth(m), end: endOfMonth(m) };
    const total = allExpenses
      .filter(e => isWithinInterval(toLocalDate(e.date), range))
      .reduce((s, e) => s + e.totalAmount, 0);
    return { label: format(m, 'MMM'), total };
  });
  const maxMonthly = Math.max(...monthlyTotals.map(m => m.total), 1);

  // Who spent how much (amount each member paid) within the selected period
  const memberTotals: Record<string, number> = {};
  for (const e of periodExpenses) {
    for (const p of e.payers) {
      memberTotals[p.userId] = (memberTotals[p.userId] || 0) + p.amount;
    }
  }
  const sortedMembers = Object.entries(memberTotals)
    .map(([id, amount]) => ({ id, amount, name: doc.members[id]?.displayName || 'Unknown' }))
    .sort((a, b) => b.amount - a.amount);
  const maxMemberAmount = Math.max(...sortedMembers.map(m => m.amount), 1);

  const periodLabel = period === 'month' ? 'this month' : period === 'year' ? 'this year' : 'all time';

  return (
    <div className="flex flex-col">
      <Header title={`${doc.meta.name} Stats`} showBack />

      <div className="p-4 space-y-4">
        <div className="flex gap-2">
          {(['month', 'year', 'all'] as Period[]).map(p => (
            <button
              key={p}
              type="button"
              onClick={() => setPeriod(p)}
              className={`flex-1 rounded-md py-1.5 text-sm font-medium border transition-colors ${
                period === p
                  ? 'bg-primary text-primary-foreground border-primary'
                  : 'bg-background border-input text-muted-foreground'
              }`}
            >
              {p === 'month' ? 'This Month' : p === 'year' ? 'This Year' : 'All Time'}
            </button>
          ))}
        </div>

        <Card>
          <CardContent className="p-4 text-center space-y-1">
            <p className="text-xs text-muted-foreground uppercase tracking-wide">
              Total spent {periodLabel}
            </p>
            <p className="text-2xl font-bold">{formatCents(periodTotal, currency)}</p>
            <p className="text-xs text-muted-foreground">
              {periodExpenses.length} expense{periodExpenses.length !== 1 ? 's' : ''}
            </p>
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Monthly Trend
            </h3>
            <div className="flex items-end justify-between gap-2 h-32">
              {monthlyTotals.map((m, i) => (
                <div key={i} className="flex-1 flex flex-col items-center gap-1 h-full justify-end">
                  <span className="text-[10px] text-muted-foreground">
                    {m.total > 0 ? formatCents(m.total, currency) : ''}
                  </span>
                  <div
                    className="w-full rounded-t-sm bg-primary min-h-[2px]"
                    style={{ height: `${Math.max((m.total / maxMonthly) * 100, m.total > 0 ? 4 : 0)}%` }}
                  />
                  <span className="text-[10px] text-muted-foreground">{m.label}</span>
                </div>
              ))}
            </div>
          </CardContent>
        </Card>

        {sortedMembers.length > 0 ? (
          <Card>
            <CardContent className="p-4 space-y-3">
              <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
                Who Spent How Much
              </h3>
              {sortedMembers.map(m => (
                <div key={m.id} className="space-y-1">
                  <div className="flex justify-between text-sm">
                    <span className="font-medium">{m.name}</span>
                    <span className="font-medium">{formatCents(m.amount, currency)}</span>
                  </div>
                  <div className="h-2 rounded-full bg-muted overflow-hidden">
                    <div
                      className="h-full rounded-full bg-primary"
                      style={{ width: `${(m.amount / maxMemberAmount) * 100}%` }}
                    />
                  </div>
                </div>
              ))}
            </CardContent>
          </Card>
        ) : (
          <div className="text-center py-8">
            <p className="text-sm text-muted-foreground">No expenses {periodLabel}</p>
          </div>
        )}
      </div>
    </div>
  );
}
