import { describe, it, expect } from 'vitest';
import {
  generateIdentity,
  signMessage,
  verifySignature,
  peerIdFromPublicKey,
  publicKeyFromPeerId,
  isLegacyPeerId,
  isPlaceholderMember,
} from '@/lib/crypto/identity';

describe('generateIdentity', () => {
  it('creates a peerId derived from the full public key', async () => {
    const identity = await generateIdentity('Alice');
    // peerId = "peer-" + full 64-char public key hex (was truncated to 16 chars)
    expect(identity.peerId).toBe(`peer-${identity.publicKey}`);
    expect(identity.displayName).toBe('Alice');
    expect(identity.avatar).toBe('');
    expect(identity.publicKey).toMatch(/^[0-9a-f]+$/);
    expect(identity.privateKey).toMatch(/^[0-9a-f]+$/);
  });

  it('generates a distinct keypair (and peerId) each time', async () => {
    const a = await generateIdentity('Alice');
    const b = await generateIdentity('Alice');
    expect(a.peerId).not.toBe(b.peerId);
    expect(a.publicKey).not.toBe(b.publicKey);
    expect(a.privateKey).not.toBe(b.privateKey);
  });
});

describe('signMessage / verifySignature', () => {
  it('produces a signature that verifies against the matching public key', async () => {
    const identity = await generateIdentity('Alice');
    const signature = await signMessage(identity.privateKey, 'hello world');
    const ok = await verifySignature(identity.publicKey, 'hello world', signature);
    expect(ok).toBe(true);
  });

  it('rejects a signature checked against a different message (tamper detection)', async () => {
    const identity = await generateIdentity('Alice');
    const signature = await signMessage(identity.privateKey, 'hello world');
    const ok = await verifySignature(identity.publicKey, 'hello WORLD', signature);
    expect(ok).toBe(false);
  });

  it('rejects a signature checked against a different public key', async () => {
    const alice = await generateIdentity('Alice');
    const bob = await generateIdentity('Bob');
    const signature = await signMessage(alice.privateKey, 'hello world');
    const ok = await verifySignature(bob.publicKey, 'hello world', signature);
    expect(ok).toBe(false);
  });

  it('returns false instead of throwing for a garbage signature/key', async () => {
    const ok = await verifySignature('not-hex-!!', 'hello world', 'also-not-hex');
    expect(ok).toBe(false);
  });
});

describe('peerIdFromPublicKey / publicKeyFromPeerId', () => {
  const PUB = 'a'.repeat(64); // 32-byte Ed25519 pubkey hex

  it('mints a peerId from the full public key hex (no truncation)', () => {
    expect(peerIdFromPublicKey(PUB)).toBe(`peer-${PUB}`);
  });

  it('recovers the full public key hex from a new-format peerId', () => {
    const peerId = peerIdFromPublicKey(PUB);
    expect(publicKeyFromPeerId(peerId)).toBe(PUB);
  });

  it('round-trips a fresh identity so signature verification works with derived keys', async () => {
    const id = await generateIdentity('Alice');
    expect(publicKeyFromPeerId(id.peerId)).toBe(id.publicKey);
    // Derived-key verification: sender's pubkey came out of the peerId alone,
    // no members-map lookup needed. This is what makes fail-closed verification practical.
    const sig = await signMessage(id.privateKey, 'msg');
    const derivedPub = publicKeyFromPeerId(id.peerId)!;
    expect(await verifySignature(derivedPub, 'msg', sig)).toBe(true);
  });

  it('returns null for legacy 16-hex-char peerIds (cannot derive the pubkey)', () => {
    expect(publicKeyFromPeerId('peer-a1b2c3d4e5f6a7b8')).toBeNull();
  });

  it('returns null for garbage / non-hex peerIds', () => {
    expect(publicKeyFromPeerId('peer-not-hex')).toBeNull();
    expect(publicKeyFromPeerId('random string')).toBeNull();
    expect(publicKeyFromPeerId('peer-')).toBeNull();
  });

  it('isLegacyPeerId detects the legacy short format', () => {
    expect(isLegacyPeerId('peer-a1b2c3d4e5f6a7b8')).toBe(true);
    expect(isLegacyPeerId('peer-A1B2C3D4E5F6A7B8')).toBe(true);
    // Not the legacy 16-hex format: full-length new format, non-hex chars, wrong prefix
    expect(isLegacyPeerId(`peer-${PUB}`)).toBe(false);
    expect(isLegacyPeerId('peer-not-hex-16!')).toBe(false);
    expect(isLegacyPeerId('foo-a1b2c3d4e5f6a7b8')).toBe(false);
  });

  it('requires an explicit manual-placeholder marker before allowing a claim', () => {
    expect(isPlaceholderMember({ peerId: 'peer-a1b2c3d4e5f6a7b8' })).toBe(false);
    expect(isPlaceholderMember({ peerId: 'peer-a1b2c3d4e5f6a7b8', isManualPlaceholder: true })).toBe(true);
  });
});
