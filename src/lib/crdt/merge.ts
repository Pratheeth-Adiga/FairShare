import type { GroupDocument } from './document';
import type { Expense, MemberProfile, Settlement } from '@/types';
import { groupSettingsSchema } from '@/lib/validation/schemas';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';
import { publicKeyFromPeerId } from '@/lib/crypto/identity';

// how far ahead of our own clock an incoming stamp may be before it gets pulled back
export const MAX_CLOCK_SKEW_MS = 5 * 60 * 1000;

function sanitizeMemberProfile(member: MemberProfile): MemberProfile {
  if (!member.publicKey) return member;
  const derivedKey = publicKeyFromPeerId(member.peerId);
  if (!derivedKey || derivedKey.toLowerCase() === member.publicKey.toLowerCase()) return member;
  const { publicKey: _ignored, ...sanitized } = member;
  return sanitized;
}

// sorted keys, so a reloaded record and an in-session one serialize the same
function canonical(value: unknown): string {
  return JSON.stringify(value, (_key, v: unknown) =>
    v && typeof v === 'object' && !Array.isArray(v)
      ? Object.fromEntries(Object.entries(v as Record<string, unknown>).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0)))
      : v
  );
}

// missing or unparseable stamps count as 0 for the meta fields
function metaStamp(stamp: string | undefined): number {
  const ms = stamp ? Date.parse(stamp) : NaN;
  return Number.isFinite(ms) ? ms : 0;
}

// Newer updatedAt wins; exact ties fall back to content so every peer lands on
// the same record whichever way round the merge runs.
function pickLatest<T extends { updatedAt?: string }>(a: T, b: T): T {
  const at = a.updatedAt ? Date.parse(a.updatedAt) : 0;
  const bt = b.updatedAt ? Date.parse(b.updatedAt) : 0;
  const aFinite = Number.isFinite(at);
  const bFinite = Number.isFinite(bt);
  if (aFinite !== bFinite) return aFinite ? a : b;
  if (aFinite && at !== bt) return at > bt ? a : b;
  return canonical(a) <= canonical(b) ? a : b;
}

function pickByStamp<T>(local: T, remote: T, localAt: number, remoteAt: number, content: (value: T) => string): T {
  if (localAt !== remoteAt) return localAt > remoteAt ? local : remote;
  return content(local) <= content(remote) ? local : remote;
}

function mergeById<T extends { updatedAt?: string }>(
  local: Record<string, T>,
  remote: Record<string, T>
): Record<string, T> {
  const merged: Record<string, T> = { ...local };
  for (const [id, remoteValue] of Object.entries(remote)) {
    const localValue = merged[id];
    merged[id] = localValue ? pickLatest(localValue, remoteValue) : remoteValue;
  }
  return merged;
}

interface MergedRecords {
  members: Record<string, MemberProfile>;
  formerMembers: Record<string, MemberProfile>;
  expenses: Record<string, Expense>;
  settlements: Record<string, Settlement>;
}

function mergeRecords(local: GroupDocument, remote: GroupDocument, groupId: string): MergedRecords {
  const members = mergeById(local.members, remote.members);
  for (const [id, member] of Object.entries(members)) {
    members[id] = sanitizeMemberProfile(member);
  }
  // records stamped for another group don't belong here, whoever sent them
  const expenses = Object.fromEntries(
    Object.entries(mergeById(local.expenses, remote.expenses)).filter(([, e]) => e.groupId === null || e.groupId === groupId)
  );
  const settlements = Object.fromEntries(
    Object.entries(mergeById(local.settlements, remote.settlements)).filter(([, s]) => s.groupId === groupId)
  );
  return {
    members,
    // Keep historical profiles of removed members so past expenses/settlements
    // still resolve a display name after a merge.
    formerMembers: mergeById(local.formerMembers || {}, remote.formerMembers || {}),
    expenses,
    settlements,
  };
}

// Mutates `records`: drops anything whose tombstone is newer than its last edit.
function applyTombstones(records: MergedRecords, localDeleted: Record<string, string>, remoteDeleted: Record<string, string>): Record<string, string> {
  const tombstoneMs = (stamp: string | undefined) => {
    const ms = stamp ? Date.parse(stamp) : NaN;
    return Number.isFinite(ms) ? ms : Number.NEGATIVE_INFINITY;
  };

  // Keep the latest tombstone so an older deletion cannot override a later edit.
  const mergedDeleted: Record<string, string> = { ...localDeleted };
  for (const [id, deletedAt] of Object.entries(remoteDeleted)) {
    const existing = mergedDeleted[id];
    const incomingMs = tombstoneMs(deletedAt);
    const existingMs = tombstoneMs(existing);
    if (!existing || incomingMs > existingMs || (incomingMs === existingMs && deletedAt > existing)) {
      mergedDeleted[id] = deletedAt;
    }
  }

  const { members, formerMembers, expenses, settlements } = records;
  const finalDeleted: Record<string, string> = {};
  for (const [id, deletedAt] of Object.entries(mergedDeleted)) {
    const updatedAt = Math.max(
      members[id]?.updatedAt ? Date.parse(members[id].updatedAt) : 0,
      expenses[id]?.updatedAt ? Date.parse(expenses[id].updatedAt) : 0,
      settlements[id]?.updatedAt ? Date.parse(settlements[id].updatedAt) : 0,
    );
    if (Number.isFinite(updatedAt) && updatedAt > tombstoneMs(deletedAt)) continue;
    if (members[id] && !formerMembers[id]) {
      formerMembers[id] = members[id];
    }
    delete members[id];
    delete expenses[id];
    delete settlements[id];
    finalDeleted[id] = deletedAt;
  }

  // An active member always wins over a stale former-member record.
  for (const id of Object.keys(members)) {
    delete formerMembers[id];
  }
  return finalDeleted;
}

// settlements must never point at tombstoned expenses
function scrubSettlementRefs(settlements: Record<string, Settlement>, deleted: Record<string, string>): void {
  for (const [id, settlement] of Object.entries(settlements)) {
    if (settlement.settlesExpenses.some(eid => eid in deleted)) {
      settlements[id] = {
        ...settlement,
        settlesExpenses: settlement.settlesExpenses.filter(eid => !(eid in deleted)),
      };
    }
  }
}

function mergeMeta(localMeta: GroupDocument['meta'], remoteMeta: GroupDocument['meta']): GroupDocument['meta'] {
  // Older createdAt is the original document; use it as base metadata.
  const baseMeta = new Date(remoteMeta.createdAt) < new Date(localMeta.createdAt)
    ? remoteMeta
    : localMeta;

  const nameWinner = pickByStamp(
    localMeta,
    remoteMeta,
    metaStamp(localMeta.nameUpdatedAt),
    metaStamp(remoteMeta.nameUpdatedAt),
    meta => meta.name,
  );

  // State priority is only for legacy documents with no state stamp on either side.
  const STATE_PRIORITY: Record<string, number> = { active: 3, settling: 2, archived: 1, closed: 0 };
  const localStateAt = localMeta.stateUpdatedAt ? Date.parse(localMeta.stateUpdatedAt) : Number.NaN;
  const remoteStateAt = remoteMeta.stateUpdatedAt ? Date.parse(remoteMeta.stateUpdatedAt) : Number.NaN;
  let stateWinner: typeof localMeta;
  if (Number.isFinite(localStateAt) || Number.isFinite(remoteStateAt)) {
    if (!Number.isFinite(remoteStateAt) || (Number.isFinite(localStateAt) && localStateAt > remoteStateAt)) {
      stateWinner = localMeta;
    } else if (!Number.isFinite(localStateAt) || remoteStateAt > localStateAt) {
      stateWinner = remoteMeta;
    } else if (STATE_PRIORITY[localMeta.state] !== STATE_PRIORITY[remoteMeta.state]) {
      stateWinner = STATE_PRIORITY[localMeta.state] < STATE_PRIORITY[remoteMeta.state] ? localMeta : remoteMeta;
    } else {
      stateWinner = localMeta.state <= remoteMeta.state ? localMeta : remoteMeta;
    }
  } else {
    stateWinner = STATE_PRIORITY[localMeta.state] >= STATE_PRIORITY[remoteMeta.state] ? localMeta : remoteMeta;
  }

  const settingsWinner = pickByStamp(
    localMeta,
    remoteMeta,
    metaStamp(localMeta.settingsUpdatedAt),
    metaStamp(remoteMeta.settingsUpdatedAt),
    meta => canonical(meta.settings),
  );

  // validate the winning settings; fall back to the other peer's if invalid
  const settingsLoser = settingsWinner === remoteMeta ? localMeta : remoteMeta;
  const validatedSettings = groupSettingsSchema.safeParse(settingsWinner.settings).success
    ? settingsWinner.settings
    : (groupSettingsSchema.safeParse(settingsLoser.settings).success ? settingsLoser.settings : DEFAULT_GROUP_SETTINGS);

  return {
    ...baseMeta,
    name: nameWinner.name,
    ...(nameWinner.nameUpdatedAt !== undefined ? { nameUpdatedAt: nameWinner.nameUpdatedAt } : {}),
    settings: validatedSettings,
    ...(settingsWinner.settingsUpdatedAt !== undefined ? { settingsUpdatedAt: settingsWinner.settingsUpdatedAt } : {}),
    state: stateWinner.state,
    ...(stateWinner.stateUpdatedAt !== undefined ? { stateUpdatedAt: stateWinner.stateUpdatedAt } : {}),
  };
}

export function mergeDocuments(local: GroupDocument, remote: GroupDocument): GroupDocument {
  const meta = mergeMeta(local.meta, remote.meta);
  const records = mergeRecords(local, remote, meta.id);
  const deleted = applyTombstones(records, local.deleted, remote.deleted);
  scrubSettlementRefs(records.settlements, deleted);

  return {
    meta,
    members: records.members,
    formerMembers: records.formerMembers,
    expenses: records.expenses,
    settlements: records.settlements,
    deleted,
    // ratchet to the higher of the two versions so callers can detect "did the merge
    // bring in anything new" via a cheap number comparison instead of diffing the doc
    version: Math.max(local.version || 0, remote.version || 0),
  };
}

// Newest stamp anywhere in the document: records, tombstones and meta.
export function latestStamp(doc: GroupDocument): number {
  let max = 0;
  const consider = (stamp: string | undefined) => {
    const ms = stamp ? Date.parse(stamp) : NaN;
    if (Number.isFinite(ms) && ms > max) max = ms;
  };
  for (const records of [doc.members, doc.formerMembers || {}, doc.expenses, doc.settlements]) {
    for (const record of Object.values(records)) consider(record.updatedAt);
  }
  Object.values(doc.deleted).forEach(consider);
  consider(doc.meta.nameUpdatedAt);
  consider(doc.meta.settingsUpdatedAt);
  consider(doc.meta.stateUpdatedAt);
  return max;
}

// stopgap until there's a real HLC. A far-future stamp would otherwise win
// every conflict (or pin a field) until the wall clock caught up.
export function clampFutureStamps(doc: GroupDocument, maxMs: number): GroupDocument {
  if (latestStamp(doc) <= maxMs) return doc;
  const cap = new Date(maxMs).toISOString();
  const tooNew = (stamp: string | undefined) => !!stamp && Date.parse(stamp) > maxMs;
  const clampRecords = <T extends { updatedAt?: string }>(records: Record<string, T>): Record<string, T> =>
    Object.fromEntries(Object.entries(records).map(([id, r]) => [id, tooNew(r.updatedAt) ? { ...r, updatedAt: cap } : r]));

  const meta = { ...doc.meta };
  if (tooNew(meta.nameUpdatedAt)) meta.nameUpdatedAt = cap;
  if (tooNew(meta.settingsUpdatedAt)) meta.settingsUpdatedAt = cap;
  if (tooNew(meta.stateUpdatedAt)) meta.stateUpdatedAt = cap;

  return {
    ...doc,
    meta,
    members: clampRecords(doc.members),
    ...(doc.formerMembers ? { formerMembers: clampRecords(doc.formerMembers) } : {}),
    expenses: clampRecords(doc.expenses),
    settlements: clampRecords(doc.settlements),
    deleted: Object.fromEntries(Object.entries(doc.deleted).map(([id, at]) => [id, tooNew(at) ? cap : at])),
  };
}
