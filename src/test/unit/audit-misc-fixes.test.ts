// Regression coverage for determinism, display, and backup behavior.
import { describe, it, expect } from 'vitest';
import { simplifyDebts } from '@/lib/balance/simplify';
import { getCategoryOptions, slugifyCategoryLabel } from '@/lib/utils/categories';
import { toLocalDate, formatExpenseDate } from '@/lib/utils/date';
import { exportExpensesToCSV, importGroupFromJSON, exportGroupToJSON } from '@/lib/io/backup';
import { getCategoryBreakdown } from '@/lib/balance/calculator';
import { createGroupDocument } from '@/lib/crdt/document';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';
import type { GroupDocument } from '@/lib/crdt/document';
import type { Expense } from '@/types';

function makeExpense(over: Partial<Expense> = {}): Expense {
  return {
    id: 'e1', groupId: 'g1', friendId: null, description: 'Dinner',
    totalAmount: 10000, currency: 'USD',
    payers: [{ userId: 'peer-a', amount: 10000 }],
    splitType: 'equal',
    splits: [{ userId: 'peer-a', amount: 5000 }, { userId: 'peer-b', amount: 5000 }],
    items: [], category: 'food', date: '2026-01-15',
    createdAt: '2026-01-15T00:00:00Z', createdBy: 'peer-a', notes: '',
    ...over,
  };
}

function baseDoc(): GroupDocument {
  const doc = createGroupDocument('g1', 'Trip', 'peer-a', 'Alice', DEFAULT_GROUP_SETTINGS);
  doc.members['peer-b'] = { peerId: 'peer-b', displayName: 'Bob', avatar: '', joinedAt: '2026-01-01T00:00:00Z' };
  return doc;
}

describe('simplifyDebts produces the same plan on every peer', () => {
  it('does not depend on balance-map insertion order', () => {
    // Equal balances must sort deterministically, independent of insertion order.
    const orderA = { alice: 2000, bob: 2000, carol: -3000, dave: -1000 };
    const orderB = { bob: 2000, alice: 2000, dave: -1000, carol: -3000 };
    expect(simplifyDebts(orderA)).toEqual(simplifyDebts(orderB));
  });

  it('is stable across every permutation of an all-equal balance set', () => {
    const entries: [string, number][] = [
      ['w', 1000], ['x', 1000], ['y', -1000], ['z', -1000],
    ];
    const permutations = [
      entries,
      [...entries].reverse(),
      [entries[1]!, entries[0]!, entries[3]!, entries[2]!],
    ];
    const results = permutations.map(p => simplifyDebts(Object.fromEntries(p)));
    for (const r of results) expect(r).toEqual(results[0]);
  });

  it('still settles everyone to zero', () => {
    const balances = { alice: 2000, bob: 2000, carol: -3000, dave: -1000 };
    const net: Record<string, number> = { ...balances };
    for (const t of simplifyDebts(balances)) {
      net[t.from] = (net[t.from] || 0) + t.amount;
      net[t.to] = (net[t.to] || 0) - t.amount;
    }
    for (const v of Object.values(net)) expect(v).toBe(0);
  });
});

describe('category options are unique by value', () => {
  it('does not emit two options sharing a value', () => {
    // Custom IDs can collide with built-in IDs.
    expect(slugifyCategoryLabel('Travel')).toBe('travel');
    const options = getCategoryOptions({
      customCategories: [{ id: 'travel', label: 'My Travel' }],
      disabledCategories: [],
    });
    const values = options.map(o => o.value);
    expect(new Set(values).size).toBe(values.length);
  });

  it('lets the custom label win the collision', () => {
    const options = getCategoryOptions({
      customCategories: [{ id: 'travel', label: 'My Travel' }],
      disabledCategories: [],
    });
    expect(options.find(o => o.value === 'travel')?.label).toBe('My Travel');
  });

  it('still honours disabled defaults and keeps non-colliding customs', () => {
    const options = getCategoryOptions({
      customCategories: [{ id: 'pet-care', label: 'Pet Care' }],
      disabledCategories: ['food'],
    });
    expect(options.map(o => o.value)).toContain('pet-care');
    expect(options.map(o => o.value)).not.toContain('food');
  });
});

describe('dates do not silently invent a day', () => {
  it('rejects an empty string instead of returning 1 Jan 1900', () => {
    expect(Number.isNaN(toLocalDate('').getTime())).toBe(true);
  });

  it('rejects garbage instead of returning 1 Jan of the current year', () => {
    expect(Number.isNaN(toLocalDate('not-a-date').getTime())).toBe(true);
    expect(Number.isNaN(toLocalDate('2026-13-45').getTime())).toBe(true);
    expect(Number.isNaN(toLocalDate('26-1-5').getTime())).toBe(true);
  });

  it('still parses a bare calendar day at LOCAL midnight', () => {
    const d = toLocalDate('2026-01-15');
    expect(d.getFullYear()).toBe(2026);
    expect(d.getMonth()).toBe(0);
    expect(d.getDate()).toBe(15);
  });

  it('still parses a legacy ISO timestamp by its date part', () => {
    const d = toLocalDate('2026-01-15T12:00:00.000Z');
    expect(d.getDate()).toBe(15);
    expect(d.getMonth()).toBe(0);
  });

  it('formats calendar dates in the Indian day/month/year convention', () => {
    expect(formatExpenseDate('2026-09-07')).toBe('07/09/2026');
  });

  it('surfaces an unparseable date honestly rather than as a plausible day', () => {
    expect(formatExpenseDate('')).toBe('Invalid Date');
  });
});

describe('CSV export is complete and well-formed', () => {
  it('includes splits belonging to a member who was removed', () => {
    // removeMember does not rewrite existing splits, and the export only had
    // columns for CURRENT members - so those amounts vanished and the "owes"
    // columns stopped adding up to the total.
    const doc = baseDoc();
    doc.expenses['e1'] = makeExpense();
    delete doc.members['peer-b'];

    const csv = exportExpensesToCSV(doc);
    expect(csv).toContain('peer-b (removed) owes');
    // 50.00 appears for the removed member's share
    expect(csv.split('\r\n')[1]).toContain('50.00');
  });

  it('quotes a bare carriage return so the record is not split in two', () => {
    // Rows are joined with CRLF; an unquoted lone CR broke the record for Excel
    // and most CSV parsers.
    const doc = baseDoc();
    doc.expenses['e1'] = makeExpense({ description: 'Paid\rin cash' });
    const csv = exportExpensesToCSV(doc);
    expect(csv).toContain('"Paid\rin cash"');
    // header + exactly one data row
    expect(csv.split('\r\n')).toHaveLength(2);
  });

  it('still quotes commas, quotes and newlines', () => {
    const doc = baseDoc();
    doc.expenses['e1'] = makeExpense({ description: 'a,b "c"\nd' });
    expect(exportExpensesToCSV(doc)).toContain('"a,b ""c""\nd"');
  });

  it('emits a normal row for an ordinary expense', () => {
    const doc = baseDoc();
    doc.expenses['e1'] = makeExpense();
    const rows = exportExpensesToCSV(doc).split('\r\n');
    expect(rows).toHaveLength(2);
    expect(rows[1]).toContain('Dinner');
    expect(rows[1]).toContain('100.00');
  });
});

describe('group import reports its own errors', () => {
  it('rejects a file with no meta.settings with the user-facing message', () => {
    // The legacy-shape normalisation dereferences doc.meta.settings.customCategories,
    // so this used to surface a raw
    // "TypeError: Cannot read properties of undefined (reading 'customCategories')".
    const bad = JSON.stringify({
      meta: { id: 'g1', createdAt: '2026-01-01T00:00:00Z' },
      members: {},
      expenses: {},
    });
    expect(() => importGroupFromJSON(bad)).toThrow(/valid FairShare group export/i);
  });

  it('still rejects non-JSON with the JSON message', () => {
    expect(() => importGroupFromJSON('{{{')).toThrow(/not valid JSON/i);
  });

  it('still rejects a file missing members/expenses', () => {
    expect(() => importGroupFromJSON(JSON.stringify({ meta: { id: 'g1' } })))
      .toThrow(/valid FairShare group export/i);
  });

  it('round-trips a real export, preserving splitInputs', () => {
    const doc = baseDoc();
    doc.expenses['e1'] = makeExpense({
      splitType: 'shares',
      splits: [{ userId: 'peer-a', amount: 2500 }, { userId: 'peer-b', amount: 7500 }],
      splitInputs: { 'peer-a': 1, 'peer-b': 3 },
    });
    const restored = importGroupFromJSON(exportGroupToJSON(doc));
    expect(restored.expenses['e1'].splitInputs).toEqual({ 'peer-a': 1, 'peer-b': 3 });
  });
});

describe('category breakdown uses whole cents', () => {
  it('apportions a multi-tag expense to integers summing to the total', () => {
    // Was `totalAmount / cats.length`, which produced 333.33333333333337 per tag
    // (summing to 1000.0000000000001) and rendered as "$3.33.333333333333314"
    // once passed through formatCents.
    const breakdown = getCategoryBreakdown([
      makeExpense({ totalAmount: 1000, categories: ['food', 'travel', 'fun'] }),
    ]);
    const values = Object.values(breakdown);
    for (const v of values) expect(Number.isInteger(v)).toBe(true);
    expect(values.reduce((a, b) => a + b, 0)).toBe(1000);
  });

  it('is unaffected for a single-category expense', () => {
    expect(getCategoryBreakdown([makeExpense({ totalAmount: 1000, category: 'food' })]))
      .toEqual({ food: 1000 });
  });

  it('accumulates across expenses without drifting', () => {
    const breakdown = getCategoryBreakdown([
      makeExpense({ id: 'a', totalAmount: 1000, categories: ['food', 'travel', 'fun'] }),
      makeExpense({ id: 'b', totalAmount: 1000, categories: ['food', 'travel', 'fun'] }),
    ]);
    expect(Object.values(breakdown).reduce((a, b) => a + b, 0)).toBe(2000);
  });
});
