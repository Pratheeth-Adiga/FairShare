import { describe, it, expect } from 'vitest';
import { mergeDocuments } from '@/lib/crdt/merge';
import { createGroupDocument } from '@/lib/crdt/document';
import { addExpense, addMember, addSettlement, deleteExpense, updateGroupSettings, changeGroupState } from '@/lib/crdt/operations';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';
import type { Expense, Settlement } from '@/types';

function makeExpense(overrides: Partial<Expense> = {}): Expense {
  return {
    id: 'e1',
    groupId: 'g1',
    friendId: null,
    description: 'Dinner',
    totalAmount: 2000,
    currency: 'USD',
    payers: [{ userId: 'peer-alice', amount: 2000 }],
    splitType: 'equal',
    splits: [
      { userId: 'peer-alice', amount: 1000 },
      { userId: 'peer-bob', amount: 1000 },
    ],
    items: [],
    category: 'food',
    date: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    updatedAt: '2026-01-01T00:00:00Z',
    createdBy: 'peer-alice',
    notes: '',
    ...overrides,
  };
}

function baseDoc() {
  const doc = createGroupDocument('g1', 'Trip', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);
  return addMember(doc, { peerId: 'peer-bob', displayName: 'Bob', avatar: '', joinedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-01T00:00:00Z' });
}

describe('mergeDocuments - expenses/members (LWW)', () => {
  it('unions expenses that only exist on one side', () => {
    const local = addExpense(baseDoc(), makeExpense({ id: 'e1' }));
    const remote = addExpense(baseDoc(), makeExpense({ id: 'e2' }));
    const merged = mergeDocuments(local, remote);
    expect(Object.keys(merged.expenses).sort()).toEqual(['e1', 'e2']);
  });

  it('picks the expense with the newer updatedAt on conflict', () => {
    const local = addExpense(baseDoc(), makeExpense({ description: 'Old', updatedAt: '2026-01-01T00:00:00Z' }));
    const remote = addExpense(baseDoc(), makeExpense({ description: 'New', updatedAt: '2026-01-02T00:00:00Z' }));
    const merged = mergeDocuments(local, remote);
    expect(merged.expenses['e1'].description).toBe('New');
  });

  it('is commutative (merge(a,b) content matches merge(b,a) content) on a genuine conflict', () => {
    const local = addExpense(baseDoc(), makeExpense({ description: 'Old', updatedAt: '2026-01-01T00:00:00Z' }));
    const remote = addExpense(baseDoc(), makeExpense({ description: 'New', updatedAt: '2026-01-02T00:00:00Z' }));
    const ab = mergeDocuments(local, remote);
    const ba = mergeDocuments(remote, local);
    expect(ab.expenses).toEqual(ba.expenses);
  });

  it('falls back to deterministic content comparison on an exact updatedAt tie', () => {
    const local = addExpense(baseDoc(), makeExpense({ description: 'AAA', updatedAt: '2026-01-01T00:00:00Z' }));
    const remote = addExpense(baseDoc(), makeExpense({ description: 'ZZZ', updatedAt: '2026-01-01T00:00:00Z' }));
    const ab = mergeDocuments(local, remote);
    const ba = mergeDocuments(remote, local);
    // Same winner regardless of merge order.
    expect(ab.expenses['e1']).toEqual(ba.expenses['e1']);
  });

  it('merges member profiles with the same LWW rule', () => {
    const local = baseDoc();
    const remote = { ...baseDoc(), members: { ...baseDoc().members, 'peer-bob': { peerId: 'peer-bob', displayName: 'Bobby', avatar: '', joinedAt: '2026-01-01T00:00:00Z', updatedAt: '2026-01-03T00:00:00Z' } } };
    const merged = mergeDocuments(local, remote);
    expect(merged.members['peer-bob'].displayName).toBe('Bobby');
  });
});

describe('mergeDocuments - tombstones', () => {
  it('unions tombstones from both sides', () => {
    let local = addExpense(baseDoc(), makeExpense({ id: 'e1' }));
    local = addExpense(local, makeExpense({ id: 'e2' }));
    local = deleteExpense(local, 'e1');

    let remote = addExpense(baseDoc(), makeExpense({ id: 'e1' }));
    remote = addExpense(remote, makeExpense({ id: 'e2' }));
    remote = deleteExpense(remote, 'e2');

    const merged = mergeDocuments(local, remote);
    expect(Object.keys(merged.deleted).sort()).toEqual(['e1', 'e2']);
    expect(merged.expenses['e1']).toBeUndefined();
    expect(merged.expenses['e2']).toBeUndefined();
  });

  // Latest deletion timestamps must win and merge associativity must hold.
  it('keeps the latest deletion timestamp when both sides deleted the same expense', () => {
    let local = addExpense(baseDoc(), makeExpense({ id: 'e1' }));
    local = { ...deleteExpense(local, 'e1'), deleted: { e1: '2026-01-05T00:00:00Z' } };

    let remote = addExpense(baseDoc(), makeExpense({ id: 'e1' }));
    remote = { ...deleteExpense(remote, 'e1'), deleted: { e1: '2026-01-02T00:00:00Z' } };

    expect(mergeDocuments(local, remote).deleted['e1']).toBe('2026-01-05T00:00:00Z');
    // and the choice must not depend on which side is "local"
    expect(mergeDocuments(remote, local).deleted['e1']).toBe('2026-01-05T00:00:00Z');
  });

  it('strips settlesExpenses references to expenses deleted on the other side', () => {
    const settlement: Settlement = {
      id: 's1', groupId: 'g1', from: 'peer-bob', to: 'peer-alice', amount: 500, date: '2026-01-02T00:00:00Z', note: '', settlesExpenses: ['e1'],
    };
    let local = addExpense(baseDoc(), makeExpense({ id: 'e1' }));
    local = addSettlement(local, settlement);

    let remote = addExpense(baseDoc(), makeExpense({ id: 'e1' }));
    remote = deleteExpense(remote, 'e1');

    const merged = mergeDocuments(local, remote);
    expect(merged.settlements['s1'].settlesExpenses).toEqual([]);
  });
});

describe('mergeDocuments - meta', () => {
  it('picks the older createdAt document as the base for id/name/createdBy', () => {
    const older = createGroupDocument('g1', 'Original Name', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);
    older.meta.createdAt = '2026-01-01T00:00:00Z';
    const newer = createGroupDocument('g1', 'Renamed Locally', 'peer-bob', 'Bob', DEFAULT_GROUP_SETTINGS);
    newer.meta.createdAt = '2026-06-01T00:00:00Z';

    const merged = mergeDocuments(newer, older);
    expect(merged.meta.name).toBe('Original Name');
    expect(merged.meta.createdBy).toBe('peer-alice');
  });

  // Unstamped documents retain the legacy state-priority fallback.
  it('applies state priority when NEITHER side carries a stamp', () => {
    const unstamped = (state: 'active' | 'settling' | 'archived' | 'closed') => {
      const d = baseDoc();
      return { ...d, meta: { ...d.meta, state } };
    };
    expect(mergeDocuments(unstamped('active'), unstamped('closed')).meta.state).toBe('active');
    expect(mergeDocuments(unstamped('closed'), unstamped('active')).meta.state).toBe('active');
    expect(mergeDocuments(unstamped('settling'), unstamped('archived')).meta.state).toBe('settling');
  });

  it('a stamped state change beats an unstamped peer, so archiving actually sticks', () => {
    const active = baseDoc();
    const closed = changeGroupState(baseDoc(), 'closed');
    expect(mergeDocuments(active, closed).meta.state).toBe('closed');
    expect(mergeDocuments(closed, active).meta.state).toBe('closed');
  });

  it('resolves two stamped state changes by last-write-wins, in either order', () => {
    const older = changeGroupState(baseDoc(), 'archived');
    older.meta.stateUpdatedAt = '2026-01-01T00:00:00Z';
    const newer = changeGroupState(baseDoc(), 'active');
    newer.meta.stateUpdatedAt = '2026-06-01T00:00:00Z';
    expect(mergeDocuments(older, newer).meta.state).toBe('active');
    expect(mergeDocuments(newer, older).meta.state).toBe('active');
  });

  it('resolves settings via LWW on settingsUpdatedAt', () => {
    const local = updateGroupSettings(baseDoc(), { defaultCurrency: 'EUR' });
    local.meta.settingsUpdatedAt = '2026-01-01T00:00:00Z';
    const remote = updateGroupSettings(baseDoc(), { defaultCurrency: 'GBP' });
    remote.meta.settingsUpdatedAt = '2026-01-02T00:00:00Z';

    const merged = mergeDocuments(local, remote);
    expect(merged.meta.settings.defaultCurrency).toBe('GBP');
  });

  it('ratchets version to the max of both sides', () => {
    let local = baseDoc();
    local = addExpense(local, makeExpense({ id: 'e1' }));
    local = addExpense(local, makeExpense({ id: 'e2' }));
    const remote = baseDoc();

    const merged = mergeDocuments(local, remote);
    expect(merged.version).toBe(Math.max(local.version || 0, remote.version || 0));
  });

  it('falls back to DEFAULT_GROUP_SETTINGS when both peers have invalid settings', () => {
    // Simulate two peers whose settings objects failed schema validation by
    // hand-crafting documents with invalid (empty) settings objects.
    const local = { ...baseDoc(), meta: { ...baseDoc().meta, settings: {} as never, settingsUpdatedAt: '2026-01-01T00:00:00Z' } };
    const remote = { ...baseDoc(), meta: { ...baseDoc().meta, settings: {} as never, settingsUpdatedAt: '2026-01-02T00:00:00Z' } };
    const merged = mergeDocuments(local, remote);
    // The fallback must be the canonical default, not whatever the winner had.
    expect(merged.meta.settings).toEqual(DEFAULT_GROUP_SETTINGS);
  });
});

describe('mergeDocuments - settlements', () => {
  it('uses LWW to resolve settlement ID collisions', () => {
    const s1Old: Settlement = {
      id: 's1', groupId: 'g1', from: 'peer-bob', to: 'peer-alice', amount: 500,
      date: '2026-01-01T00:00:00Z', note: 'old', settlesExpenses: [],
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const s1New: Settlement = {
      id: 's1', groupId: 'g1', from: 'peer-bob', to: 'peer-alice', amount: 1000,
      date: '2026-01-02T00:00:00Z', note: 'new', settlesExpenses: [],
      updatedAt: '2026-01-02T00:00:00Z',
    };
    const local = addSettlement(baseDoc(), s1Old);
    const remote = addSettlement(baseDoc(), s1New);
    const merged = mergeDocuments(local, remote);
    expect(merged.settlements['s1'].amount).toBe(1000);
    expect(merged.settlements['s1'].note).toBe('new');
  });

  it('is commutative for settlement LWW conflicts', () => {
    const s1Old: Settlement = {
      id: 's1', groupId: 'g1', from: 'peer-bob', to: 'peer-alice', amount: 500,
      date: '2026-01-01T00:00:00Z', note: 'old', settlesExpenses: [],
      updatedAt: '2026-01-01T00:00:00Z',
    };
    const s1New: Settlement = {
      id: 's1', groupId: 'g1', from: 'peer-bob', to: 'peer-alice', amount: 1000,
      date: '2026-01-02T00:00:00Z', note: 'new', settlesExpenses: [],
      updatedAt: '2026-01-02T00:00:00Z',
    };
    const local = addSettlement(baseDoc(), s1Old);
    const remote = addSettlement(baseDoc(), s1New);
    const ab = mergeDocuments(local, remote);
    const ba = mergeDocuments(remote, local);
    expect(ab.settlements).toEqual(ba.settlements);
  });

  it('unions settlements that only exist on one side', () => {
    const s1: Settlement = {
      id: 's1', groupId: 'g1', from: 'peer-bob', to: 'peer-alice', amount: 500,
      date: '2026-01-01T00:00:00Z', note: '', settlesExpenses: [],
    };
    const s2: Settlement = {
      id: 's2', groupId: 'g1', from: 'peer-alice', to: 'peer-bob', amount: 300,
      date: '2026-01-02T00:00:00Z', note: '', settlesExpenses: [],
    };
    const local = addSettlement(baseDoc(), s1);
    const remote = addSettlement(baseDoc(), s2);
    const merged = mergeDocuments(local, remote);
    expect(Object.keys(merged.settlements).sort()).toEqual(['s1', 's2']);
  });

  it('strips deleted expense refs from settlements during merge', () => {
    const s1: Settlement = {
      id: 's1', groupId: 'g1', from: 'peer-bob', to: 'peer-alice', amount: 500,
      date: '2026-01-01T00:00:00Z', note: '', settlesExpenses: ['e1', 'e2'],
    };
    let local = addExpense(baseDoc(), makeExpense({ id: 'e1' }));
    local = addExpense(local, makeExpense({ id: 'e2' }));
    local = addSettlement(local, s1);

    let remote = addExpense(baseDoc(), makeExpense({ id: 'e1' }));
    remote = addExpense(remote, makeExpense({ id: 'e2' }));
    remote = deleteExpense(remote, 'e1');

    const merged = mergeDocuments(local, remote);
    expect(merged.settlements['s1'].settlesExpenses).toEqual(['e2']);
  });
});
