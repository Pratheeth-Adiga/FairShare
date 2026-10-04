// Follow-up regression coverage for bugs found during the 2026-09-01 fix pass.
import { describe, it, expect } from 'vitest';
import { mergeDocuments } from '@/lib/crdt/merge';
import { renameGroup, addExpense, editExpense } from '@/lib/crdt/operations';
import { createGroupDocument } from '@/lib/crdt/document';
import { groupDocumentSchema } from '@/lib/validation/schemas';
import { deserializeMessage, serializeMessage, CONTROL_MESSAGE_TYPES } from '@/lib/p2p/message-protocol';
import { isSplitValid } from '@/lib/balance/validation';
import { estimatePassphraseStrength } from '@/lib/crypto/passphrase-strength';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';
import type { GroupDocument } from '@/lib/crdt/document';
import type { Expense } from '@/types';

function baseDoc(name = 'Trip'): GroupDocument {
  const doc = createGroupDocument('g1', name, 'peer-a', 'Alice', DEFAULT_GROUP_SETTINGS);
  doc.members['peer-b'] = {
    peerId: 'peer-b', displayName: 'Bob', avatar: '', joinedAt: '2026-01-01T00:00:00Z',
  };
  return doc;
}

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

// group names use a last-write-wins timestamp
describe('group rename propagation', () => {
  it('a remote rename with a newer stamp wins', () => {
    const local = baseDoc('Trip');
    const remote = renameGroup(baseDoc('Trip'), 'Iceland 2026');
    expect(mergeDocuments(local, remote).meta.name).toBe('Iceland 2026');
  });

  it('a local rename with a newer stamp is not clobbered by a stale remote', () => {
    const local = renameGroup(baseDoc('Trip'), 'Iceland 2026');
    const remote = baseDoc('Trip');
    expect(mergeDocuments(local, remote).meta.name).toBe('Iceland 2026');
  });

  it('the newer of two competing renames wins regardless of merge order', () => {
    const older = { ...baseDoc('Trip') };
    older.meta = { ...older.meta, name: 'Old Name', nameUpdatedAt: '2026-01-01T00:00:00Z' };
    const newer = { ...baseDoc('Trip') };
    newer.meta = { ...newer.meta, name: 'New Name', nameUpdatedAt: '2026-06-01T00:00:00Z' };

    // Both merge orders must converge.
    expect(mergeDocuments(older, newer).meta.name).toBe('New Name');
    expect(mergeDocuments(newer, older).meta.name).toBe('New Name');
  });

  it('carries the winning stamp forward so the rename keeps winning on the next hop', () => {
    const local = baseDoc('Trip');
    const remote = renameGroup(baseDoc('Trip'), 'Iceland 2026');
    const merged = mergeDocuments(local, remote);
    expect(merged.meta.nameUpdatedAt).toBe(remote.meta.nameUpdatedAt);
    // The winning stamp survives another merge:
    expect(mergeDocuments(baseDoc('Trip'), merged).meta.name).toBe('Iceland 2026');
  });

  it('still prefers the older document for the IMMUTABLE identity fields', () => {
    const older = createGroupDocument('g1', 'Original Name', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);
    older.meta.createdAt = '2026-01-01T00:00:00Z';
    const newer = createGroupDocument('g1', 'Renamed Locally', 'peer-bob', 'Bob', DEFAULT_GROUP_SETTINGS);
    newer.meta.createdAt = '2026-06-01T00:00:00Z';
    expect(mergeDocuments(newer, older).meta.createdBy).toBe('peer-alice');
    expect(mergeDocuments(newer, older).meta.createdAt).toBe('2026-01-01T00:00:00Z');
  });

  it('renameGroup trims and rejects an empty name', () => {
    expect(renameGroup(baseDoc(), '  Padded  ').meta.name).toBe('Padded');
    expect(() => renameGroup(baseDoc(), '   ')).toThrow();
  });

  it('renameGroup bumps the version so the change is gossipped', () => {
    const before = baseDoc();
    expect(renameGroup(before, 'X').version).toBe((before.version || 0) + 1);
  });

  it('nameUpdatedAt survives the persistence/wire schema', () => {
    // Zod strips unknown keys, so a field missing from the schema is silently
    // deleted on every load and every P2P ingest.
    const renamed = renameGroup(baseDoc(), 'Iceland 2026');
    const parsed = groupDocumentSchema.safeParse(JSON.parse(JSON.stringify(renamed)));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.meta.nameUpdatedAt).toBe(renamed.meta.nameUpdatedAt);
  });
});

// member public keys must survive schema validation
describe('member publicKey survives validation', () => {
  const KEY = 'ab'.repeat(32); // 64 hex chars

  it('preserves publicKey on a member profile', () => {
    const doc = createGroupDocument('g1', 'Trip', 'peer-a', 'Alice', DEFAULT_GROUP_SETTINGS, KEY);
    const parsed = groupDocumentSchema.safeParse(JSON.parse(JSON.stringify(doc)));
    expect(parsed.success).toBe(true);
    expect(parsed.success && parsed.data.members['peer-a'].publicKey).toBe(KEY);
  });

  it('still accepts members without a publicKey in legacy documents', () => {
    const doc = createGroupDocument('g1', 'Trip', 'peer-a', 'Alice', DEFAULT_GROUP_SETTINGS);
    expect(groupDocumentSchema.safeParse(JSON.parse(JSON.stringify(doc))).success).toBe(true);
  });

  it('omits the key entirely rather than storing undefined when none is supplied', () => {
    // An explicit `publicKey: undefined` is not the same as an absent key: it
    // makes `in` checks answer true and disappears on JSON.stringify, so the
    // in-memory and persisted documents would not agree.
    const doc = createGroupDocument('g1', 'Trip', 'peer-a', 'Alice', DEFAULT_GROUP_SETTINGS);
    expect('publicKey' in doc.members['peer-a']).toBe(false);
  });

  it('rejects an absurdly long publicKey', () => {
    const doc = createGroupDocument('g1', 'Trip', 'peer-a', 'Alice', DEFAULT_GROUP_SETTINGS, 'a'.repeat(5000));
    expect(groupDocumentSchema.safeParse(JSON.parse(JSON.stringify(doc))).success).toBe(false);
  });
});

// bound every peer ID used in persisted maps
describe('peerId bounds applied consistently', () => {
  const huge = 'peer-' + 'a'.repeat(200_000);

  const docWith = (mutate: (d: Record<string, never>) => void) => {
    const doc = JSON.parse(JSON.stringify(baseDoc()));
    mutate(doc);
    return groupDocumentSchema.safeParse(doc).success;
  };

  it('rejects an oversized settlement "from"', () => {
    expect(docWith(d => {
      (d as never as GroupDocument).settlements['s1'] = {
        id: 's1', groupId: 'g1', from: huge, to: 'peer-b',
        amount: 100, date: '2026-01-01', note: '', settlesExpenses: [],
      };
    })).toBe(false);
  });

  it('rejects an oversized expense payer userId', () => {
    expect(docWith(d => {
      (d as never as GroupDocument).expenses['e1'] = makeExpense({
        payers: [{ userId: huge, amount: 10000 }],
      });
    })).toBe(false);
  });

  it('rejects an oversized expense createdBy', () => {
    expect(docWith(d => {
      (d as never as GroupDocument).expenses['e1'] = makeExpense({ createdBy: huge });
    })).toBe(false);
  });

  it('still accepts a normal document', () => {
    expect(docWith(() => {})).toBe(true);
  });
});

// only ping/pong may omit groupId
describe('only connection-level messages are exempt from the groupId requirement', () => {
  const frame = (type: string, groupId: string) => serializeMessage({
    id: '11111111-2222-3333-4444-555555555555',
    type: type as never, groupId, from: 'peer-a', hopCount: 0,
    timestamp: '2026-09-01T00:00:00.000Z',
  });

  // the hello handshake and peer-announce are connection-level too
  it('exempts exactly the connection-level types', () => {
    expect([...CONTROL_MESSAGE_TYPES].sort()).toEqual(['hello', 'hello-proof', 'peer-announce', 'ping', 'pong']);
  });

  for (const type of ['ping', 'pong', 'hello', 'hello-proof', 'peer-announce']) {
    it(`accepts ${type} with an empty groupId`, () => {
      expect(deserializeMessage(frame(type, ''))).not.toBeNull();
    });
    it(`accepts ${type} with a real groupId too`, () => {
      expect(deserializeMessage(frame(type, 'g1'))).not.toBeNull();
    });
  }

  for (const type of ['sync-request', 'document',
                      'introduce-request', 'introduce-offer', 'introduce-answer']) {
    it(`still rejects ${type} with an empty groupId`, () => {
      expect(deserializeMessage(frame(type, ''))).toBeNull();
    });
  }

  it('rejects an oversized groupId even on a ping', () => {
    expect(deserializeMessage(frame('ping', 'g'.repeat(1000)))).toBeNull();
  });

  it('rejects an oversized `from` field', () => {
    expect(deserializeMessage(serializeMessage({
      id: 'i', type: 'ping', groupId: '', from: 'p'.repeat(1000),
      hopCount: 0, timestamp: 't',
    }))).toBeNull();
  });
});

// both expense forms use the shared split predicates
describe('shared split validation covers by_weight', () => {
  const members = ['peer-a', 'peer-b'];

  it('accepts a shares split where one member is deliberately set to 0', () => {
    expect(isSplitValid('shares', members, 10000, { shares: { 'peer-a': '1', 'peer-b': '0' } }))
      .toBe(true);
  });

  it('applies the identical rule to by_weight', () => {
    expect(isSplitValid('by_weight', members, 10000, { shares: { 'peer-a': '3', 'peer-b': '0' } }))
      .toBe(true);
  });

  it('rejects a by_weight split where every weight is 0', () => {
    // calculateSplits returns {} for a zero total weight, which would drop
    // everybody from the expense.
    expect(isSplitValid('by_weight', members, 10000, { shares: { 'peer-a': '0', 'peer-b': '0' } }))
      .toBe(false);
  });

  it('rejects by_weight with no weights supplied at all', () => {
    expect(isSplitValid('by_weight', members, 10000, {})).toBe(false);
  });
});

// editExpense validates the merged expense, not an incomplete patch
describe('editExpense enforces the same invariants as addExpense', () => {
  const withExpense = () => addExpense(baseDoc(), makeExpense());

  it('rejects raising totalAmount without updating the splits', () => {
    expect(() => editExpense(withExpense(), 'e1', { totalAmount: 20000 })).toThrow();
  });

  it('rejects splits that no longer sum to totalAmount', () => {
    expect(() => editExpense(withExpense(), 'e1', {
      splits: [{ userId: 'peer-a', amount: 100 }, { userId: 'peer-b', amount: 100 }],
    })).toThrow();
  });

  it('rejects payers that no longer sum to totalAmount', () => {
    expect(() => editExpense(withExpense(), 'e1', {
      payers: [{ userId: 'peer-a', amount: 1 }],
    })).toThrow();
  });

  it('accepts a coherent amount + payers + splits change together', () => {
    expect(() => editExpense(withExpense(), 'e1', {
      totalAmount: 20000,
      payers: [{ userId: 'peer-a', amount: 20000 }],
      splits: [{ userId: 'peer-a', amount: 10000 }, { userId: 'peer-b', amount: 10000 }],
    })).not.toThrow();
  });

  it('accepts an edit that does not touch the money at all', () => {
    expect(() => editExpense(withExpense(), 'e1', { description: 'Renamed' })).not.toThrow();
  });

  it('rejects a non-positive totalAmount', () => {
    expect(() => editExpense(withExpense(), 'e1', {
      totalAmount: 0, payers: [{ userId: 'peer-a', amount: 0 }],
      splits: [{ userId: 'peer-a', amount: 0 }],
    })).toThrow();
  });

  it('tolerates the 1-cent remainder a real split leaves behind', () => {
    // An equal 3-way split of 10.00 is 3.34/3.33/3.33; the roundingAssignee
    // absorbs the leftover cent. That must not be treated as an inconsistency.
    const doc = baseDoc();
    doc.members['peer-c'] = { peerId: 'peer-c', displayName: 'Cara', avatar: '', joinedAt: '2026-01-01T00:00:00Z' };
    expect(() => addExpense(doc, makeExpense({
      totalAmount: 1000,
      payers: [{ userId: 'peer-a', amount: 1000 }],
      splits: [
        { userId: 'peer-a', amount: 334 },
        { userId: 'peer-b', amount: 333 },
        { userId: 'peer-c', amount: 333 },
      ],
    }))).not.toThrow();
  });

  it('rejects an expense with no payers or no splits', () => {
    expect(() => addExpense(baseDoc(), makeExpense({ payers: [] }))).toThrow();
    expect(() => addExpense(baseDoc(), makeExpense({ splits: [] }))).toThrow();
  });

  it('rejects non-finite payer or split amounts', () => {
    expect(() => addExpense(baseDoc(), makeExpense({
      payers: [{ userId: 'peer-a', amount: Infinity }],
    }))).toThrow();
    expect(() => addExpense(baseDoc(), makeExpense({
      splits: [{ userId: 'peer-a', amount: NaN }, { userId: 'peer-b', amount: 5000 }],
    }))).toThrow();
  });
});

// ---------------------------------------------------------------------------
// passphrase strength meter that guides users past the floor.
// ---------------------------------------------------------------------------
describe('passphrase strength estimate', () => {
  it('scores an empty passphrase at zero', () => {
    expect(estimatePassphraseStrength('').score).toBe(0);
  });

  it('flags a common passphrase regardless of length', () => {
    expect(estimatePassphraseStrength('password').score).toBe(0);
    expect(estimatePassphraseStrength('PassWord').score).toBe(0); // case-insensitive
  });

  it('flags a long but repetitive passphrase', () => {
    // "aaaaaaaaaaaa" passes a naive length check but has ~no entropy.
    expect(estimatePassphraseStrength('aaaaaaaaaaaa').score).toBe(0);
  });

  it('rates a long multi-word passphrase highly', () => {
    expect(estimatePassphraseStrength('correct horse battery staple').score).toBeGreaterThanOrEqual(3);
  });

  it('rates a short mixed passphrase above a short simple one', () => {
    expect(estimatePassphraseStrength('Ab3$xyzq').score)
      .toBeGreaterThan(estimatePassphraseStrength('abcdxyz').score);
  });

  it('never returns a score outside 0..4', () => {
    for (const p of ['', 'a', 'abc', 'a'.repeat(500), 'Tr0ub4dor&3 correct horse battery staple']) {
      const { score } = estimatePassphraseStrength(p);
      expect(score).toBeGreaterThanOrEqual(0);
      expect(score).toBeLessThanOrEqual(4);
    }
  });

  it('always returns a non-empty label', () => {
    for (const p of ['', 'abc', 'correct horse battery staple']) {
      expect(estimatePassphraseStrength(p).label.length).toBeGreaterThan(0);
    }
  });
});
