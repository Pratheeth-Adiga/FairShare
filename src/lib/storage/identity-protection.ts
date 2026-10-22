import { Capacitor, registerPlugin } from '@capacitor/core';
import type { UserIdentity } from '@/types';
import { isEncryptedKey } from '@/lib/crypto/key-encryption';
import { loadIdentity, saveIdentity } from './database';

interface IdentityProtectionPlugin {
  protect(options: { peerId: string; privateKey: string }): Promise<{ value: string }>;
  retrieve(options: { peerId: string; value: string }): Promise<{ privateKey: string }>;
  remove(options: { peerId: string; value: string }): Promise<void>;
}

const IdentityProtection = registerPlugin<IdentityProtectionPlugin>('IdentityProtection');
const PREFIX = 'native1:';

export function isNativeProtected(key: string): boolean {
  return key.startsWith(PREFIX);
}

function nativeValue(key: string): string {
  const prefix = `${PREFIX}${Capacitor.getPlatform()}:`;
  if (!Capacitor.isNativePlatform() || !key.startsWith(prefix)) {
    throw new Error('This identity needs secure storage on its original device. Restore an identity backup instead.');
  }
  return key.slice(prefix.length);
}

export async function retrieveIdentity(identity: UserIdentity): Promise<UserIdentity> {
  if (!isNativeProtected(identity.privateKey)) return identity;
  const { privateKey } = await IdentityProtection.retrieve({
    peerId: identity.peerId,
    value: nativeValue(identity.privateKey),
  });
  if (!privateKey || isNativeProtected(privateKey) || isEncryptedKey(privateKey)) {
    throw new Error('Secure storage returned an invalid identity key.');
  }
  return { ...identity, privateKey };
}

export async function removeIdentityProtection(identity: UserIdentity): Promise<void> {
  if (!isNativeProtected(identity.privateKey)) return;
  await IdentityProtection.remove({ peerId: identity.peerId, value: nativeValue(identity.privateKey) });
}

export async function protectIdentity(identity: UserIdentity): Promise<UserIdentity> {
  if (isNativeProtected(identity.privateKey)) {
    await retrieveIdentity(identity);
    return identity;
  }
  if (!Capacitor.isNativePlatform() || isEncryptedKey(identity.privateKey)) return identity;
  const { value } = await IdentityProtection.protect({
    peerId: identity.peerId,
    privateKey: identity.privateKey,
  });
  if (!value) throw new Error('Secure storage did not save the identity key.');
  const protectedIdentity = {
    ...identity,
    privateKey: `${PREFIX}${Capacitor.getPlatform()}:${value}`,
  };
  try {
    const retrieved = await retrieveIdentity(protectedIdentity);
    if (retrieved.privateKey !== identity.privateKey) {
      throw new Error('Secure storage could not verify the saved identity key.');
    }
  } catch (e) {
    await removeIdentityProtection(protectedIdentity).catch(console.error);
    throw e;
  }
  return protectedIdentity;
}

export async function persistIdentity(identity: UserIdentity, clearPendingProfile = false): Promise<UserIdentity> {
  const previous = await loadIdentity();
  const protectedIdentity = await protectIdentity(identity);
  try {
    await saveIdentity(protectedIdentity, clearPendingProfile);
  } catch (e) {
    if (protectedIdentity.privateKey !== identity.privateKey && protectedIdentity.privateKey !== previous?.privateKey) {
      await removeIdentityProtection(protectedIdentity).catch(console.error);
    }
    throw e;
  }
  if (previous && previous.privateKey !== protectedIdentity.privateKey) {
    await removeIdentityProtection(previous).catch(console.error);
  }
  return protectedIdentity;
}
