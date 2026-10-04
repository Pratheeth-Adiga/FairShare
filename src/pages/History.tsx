import { useState, useRef } from 'react';
import { Header } from '@/components/layout/Header';
import { Input } from '@/components/ui/input';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { useGroupsStore } from '@/stores/groups.store';
import { formatCents } from '@/lib/utils/currency';
import { formatExpenseDate } from '@/lib/utils/date';
import { useNavigate } from 'react-router-dom';
import { useVirtualizer } from '@tanstack/react-virtual';

const ITEM_HEIGHT = 72;

export function HistoryPage() {
  const [search, setSearch] = useState('');
  const navigate = useNavigate();
  const groupList = useGroupsStore(s => s.groupList);
  const documents = useGroupsStore(s => s.documents);
  const getExpenses = useGroupsStore(s => s.getExpenses);
  const parentRef = useRef<HTMLDivElement>(null);

  const allExpenses = groupList.flatMap(group => {
    const expenses = getExpenses(group.id);
    return expenses
      .filter(e => e.groupId)
      .map(e => ({ ...e, groupName: documents[group.id]?.meta.name || '' }));
  }).sort((a, b) => new Date(b.date).getTime() - new Date(a.date).getTime());

  const filtered = search
    ? allExpenses.filter(e =>
        e.description.toLowerCase().includes(search.toLowerCase()) ||
        e.category.toLowerCase().includes(search.toLowerCase())
      )
    : allExpenses;

  const virtualizer = useVirtualizer({
    count: filtered.length,
    getScrollElement: () => parentRef.current,
    estimateSize: () => ITEM_HEIGHT,
    overscan: 10,
  });

  return (
    <div className="flex flex-col h-full">
      <Header title="History" />

      <div className="p-4 pb-2">
        <Input
          placeholder="Search expenses..."
          value={search}
          onChange={e => setSearch(e.target.value)}
        />
      </div>

      {filtered.length === 0 ? (
        <div className="text-center py-8">
          <p className="text-muted-foreground">
            {search ? 'No expenses match your search' : 'No expenses yet'}
          </p>
        </div>
      ) : (
        <div ref={parentRef} className="flex-1 overflow-auto px-4 pb-4">
          <div style={{ height: virtualizer.getTotalSize(), position: 'relative' }}>
            {virtualizer.getVirtualItems().map(virtualRow => {
              const expense = filtered[virtualRow.index];
              return (
                <div
                  key={expense.id}
                  style={{
                    position: 'absolute',
                    top: virtualRow.start,
                    left: 0,
                    right: 0,
                    height: virtualRow.size,
                  }}
                >
                  <Card
                    className="cursor-pointer hover:bg-accent/50 transition-colors mb-2"
                    onClick={() => navigate(`/group/${expense.groupId}/expense/${expense.id}`)}
                  >
                    <CardContent className="p-3 flex items-center justify-between">
                      <div>
                        <p className="font-medium text-sm">{expense.description}</p>
                        <p className="text-xs text-muted-foreground">
                          {expense.groupName} · {formatExpenseDate(expense.date)}
                        </p>
                      </div>
                      <div className="text-right">
                        <p className="font-semibold text-sm">
                          {formatCents(expense.totalAmount, expense.currency)}
                        </p>
                        <Badge variant="secondary" className="text-xs">
                          {expense.category}
                        </Badge>
                      </div>
                    </CardContent>
                  </Card>
                </div>
              );
            })}
          </div>
        </div>
      )}
    </div>
  );
}
