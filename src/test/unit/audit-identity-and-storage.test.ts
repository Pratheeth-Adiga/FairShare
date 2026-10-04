// Regression coverage for identity minting and single-identity storage.
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import { encodeIdentityForQR, decodeIdentityFromQR } from '@/lib/crypto/identity-qr';
import { peerIdFromPublicKey, publicKeyFromPeerId, isLegacyPeerId } from '@/lib/crypto/identity';
import { db, saveIdentity, loadIdentity, recordKnownPeer, loadKnownPeersForGroup } from '@/lib/storage/database';
import type { UserIdentity } from '@/types';

const PK_A = 'a1b2c3d4e5f6a7b8'.repeat(4); // 64 hex chars, a real key length
const PK_B = 'f0e1d2c3b4a59687'.repeat(4);

function makeIdentity(publicKey: string, over: Partial<UserIdentity> = {}): UserIdentity {
  return {
    peerId: peerIdFromPublicKey(publicKey),
    publicKey,
    privateKey: 'f6e5d4c3b2a1f0e1d2c3b4a5b6c7d8e9'.repeat(2),
    displayName: 'Alice',
    avatar: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...over,
  };
}

describe('QR identity restore mints the canonical peerId', () => {
  it('re-derives the FULL 64-hex peerId, not a 16-char truncation', () => {
    // The decoder used `peer-${publicKey.slice(0, 16)}`, so a device restoring by
    // QR came up as a DIFFERENT peer: absent from doc.members of every group,
    // rejected by the membership verifier, its expense history orphaned.
    const decoded = decodeIdentityFromQR(encodeIdentityForQR(makeIdentity(PK_A)));
    expect(decoded.peerId).toBe(`peer-${PK_A}`);
    expect(decoded.peerId).toHaveLength(69);
  });

  it('produces a peerId the public key can be recovered from', () => {
    // A truncated id defeats publicKeyFromPeerId, dropping the peer back to
    // trust-on-first-use and reintroducing the grindable 64-bit identifier this
    // was written to remove.
    const decoded = decodeIdentityFromQR(encodeIdentityForQR(makeIdentity(PK_A)));
    expect(publicKeyFromPeerId(decoded.peerId)).toBe(PK_A.toLowerCase());
    expect(isLegacyPeerId(decoded.peerId)).toBe(false);
  });

  it('agrees exactly with how a fresh identity is minted', () => {
    const decoded = decodeIdentityFromQR(encodeIdentityForQR(makeIdentity(PK_A)));
    expect(decoded.peerId).toBe(peerIdFromPublicKey(decoded.publicKey));
  });

  it('still round-trips the rest of the identity', () => {
    const identity = makeIdentity(PK_A, { displayName: 'Zoë', avatar: 'x' });
    const decoded = decodeIdentityFromQR(encodeIdentityForQR(identity));
    expect(decoded.publicKey).toBe(identity.publicKey);
    expect(decoded.privateKey).toBe(identity.privateKey);
    expect(decoded.displayName).toBe('Zoë');
    expect(decoded.avatar).toBe('x');
  });
});

describe('the identity table holds exactly one row', () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.identity.clear();
  });

  it('replaces the previous identity rather than adding a second row', async () => {
    // Replacing an identity must leave one row and load the new key.
    await saveIdentity(makeIdentity(PK_A, { displayName: 'Old' }));
    await saveIdentity(makeIdentity(PK_B, { displayName: 'New' }));

    expect(await db.identity.count()).toBe(1);
    const loaded = await loadIdentity();
    expect(loaded?.displayName).toBe('New');
    expect(loaded?.peerId).toBe(peerIdFromPublicKey(PK_B));
  });

  it('survives the case where the new peerId sorts BEFORE the old one', async () => {
    // Check both peerId sort orders.
    await saveIdentity(makeIdentity(PK_B, { displayName: 'Old' }));
    await saveIdentity(makeIdentity(PK_A, { displayName: 'New' }));
    expect((await loadIdentity())?.displayName).toBe('New');

    // ...and the reverse ordering too, so the test is not accidentally passing
    // on lexicographic luck.
    await db.identity.clear();
    await saveIdentity(makeIdentity(PK_A, { displayName: 'Old' }));
    await saveIdentity(makeIdentity(PK_B, { displayName: 'New' }));
    expect((await loadIdentity())?.displayName).toBe('New');
  });

  it('a profile update on the same identity is still just an update', async () => {
    await saveIdentity(makeIdentity(PK_A, { displayName: 'Before' }));
    await saveIdentity(makeIdentity(PK_A, { displayName: 'After' }));
    expect(await db.identity.count()).toBe(1);
    expect((await loadIdentity())?.displayName).toBe('After');
  });

  it('returns undefined when there is no identity', async () => {
    expect(await loadIdentity()).toBeUndefined();
  });
});

describe('recordKnownPeer does not lose group memberships to a race', () => {
  beforeEach(async () => {
    if (!db.isOpen()) await db.open();
    await db.peers.clear();
  });

  it('keeps both groups when two records are written concurrently', async () => {
    // Concurrent writes must preserve both group memberships.
    await Promise.all([
      recordKnownPeer('g1', 'peer-x', 'Xavier', ''),
      recordKnownPeer('g2', 'peer-x', 'Xavier', ''),
    ]);

    const row = await db.peers.get('peer-x');
    expect(row?.groupIds.slice().sort()).toEqual(['g1', 'g2']);
    expect(await loadKnownPeersForGroup('g1')).toHaveLength(1);
    expect(await loadKnownPeersForGroup('g2')).toHaveLength(1);
  });

  it('holds up across several concurrent groups', async () => {
    const groups = ['g1', 'g2', 'g3', 'g4', 'g5'];
    await Promise.all(groups.map(g => recordKnownPeer(g, 'peer-y', 'Yara', '')));
    expect((await db.peers.get('peer-y'))?.groupIds.slice().sort()).toEqual(groups);
  });

  it('does not duplicate a group recorded twice', async () => {
    await recordKnownPeer('g1', 'peer-z', 'Zed', '');
    await recordKnownPeer('g1', 'peer-z', 'Zed', '');
    expect((await db.peers.get('peer-z'))?.groupIds).toEqual(['g1']);
  });
});
