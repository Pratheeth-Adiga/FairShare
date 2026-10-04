import { useState, useReducer, useEffect } from 'react';
import { useParams, useNavigate, useLocation } from 'react-router-dom';
import { Button } from '@/components/ui/button';
import { Input } from '@/components/ui/input';
import { Label } from '@/components/ui/label';
import { Select } from '@/components/ui/select';
import { Card, CardContent } from '@/components/ui/card';
import { Header } from '@/components/layout/Header';
import { useGroupsStore } from '@/stores/groups.store';
import { useIdentityStore } from '@/stores/identity.store';
import { calculateSplits } from '@/lib/balance/split';
import { isSplitValid, isPayerValid } from '@/lib/balance/validation';
import { formatCents, SUPPORTED_CURRENCIES, getAmountValidationError } from '@/lib/utils/currency';
import { todayLocalYMD } from '@/lib/utils/date';
import { MAX_LENGTHS } from '@/lib/utils/validation';
import { getCategoryOptions } from '@/lib/utils/categories';
import type { SplitType } from '@/types';
// the form state machine is shared with EditExpense
import {
  SPLIT_TYPES,
  WEIGHTED_SPLIT_TYPES,
  expenseFormReducer,
  createInitialExpenseFormState,
  splitInputsFor,
} from '@/lib/forms/expense-form';
import { generateExpenseId } from '@/lib/crypto/identity';
import { MAX_AMOUNT_CENTS } from '@/lib/crdt/operations';

export function AddExpense() {
  const { groupId } = useParams<{ groupId: string }>();
  const navigate = useNavigate();
  const location = useLocation();
  const identity = useIdentityStore(s => s.identity);
  const getDocument = useGroupsStore(s => s.getDocument);
  const addExpense = useGroupsStore(s => s.addExpense);
  const doc = useGroupsStore(s => (groupId ? s.documents[groupId] : undefined));

  // the id doubles as the rounding seed, and also stops a second tap from saving the same expense twice
  const [expenseId] = useState(() => generateExpenseId());
  const [isSubmitting, setIsSubmitting] = useState(false);
  const [submitError, setSubmitError] = useState('');
  const [formState, dispatch] = useReducer(
    expenseFormReducer,
    undefined,
    () => createInitialExpenseFormState(
      identity?.peerId || '',
      todayLocalYMD(),
      groupId ? getDocument(groupId)?.meta.settings.defaultSplitType : undefined,
    ),
  );
  const {
    description, amount, categories, payerId, multiPayer, payerAmounts,
    splitType, selectedMembers, notes, date, exactAmounts, percentages, shares,
  } = formState;

  const members = doc ? Object.entries(doc.members) : [];
  const currency = doc?.meta.settings.defaultCurrency || 'INR';
  const currencySymbol = SUPPORTED_CURRENCIES.find(c => c.code === currency)?.symbol || '$';

  useEffect(() => {
    if (selectedMembers.length === 0 && members.length > 0) {
      dispatch({ type: 'INIT_SELECTED_MEMBERS', memberIds: members.map(([id]) => id) });
    }
  }, [members.length]);

  // prune any selected/split member no longer in the group (a peer could
  // have removed them while this form was open).
  const memberIdsKey = members.map(([id]) => id).join(',');
  useEffect(() => {
    dispatch({ type: 'PRUNE_REMOVED_MEMBERS', currentMemberIds: members.map(([id]) => id) });
  }, [memberIdsKey]);

  useEffect(() => {
    dispatch({ type: 'INIT_MISSING_SHARES', memberIds: selectedMembers });
  }, [selectedMembers]);

  if (!groupId) return null;
  if (!doc) return <div className="p-4">Group not found</div>;

  const amountCents = Math.round(parseFloat(amount) * 100);
  const isValidAmount = !isNaN(amountCents) && amountCents > 0 && amountCents <= MAX_AMOUNT_CENTS;

  const getSplitParams = () => {
    switch (splitType) {
      case 'exact':
        return Object.fromEntries(
          selectedMembers.map(id => [id, Math.round(parseFloat(exactAmounts[id] || '0') * 100)])
        );
      case 'percentage':
        return Object.fromEntries(
          selectedMembers.map(id => [id, parseFloat(percentages[id] || '0')])
        );
      case 'shares':
      case 'by_weight':
        return Object.fromEntries(
          selectedMembers.map(id => [id, parseFloat(shares[id] || '0')])
        );
      default:
        return undefined;
    }
  };

  const getPreviewSplits = () => {
    if (!isValidAmount || selectedMembers.length === 0) return null;
    try {
      return calculateSplits(amountCents, splitType, selectedMembers, getSplitParams(), expenseId);
    } catch {
      return null;
    }
  };

  const previewSplits = getPreviewSplits();

  const splitValid = isSplitValid(splitType, selectedMembers, amountCents, { exactAmounts, percentages, shares });
  const payerValid = isPayerValid(multiPayer, payerId, payerAmounts, amountCents);

  const handleSubmit = () => {
    if (isSubmitting) return;
    if (!description.trim() || !isValidAmount || !splitValid || !payerValid || !identity || categories.length === 0) return;

    const splits = calculateSplits(amountCents, splitType, selectedMembers, getSplitParams(), expenseId);

    let payers: { userId: string; amount: number }[];
    if (multiPayer) {
      payers = Object.entries(payerAmounts)
        .filter(([, amt]) => parseFloat(amt) > 0)
        .map(([userId, amt]) => ({ userId, amount: Math.round(parseFloat(amt) * 100) }));
    } else {
      if (!payerId) return;
      payers = [{ userId: payerId, amount: amountCents }];
    }

    // keep the raw shares, weights or percentages so Edit can show exactly what was typed
    const splitInputs = splitInputsFor(splitType, selectedMembers, percentages, shares);
    setIsSubmitting(true);
    const saved = addExpense(groupId, {
      id: expenseId,
      groupId,
      friendId: null,
      description: description.trim(),
      totalAmount: amountCents,
      currency,
      payers,
      splitType,
      splits: Object.entries(splits).map(([userId, splitAmount]) => ({ userId, amount: splitAmount })),
      items: [],
      category: categories[0] || 'other',
      categories,
      // keep the user-typed calendar day independent of timezones
      date: date || todayLocalYMD(),
      createdAt: new Date().toISOString(),
      createdBy: identity?.peerId || '',
      notes,
      ...(splitInputs ? { splitInputs } : {}),
    });
    if (!saved) {
      setIsSubmitting(false);
      setSubmitError('Could not save this expense. Check the amounts and try again.');
      return;
    }

    const groupPath = `/group/${groupId}`;
    if ((location.state as { returnTo?: string } | null)?.returnTo === groupPath) {
      navigate(-1);
    } else {
      navigate(groupPath, { replace: true });
    }
  };

  return (
    <div className="flex flex-col">
      <Header title="Add Expense" showBack />

      <div className="p-4 space-y-4">
        <div className="space-y-2">
          <Label htmlFor="description">Description</Label>
          <Input
            id="description"
            placeholder="What was it for?"
            value={description}
            onChange={e => dispatch({ type: 'SET_FIELD', field: 'description', value: e.target.value })}
            maxLength={MAX_LENGTHS.expenseDescription}
            autoFocus
          />
        </div>

        <div className="space-y-2">
          <Label htmlFor="amount">Amount ({currency})</Label>
          <div className="relative">
            <span className="absolute left-3 top-1/2 -translate-y-1/2 text-muted-foreground">
              {currencySymbol}
            </span>
            <Input
              id="amount"
              type="number"
              step="0.01"
              min="0"
              placeholder="0.00"
              value={amount}
              onChange={e => dispatch({ type: 'SET_FIELD', field: 'amount', value: e.target.value })}
              className="pl-7"
            />
          </div>
          {getAmountValidationError(amount) && (
            <p className="text-xs text-destructive">{getAmountValidationError(amount)}</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="date">Date</Label>
          <Input
            id="date"
            type="date"
            value={date}
            onChange={e => dispatch({ type: 'SET_FIELD', field: 'date', value: e.target.value })}
          />
        </div>

        <div className="space-y-2">
          <div className="flex items-center justify-between">
            <Label htmlFor="payer">Paid by</Label>
            <label className="flex items-center gap-1.5 cursor-pointer">
              <input
                type="checkbox"
                checked={multiPayer}
                onChange={e => dispatch({ type: 'SET_MULTI_PAYER', value: e.target.checked })}
                className="rounded border-input"
              />
              <span className="text-xs text-muted-foreground">Multiple payers</span>
            </label>
          </div>

          {!multiPayer ? (
            <Select id="payer" value={payerId} onChange={e => dispatch({ type: 'SET_FIELD', field: 'payerId', value: e.target.value })}>
              {members.map(([id, member]) => (
                <option key={id} value={id}>{member.displayName}</option>
              ))}
            </Select>
          ) : (
            <div className="space-y-2 border rounded-md p-3">
              <p className="text-xs text-muted-foreground">Enter amount each person paid</p>
              {members.map(([id, member]) => (
                <div key={id} className="flex items-center gap-2">
                  <span className="text-sm min-w-[80px]">{member.displayName}</span>
                  <div className="relative flex-1">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      {currencySymbol}
                    </span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={payerAmounts[id] || ''}
                      onChange={e => dispatch({ type: 'SET_MAP_VALUE', field: 'payerAmounts', memberId: id, value: e.target.value })}
                      className="pl-6 h-8 text-sm"
                    />
                  </div>
                </div>
              ))}
              {isValidAmount && (
                <p className={`text-xs ${
                  Math.abs(Object.values(payerAmounts).reduce((s, v) => s + Math.round(parseFloat(v || '0') * 100), 0) - amountCents) === 0
                    ? 'text-green-600' : 'text-red-500'
                }`}>
                  Total: {currencySymbol}{Object.values(payerAmounts).reduce((s, v) => s + parseFloat(v || '0'), 0).toFixed(2)} / {currencySymbol}{(amountCents / 100).toFixed(2)}
                </p>
              )}
            </div>
          )}
        </div>

        <div className="space-y-2">
          <Label>Categories</Label>
          <div className="flex flex-wrap gap-2 border rounded-md p-3">
            {getCategoryOptions(doc.meta.settings).map(c => (
              <label key={c.value} className="flex items-center gap-1.5 cursor-pointer text-sm">
                <input
                  type="checkbox"
                  checked={categories.includes(c.value)}
                  onChange={e => dispatch({ type: 'TOGGLE_ARRAY_ITEM', field: 'categories', value: c.value, checked: e.target.checked })}
                  className="rounded border-input"
                />
                {c.label}
              </label>
            ))}
          </div>
          {categories.length === 0 && (
            <p className="text-xs text-destructive">Select at least one category.</p>
          )}
        </div>

        <div className="space-y-2">
          <Label htmlFor="splitType">Split Type</Label>
          <Select
            id="splitType"
            value={splitType}
            onChange={e => dispatch({ type: 'SET_SPLIT_TYPE', value: e.target.value as SplitType })}
          >
            {SPLIT_TYPES.map(s => (
              <option key={s.value} value={s.value}>{s.label}</option>
            ))}
          </Select>
          <p className="text-xs text-muted-foreground">
            {SPLIT_TYPES.find(s => s.value === splitType)?.description}
          </p>
        </div>

        <div className="space-y-2">
          <Label>Split between</Label>
          <div className="space-y-2 border rounded-md p-3">
            {members.map(([id, member]) => (
              <label key={id} className="flex items-center gap-2 cursor-pointer">
                <input
                  type="checkbox"
                  checked={selectedMembers.includes(id)}
                  onChange={e => dispatch({ type: 'TOGGLE_ARRAY_ITEM', field: 'selectedMembers', value: id, checked: e.target.checked })}
                  className="rounded border-input"
                />
                <span className="text-sm">{member.displayName}</span>
              </label>
            ))}
          </div>
        </div>

        {/* Split detail inputs */}
        {splitType === 'exact' && selectedMembers.length > 0 && (
          <Card>
            <CardContent className="p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Enter exact amount for each person</p>
              {selectedMembers.map(id => (
                <div key={id} className="flex items-center gap-2">
                  <span className="text-sm min-w-[80px]">{doc.members[id]?.displayName}</span>
                  <div className="relative flex-1">
                    <span className="absolute left-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">
                      {currencySymbol}
                    </span>
                    <Input
                      type="number"
                      step="0.01"
                      min="0"
                      placeholder="0.00"
                      value={exactAmounts[id] || ''}
                      onChange={e => dispatch({ type: 'SET_MAP_VALUE', field: 'exactAmounts', memberId: id, value: e.target.value })}
                      className="pl-6 h-8 text-sm"
                    />
                  </div>
                </div>
              ))}
              {isValidAmount && (
                <p className={`text-xs ${
                  Math.abs(selectedMembers.reduce((s, id) => s + Math.round(parseFloat(exactAmounts[id] || '0') * 100), 0) - amountCents) === 0
                    ? 'text-green-600' : 'text-red-500'
                }`}>
                  Total: {currencySymbol}{(selectedMembers.reduce((s, id) => s + parseFloat(exactAmounts[id] || '0'), 0)).toFixed(2)} / {currencySymbol}{(amountCents / 100).toFixed(2)}
                </p>
              )}
            </CardContent>
          </Card>
        )}

        {splitType === 'percentage' && selectedMembers.length > 0 && (
          <Card>
            <CardContent className="p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">Enter percentage for each person (must total 100%)</p>
              {selectedMembers.map(id => (
                <div key={id} className="flex items-center gap-2">
                  <span className="text-sm min-w-[80px]">{doc.members[id]?.displayName}</span>
                  <div className="relative flex-1">
                    <Input
                      type="number"
                      step="1"
                      min="0"
                      max="100"
                      placeholder="0"
                      value={percentages[id] || ''}
                      onChange={e => dispatch({ type: 'SET_MAP_VALUE', field: 'percentages', memberId: id, value: e.target.value })}
                      className="h-8 text-sm pr-8"
                    />
                    <span className="absolute right-2 top-1/2 -translate-y-1/2 text-xs text-muted-foreground">%</span>
                  </div>
                </div>
              ))}
              <p className={`text-xs ${
                Math.abs(selectedMembers.reduce((s, id) => s + parseFloat(percentages[id] || '0'), 0) - 100) < 0.01
                  ? 'text-green-600' : 'text-red-500'
              }`}>
                Total: {selectedMembers.reduce((s, id) => s + parseFloat(percentages[id] || '0'), 0).toFixed(1)}%
              </p>
            </CardContent>
          </Card>
        )}

        {WEIGHTED_SPLIT_TYPES.includes(splitType) && selectedMembers.length > 0 && (
          <Card>
            <CardContent className="p-3 space-y-2">
              <p className="text-xs font-medium text-muted-foreground">
                {splitType === 'by_weight' ? 'Enter a weight for each person' : 'Enter shares for each person'}
              </p>
              {selectedMembers.map(id => (
                <div key={id} className="flex items-center gap-2">
                  <span className="text-sm min-w-[80px]">{doc.members[id]?.displayName}</span>
                  <Input
                    type="number"
                    step="1"
                    min="0"
                    placeholder="0"
                    value={shares[id] ?? ''}
                    onChange={e => dispatch({ type: 'SET_MAP_VALUE', field: 'shares', memberId: id, value: e.target.value })}
                    className="h-8 text-sm flex-1"
                  />
                  <span className="text-xs text-muted-foreground">
                    {splitType === 'by_weight' ? 'weight' : 'shares'} (leave empty for 0)
                  </span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        {/* Split preview */}
        {previewSplits && isValidAmount && (
          <Card>
            <CardContent className="p-3 space-y-1">
              <p className="text-xs font-medium text-muted-foreground mb-2">Split Preview</p>
              {Object.entries(previewSplits).map(([id, splitAmount]) => (
                <div key={id} className="flex justify-between text-sm">
                  <span>{doc.members[id]?.displayName || id}</span>
                  <span className="font-medium">{formatCents(splitAmount, currency)}</span>
                </div>
              ))}
            </CardContent>
          </Card>
        )}

        <div className="space-y-2">
          <Label htmlFor="notes">Notes (optional)</Label>
          <Input
            id="notes"
            placeholder="Any additional context..."
            value={notes}
            onChange={e => dispatch({ type: 'SET_FIELD', field: 'notes', value: e.target.value })}
            maxLength={MAX_LENGTHS.notes}
          />
        </div>

        {submitError && <p className="text-sm text-destructive" role="alert">{submitError}</p>}

        <Button
          className="w-full"
          size="lg"
          onClick={handleSubmit}
          disabled={isSubmitting || !description.trim() || !isValidAmount || !splitValid || !payerValid || categories.length === 0}
        >
          Add {isValidAmount ? formatCents(amountCents, currency) : ''} Expense
        </Button>
      </div>
    </div>
  );
}
