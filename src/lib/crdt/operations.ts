import type { Expense, ExpenseComment, ExpenseEditRecord, Settlement, PeerId, MemberProfile, GroupSettings } from '@/types';
import type { GroupDocument } from './document';
import type { GroupState } from '@/types';
import { groupSettingsSchema } from '@/lib/validation/schemas';
import { MAX_LENGTHS } from '@/lib/utils/validation';

// Fields that are metadata rather than user-editable content; excluded from edit-history diffs.
const EDIT_HISTORY_IGNORED_FIELDS = new Set<keyof Expense>(['id', 'updatedAt', 'editHistory', 'comments']);
// every entry holds full before/after copies, so an old expense can't grow forever
export const MAX_EDIT_HISTORY = 20;
// ten billion in major units, far above any real expense and well under 2^53
export const MAX_AMOUNT_CENTS = 1e12;

// stamps never go backwards past anything this device has seen, so a device
// with a slow clock still beats the edits it's answering. Not a full HLC, just monotonic.
let lastStampMs = 0;

export function nextStamp(): string {
  lastStampMs = Math.max(Date.now(), lastStampMs + 1);
  return new Date(lastStampMs).toISOString();
}

// only call with stamps already clamped by clampFutureStamps, or one bad peer pins our clock
export function observeStamp(ms: number): void {
  if (Number.isFinite(ms) && ms > lastStampMs) lastStampMs = ms;
}

// monotonic per-peer mutation counter, bumped by every function below that
// changes document content. See GroupDocument.version for how it's used on merge.
function bumpVersion(doc: GroupDocument): number {
  return (doc.version || 0) + 1;
}

// one cent of rounding slack for edits of older rows. New expenses get 0.
const EXPENSE_SUM_TOLERANCE_CENTS = 1;

function isValidAmount(cents: number): boolean {
  return Number.isInteger(cents) && cents >= 0 && cents <= MAX_AMOUNT_CENTS;
}

export function validateExpenseInvariants(expense: Expense, tolerance: number = EXPENSE_SUM_TOLERANCE_CENTS): void {
  const sum = (parts: { amount: number }[]) => parts.reduce((acc, p) => acc + p.amount, 0);

  // whole cents only, and nothing big enough to lose precision
  if (!isValidAmount(expense.totalAmount) || expense.totalAmount === 0) {
    throw new Error('Expense totalAmount must be a positive whole number of cents');
  }
  if (!Array.isArray(expense.payers) || expense.payers.length === 0) {
    throw new Error('Expense must have at least one payer');
  }
  if (!Array.isArray(expense.splits) || expense.splits.length === 0) {
    throw new Error('Expense must have at least one split');
  }
  if (expense.payers.some(p => !isValidAmount(p.amount))) {
    throw new Error('Expense payer amounts must all be whole cents');
  }
  if (expense.splits.some(s => !isValidAmount(s.amount))) {
    throw new Error('Expense split amounts must all be whole cents');
  }

  const payerTotal = sum(expense.payers);
  const splitTotal = sum(expense.splits);
  if (Math.abs(payerTotal - expense.totalAmount) > tolerance) {
    throw new Error(`Payer total ${payerTotal} does not match totalAmount ${expense.totalAmount}`);
  }
  if (Math.abs(splitTotal - expense.totalAmount) > tolerance) {
    throw new Error(`Split total ${splitTotal} does not match totalAmount ${expense.totalAmount}`);
  }
}

export function addExpense(doc: GroupDocument, expense: Expense): GroupDocument {
  if (doc.meta.state !== 'active') {
    throw new Error('Cannot add expenses to a non-active group');
  }
  // reject an expense meant for a different group leaking in via merge/import
  if (expense.groupId !== null && expense.groupId !== doc.meta.id) {
    throw new Error('Expense groupId does not match this document');
  }
  validateExpenseInvariants(expense, 0);
  // clear any prior tombstone so the re-added expense survives the next merge
  const { [expense.id]: _tombstone, ...remainingDeleted } = doc.deleted;
  return {
    ...doc,
    expenses: { ...doc.expenses, [expense.id]: { ...expense, updatedAt: expense.updatedAt || nextStamp() } },
    deleted: remainingDeleted,
    version: bumpVersion(doc),
  };
}

export function editExpense(
  doc: GroupDocument,
  expenseId: string,
  patch: Partial<Expense>,
  editedBy?: PeerId
): GroupDocument {
  const existing = doc.expenses[expenseId];
  if (!existing) throw new Error('Expense not found');
  // same gate as addExpense
  if (doc.meta.state !== 'active') throw new Error('Cannot edit expenses in a non-active group');

  const changes: ExpenseEditRecord['changes'] = {};
  for (const key of Object.keys(patch) as (keyof Expense)[]) {
    if (EDIT_HISTORY_IGNORED_FIELDS.has(key)) continue;
    const from = existing[key];
    const to = patch[key];
    if (JSON.stringify(from) !== JSON.stringify(to)) {
      changes[key] = { from, to };
    }
  }

  const now = nextStamp();
  let editHistory = existing.editHistory ? [...existing.editHistory] : [];
  if (Object.keys(changes).length > 0 && editedBy) {
    editHistory.push({ editedAt: now, editedBy, changes });
    editHistory = editHistory.slice(-MAX_EDIT_HISTORY);
  }

  const updated: Expense = { ...existing, ...patch, id: expenseId, updatedAt: now, editHistory };
  // validate the merged result rather than the patch - a patch legitimately
  // touches only one of totalAmount/payers/splits, and it is the combination of
  // the three that has to stay consistent.
  validateExpenseInvariants(updated);

  return {
    ...doc,
    expenses: {
      ...doc.expenses,
      [expenseId]: updated,
    },
    version: bumpVersion(doc),
  };
}

export function deleteExpense(doc: GroupDocument, expenseId: string): GroupDocument {
  if (!doc.expenses[expenseId]) throw new Error('Expense not found');
  if (doc.meta.state !== 'active') throw new Error('Cannot delete expenses in a non-active group');

  const { [expenseId]: _removed, ...remaining } = doc.expenses;
  return {
    ...doc,
    expenses: remaining,
    deleted: { ...doc.deleted, [expenseId]: nextStamp() },
    version: bumpVersion(doc),
  };
}

export function addComment(
  doc: GroupDocument,
  expenseId: string,
  comment: ExpenseComment
): GroupDocument {
  const existing = doc.expenses[expenseId];
  if (!existing) throw new Error('Expense not found');
  if (!doc.members[comment.authorId]) throw new Error('Comment author is not a group member');
  if (!comment.text.trim()) throw new Error('Comment text cannot be empty');
  // prevent a malicious peer from bloating the document with unlimited comments
  const MAX_COMMENTS_PER_EXPENSE = 100;
  const existingComments = existing.comments || [];
  if (existingComments.length >= MAX_COMMENTS_PER_EXPENSE) {
    throw new Error(`Expense has reached the maximum of ${MAX_COMMENTS_PER_EXPENSE} comments`);
  }

  const comments = [...existingComments, comment];
  return {
    ...doc,
    // Re-stamp so mergeDocuments cannot discard the new comment.
    expenses: { ...doc.expenses, [expenseId]: { ...existing, comments, updatedAt: nextStamp() } },
    version: bumpVersion(doc),
  };
}

export function deleteComment(doc: GroupDocument, expenseId: string, commentId: string): GroupDocument {
  const existing = doc.expenses[expenseId];
  if (!existing) throw new Error('Expense not found');

  const comments = (existing.comments || []).filter(c => c.id !== commentId);
  return {
    ...doc,
    // Same reason as addComment: re-stamp updatedAt or a concurrent edit wins
    // the merge and resurrects the deleted comment on both peers.
    expenses: { ...doc.expenses, [expenseId]: { ...existing, comments, updatedAt: nextStamp() } },
    version: bumpVersion(doc),
  };
}

// tombstones cost ~60 bytes each, so keep them well past the longest gap
// a trip-group member is likely to go without opening the app.
export const TOMBSTONE_MAX_AGE_MS = 400 * 24 * 60 * 60 * 1000;

export function pruneTombstones(doc: GroupDocument, maxAgeMs: number = TOMBSTONE_MAX_AGE_MS): GroupDocument {
  const now = Date.now();
  const deleted: Record<string, string> = {};
  for (const [id, deletedAt] of Object.entries(doc.deleted)) {
    if (now - new Date(deletedAt).getTime() < maxAgeMs) {
      deleted[id] = deletedAt;
    }
  }
  if (Object.keys(deleted).length === Object.keys(doc.deleted).length) return doc;
  return { ...doc, deleted, version: bumpVersion(doc) };
}

export function addSettlement(doc: GroupDocument, settlement: Settlement): GroupDocument {
  if (doc.meta.state !== 'active' && doc.meta.state !== 'settling') {
    throw new Error('Cannot add settlements to an archived or closed group');
  }
  // same cross-group guard as addExpense
  if (settlement.groupId !== doc.meta.id) {
    throw new Error('Settlement groupId does not match this document');
  }
  if (!doc.members[settlement.from] && !doc.formerMembers?.[settlement.from]) {
    throw new Error('Settlement sender is not a group member');
  }
  if (!doc.members[settlement.to] && !doc.formerMembers?.[settlement.to]) {
    throw new Error('Settlement recipient is not a group member');
  }
  if (settlement.from === settlement.to) {
    throw new Error('Cannot settle with yourself');
  }
  if (!isValidAmount(settlement.amount) || settlement.amount === 0) {
    throw new Error('Settlement amount must be a positive whole number of cents');
  }
  // the load schema caps the note, so the write side has to as well
  if (settlement.note.length > MAX_LENGTHS.notes) {
    throw new Error(`Settlement note is longer than ${MAX_LENGTHS.notes} characters`);
  }
  // strip references to expenses that no longer exist or were deleted
  const cleanedExpenses = settlement.settlesExpenses.filter(
    eid => eid in doc.expenses && !(eid in doc.deleted)
  );
  return {
    ...doc,
    settlements: { ...doc.settlements, [settlement.id]: { ...settlement, settlesExpenses: cleanedExpenses, updatedAt: settlement.updatedAt || nextStamp() } },
    version: bumpVersion(doc),
  };
}

// tombstoned like an expense, merge already drops tombstoned settlements
export function deleteSettlement(doc: GroupDocument, settlementId: string): GroupDocument {
  if (!doc.settlements[settlementId]) throw new Error('Settlement not found');
  const { [settlementId]: _removed, ...remaining } = doc.settlements;
  return {
    ...doc,
    settlements: remaining,
    deleted: { ...doc.deleted, [settlementId]: nextStamp() },
    version: bumpVersion(doc),
  };
}

export function addMember(doc: GroupDocument, member: MemberProfile): GroupDocument {
  // clear any prior tombstone so the re-added member survives the next merge
  const { [member.peerId]: _tombstone, ...remainingDeleted } = doc.deleted;
  const { [member.peerId]: _formerMember, ...remainingFormerMembers } = doc.formerMembers || {};
  return {
    ...doc,
    members: { ...doc.members, [member.peerId]: { ...member, updatedAt: member.updatedAt || nextStamp() } },
    formerMembers: remainingFormerMembers,
    deleted: remainingDeleted,
    version: bumpVersion(doc),
  };
}

export function removeMember(doc: GroupDocument, peerId: PeerId): GroupDocument {
  if (!doc.members[peerId]) throw new Error('Member not found');
  if (Object.keys(doc.members).length === 1) {
    throw new Error('Cannot remove the last member from a group');
  }
  const { [peerId]: removedMember, ...remaining } = doc.members;
  return {
    ...doc,
    members: remaining,
    formerMembers: { ...doc.formerMembers, [peerId]: removedMember },
    // record removal timestamp so peers can converge on the deletion via merge
    deleted: { ...doc.deleted, [peerId]: nextStamp() },
    version: bumpVersion(doc),
  };
}

// reassign all expense/settlement references from one member to another,
// then remove the source member. Used when merging a placeholder with a real peer.
export function reassignMember(doc: GroupDocument, fromPeerId: PeerId, toPeerId: PeerId): GroupDocument {
  if (!doc.members[fromPeerId]) throw new Error('Source member not found');
  if (!doc.members[toPeerId]) throw new Error('Target member not found');
  if (fromPeerId === toPeerId) throw new Error('Cannot reassign to self');

  const now = nextStamp();
  const swap = (id: PeerId) => (id === fromPeerId ? toPeerId : id);
  // placeholder Bob and real Bob are often both on one expense, so fold them into one row
  const foldRows = (rows: { userId: PeerId; amount: number }[]) => {
    const byUser = new Map<PeerId, number>();
    for (const row of rows) byUser.set(swap(row.userId), (byUser.get(swap(row.userId)) || 0) + row.amount);
    return Array.from(byUser, ([userId, amount]) => ({ userId, amount }));
  };

  const expenses: Record<string, Expense> = { ...doc.expenses };
  for (const [id, e] of Object.entries(doc.expenses)) {
    const touches = e.createdBy === fromPeerId
      || e.payers.some(p => p.userId === fromPeerId)
      || e.splits.some(s => s.userId === fromPeerId)
      || e.items.some(item => item.assignees.includes(fromPeerId))
      || (!!e.splitInputs && fromPeerId in e.splitInputs)
      || !!e.comments?.some(c => c.authorId === fromPeerId)
      || !!e.editHistory?.some(r => r.editedBy === fromPeerId);
    // restamping untouched records would beat concurrent deletes and edits group-wide
    if (!touches) continue;

    let splitInputs = e.splitInputs;
    if (splitInputs && fromPeerId in splitInputs) {
      const { [fromPeerId]: moved, ...rest } = splitInputs;
      splitInputs = { ...rest, [toPeerId]: (rest[toPeerId] || 0) + (moved || 0) };
    }
    expenses[id] = {
      ...e,
      payers: foldRows(e.payers),
      splits: foldRows(e.splits),
      items: e.items.map(item => ({ ...item, assignees: Array.from(new Set(item.assignees.map(swap))) })),
      createdBy: swap(e.createdBy),
      ...(splitInputs ? { splitInputs } : {}),
      ...(e.comments ? { comments: e.comments.map(c => ({ ...c, authorId: swap(c.authorId) })) } : {}),
      ...(e.editHistory ? { editHistory: e.editHistory.map(r => ({ ...r, editedBy: swap(r.editedBy) })) } : {}),
      updatedAt: now,
    };
  }

  const settlements: Record<string, Settlement> = { ...doc.settlements };
  for (const [id, s] of Object.entries(doc.settlements)) {
    if (s.from !== fromPeerId && s.to !== fromPeerId) continue;
    settlements[id] = { ...s, from: swap(s.from), to: swap(s.to), updatedAt: now };
  }

  const { [fromPeerId]: removedMember, ...remainingMembers } = doc.members;
  const { [fromPeerId]: _formerMember, ...remainingFormerMembers } = doc.formerMembers || {};

  return {
    ...doc,
    members: remainingMembers,
    // Keep the source profile for stale references that survive a merge.
    formerMembers: { ...remainingFormerMembers, [fromPeerId]: removedMember },
    expenses,
    settlements,
    // tombstone the source so stale peers cannot re-add it during merge
    deleted: { ...doc.deleted, [fromPeerId]: now },
    version: bumpVersion(doc),
  };
}

export function updateGroupSettings(
  doc: GroupDocument,
  settings: Partial<GroupSettings>
): GroupDocument {
  const merged = { ...doc.meta.settings, ...settings };
  // balances ignore expense.currency, so switching would relabel every past amount
  if (merged.defaultCurrency !== doc.meta.settings.defaultCurrency && Object.keys(doc.expenses).length > 0) {
    throw new Error('Currency cannot be changed once the group has expenses');
  }
  // same schema merge.ts already checks settings against during CRDT merge
  const parsed = groupSettingsSchema.safeParse(merged);
  if (!parsed.success) {
    throw new Error(`Invalid group settings: ${parsed.error.message}`);
  }
  return {
    ...doc,
    meta: {
      ...doc.meta,
      settings: parsed.data,
      settingsUpdatedAt: nextStamp(),
    },
    version: bumpVersion(doc),
  };
}

// Renames the group. Stamps meta.nameUpdatedAt so the change can win a merge
// against peers that still hold the old name - see mergeDocuments for why the
// name cannot simply ride along on baseMeta.
export function renameGroup(doc: GroupDocument, name: string): GroupDocument {
  const trimmed = name.trim();
  if (!trimmed) throw new Error('Group name cannot be empty');
  if (trimmed.length > MAX_LENGTHS.groupName) throw new Error(`Group name is longer than ${MAX_LENGTHS.groupName} characters`);
  return {
    ...doc,
    meta: { ...doc.meta, name: trimmed, nameUpdatedAt: nextStamp() },
    version: bumpVersion(doc),
  };
}

export function changeGroupState(doc: GroupDocument, newState: GroupState): GroupDocument {
  return {
    ...doc,
    // Stamped so the change can win a merge. Fixed state priority alone ranks
    // `active` above `archived`/`closed`, so an archive was silently reverted by
    // the next sync with any peer that had not archived yet.
    meta: { ...doc.meta, state: newState, stateUpdatedAt: nextStamp() },
    version: bumpVersion(doc),
  };
}

export function updateMemberProfile(
  doc: GroupDocument,
  peerId: PeerId,
  update: Partial<MemberProfile>
): GroupDocument {
  const existing = doc.members[peerId];
  if (!existing) throw new Error('Member not found');
  return {
    ...doc,
    members: {
      ...doc.members,
      [peerId]: { ...existing, ...update, peerId, updatedAt: nextStamp() },
    },
    version: bumpVersion(doc),
  };
}
