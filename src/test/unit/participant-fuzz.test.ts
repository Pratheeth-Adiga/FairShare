import { describe, expect, it } from 'vitest';
import { createGroupDocument } from '@/lib/crdt/document';
import type { GroupDocument } from '@/lib/crdt/document';
import { addComment, addExpense, addMember, addSettlement, reassignMember, removeMember } from '@/lib/crdt/operations';
import { mergeDocuments } from '@/lib/crdt/merge';
import { getBalances } from '@/lib/crdt/queries';
import { exportGroupToJSON, importGroupFromJSON } from '@/lib/io/backup';
import { DEFAULT_GROUP_SETTINGS } from '@/types/group';
import type { Expense, MemberProfile } from '@/types';

function seededRandom(seed: number): () => number {
  let state = seed >>> 0;
  return () => {
    state = (state * 1664525 + 1013904223) >>> 0;
    return state / 0x1_0000_0000;
  };
}

function profile(peerId: string): MemberProfile {
  return { peerId, displayName: peerId, avatar: '', joinedAt: '2026-09-02T00:00:00.000Z' };
}

function expense(id: string, memberIds: string[]): Expense {
  const totalAmount = 1001;
  const payerId = memberIds[0];
  const baseShare = Math.floor(totalAmount / memberIds.length);
  const remainder = totalAmount - baseShare * memberIds.length;
  return {
    id,
    groupId: 'fuzz-group',
    friendId: null,
    description: id,
    totalAmount,
    currency: 'INR',
    payers: [{ userId: payerId, amount: totalAmount }],
    splitType: 'equal',
    splits: memberIds.map((userId, index) => ({ userId, amount: baseShare + (index < remainder ? 1 : 0) })),
    items: [],
    category: 'other',
    date: '2026-09-02',
    createdAt: '2026-09-02T00:00:00.000Z',
    createdBy: payerId,
    notes: '',
  };
}

function referencedParticipants(doc: GroupDocument): Set<string> {
  const ids = new Set<string>();
  for (const item of Object.values(doc.expenses)) {
    ids.add(item.createdBy);
    item.payers.forEach(payer => ids.add(payer.userId));
    item.splits.forEach(split => ids.add(split.userId));
    item.comments?.forEach(comment => ids.add(comment.authorId));
    item.editHistory?.forEach(edit => ids.add(edit.editedBy));
  }
  for (const settlement of Object.values(doc.settlements)) {
    ids.add(settlement.from);
    ids.add(settlement.to);
  }
  return ids;
}

function assertInvariants(doc: GroupDocument) {
  const profiles = { ...(doc.formerMembers || {}), ...doc.members };
  for (const peerId of referencedParticipants(doc)) {
    expect(profiles[peerId], `missing profile for ${peerId}`).toBeDefined();
  }
  const balanceTotal = Object.values(getBalances(doc)).reduce((sum, balance) => sum + balance, 0);
  expect(balanceTotal).toBe(0);
}

describe('participant invariants under deterministic randomized operations', () => {
  for (const seed of [7, 42, 20260902]) {
    it(`preserves profiles and zero-sum balances for seed ${seed}`, () => {
      const random = seededRandom(seed);
      let peerA = createGroupDocument('fuzz-group', 'Fuzz', 'peer-alice', 'Alice', DEFAULT_GROUP_SETTINGS);
      peerA = addMember(peerA, profile('peer-bob'));
      let peerB = importGroupFromJSON(exportGroupToJSON(peerA));
      let memberSerial = 0;
      let recordSerial = 0;

      for (let step = 0; step < 30; step++) {
        const target = random() < 0.5 ? peerA : peerB;
        const activeIds = Object.keys(target.members);
        const operation = Math.floor(random() * 5);
        let next = target;

        if (operation === 0) {
          next = addMember(target, profile(`peer-added-${memberSerial++}`));
        } else if (operation === 1 && activeIds.length > 1) {
          next = removeMember(target, activeIds[activeIds.length - 1]);
        } else if (operation === 2) {
          next = addExpense(target, expense(`expense-${recordSerial++}`, activeIds));
          next = addComment(next, `expense-${recordSerial - 1}`, {
            id: `comment-${recordSerial}`,
            authorId: activeIds[0],
            text: 'checked',
            createdAt: '2026-09-02T00:00:00.000Z',
          });
        } else if (operation === 3 && activeIds.length > 1) {
          next = addSettlement(target, {
            id: `settlement-${recordSerial++}`,
            groupId: 'fuzz-group',
            from: activeIds[activeIds.length - 1],
            to: activeIds[0],
            amount: 1,
            date: '2026-09-02',
            note: 'fuzz',
            settlesExpenses: [],
          });
        } else if (operation === 4 && activeIds.length > 1) {
          next = reassignMember(target, activeIds[activeIds.length - 1], activeIds[0]);
        }

        if (target === peerA) peerA = next; else peerB = next;
        assertInvariants(peerA);
        assertInvariants(peerB);

        // Randomly exchange complete signed-document equivalents, then converge both sides.
        if (random() < 0.65) {
          peerA = mergeDocuments(peerA, peerB);
          peerB = mergeDocuments(peerB, peerA);
          assertInvariants(peerA);
          assertInvariants(peerB);
        }
      }

      peerA = mergeDocuments(peerA, peerB);
      peerB = mergeDocuments(peerB, peerA);
      expect(peerA).toEqual(peerB);
      assertInvariants(importGroupFromJSON(exportGroupToJSON(peerA)));
    });
  }
});