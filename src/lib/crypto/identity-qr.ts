import type { UserIdentity } from '@/types';
import { userIdentitySchema, formatZodError } from '@/lib/validation/schemas';
import { peerIdFromPublicKey } from '@/lib/crypto/identity';

// Compact binary+base64 identity codec for QR transfer. Keeps QR payloads under camera limits.
const QR_IDENTITY_PREFIX = 'FSID1:';

type DecodedIdentity = UserIdentity & { generatedAt: number | null };

function hexToBytes(hex: string): Uint8Array {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  return bytes;
}

function bytesToHex(bytes: Uint8Array): string {
  return Array.from(bytes).map(b => b.toString(16).padStart(2, '0')).join('');
}

function bytesToBase64(bytes: Uint8Array): string {
  let binary = '';
  bytes.forEach(b => { binary += String.fromCharCode(b); });
  return btoa(binary);
}

function base64ToBytes(b64: string): Uint8Array {
  const binary = atob(b64);
  const bytes = new Uint8Array(binary.length);
  for (let i = 0; i < binary.length; i++) bytes[i] = binary.charCodeAt(i);
  return bytes;
}

// Wire format: [1B len][publicKey bytes][1B len][privateKey bytes]
//              [1B len][displayName UTF-8][1B len][avatar UTF-8][8B createdAt epoch-ms]
function encodeIdentityBinary(identity: UserIdentity): Uint8Array {
  const publicKeyBytes = hexToBytes(identity.publicKey);
  const privateKeyBytes = hexToBytes(identity.privateKey);
  const nameBytes = new TextEncoder().encode(identity.displayName);
  const avatarBytes = new TextEncoder().encode(identity.avatar);
  const createdAtMs = Date.parse(identity.createdAt) || Date.now();

  if (publicKeyBytes.length > 255 || privateKeyBytes.length > 255 || nameBytes.length > 255 || avatarBytes.length > 255) {
    throw new Error('This identity is too large to encode as a QR code. Use "Export Identity" (file) instead.');
  }

  const buf = new Uint8Array(4 + publicKeyBytes.length + privateKeyBytes.length + nameBytes.length + avatarBytes.length + 8 + 8);
  let offset = 0;
  buf[offset++] = publicKeyBytes.length;
  buf.set(publicKeyBytes, offset); offset += publicKeyBytes.length;
  buf[offset++] = privateKeyBytes.length;
  buf.set(privateKeyBytes, offset); offset += privateKeyBytes.length;
  buf[offset++] = nameBytes.length;
  buf.set(nameBytes, offset); offset += nameBytes.length;
  buf[offset++] = avatarBytes.length;
  buf.set(avatarBytes, offset); offset += avatarBytes.length;
  new DataView(buf.buffer).setFloat64(offset, createdAtMs);
  offset += 8;
  // embed QR generation timestamp for expiration checks
  new DataView(buf.buffer).setFloat64(offset, Date.now());
  return buf;
}

function decodeIdentityBinary(buf: Uint8Array): DecodedIdentity {
  let offset = 0;
  const readChunk = () => {
    const len = buf[offset];
    offset += 1;
    const chunk = buf.slice(offset, offset + len);
    offset += len;
    return chunk;
  };

  const publicKeyBytes = readChunk();
  const privateKeyBytes = readChunk();
  const nameBytes = readChunk();
  const avatarBytes = readChunk();
  const createdAtMs = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat64(offset);
  offset += 8;

  // read optional QR generation timestamp appended after createdAt
  let generatedAtMs: number | null = null;
  if (offset + 8 <= buf.length) {
    generatedAtMs = new DataView(buf.buffer, buf.byteOffset, buf.byteLength).getFloat64(offset);
  }

  const publicKey = bytesToHex(publicKeyBytes);
  return {
    // Use the canonical minting function instead of a truncated legacy peerId.
    peerId: peerIdFromPublicKey(publicKey),
    publicKey,
    privateKey: bytesToHex(privateKeyBytes),
    displayName: new TextDecoder().decode(nameBytes),
    avatar: new TextDecoder().decode(avatarBytes),
    createdAt: new Date(createdAtMs).toISOString(),
    generatedAt: generatedAtMs,
  };
}

export function encodeIdentityForQR(identity: UserIdentity): string {
  return QR_IDENTITY_PREFIX + bytesToBase64(encodeIdentityBinary(identity));
}

export function isIdentityQRBlob(blob: string): boolean {
  return blob.startsWith(QR_IDENTITY_PREFIX);
}

export function decodeIdentityFromQR(blob: string): UserIdentity {
  const trimmed = blob.trim();
  if (!trimmed.startsWith(QR_IDENTITY_PREFIX)) {
    throw new Error('This QR code is not a FairShare identity code.');
  }

  let identity: UserIdentity;
  let generatedAt: number | null = null;
  try {
    const decoded = decodeIdentityBinary(base64ToBytes(trimmed.slice(QR_IDENTITY_PREFIX.length)));
    ({ generatedAt, ...identity } = decoded);
  } catch {
    throw new Error('This QR code is corrupted or incomplete.');
  }

  // reject QR codes older than 10 minutes or without generation timestamps
  const QR_MAX_AGE_MS = 10 * 60 * 1000;
  if (!generatedAt || Date.now() - generatedAt > QR_MAX_AGE_MS) {
    throw new Error('This identity QR code has expired. Please generate a new one.');
  }

  const result = userIdentitySchema.safeParse(identity);
  if (!result.success) {
    throw new Error(`Invalid identity QR code (${formatZodError(result.error)}).`);
  }
  return result.data;
}
