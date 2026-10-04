import { describe, it, expect } from 'vitest';
import {
  encodeIdentityForQR,
  decodeIdentityFromQR,
  isIdentityQRBlob,
} from '@/lib/crypto/identity-qr';
import type { UserIdentity } from '@/types';

function makeIdentity(overrides: Partial<UserIdentity> = {}): UserIdentity {
  return {
    // Use a full-length key so truncation cannot pass this fixture accidentally.
    peerId: 'peer-' + 'a1b2c3d4e5f6a7b8'.repeat(4),
    publicKey: 'a1b2c3d4e5f6a7b8'.repeat(4),
    privateKey: 'f6e5d4c3b2a1f0e1d2c3b4a5b6c7d8e9'.repeat(2),
    displayName: 'Alice',
    avatar: '',
    createdAt: '2026-01-01T00:00:00.000Z',
    ...overrides,
  };
}

describe('identity QR encode/decode', () => {
  it('round-trips an identity through encode/decode', () => {
    const identity = makeIdentity();
    const blob = encodeIdentityForQR(identity);
    const decoded = decodeIdentityFromQR(blob);

    expect(decoded.publicKey).toBe(identity.publicKey);
    expect(decoded.privateKey).toBe(identity.privateKey);
    expect(decoded.displayName).toBe(identity.displayName);
    expect(decoded.avatar).toBe(identity.avatar);
    // peerId is re-derived from the FULL publicKey hex (was truncated to 16 chars before)
    expect(decoded.peerId).toBe(`peer-${identity.publicKey}`);
  });

  it('preserves createdAt to the second (millisecond epoch round-trip)', () => {
    const identity = makeIdentity({ createdAt: '2026-03-15T12:34:56.000Z' });
    const decoded = decodeIdentityFromQR(encodeIdentityForQR(identity));
    expect(decoded.createdAt).toBe('2026-03-15T12:34:56.000Z');
  });

  it('round-trips a non-empty avatar', () => {
    const identity = makeIdentity({ avatar: 'avatar-data-uri-or-emoji' });
    const decoded = decodeIdentityFromQR(encodeIdentityForQR(identity));
    expect(decoded.avatar).toBe('avatar-data-uri-or-emoji');
  });

  it('isIdentityQRBlob distinguishes identity blobs from other strings', () => {
    const blob = encodeIdentityForQR(makeIdentity());
    expect(isIdentityQRBlob(blob)).toBe(true);
    expect(isIdentityQRBlob('FS2:something')).toBe(false);
    expect(isIdentityQRBlob('random text')).toBe(false);
  });

  it('throws a clear error for a blob with the wrong prefix', () => {
    expect(() => decodeIdentityFromQR('FS2:notanidentity')).toThrow(
      'not a FairShare identity code'
    );
  });

  it('throws a clear error for a corrupted/truncated blob', () => {
    expect(() => decodeIdentityFromQR('FSID1:!!!not-base64!!!')).toThrow(
      'corrupted or incomplete'
    );
  });

  it('rejects a display name too large to fit the QR wire format', () => {
    const identity = makeIdentity({ displayName: 'x'.repeat(300) });
    expect(() => encodeIdentityForQR(identity)).toThrow('too large to encode');
  });

  it('does not leak the _generatedAt sentinel onto the returned UserIdentity', () => {
    const identity = makeIdentity();
    const blob = encodeIdentityForQR(identity);
    const decoded = decodeIdentityFromQR(blob);
    // The generation timestamp is consumed internally for the expiration
    // check; it must NOT surface as a stray property on the returned identity,
    // otherwise a caller doing `saveIdentity({...decoded})` would persist it.
    expect(decoded).not.toHaveProperty('_generatedAt');
    // Keys are exactly the UserIdentity fields without sentinel properties.
    expect(Object.keys(decoded).sort()).toEqual([
      'avatar', 'createdAt', 'displayName', 'peerId', 'privateKey', 'publicKey',
    ]);
  });
});
