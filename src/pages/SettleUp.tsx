import { useState } from 'react';
import { useParams, useNavigate } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Header } from '@/components/layout/Header';
import { useGroupsStore } from '@/stores/groups.store';
import { useIdentityStore } from '@/stores/identity.store';
import { formatCents, SUPPORTED_CURRENCIES, getAmountValidationError } from '@/lib/utils/currency';
import { MAX_LENGTHS } from '@/lib/utils/validation';
import { getMemberNames } from '@/lib/crdt/queries';
import { MAX_AMOUNT_CENTS } from '@/lib/crdt/operations';

export function SettleUp() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const doc = useGroupsStore(s => (groupId ? s.documents[groupId] : undefined));
  const getSimplifiedDebts = useGroupsStore(s => s.getSimplifiedDebts);
  const getPairwiseBalances = useGroupsStore(s => s.getPairwiseBalances);
  const addSettlement = useGroupsStore(s => s.addSettlement);
  const identity = useIdentityStore(s => s.identity);

  const [fromId, setFromId] = useState('');
  const [toId, setToId] = useState('');
  const [amount, setAmount] = useState('');
  const [note, setNote] = useState('');
  // one settlement per tap
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');

  if (!groupId) return null;
  if (!doc) return <div className="p-4">Group not found</div>;

  const debts = getSimplifiedDebts(groupId);
  const pairwiseBalances = identity ? getPairwiseBalances(groupId, identity.peerId) : [];
  const members = Object.entries(doc.members);
  // a debt can still involve someone who has since been removed
  const memberNames = getMemberNames(doc);
  const currency = doc.meta.settings.defaultCurrency;
  const currencySymbol = SUPPORTED_CURRENCIES.find(c => c.code === currency)?.symbol || '$';

  // getPairwiseBalances(from) is positive when `to` owes `from`, so what
  // `from` owes `to` is the negation
  const fromOwesTo = (() => {
    if (!fromId || !toId || fromId === toId) return null;
    const entry = getPairwiseBalances(groupId, fromId).find(b => b.peerId === toId);
    return entry ? -entry.amount : 0;
  })();
  const amountCentsCustom = Math.round(parseFloat(amount) * 100);
  const isOverpayment = fromOwesTo !== null && fromOwesTo > 0 && !isNaN(amountCentsCustom)
    && amountCentsCustom > fromOwesTo;

  const record = (from: string, to: string, amountCents: number, settlementNote: string) => {
    if (isSubmitting) return;
    setIsSubmitting(true);
    const saved = addSettlement(groupId, {
      groupId,
      from,
      to,
      amount: amountCents,
      date: new Date().toISOString(),
      note: settlementNote,
      settlesExpenses: [],
    });
    if (!saved) {
      setIsSubmitting(false);
      setSubmitError('Could not record this settlement. Please try again.');
      return;
    }
    navigate(`/group/${groupId}`);
  };

  const handleSettle = () => {
    const amountCents = Math.round(parseFloat(amount) * 100);
    if (!fromId || !toId || isNaN(amountCents) || amountCents <= 0 || amountCents > MAX_AMOUNT_CENTS) return;
    record(fromId, toId, amountCents, note);
  };

  const handleQuickSettle = (from: string, to: string, amt: number) => {
    record(from, to, amt, 'Full settlement');
  };

  return (
    <div className="flex flex-col">
      <Header title="Settle Up" showBack />

      <div className="p-4 space-y-4">
        {/* Suggested settlements */}
        {debts.length > 0 && (
          <div className="space-y-2">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Suggested Settlements
            </h3>
            {debts.map((debt, i) => (
              <Card key={i}>
                <CardContent className="p-3 flex items-center justify-between">
                  <div>
                    <p className="text-sm">
                      <span className="font-medium">{memberNames[debt.from]}</span>
                      {' pays '}
                      <span className="font-medium">{memberNames[debt.to]}</span>
                    </p>
                    <p className="text-lg font-bold">
                      {formatCents(debt.amount, doc.meta.settings.defaultCurrency)}
                    </p>
                  </div>
                  <Button
                    size="sm"
                    disabled={isSubmitting}
                    onClick={() => handleQuickSettle(debt.from, debt.to, debt.amount)}
                  >
                    Settle
                  </Button>
                </CardContent>
              </Card>
            ))}
          </div>
        )}

        {debts.length === 0 && (
          <Card>
            <CardContent className="p-4 text-center">
              <p className="text-muted-foreground">Everyone is settled up!</p>
            </CardContent>
          </Card>
        )}

        {/* Individual balances, settled one-on-one regardless of group-wide simplification */}
        {identity && pairwiseBalances.length > 0 && (
          <div className="space-y-2 border-t pt-4">
            <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
              Settle Individually
            </h3>
            <p className="text-xs text-muted-foreground">
              Your balance with each member, so you can settle with them separately.
            </p>
            {pairwiseBalances.map(balance => {
              const theyOweYou = balance.amount > 0;
              const from = theyOweYou ? balance.peerId : identity.peerId;
              const to = theyOweYou ? identity.peerId : balance.peerId;
              return (
                <Card key={balance.peerId}>
                  <CardContent className="p-3 flex items-center justify-between">
                    <div>
                      <p className="text-sm">
                        <span className="font-medium">{memberNames[balance.peerId] || 'Unknown'}</span>
                        {theyOweYou ? ' owes you' : ' (you owe)'}
                      </p>
                      <p className={`text-lg font-bold ${theyOweYou ? 'text-success' : 'text-destructive'}`}>
                        {formatCents(Math.abs(balance.amount), currency)}
                      </p>
                    </div>
                    <Button
                      size="sm"
                      disabled={isSubmitting}
                      onClick={() => handleQuickSettle(from, to, Math.abs(balance.amount))}
                    >
                      Settle
                    </Button>
                  </CardContent>
                </Card>
              );
            })}
          </div>
        )}

        {/* Custom settlement */}
        <div className="space-y-3 border-t pt-4">
          <h3 className="text-sm font-medium text-muted-foreground uppercase tracking-wide">
            Custom Settlement
          </h3>

          <div className="space-y-2">
            <Label htmlFor="from">From</Label>
            <Select id="from" value={fromId} onChange={e => setFromId(e.target.value)}>
              <option value="">Select who paid</option>
              {members.map(([id, member]) => (
                <option key={id} value={id}>{member.displayName}</option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="to">To</Label>
            <Select id="to" value={toId} onChange={e => setToId(e.target.value)}>
              <option value="">Select who received</option>
              {members.map(([id, member]) => (
                <option key={id} value={id}>{member.displayName}</option>
              ))}
            </Select>
          </div>

          <div className="space-y-2">
            <Label htmlFor="settle-amount">Amount</Label>
            <div className="relative">
              <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">{currencySymbol}</span>
              <Input
                id="settle-amount"
                type="number"
                step="0.01"
                min="0"
                placeholder="0.00"
                value={amount}
                onChange={e => setAmount(e.target.value)}
                className="pl-7"
              />
            </div>
            {getAmountValidationError(amount) && (
              <p className="text-xs text-destructive">{getAmountValidationError(amount)}</p>
            )}
            {fromOwesTo !== null && fromOwesTo > 0 && (
              <p className="text-xs text-muted-foreground">
                Current balance: {memberNames[fromId]} owes {memberNames[toId]} {formatCents(fromOwesTo, currency)}
              </p>
            )}
            {fromOwesTo !== null && fromOwesTo < 0 && (
              <p className="text-xs text-warning">
                {memberNames[toId]} owes {memberNames[fromId]} {formatCents(-fromOwesTo, currency)}. A payment this way adds to that debt, check From and To.
              </p>
            )}
            {fromOwesTo === 0 && (
              <p className="text-xs text-muted-foreground">
                These two are even right now, so this payment starts a new balance.
              </p>
            )}
            {isOverpayment && (
              <p className="text-xs text-warning">
                Amount exceeds the outstanding balance (this will create an overpayment).
              </p>
            )}
          </div>

          <div className="space-y-2">
            <Label htmlFor="settle-note">Note (optional)</Label>
            <Input
              id="settle-note"
              placeholder="e.g., Venmo transfer"
              value={note}
              maxLength={MAX_LENGTHS.notes}
              onChange={e => setNote(e.target.value)}
            />
          </div>

          {submitError && <p className="text-sm text-destructive" role="alert">{submitError}</p>}

          <Button
            className="w-full"
            onClick={handleSettle}
            disabled={isSubmitting || !fromId || !toId || fromId === toId || !amount || parseFloat(amount) <= 0}
          >
            Record Settlement
          </Button>
        </div>
      </div>
    </div>
  );
}
