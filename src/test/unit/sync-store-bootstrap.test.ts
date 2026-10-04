import { beforeEach, describe, it, expect, vi } from 'vitest';
import type { P2PMessage } from '@/lib/p2p/message-protocol';

const membershipVerifier = vi.hoisted(() => ({
  value: null as ((peerId: string, groupId: string, messageType: P2PMessage['type']) => boolean) | null,
}));
const localDocument = vi.hoisted(() => ({ value: undefined as { members: Record<string, unknown>; deleted: Record<string, string> } | undefined }));
const admitted = vi.hoisted(() => ({ value: new Set<string>() }));

vi.mock('@/lib/p2p/node', () => ({
  createP2PNode: () => ({
    start: vi.fn().mockResolvedValue(undefined),
    onPeerEvent: vi.fn(() => () => {}),
    connectedPeers: new Set<string>(),
    isAdmitted: (peerId: string, groupId: string) => admitted.value.has(`${peerId}|${groupId}`),
    setMembershipVerifier: vi.fn((verifier) => { membershipVerifier.value = verifier; }),
  }),
}));

vi.mock('@/stores/groups.store', () => ({
  useGroupsStore: {
    getState: () => ({ getDocument: () => localDocument.value }),
  },
}));

vi.mock('@/stores/identity.store', () => ({
  useIdentityStore: {
    getState: () => ({ identity: null }),
  },
}));

const { useSyncStore } = await import('@/stores/sync.store');

describe('sync-store joining bootstrap', () => {
  beforeEach(() => {
    localDocument.value = undefined;
    admitted.value = new Set();
  });

  it('accepts only the first document before the group exists locally', async () => {
    await useSyncStore.getState().initializeP2P('peer-local');

    const verifier = membershipVerifier.value;
    expect(verifier).not.toBeNull();
    expect(verifier!('peer-creator', 'group-1', 'document')).toBe(true);
    expect(verifier!('peer-creator', 'group-1', 'sync-request')).toBe(false);
    expect(verifier!('peer-creator', 'group-1', 'introduce-request')).toBe(false);
  });

  it('rejects a document push from a non-member even when directly connected', async () => {
    localDocument.value = { members: { 'peer-creator': {} }, deleted: {} };
    await useSyncStore.getState().initializeP2P('peer-local');

    const verifier = membershipVerifier.value;
    expect(verifier!('peer-joiner', 'group-1', 'document')).toBe(false);
    expect(verifier!('peer-joiner', 'group-1', 'sync-request')).toBe(false);
    expect(verifier!('peer-creator', 'group-1', 'document')).toBe(true);
  });

  // the joiner we just QR-paired with has to be able to push its "add me" document
  it('lets a QR-admitted joiner send a document and ask for one, but nothing else', async () => {
    localDocument.value = { members: { 'peer-creator': {} }, deleted: {} };
    admitted.value.add('peer-joiner|group-1');
    await useSyncStore.getState().initializeP2P('peer-local');

    const verifier = membershipVerifier.value;
    expect(verifier!('peer-joiner', 'group-1', 'document')).toBe(true);
    expect(verifier!('peer-joiner', 'group-1', 'sync-request')).toBe(true);
    expect(verifier!('peer-joiner', 'group-1', 'introduce-request')).toBe(false);
    expect(verifier!('peer-joiner', 'group-2', 'document')).toBe(false);
  });
});