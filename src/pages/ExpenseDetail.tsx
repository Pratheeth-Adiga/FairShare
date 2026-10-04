import { useParams, useNavigate } from 'react-router-dom';
import { Trash2, Pencil, Send, X, History } from 'lucide-react';
import { useState } from 'react';
import { Button } from '@/components/ui/button';
import { Card, CardContent } from '@/components/ui/card';
import { Badge } from '@/components/ui/badge';
import { Header } from '@/components/layout/Header';
import { useGroupsStore } from '@/stores/groups.store';
import { useIdentityStore } from '@/stores/identity.store';
import { formatCents } from '@/lib/utils/currency';
import { formatExpenseDate } from '@/lib/utils/date';
import { getExpenseCategories, getMemberNames } from '@/lib/crdt/queries';
import { categoryLabel } from '@/lib/utils/categories';

const FIELD_LABELS: Record<string, string> = {
  description: 'Description',
  totalAmount: 'Amount',
  category: 'Category',
  categories: 'Categories',
  date: 'Date',
  notes: 'Notes',
  payers: 'Paid by',
  splits: 'Split',
  splitType: 'Split type',
};

function formatHistoryValue(value: unknown): string {
  if (typeof value === 'string') return value || '(empty)';
  if (typeof value === 'number' || typeof value === 'boolean') return String(value);
  if (value === null || value === undefined) return '(empty)';
  return JSON.stringify(value);
}

export function ExpenseDetail() {
  const { groupId, expenseId } = useParams<{ groupId: string; expenseId: string }>();
  const navigate = useNavigate();
  const { removeExpense, addComment, removeComment } = useGroupsStore.getState();
  const doc = useGroupsStore(s => (groupId ? s.documents[groupId] : undefined));
  const identity = useIdentityStore(s => s.identity);
  const [commentText, setCommentText] = useState('');
  const [showHistory, setShowHistory] = useState(false);
  const [confirmDeleteExpense, setConfirmDeleteExpense] = useState(false);
  const [confirmDeleteCommentId, setConfirmDeleteCommentId] = useState<string | null>(null);

  if (!groupId || !expenseId) return null;
  if (!doc) return <div className="p-4">Group not found</div>;

  const expense = doc.expenses[expenseId];
  if (!expense) return <div className="p-4">Expense not found</div>;

  const memberNames = getMemberNames(doc);

  const handleDelete = () => {
    removeExpense(groupId, expenseId);
    navigate(`/group/${groupId}`, { replace: true });
  };

  const handleAddComment = () => {
    if (!identity || !commentText.trim()) return;
    addComment(groupId, expenseId, identity.peerId, commentText.trim());
    setCommentText('');
  };

  const comments = expense.comments || [];
  const editHistory = expense.editHistory || [];

  return (
    <div className="flex flex-col">
      <Header
        title="Expense Detail"
        showBack
        rightAction={doc.meta.state === 'active' ? (
          <div className="flex gap-1">
            <Button
              variant="ghost"
              size="icon"
              title="Edit expense"
              onClick={() => navigate(`/group/${groupId}/expense/${expenseId}/edit`, {
                state: { returnTo: `/group/${groupId}/expense/${expenseId}` },
              })}
            >
              <Pencil className="h-5 w-5" />
            </Button>
            <Button variant="ghost" size="icon" title="Delete expense" onClick={() => setConfirmDeleteExpense(true)}>
              <Trash2 className="h-5 w-5 text-destructive" />
            </Button>
          </div>
        ) : null}
      />

      <div className="p-4 space-y-4">
        {confirmDeleteExpense && (
          <Card className="border-destructive">
            <CardContent className="p-4 space-y-2">
              <p className="text-sm text-destructive font-medium text-center">Delete this expense? This cannot be undone.</p>
              <div className="flex gap-2">
                <Button variant="outline" className="flex-1" onClick={() => setConfirmDeleteExpense(false)}>Cancel</Button>
                <Button variant="destructive" className="flex-1" onClick={handleDelete}>Confirm Delete</Button>
              </div>
            </CardContent>
          </Card>
        )}
        <Card>
          <CardContent className="p-4 space-y-3">
            <div className="flex justify-between items-start gap-2">
              <div>
                <h2 className="text-xl font-bold">{expense.description}</h2>
                <p className="text-sm text-muted-foreground">
                  {formatExpenseDate(expense.date, {
                    weekday: 'long',
                    year: 'numeric',
                    month: 'long',
                    day: 'numeric',
                  })}
                </p>
              </div>
              <div className="flex flex-wrap gap-1 justify-end">
                {getExpenseCategories(expense).map(cat => (
                  <Badge key={cat} variant="secondary">{categoryLabel(doc.meta.settings, cat)}</Badge>
                ))}
              </div>
            </div>

            <div className="text-3xl font-bold text-center py-2">
              {formatCents(expense.totalAmount, expense.currency)}
            </div>

            {expense.notes && (
              <p className="text-sm text-muted-foreground italic">"{expense.notes}"</p>
            )}

            {expense.updatedAt && (
              <p className="text-xs text-muted-foreground text-center">
                Last updated {new Date(expense.updatedAt).toLocaleString()}
              </p>
            )}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">Paid by</h3>
            {expense.payers.map(payer => (
              <div key={payer.userId} className="flex justify-between">
                <span className="text-sm">{memberNames[payer.userId] || 'Unknown'}</span>
                <span className="text-sm font-medium">
                  {formatCents(payer.amount, expense.currency)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        <Card>
          <CardContent className="p-4 space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Split ({expense.splitType})
            </h3>
            {expense.splits.map(split => (
              <div key={split.userId} className="flex justify-between">
                <span className="text-sm">{memberNames[split.userId] || 'Unknown'}</span>
                <span className="text-sm font-medium">
                  {formatCents(split.amount, expense.currency)}
                </span>
              </div>
            ))}
          </CardContent>
        </Card>

        {editHistory.length > 0 && (
          <Card>
            <CardContent className="p-4 space-y-2">
              <button
                type="button"
                className="flex items-center gap-2 text-sm font-medium text-muted-foreground uppercase tracking-wide w-full"
                onClick={() => setShowHistory(v => !v)}
              >
                <History className="h-4 w-4" />
                Edit History ({editHistory.length})
              </button>
              {showHistory && (
                <div className="space-y-3 pt-1">
                  {[...editHistory].reverse().map((record, i) => (
                    <div key={i} className="text-sm border-l-2 border-muted pl-3">
                      <div className="text-muted-foreground text-xs">
                        {memberNames[record.editedBy] || record.editedBy} · {new Date(record.editedAt).toLocaleString()}
                      </div>
                      <ul className="mt-1 space-y-0.5">
                        {Object.entries(record.changes).map(([field, change]) => (
                          <li key={field}>
                            <span className="font-medium">{FIELD_LABELS[field] || field}</span>
                            {' changed from '}
                            <span className="font-medium">{formatHistoryValue(change.from)}</span>
                            {' to '}
                            <span className="font-medium">{formatHistoryValue(change.to)}</span>
                          </li>
                        ))}
                      </ul>
                    </div>
                  ))}
                </div>
              )}
            </CardContent>
          </Card>
        )}

        <Card>
          <CardContent className="p-4 space-y-3">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Comments ({comments.length})
            </h3>
            {comments.length > 0 && (
              <div className="space-y-2">
                {comments.map(comment => (
                  <div key={comment.id} className="flex justify-between items-start gap-2 bg-muted/50 rounded-md p-2">
                    <div>
                      <div className="text-xs text-muted-foreground">
                        {memberNames[comment.authorId] || 'Unknown'} · {new Date(comment.createdAt).toLocaleString()}
                      </div>
                      <div className="text-sm">{comment.text}</div>
                    </div>
                    {identity?.peerId === comment.authorId && (
                      confirmDeleteCommentId === comment.id ? (
                        <div className="flex items-center gap-1 shrink-0">
                          <button
                            type="button"
                            className="text-xs text-destructive font-medium"
                            onClick={() => { removeComment(groupId, expenseId, comment.id); setConfirmDeleteCommentId(null); }}
                          >
                            Delete
                          </button>
                          <button
                            type="button"
                            className="text-xs text-muted-foreground"
                            onClick={() => setConfirmDeleteCommentId(null)}
                          >
                            Cancel
                          </button>
                        </div>
                      ) : (
                        <button
                          type="button"
                          aria-label="Delete comment"
                          className="text-muted-foreground hover:text-destructive shrink-0"
                          onClick={() => setConfirmDeleteCommentId(comment.id)}
                        >
                          <X className="h-4 w-4" />
                        </button>
                      )
                    )}
                  </div>
                ))}
              </div>
            )}
            <div className="flex gap-2">
              <input
                className="flex-1 rounded-md border border-input bg-background px-3 py-2 text-sm"
                placeholder="Add a comment..."
                value={commentText}
                maxLength={500}
                onChange={e => setCommentText(e.target.value)}
                onKeyDown={e => { if (e.key === 'Enter') handleAddComment(); }}
              />
              <Button type="button" size="icon" title="Send comment" disabled={!commentText.trim()} onClick={handleAddComment}>
                <Send className="h-4 w-4" />
              </Button>
            </div>
          </CardContent>
        </Card>
      </div>
    </div>
  );
}
