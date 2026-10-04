import { describe, it, expect } from 'vitest';
import { groupDocumentSchema, groupSettingsSchema } from '@/lib/validation/schemas';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';
import { MAX_LENGTHS } from '@/lib/utils/validation';

// Minimal valid group document fixture for schema tests
function minimalDoc(overrides: Record<string, unknown> = {}) {
  return {
    meta: {
      id: 'g1',
      name: 'Trip',
      settings: DEFAULT_GROUP_SETTINGS,
      state: 'active',
      createdBy: 'peer-alice',
      createdAt: '2026-01-01T00:00:00Z',
    },
    members: {
      'peer-alice': { peerId: 'peer-alice', displayName: 'Alice', avatar: '', joinedAt: '2026-01-01T00:00:00Z' },
    },
    expenses: {},
    settlements: {},
    deleted: {},
    ...overrides,
  };
}

function minimalExpense(overrides: Record<string, unknown> = {}) {
  return {
    id: 'e1',
    groupId: 'g1',
    friendId: null,
    description: 'Dinner',
    totalAmount: 2000,
    currency: 'USD',
    payers: [{ userId: 'peer-alice', amount: 2000 }],
    splitType: 'equal',
    splits: [{ userId: 'peer-alice', amount: 2000 }],
    items: [],
    category: 'food',
    date: '2026-01-01T00:00:00Z',
    createdAt: '2026-01-01T00:00:00Z',
    createdBy: 'peer-alice',
    notes: '',
    ...overrides,
  };
}

describe('groupDocumentSchema amount field hardening', () => {
  it('accepts a valid document', () => {
    const result = groupDocumentSchema.safeParse(minimalDoc());
    expect(result.success).toBe(true);
  });

  it('rejects an expense with a negative totalAmount', () => {
    const doc = minimalDoc({ expenses: { e1: minimalExpense({ totalAmount: -100 }) } });
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects an expense with Infinity totalAmount', () => {
    const doc = minimalDoc({ expenses: { e1: minimalExpense({ totalAmount: Infinity }) } });
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects a payer with a negative amount', () => {
    const doc = minimalDoc({ expenses: { e1: minimalExpense({ payers: [{ userId: 'peer-alice', amount: -500 }] }) } });
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects a split with a negative amount', () => {
    const doc = minimalDoc({ expenses: { e1: minimalExpense({ splits: [{ userId: 'peer-alice', amount: -500 }] }) } });
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects a settlement with a negative amount', () => {
    const settlement = { id: 's1', groupId: 'g1', from: 'peer-alice', to: 'peer-bob', amount: -100, date: '2026-01-02T00:00:00Z', note: '', settlesExpenses: [] };
    const doc = minimalDoc({ settlements: { s1: settlement } });
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects a settlement with a zero amount', () => {
    const settlement = { id: 's1', groupId: 'g1', from: 'peer-alice', to: 'peer-bob', amount: 0, date: '2026-01-02T00:00:00Z', note: '', settlesExpenses: [] };
    const doc = minimalDoc({ settlements: { s1: settlement } });
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });
});

describe('F-153: free-text length caps at the schema boundary', () => {
  it('rejects an expense description over the max length', () => {
    const doc = minimalDoc({ expenses: { e1: minimalExpense({ description: 'x'.repeat(MAX_LENGTHS.expenseDescription + 1) }) } });
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects expense notes over the max length', () => {
    const doc = minimalDoc({ expenses: { e1: minimalExpense({ notes: 'x'.repeat(MAX_LENGTHS.notes + 1) }) } });
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects a group name over the max length', () => {
    const doc = minimalDoc();
    (doc.meta as { name: string }).name = 'x'.repeat(MAX_LENGTHS.groupName + 1);
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects a member displayName over the max length', () => {
    const doc = minimalDoc({
      members: {
        'peer-alice': { peerId: 'peer-alice', displayName: 'x'.repeat(MAX_LENGTHS.displayName + 1), avatar: '', joinedAt: '2026-01-01T00:00:00Z' },
      },
    });
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects a custom category label over the max length', () => {
    const doc = minimalDoc();
    (doc.meta as { settings: typeof DEFAULT_GROUP_SETTINGS }).settings = {
      ...DEFAULT_GROUP_SETTINGS,
      customCategories: [{ id: 'c1', label: 'x'.repeat(MAX_LENGTHS.categoryLabel + 1) }],
    };
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects an expense item name over the max length', () => {
    const doc = minimalDoc({
      expenses: { e1: minimalExpense({ items: [{ name: 'x'.repeat(MAX_LENGTHS.itemName + 1), amount: 100, assignees: ['peer-alice'] }] }) },
    });
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('rejects a settlement note over the max length', () => {
    const settlement = { id: 's1', groupId: 'g1', from: 'peer-alice', to: 'peer-bob', amount: 100, date: '2026-01-02T00:00:00Z', note: 'x'.repeat(MAX_LENGTHS.notes + 1), settlesExpenses: [] };
    const doc = minimalDoc({ settlements: { s1: settlement } });
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(false);
  });

  it('still accepts values at exactly the max length', () => {
    const doc = minimalDoc({ expenses: { e1: minimalExpense({ description: 'x'.repeat(MAX_LENGTHS.expenseDescription) }) } });
    const result = groupDocumentSchema.safeParse(doc);
    expect(result.success).toBe(true);
  });
});

describe('groupSettingsSchema settleThreshold guard', () => {
  it('rejects a negative settleThreshold', () => {
    const result = groupSettingsSchema.safeParse({ ...DEFAULT_GROUP_SETTINGS, settleThreshold: -1 });
    expect(result.success).toBe(false);
  });

  it('accepts a zero settleThreshold (disabled)', () => {
    const result = groupSettingsSchema.safeParse({ ...DEFAULT_GROUP_SETTINGS, settleThreshold: 0 });
    expect(result.success).toBe(true);
  });
});
