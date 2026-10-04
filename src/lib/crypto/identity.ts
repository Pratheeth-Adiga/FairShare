import type { UserIdentity } from '@/types';
import { v4 as uuidv4 } from 'uuid';

export async function generateIdentity(displayName: string): Promise<UserIdentity> {
  // crypto.subtle.generateKey({name:'Ed25519'}) throws NotSupportedError on
  // browsers/WebViews without Ed25519 (Safari < 17, older Android WebViews, non-HTTPS
  // contexts). Surface a clear, actionable error instead of an uncaught crash during onboarding.
  if (!globalThis.crypto?.subtle) {
    throw new Error(
      'Secure key generation is unavailable in this browser context. FairShare requires the Web Crypto API, which needs a secure context (HTTPS or localhost).'
    );
  }

  let keyPair: CryptoKeyPair;
  try {
    keyPair = await crypto.subtle.generateKey(
      { name: 'Ed25519' },
      true, // extractable=true needed to persist key to IndexedDB as hex
      ['sign', 'verify']
    ) as CryptoKeyPair;
  } catch {
    throw new Error(
      'This browser does not support Ed25519 keys, which FairShare requires for identity. Please update to a recent version of Chrome, Edge, Firefox, or Safari 17+.'
    );
  }

  const publicKeyBuffer = await crypto.subtle.exportKey('raw', keyPair.publicKey);
  const privateKeyBuffer = await crypto.subtle.exportKey('pkcs8', keyPair.privateKey);

  const publicKeyHex = bufferToHex(publicKeyBuffer);
  const privateKeyHex = bufferToHex(privateKeyBuffer);

  // derive peerId from the full public key; legacy IDs remain readable
  const peerId = peerIdFromPublicKey(publicKeyHex);

  return {
    peerId,
    publicKey: publicKeyHex,
    privateKey: privateKeyHex,
    displayName,
    avatar: '',
    createdAt: new Date().toISOString(),
  };
}

// mint new IDs from the full public key; accept legacy IDs when reading
export function peerIdFromPublicKey(publicKeyHex: string): string {
  return `peer-${publicKeyHex}`;
}

export function isLegacyPeerId(peerId: string): boolean {
  return /^peer-[0-9a-f]{16}$/i.test(peerId);
}

// Legacy peer IDs alone are not evidence of a placeholder: a real old device
// can use one too. Only a member explicitly created through Add Member can be
// suggested for a user-approved claim.
export function isPlaceholderMember(m: { peerId: string; publicKey?: string; isManualPlaceholder?: boolean }): boolean {
  return isLegacyPeerId(m.peerId) && !m.publicKey && m.isManualPlaceholder === true;
}

// recover the full public key hex from a new-format peerId. Returns null for
// legacy 16-hex-char peerIds (their public key must come from another source,
// e.g. the `publicKey` field on MemberProfile).
export function publicKeyFromPeerId(peerId: string): string | null {
  const m = /^peer-([0-9a-f]{64})$/i.exec(peerId);
  return m ? m[1].toLowerCase() : null;
}

export async function signMessage(privateKeyHex: string, message: string): Promise<string> {
  const keyBuffer = hexToBuffer(privateKeyHex);
  const key = await crypto.subtle.importKey(
    'pkcs8',
    keyBuffer,
    { name: 'Ed25519' },
    false,
    ['sign']
  );
  const encoded = new TextEncoder().encode(message);
  const signature = await crypto.subtle.sign('Ed25519', key, encoded);
  return bufferToHex(signature);
}

export async function verifySignature(
  publicKeyHex: string,
  message: string,
  signatureHex: string
): Promise<boolean> {
  try {
    const keyBuffer = hexToBuffer(publicKeyHex);
    const key = await crypto.subtle.importKey(
      'raw',
      keyBuffer,
      { name: 'Ed25519' },
      false,
      ['verify']
    );
    const encoded = new TextEncoder().encode(message);
    const signature = hexToBuffer(signatureHex);
    return await crypto.subtle.verify('Ed25519', key, signature, encoded);
  } catch {
    return false;
  }
}

export function generateGroupId(): string {
  return uuidv4();
}

// a restore file can pass the schema with a private key that doesn't match its public key
export async function keysMatch(identity: Pick<UserIdentity, 'publicKey' | 'privateKey'>): Promise<boolean> {
  try {
    const probe = 'fairshare-key-check';
    const signature = await signMessage(identity.privateKey, probe);
    return await verifySignature(identity.publicKey, probe, signature);
  } catch {
    return false;
  }
}

export function generateExpenseId(): string {
  return uuidv4();
}

export function generateSettlementId(): string {
  return uuidv4();
}

export function generateCommentId(): string {
  return uuidv4();
}

function bufferToHex(buffer: ArrayBuffer): string {
  return Array.from(new Uint8Array(buffer))
    .map(b => b.toString(16).padStart(2, '0'))
    .join('');
}

function hexToBuffer(hex: string): ArrayBuffer {
  const bytes = new Uint8Array(hex.length / 2);
  for (let i = 0; i < hex.length; i += 2) {
    bytes[i / 2] = parseInt(hex.substring(i, i + 2), 16);
  }
  return bytes.buffer;
}
