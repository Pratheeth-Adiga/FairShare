import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { Expense, ExpenseComment, Settlement, MemberProfile, GroupSettings, PeerId } from '@/types';
import type { GroupState } from '@/types';
import type { GroupDocument } from '@/lib/crdt/document';
import { createGroupDocument } from '@/lib/crdt/document';
import { mergeDocuments, clampFutureStamps, latestStamp, MAX_CLOCK_SKEW_MS } from '@/lib/crdt/merge';
import * as ops from '@/lib/crdt/operations';
import * as queries from '@/lib/crdt/queries';
import type { PairwiseBalance } from '@/lib/crdt/queries';
import { saveDocumentAndGroup, loadDocument, loadGroups, deleteGroup as deleteGroupFromDB } from '@/lib/storage/database';
import type { StoredGroup } from '@/lib/storage/database';
import { generateGroupId, generateExpenseId, generateSettlementId, generateCommentId } from '@/lib/crypto/identity';
import { slugifyCategoryLabel } from '@/lib/utils/categories';
import { groupDocumentSchema, parseGroupDocument, formatZodError } from '@/lib/validation/schemas';
import type { BalanceMap } from '@/lib/balance';
import type { Transaction } from '@/lib/balance';

// total number of live records in a document. Used alongside the version
// counter to detect whether a merge actually brought anything in - see
// mergeRemoteDocument for why the counter on its own is not enough.
function recordCount(doc: GroupDocument): number {
  return (
    Object.keys(doc.members).length +
    Object.keys(doc.expenses).length +
    Object.keys(doc.settlements).length
  );
}

// Load lazily to break the groups.store <-> sync.store cycle.
function notifySync(groupId: string) {
  import('./sync.store')
    .then(({ useSyncStore }) => {
      useSyncStore.getState().broadcastDocument(groupId);
    })
    .catch(err => console.error(`[notifySync] Failed to broadcast group ${groupId}:`, err));
}

function storedGroupFrom(groupId: string, doc: GroupDocument): StoredGroup {
  return {
    id: groupId,
    name: doc.meta.name,
    topic: groupId,
    createdAt: doc.meta.createdAt,
    state: doc.meta.state,
    memberCount: Object.keys(doc.members).length,
    currency: doc.meta.settings.defaultCurrency,
  };
}

function upsertGroupEntry(list: StoredGroup[], entry: StoredGroup): void {
  const index = list.findIndex(g => g.id === entry.id);
  if (index >= 0) list[index] = entry;
  else list.push(entry);
}

// lets a caller wait until the fire-and-forget writes below have landed
const pendingWrites = new Set<Promise<unknown>>();

export async function whenSaved(): Promise<void> {
  await Promise.allSettled(Array.from(pendingWrites));
}

// fire-and-forget; records failures so the UI can tell the user it may not have saved.
function persist(groupId: string, doc: GroupDocument) {
  useGroupsStore.setState(state => { delete state.persistErrors[groupId]; });
  const write = saveDocumentAndGroup(groupId, JSON.stringify(doc), storedGroupFrom(groupId, doc)).catch(err => {
    console.error(`[persist] Failed to save group ${groupId}:`, err);
    useGroupsStore.setState(state => { state.persistErrors[groupId] = 'Could not save your last change. Please try again.'; });
  });
  pendingWrites.add(write);
  void write.finally(() => pendingWrites.delete(write));
}

// every local mutation goes through here. The result has to pass the
// same schema the loader uses, or one bad write makes the group unloadable next launch.
function applyDocOp(groupId: string, label: string, op: (doc: GroupDocument) => GroupDocument): boolean {
  const doc = useGroupsStore.getState().documents[groupId];
  if (!doc) return false;
  let updated: GroupDocument;
  try {
    // validation errors thrown by ops.* (bad member id, over-long text, etc), not I/O
    updated = op(doc);
  } catch (err) {
    console.error(`[${label}]`, err);
    return false;
  }
  const check = groupDocumentSchema.safeParse(updated);
  if (!check.success) {
    console.error(`[${label}] result would not load again, not saving:`, formatZodError(check.error));
    return false;
  }
  useGroupsStore.setState(state => {
    state.documents[groupId] = updated;
    upsertGroupEntry(state.groupList, storedGroupFrom(groupId, updated));
  });
  persist(groupId, updated);
  notifySync(groupId);
  return true;
}

// immutable document references make these WeakMap caches self-invalidating
const expensesCache = new WeakMap<GroupDocument, Expense[]>();
const balancesCache = new WeakMap<GroupDocument, BalanceMap>();
const simplifiedDebtsCache = new WeakMap<GroupDocument, Transaction[]>();
// per-user results, so this needs a nested map instead of a single cached value
const pairwiseBalancesCache = new WeakMap<GroupDocument, Map<PeerId, PairwiseBalance[]>>();

interface GroupsState {
  documents: Record<string, GroupDocument>;
  groupList: StoredGroup[];
  activeGroupId: string | null;
  isLoading: boolean;
  // groupId -> message, set when a persist write fails
  persistErrors: Record<string, string>;
  clearPersistError: (groupId: string) => void;

  initialize: () => Promise<void>;
  createGroup: (name: string, currency: string, creatorId: PeerId, creatorName: string, creatorPublicKey?: string) => Promise<string>;
  deleteGroup: (groupId: string) => Promise<void>;
  setActiveGroup: (groupId: string | null) => void;

  // mutators return false when the change was rejected and nothing was saved
  addExpense: (groupId: string, expense: Omit<Expense, 'id'> & { id?: string }) => boolean;
  editExpense: (groupId: string, expenseId: string, patch: Partial<Expense>, editedBy?: PeerId) => boolean;
  removeExpense: (groupId: string, expenseId: string) => boolean;

  addComment: (groupId: string, expenseId: string, authorId: PeerId, text: string) => boolean;
  removeComment: (groupId: string, expenseId: string, commentId: string) => boolean;

  addSettlement: (groupId: string, settlement: Omit<Settlement, 'id'>) => boolean;
  deleteSettlement: (groupId: string, settlementId: string) => boolean;

  addMember: (groupId: string, member: MemberProfile) => boolean;
  removeMember: (groupId: string, peerId: PeerId) => boolean;
  reassignMember: (groupId: string, fromPeerId: PeerId, toPeerId: PeerId) => boolean;
  updateMemberProfile: (groupId: string, peerId: PeerId, update: Partial<MemberProfile>) => boolean;

  renameGroup: (groupId: string, name: string) => boolean;
  updateSettings: (groupId: string, settings: Partial<GroupSettings>) => boolean;
  addCustomCategory: (groupId: string, label: string) => void;
  removeCategory: (groupId: string, categoryId: string) => void;
  changeState: (groupId: string, state: GroupState) => boolean;

  mergeRemoteDocument: (groupId: string, remoteDoc: GroupDocument) => void;
  importDocument: (doc: GroupDocument) => Promise<void>;

  getDocument: (groupId: string) => GroupDocument | undefined;
  getExpenses: (groupId: string) => Expense[];
  getBalances: (groupId: string) => BalanceMap;
  getSimplifiedDebts: (groupId: string) => Transaction[];
  getPairwiseBalances: (groupId: string, userId: PeerId) => PairwiseBalance[];
  getStats: (groupId: string, userId: PeerId) => ReturnType<typeof queries.getGroupStats> | null;
}

export const useGroupsStore = create<GroupsState>()(immer((set, get) => ({
  documents: {},
  groupList: [],
  activeGroupId: null,
  isLoading: true,
  persistErrors: {},

  clearPersistError: (groupId) => set((state) => { delete state.persistErrors[groupId]; }),

  initialize: async () => {
    const storedGroups = await loadGroups();
    const documents: Record<string, GroupDocument> = {};

    for (const group of storedGroups) {
      const docData = await loadDocument(group.id);
      if (!docData) continue;
      let raw: unknown;
      try {
        raw = JSON.parse(docData);
      } catch {
        console.error(`[groups.store] Skipping unreadable document for group ${group.id}`);
        continue;
      }
      // reject corrupted or incompatible documents before CRDT logic
      const result = parseGroupDocument(raw);
      if (!result.success) {
        console.error(`[groups.store] Skipping corrupted document for group ${group.id}:`, formatZodError(result.error));
        continue;
      }
      if (result.repaired) console.warn(`[groups.store] Shortened over-long text in group ${group.id} so it loads`);
      const loaded = result.data as GroupDocument;
      // pull back future stamps, and expire very old tombstones
      const doc = ops.pruneTombstones(clampFutureStamps(loaded, Date.now() + MAX_CLOCK_SKEW_MS));
      ops.observeStamp(latestStamp(doc));
      if (doc !== loaded || result.repaired) {
        saveDocumentAndGroup(group.id, JSON.stringify(doc), storedGroupFrom(group.id, doc))
          .catch(err => console.error(`[initialize] Failed to save cleaned doc for ${group.id}:`, err));
      }
      documents[group.id] = doc;
    }

    set((state) => {
      state.groupList = storedGroups;
      state.documents = documents;
      state.isLoading = false;
    });
  },

  createGroup: async (name, currency, creatorId, creatorName, creatorPublicKey) => {
    const groupId = generateGroupId();
    const settings = {
      defaultCurrency: currency,
      defaultSplitType: 'equal' as const,
      simplifyDebts: true,
      settleThreshold: 100,
      roundingAssignee: 'payer' as const,
      requireApproval: false,
      invitePermission: 'any_member' as const,
      customCategories: [],
      disabledCategories: [],
    };

    // preserve the creator key for signature verification
    const doc = createGroupDocument(groupId, name.trim(), creatorId, creatorName, settings, creatorPublicKey);
    const check = groupDocumentSchema.safeParse(doc);
    if (!check.success) throw new Error(`Could not create group (${formatZodError(check.error)})`);

    const storedGroup = storedGroupFrom(groupId, doc);
    await saveDocumentAndGroup(groupId, JSON.stringify(doc), storedGroup);

    set((state) => {
      state.documents[groupId] = doc;
      state.groupList.push(storedGroup);
    });

    return groupId;
  },

  deleteGroup: async (groupId) => {
    // stop syncing and drop it from memory before the await, so a document
    // that arrives mid-delete can't bring the group straight back
    const { useSyncStore } = await import('./sync.store');
    useSyncStore.getState().leaveGroup(groupId);
    set((state) => {
      delete state.documents[groupId];
      state.groupList = state.groupList.filter(g => g.id !== groupId);
      if (state.activeGroupId === groupId) state.activeGroupId = null;
    });
    await deleteGroupFromDB(groupId);
  },

  setActiveGroup: (groupId) => set({ activeGroupId: groupId }),

  addExpense: (groupId, expenseData) => {
    // callers can pass the id they already used as the rounding seed
    const expense: Expense = { ...expenseData, id: expenseData.id ?? generateExpenseId() };
    return applyDocOp(groupId, 'addExpense', doc => ops.addExpense(doc, expense));
  },

  editExpense: (groupId, expenseId, patch, editedBy) =>
    applyDocOp(groupId, 'editExpense', doc => ops.editExpense(doc, expenseId, patch, editedBy)),

  removeExpense: (groupId, expenseId) =>
    applyDocOp(groupId, 'removeExpense', doc => ops.deleteExpense(doc, expenseId)),

  addComment: (groupId, expenseId, authorId, text) => {
    const comment: ExpenseComment = { id: generateCommentId(), authorId, text: text.trim(), createdAt: new Date().toISOString() };
    return applyDocOp(groupId, 'addComment', doc => ops.addComment(doc, expenseId, comment));
  },

  removeComment: (groupId, expenseId, commentId) =>
    applyDocOp(groupId, 'removeComment', doc => ops.deleteComment(doc, expenseId, commentId)),

  addSettlement: (groupId, settlementData) => {
    const settlement: Settlement = { ...settlementData, id: generateSettlementId() };
    return applyDocOp(groupId, 'addSettlement', doc => ops.addSettlement(doc, settlement));
  },

  deleteSettlement: (groupId, settlementId) =>
    applyDocOp(groupId, 'deleteSettlement', doc => ops.deleteSettlement(doc, settlementId)),

  addMember: (groupId, member) =>
    applyDocOp(groupId, 'addMember', doc => ops.addMember(doc, member)),

  removeMember: (groupId, peerId) =>
    applyDocOp(groupId, 'removeMember', doc => ops.removeMember(doc, peerId)),

  reassignMember: (groupId, fromPeerId, toPeerId) =>
    applyDocOp(groupId, 'reassignMember', doc => ops.reassignMember(doc, fromPeerId, toPeerId)),

  updateMemberProfile: (groupId, peerId, update) =>
    applyDocOp(groupId, 'updateMemberProfile', doc => ops.updateMemberProfile(doc, peerId, update)),

  updateSettings: (groupId, settings) =>
    applyDocOp(groupId, 'updateSettings', doc => ops.updateGroupSettings(doc, settings)),

  addCustomCategory: (groupId, label) => {
    const doc = get().documents[groupId];
    if (!doc || !label.trim()) return;
    const existing = doc.meta.settings.customCategories;
    const id = slugifyCategoryLabel(label);
    if (existing.some(c => c.id === id)) return;
    get().updateSettings(groupId, { customCategories: [...existing, { id, label: label.trim() }] });
  },

  removeCategory: (groupId, categoryId) => {
    const doc = get().documents[groupId];
    if (!doc) return;
    const { customCategories, disabledCategories } = doc.meta.settings;
    if (customCategories.some(c => c.id === categoryId)) {
      get().updateSettings(groupId, { customCategories: customCategories.filter(c => c.id !== categoryId) });
    } else if (!disabledCategories.includes(categoryId)) {
      get().updateSettings(groupId, { disabledCategories: [...disabledCategories, categoryId] });
    }
  },

  renameGroup: (groupId, name) =>
    applyDocOp(groupId, 'renameGroup', doc => ops.renameGroup(doc, name)),

  changeState: (groupId, newState) =>
    applyDocOp(groupId, 'changeState', doc => ops.changeGroupState(doc, newState)),

  getDocument: (groupId) => get().documents[groupId],

  getExpenses: (groupId) => {
    const doc = get().documents[groupId];
    if (!doc) return [];
    let cached = expensesCache.get(doc);
    if (!cached) {
      cached = queries.getExpenses(doc);
      expensesCache.set(doc, cached);
    }
    return cached;
  },

  getBalances: (groupId) => {
    const doc = get().documents[groupId];
    if (!doc) return {};
    let cached = balancesCache.get(doc);
    if (!cached) {
      cached = queries.getBalances(doc);
      balancesCache.set(doc, cached);
    }
    return cached;
  },

  getSimplifiedDebts: (groupId) => {
    const doc = get().documents[groupId];
    if (!doc) return [];
    let cached = simplifiedDebtsCache.get(doc);
    if (!cached) {
      cached = queries.getSimplifiedDebts(doc);
      simplifiedDebtsCache.set(doc, cached);
    }
    return cached;
  },

  getPairwiseBalances: (groupId, userId) => {
    const doc = get().documents[groupId];
    if (!doc) return [];
    let byUser = pairwiseBalancesCache.get(doc);
    if (!byUser) {
      byUser = new Map();
      pairwiseBalancesCache.set(doc, byUser);
    }
    let cached = byUser.get(userId);
    if (!cached) {
      cached = queries.getPairwiseBalances(doc, userId);
      byUser.set(userId, cached);
    }
    return cached;
  },

  getStats: (groupId, userId) => {
    const doc = get().documents[groupId];
    if (!doc) return null;
    return queries.getGroupStats(doc, userId);
  },

  mergeRemoteDocument: (groupId, remoteDoc) => {
    const localDoc = get().documents[groupId];
    const merged = localDoc ? mergeDocuments(localDoc, remoteDoc) : remoteDoc;
    // nothing new came in, so skip the rewrite of the whole document
    if (localDoc && JSON.stringify(merged) === JSON.stringify(localDoc)) return;
    // version and record count catch adds/removes, the newest stamp
    // (records, tombstones and meta) catches content-only edits.
    const changed = !localDoc
      || (merged.version || 0) !== (localDoc.version || 0)
      || recordCount(merged) !== recordCount(localDoc)
      || latestStamp(merged) > latestStamp(localDoc);

    set((state) => {
      state.documents[groupId] = merged;
      upsertGroupEntry(state.groupList, storedGroupFrom(groupId, merged));
    });
    // document and group metadata are written together
    saveDocumentAndGroup(groupId, JSON.stringify(merged), storedGroupFrom(groupId, merged))
      .catch(err => console.error(`[mergeRemoteDocument] Failed to save group ${groupId}:`, err));
    // Gossip merged data through bridge connections.
    if (changed) notifySync(groupId);
  },

  importDocument: async (doc) => {
    const groupId = doc.meta.id;
    const incoming = clampFutureStamps(doc, Date.now() + MAX_CLOCK_SKEW_MS);
    const existing = get().documents[groupId];
    // merge into what's here, a straight overwrite lost everything newer than the file
    const next = existing ? mergeDocuments(existing, incoming) : incoming;

    await saveDocumentAndGroup(groupId, JSON.stringify(next), storedGroupFrom(groupId, next));

    set((state) => {
      state.documents[groupId] = next;
      upsertGroupEntry(state.groupList, storedGroupFrom(groupId, next));
    });

    if (existing) {
      notifySync(groupId);
    } else {
      import('./sync.store')
        .then(({ useSyncStore }) => useSyncStore.getState().subscribeToGroup(groupId))
        .catch(err => console.error(`[importDocument] Failed to start sync for ${groupId}:`, err));
    }
  },
})));

// derived member count reads directly from the CRDT document to avoid stale mirrors
export function getGroupMemberCount(groupId: string): number {
  const doc = useGroupsStore.getState().documents[groupId];
  return doc ? Object.keys(doc.members).length : 0;
}

// React-hook variant: subscribes to the store so components re-render whenever
// the member set changes (e.g. a remote merge adds or removes a member).
export function useGroupMemberCount(groupId: string): number {
  return useGroupsStore(s => {
    const doc = s.documents[groupId];
    return doc ? Object.keys(doc.members).length : 0;
  });
}
