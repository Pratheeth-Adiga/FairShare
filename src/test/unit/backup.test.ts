import { describe, it, expect } from 'vitest';
import {
  exportGroupToJSON,
  importGroupFromJSON,
  exportExpensesToCSV,
  exportIdentityToJSON,
  importIdentityFromJSON,
  downloadTextFile,
} from '@/lib/io/backup';
import { createGroupDocument } from '@/lib/crdt/document';
import { addExpense, addMember, deleteExpense } from '@/lib/crdt/operations';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';
import type { Expense, UserIdentity } from '@/types';

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
    createdBy: 'peer-alice',
    notes: '',
    ...overrides,
  };
}

function baseDoc() {
  const doc = createGroupDocument('g1', 'Trip', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);
  return addMember(doc, { peerId: 'peer-bob', displayName: 'Bob', avatar: '', joinedAt: '2026-01-01T00:00:00Z' });
}

function makeIdentity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    peerId: 'peer-abcdef0123456789',
    publicKey: 'a'.repeat(64),
    privateKey: 'b'.repeat(96),
    displayName: 'Alice',
    avatar: '',
    createdAt: '2026-01-01T00:00:00Z',
    ...overrides,
  };
}

describe('exportGroupToJSON / importGroupFromJSON', () => {
  it('round-trips a group document', () => {
    const doc = addExpense(baseDoc(), makeExpense());
    const json = exportGroupToJSON(doc);
    const imported = importGroupFromJSON(json);
    expect(imported).toEqual(doc);
  });

  it('accepts a bare GroupDocument (not wrapped in an export file) for forward/backward compat', () => {
    const doc = addExpense(baseDoc(), makeExpense());
    const imported = importGroupFromJSON(JSON.stringify(doc));
    expect(imported.meta.id).toBe('g1');
  });

  it('rejects invalid JSON', () => {
    expect(() => importGroupFromJSON('{not json')).toThrow('That file is not valid JSON.');
  });

  it('rejects an object missing required group fields', () => {
    expect(() => importGroupFromJSON(JSON.stringify({ foo: 'bar' }))).toThrow(
      'This file does not contain a valid FairShare group export.'
    );
  });

  it('normalizes a legacy array-based deleted field into a record', () => {
    const doc = addExpense(baseDoc(), makeExpense());
    const legacy = { ...doc, deleted: ['e1'] };
    const imported = importGroupFromJSON(JSON.stringify(legacy));
    expect(imported.deleted['e1']).toBeTruthy();
  });

  it('fills in missing settlements/customCategories/disabledCategories/version for older exports', () => {
    const doc = addExpense(baseDoc(), makeExpense());
    const legacy: Record<string, unknown> = { ...doc };
    delete (legacy as { settlements?: unknown }).settlements;
    delete (legacy as { version?: unknown }).version;
    const meta = { ...doc.meta, settings: { ...doc.meta.settings } };
    delete (meta.settings as { customCategories?: unknown }).customCategories;
    delete (meta.settings as { disabledCategories?: unknown }).disabledCategories;
    legacy.meta = meta;

    const imported = importGroupFromJSON(JSON.stringify(legacy));
    expect(imported.settlements).toEqual({});
    expect(imported.version).toBe(0);
    expect(imported.meta.settings.customCategories).toEqual([]);
    expect(imported.meta.settings.disabledCategories).toEqual([]);
  });

  it('rejects a document that fails schema validation after normalization', () => {
    const doc = addExpense(baseDoc(), makeExpense());
    const invalid = { ...doc, meta: { ...doc.meta, id: '' } };
    expect(() => importGroupFromJSON(JSON.stringify(invalid))).toThrow(
      /does not contain a valid FairShare group export/
    );
  });
});

describe('exportExpensesToCSV', () => {
  it('produces a header row plus one row per non-deleted expense', () => {
    let doc = addExpense(baseDoc(), makeExpense({ id: 'e1' }));
    doc = addExpense(doc, makeExpense({ id: 'e2', date: '2026-01-02T00:00:00Z' }));
    doc = deleteExpense(doc, 'e1');

    const csv = exportExpensesToCSV(doc);
    const lines = csv.split('\r\n');
    expect(lines).toHaveLength(2); // header + e2 only
    expect(lines[0]).toContain('Date,Description,Category');
    expect(lines[1]).toContain('Dinner');
  });

  it('escapes values containing commas, quotes, or newlines', () => {
    const doc = addExpense(baseDoc(), makeExpense({ description: 'Pizza, "extra cheese"' }));
    const csv = exportExpensesToCSV(doc);
    expect(csv).toContain('"Pizza, ""extra cheese"""');
  });
});

describe('exportIdentityToJSON / importIdentityFromJSON', () => {
  it('round-trips a user identity', () => {
    const identity = makeIdentity();
    const imported = importIdentityFromJSON(exportIdentityToJSON(identity));
    expect(imported).toEqual(identity);
  });

  it('accepts a bare UserIdentity (not wrapped in an export file)', () => {
    const identity = makeIdentity();
    const imported = importIdentityFromJSON(JSON.stringify(identity));
    expect(imported).toEqual(identity);
  });

  it('rejects invalid JSON', () => {
    expect(() => importIdentityFromJSON('not json')).toThrow('That file is not valid JSON.');
  });

  it('rejects an identity missing required fields', () => {
    const { privateKey, ...withoutPrivateKey } = makeIdentity();
    void privateKey;
    expect(() => importIdentityFromJSON(JSON.stringify(withoutPrivateKey))).toThrow(
      /does not contain a valid FairShare identity export/
    );
  });
});

describe('downloadTextFile', () => {
  it('creates and clicks a download link in the browser', async () => {
    await expect(downloadTextFile('test.json', '{}', 'application/json')).resolves.toBe('Downloaded test.json');
  });
});
