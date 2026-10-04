// Regression coverage for the sixth principal-engineer review.
import { describe, it, expect } from 'vitest';
import { parseCurrencyInput } from '@/lib/utils/currency';
import { serializeMessage, deserializeMessage, p2pMessageSchema as wireSchema } from '@/lib/p2p/message-protocol';
import type { P2PMessage } from '@/lib/p2p/message-protocol';
import { p2pMessageSchema as centralSchema, groupDocumentSchema } from '@/lib/validation/schemas';
import { addExpense, reassignMember, removeMember } from '@/lib/crdt/operations';
import { createGroupDocument } from '@/lib/crdt/document';
import { encryptPrivateKey } from '@/lib/crypto/key-encryption';
import type { GroupDocument } from '@/lib/crdt/document';
import type { Expense, GroupSettings } from '@/types';

const settings: GroupSettings = {
  defaultCurrency: 'USD', defaultSplitType: 'equal', simplifyDebts: true, settleThreshold: 100,
  roundingAssignee: 'payer', requireApproval: false, invitePermission: 'any_member',
  customCategories: [], disabledCategories: [],
};

function makeDoc(memberIds: string[] = ['peer-a', 'peer-b']): GroupDocument {
  const [creator, ...rest] = memberIds;
  const doc = createGroupDocument('g1', 'Trip', creator, 'User A', settings);
  for (const id of rest) {
    doc.members[id] = {
      peerId: id, displayName: id, avatar: '', joinedAt: new Date().toISOString(),
    } as never;
  }
  return doc;
}

function makeExpense(over: Partial<Expense> = {}): Expense {
  return {
    id: 'exp-1', groupId: 'g1', friendId: null, description: 'Dinner',
    totalAmount: 10000, currency: 'USD',
    payers: [{ userId: 'peer-a', amount: 10000 }],
    splitType: 'equal',
    splits: [{ userId: 'peer-a', amount: 5000 }, { userId: 'peer-b', amount: 5000 }],
    items: [], category: 'food', date: '2026-01-15',
    createdAt: new Date().toISOString(), createdBy: 'peer-a', notes: '',
    ...over,
  };
}

// -------------------------------------------------------------------------
// ping/pong keepalive must survive the wire round-trip.
// -------------------------------------------------------------------------
describe('ping keepalive round-trip', () => {
  const ping: P2PMessage = {
    id: '11111111-2222-3333-4444-555555555555',
    type: 'ping',
    groupId: '',          // what WebRTCConnection.startPingInterval actually sends
    from: 'peer-' + 'a'.repeat(64),
    hopCount: 0,
    timestamp: '2026-09-01T00:00:00.000Z',
  };

  it('a ping survives serialize -> deserialize', () => {
    const decoded = deserializeMessage(serializeMessage(ping));
    // If this is null the receiver never replies with a pong, missedPings reaches
    // 3, and the connection is torn down ~45s after the data channel opens.
    expect(decoded).not.toBeNull();
    expect(decoded?.type).toBe('ping');
  });

  it('a pong survives serialize -> deserialize', () => {
    const pong = { ...ping, type: 'pong' as const };
    expect(deserializeMessage(serializeMessage(pong))).not.toBeNull();
  });

  it('data-bearing messages still require a non-empty groupId', () => {
    const docMsg = { ...ping, type: 'document' as const, groupId: '' };
    expect(deserializeMessage(serializeMessage(docMsg))).toBeNull();
  });
});

// -------------------------------------------------------------------------
// the two p2pMessageSchema copies must not disagree.
// -------------------------------------------------------------------------
describe('duplicate p2pMessageSchema must not diverge', () => {
  it('both schemas agree on an empty-groupId ping', () => {
    const ping = {
      id: '11111111-2222-3333-4444-555555555555', type: 'ping', groupId: '',
      from: 'peer-x', hopCount: 0, timestamp: '2026-09-01T00:00:00.000Z',
    };
    expect(centralSchema.safeParse(ping).success)
      .toBe(wireSchema.safeParse(ping).success);
  });
});

// -------------------------------------------------------------------------
// European amounts with a thousands separator AND a decimal comma.
// -------------------------------------------------------------------------
describe('parseCurrencyInput last-comma handling', () => {
  it('parses "1,234,56" as 1234.56', () => {
    expect(parseCurrencyInput('1,234,56', 'EUR')).toBe(123456);
  });

  it('parses "1.234.567,89" (dots thousands, comma decimal)', () => {
    expect(parseCurrencyInput('1.234.567,89', 'EUR')).toBe(123456789);
  });

  it('does not regress the single-comma decimal case', () => {
    expect(parseCurrencyInput('12,34', 'EUR')).toBe(1234);
  });

  it('does not regress the pure thousands-separator case (F-50)', () => {
    expect(parseCurrencyInput('1,234,567', 'USD')).toBe(123456700);
  });
});

// -------------------------------------------------------------------------
// reassignMember must tombstone the peer it removes.
// -------------------------------------------------------------------------
describe('reassignMember tombstones the source member', () => {
  it('writes a tombstone for fromPeerId', () => {
    const after = reassignMember(makeDoc(), 'peer-b', 'peer-a');
    expect(after.members['peer-b']).toBeUndefined();
    // Without the tombstone, add-wins merge re-adds peer-b on the next sync.
    expect(after.deleted['peer-b']).toBeDefined();
  });

  it('matches removeMember tombstone behaviour', () => {
    const removed = removeMember(makeDoc(), 'peer-b');
    const reassigned = reassignMember(makeDoc(), 'peer-b', 'peer-a');
    expect(typeof reassigned.deleted['peer-b'])
      .toBe(typeof removed.deleted['peer-b']);
  });
});

// -------------------------------------------------------------------------
// cross-field expense invariants.
// -------------------------------------------------------------------------
describe('expense invariant validation', () => {
  it('rejects an expense whose splits do not sum to totalAmount', () => {
    const bad = makeExpense({
      totalAmount: 10000,
      splits: [{ userId: 'peer-a', amount: 3000 }, { userId: 'peer-b', amount: 3000 }],
    });
    expect(() => addExpense(makeDoc(), bad)).toThrow();
  });

  it('rejects an expense whose payers do not sum to totalAmount', () => {
    const bad = makeExpense({
      totalAmount: 10000,
      payers: [{ userId: 'peer-a', amount: 4000 }],
    });
    expect(() => addExpense(makeDoc(), bad)).toThrow();
  });

  it('still accepts a correctly balanced expense', () => {
    expect(() => addExpense(makeDoc(), makeExpense())).not.toThrow();
  });
});

// -------------------------------------------------------------------------
// peerId length must be bounded (it is used as an object key).
// -------------------------------------------------------------------------
describe('peerId length bound in member profiles', () => {
  it('rejects a multi-megabyte peerId', () => {
    const huge = 'peer-' + 'a'.repeat(200000);
    const payload = JSON.parse(JSON.stringify(makeDoc()));
    payload.members[huge] = {
      peerId: huge, displayName: 'Attacker', avatar: '',
      joinedAt: new Date().toISOString(),
    };
    expect(groupDocumentSchema.safeParse(payload).success).toBe(false);
  });

  it('still accepts a normal 69-char peerId', () => {
    const ok = 'peer-' + 'a'.repeat(64);
    const payload = JSON.parse(JSON.stringify(makeDoc()));
    payload.members[ok] = {
      peerId: ok, displayName: 'Normal', avatar: '',
      joinedAt: new Date().toISOString(),
    };
    expect(groupDocumentSchema.safeParse(payload).success).toBe(true);
  });
});

// -------------------------------------------------------------------------
// passphrase strength floor for private-key encryption.
// -------------------------------------------------------------------------
describe('passphrase strength floor', () => {
  const key = 'b'.repeat(96);

  it('refuses an empty passphrase', async () => {
    await expect(encryptPrivateKey(key, '')).rejects.toThrow();
  });

  it('refuses a passphrase shorter than 8 characters', async () => {
    await expect(encryptPrivateKey(key, 'abc')).rejects.toThrow();
  });

  it('accepts a reasonable passphrase', async () => {
    await expect(encryptPrivateKey(key, 'correct-horse-battery'))
      .resolves.toBeTruthy();
  });
});

// verify the real database exports pending-profile helpers
describe('database module exports pending-profile helpers', () => {
  it('exports savePendingProfileUpdate and loadPendingProfileUpdate', async () => {
    const db = await import('@/lib/storage/database') as Record<string, unknown>;
    expect(typeof db.savePendingProfileUpdate).toBe('function');
    expect(typeof db.loadPendingProfileUpdate).toBe('function');
  });
});
