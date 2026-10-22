import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import * as database from '@/lib/storage/database';
import { protectIdentity, persistIdentity, retrieveIdentity } from '@/lib/storage/identity-protection';
import { generateIdentity } from '@/lib/crypto/identity';
import { encryptPrivateKey } from '@/lib/crypto/key-encryption';
import { exportIdentityToJSON, importIdentityFromJSON } from '@/lib/io/backup';
import { encodeIdentityForQR, decodeIdentityFromQR } from '@/lib/crypto/identity-qr';
import { useIdentityStore } from '@/stores/identity.store';
import type { UserIdentity } from '@/types';

const native = vi.hoisted(() => ({
  platform: 'android',
  protect: vi.fn(),
  retrieve: vi.fn(),
  remove: vi.fn(),
}));

vi.mock('@capacitor/core', () => ({
  Capacitor: {
    getPlatform: () => native.platform,
    isNativePlatform: () => native.platform !== 'web',
  },
  registerPlugin: () => native,
}));

vi.mock('@/stores/groups.store', () => ({
  useGroupsStore: { getState: () => ({ documents: {}, updateMemberProfile: vi.fn() }) },
  whenSaved: async () => {},
}));

const vault = new Map<string, { peerId: string; privateKey: string }>();
let nextSlot = 0;
let original: UserIdentity;
let imported: UserIdentity;
const passphrase = 'correct horse battery staple';
const { db, loadIdentity, saveIdentity } = database;

beforeAll(async () => {
  original = await generateIdentity('Original');
  imported = await generateIdentity('Imported');
});

beforeEach(async () => {
  await db.identity.clear();
  await db.identityMeta.clear();
  native.platform = 'android';
  nextSlot = 0;
  vault.clear();
  native.protect.mockReset().mockImplementation(async ({ peerId, privateKey }) => {
    const value = `slot-${++nextSlot}`;
    vault.set(value, { peerId, privateKey });
    return { value };
  });
  native.retrieve.mockReset().mockImplementation(async ({ peerId, value }) => {
    const saved = vault.get(value);
    if (!saved || saved.peerId !== peerId) throw new Error('Secure key unavailable');
    return { privateKey: saved.privateKey };
  });
  native.remove.mockReset().mockImplementation(async ({ value }) => {
    vault.delete(value);
  });
  useIdentityStore.setState(useIdentityStore.getInitialState(), true);
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('identity protection adapter', () => {
  it.each(['android', 'ios'])('stores a verified %s reference instead of the identity key', async platform => {
    native.platform = platform;
    const saved = await persistIdentity(original);
    expect(saved.privateKey).toBe(`native1:${platform}:slot-1`);
    expect(await loadIdentity()).toEqual(saved);
    expect(await retrieveIdentity(saved)).toEqual(original);
    expect(native.protect).toHaveBeenCalledWith({ peerId: original.peerId, privateKey: original.privateKey });
  });

  it('keeps the web storage and passphrase formats unchanged', async () => {
    native.platform = 'web';
    expect(await protectIdentity(original)).toBe(original);
    const encrypted = { ...original, privateKey: await encryptPrivateKey(original.privateKey, passphrase) };
    expect(await persistIdentity(encrypted)).toEqual(encrypted);
    expect(native.protect).not.toHaveBeenCalled();
    expect(native.retrieve).not.toHaveBeenCalled();
  });

  it('leaves an existing passphrase-protected native identity untouched', async () => {
    const encrypted = { ...original, privateKey: await encryptPrivateKey(original.privateKey, passphrase) };
    expect(await persistIdentity(encrypted)).toEqual(encrypted);
    expect(native.protect).not.toHaveBeenCalled();
  });

  it.each(['protect', 'retrieve'] as const)('keeps the previous row when native %s fails', async operation => {
    await saveIdentity(original);
    native[operation].mockRejectedValueOnce(new Error('Device storage failed'));
    await expect(persistIdentity(imported)).rejects.toThrow('Device storage failed');
    expect(await loadIdentity()).toEqual(original);
    if (operation === 'retrieve') {
      expect(native.remove).toHaveBeenCalledWith({ peerId: imported.peerId, value: 'slot-1' });
    } else {
      expect(native.remove).not.toHaveBeenCalled();
    }
    expect(vault.size).toBe(0);
  });

  it('does not commit a reference that reads back a different key', async () => {
    await saveIdentity(original);
    native.retrieve.mockResolvedValueOnce({ privateKey: 'wrong-key' });
    await expect(persistIdentity(imported)).rejects.toThrow('could not verify');
    expect(await loadIdentity()).toEqual(original);
    expect(native.remove).toHaveBeenCalledWith({ peerId: imported.peerId, value: 'slot-1' });
    expect(vault.size).toBe(0);
  });

  it.each(['android', 'ios'])('only removes the new %s entry when verification fails', async platform => {
    native.platform = platform;
    const previous = await persistIdentity(original);
    native.retrieve.mockRejectedValueOnce(new Error('Readback failed'));
    await expect(persistIdentity(imported)).rejects.toThrow('Readback failed');
    expect(await loadIdentity()).toEqual(previous);
    expect(native.remove).toHaveBeenCalledExactlyOnceWith({ peerId: imported.peerId, value: 'slot-2' });
    expect(vault.size).toBe(1);
    expect(await retrieveIdentity(previous)).toEqual(original);
  });

  it('logs failed verification cleanup without hiding the original error', async () => {
    await saveIdentity(original);
    const readError = new Error('Readback failed');
    const cleanupError = new Error('Delete refused');
    const log = vi.spyOn(console, 'error').mockImplementation(() => {});
    native.retrieve.mockRejectedValueOnce(readError);
    native.remove.mockRejectedValueOnce(cleanupError);
    await expect(persistIdentity(imported)).rejects.toBe(readError);
    expect(log).toHaveBeenCalledWith(cleanupError);
    expect(await loadIdentity()).toEqual(original);
    expect(vault.size).toBe(1);
  });

  it('keeps the old secure key if the database commit fails', async () => {
    const previous = await persistIdentity(original);
    vi.spyOn(database, 'saveIdentity').mockRejectedValueOnce(new Error('Disk full'));
    await expect(persistIdentity(imported)).rejects.toThrow('Disk full');
    expect(await loadIdentity()).toEqual(previous);
    expect(await retrieveIdentity(previous)).toEqual(original);
    expect(native.remove).toHaveBeenCalledWith({ peerId: imported.peerId, value: 'slot-2' });
    expect(vault.has('slot-1')).toBe(true);
  });

  it('releases the old reference only after the new row is committed', async () => {
    await persistIdentity(original);
    native.remove.mockImplementationOnce(async ({ value }) => {
      expect((await loadIdentity())?.peerId).toBe(imported.peerId);
      vault.delete(value);
    });
    await persistIdentity(imported);
    expect(vault.has('slot-1')).toBe(false);
    expect((await loadIdentity())?.privateKey).toBe('native1:android:slot-2');
  });

  it('rejects a native row on the web or the wrong platform', async () => {
    const saved = await persistIdentity(original);
    native.retrieve.mockClear();
    for (const platform of ['web', 'ios']) {
      native.platform = platform;
      await expect(retrieveIdentity(saved)).rejects.toThrow('original device');
    }
    expect(native.retrieve).not.toHaveBeenCalled();
  });

  it('does not replace a missing wrapping key or fall back to a session key', async () => {
    const saved = await persistIdentity(original);
    vault.clear();
    native.protect.mockClear();
    await expect(retrieveIdentity(saved)).rejects.toThrow('unavailable');
    expect(native.protect).not.toHaveBeenCalled();
    expect(await loadIdentity()).toEqual(saved);
  });

  it('reuses an existing protected reference without replacing its key', async () => {
    const saved = await persistIdentity(original);
    native.protect.mockClear();
    expect(await persistIdentity(saved)).toEqual(saved);
    expect(native.protect).not.toHaveBeenCalled();
    expect(native.remove).not.toHaveBeenCalled();
    expect(vault.size).toBe(1);
  });
});

describe.each(['android', 'ios'])('%s identity lifecycle', platform => {
  beforeEach(() => {
    native.platform = platform;
  });

  it('creates protected identities and retrieves the same key after a reboot', async () => {
    await useIdentityStore.getState().createIdentity('New');
    const identity = useIdentityStore.getState().identity!;
    expect((await loadIdentity())?.privateKey).toMatch(/^native1:/);
    expect(useIdentityStore.getState().isNativeProtectedOnDisk).toBe(true);
    useIdentityStore.setState(useIdentityStore.getInitialState(), true);
    await useIdentityStore.getState().initialize();
    expect(useIdentityStore.getState().identity).toEqual(identity);
    expect(useIdentityStore.getState().needsPassphrase).toBe(false);
  });

  it('does not save a new identity as plaintext when secure storage refuses creation', async () => {
    native.protect.mockRejectedValueOnce(new Error('Secure storage unavailable'));
    await expect(useIdentityStore.getState().createIdentity('New')).rejects.toThrow('Secure storage unavailable');
    expect(await loadIdentity()).toBeUndefined();
    expect(useIdentityStore.getState().identity).toBeNull();
  });

  it('migrates plaintext only after secure storage readback succeeds', async () => {
    await saveIdentity(original);
    await useIdentityStore.getState().initialize();
    expect(useIdentityStore.getState().identity).toEqual(original);
    expect((await loadIdentity())?.privateKey).toBe(`native1:${platform}:slot-1`);
    expect(useIdentityStore.getState().isEncryptedOnDisk).toBe(true);
  });

  it('keeps a failed migration recoverable and blocks creating a replacement', async () => {
    await saveIdentity(original);
    native.retrieve.mockRejectedValueOnce(new Error('Device locked'));
    await useIdentityStore.getState().initialize();
    expect(useIdentityStore.getState().loadError).toBe('Device locked');
    expect(useIdentityStore.getState().identity).toBeNull();
    expect(await loadIdentity()).toEqual(original);
    await expect(useIdentityStore.getState().createIdentity('Replacement')).rejects.toThrow('already exists');
    await useIdentityStore.getState().initialize();
    expect(useIdentityStore.getState().loadError).toBeNull();
    expect(useIdentityStore.getState().identity).toEqual(original);
  });

  it('preserves legacy passphrase protection through boot, unlock and profile saves', async () => {
    const encrypted = { ...original, privateKey: await encryptPrivateKey(original.privateKey, passphrase) };
    await saveIdentity(encrypted);
    await useIdentityStore.getState().initialize();
    expect(useIdentityStore.getState().needsPassphrase).toBe(true);
    await expect(useIdentityStore.getState().unlockWithPassphrase('wrong')).rejects.toThrow('Incorrect passphrase');
    expect(await loadIdentity()).toEqual(encrypted);
    await useIdentityStore.getState().unlockWithPassphrase(passphrase);
    await useIdentityStore.getState().updateProfile({ displayName: 'Renamed' });
    expect((await loadIdentity())?.privateKey).toBe(encrypted.privateKey);
    expect(useIdentityStore.getState().identity?.privateKey).toBe(original.privateKey);
    expect(native.protect).not.toHaveBeenCalled();
  });

  it('switches from a passphrase only by request, without a plaintext write', async () => {
    const encrypted = { ...original, privateKey: await encryptPrivateKey(original.privateKey, passphrase) };
    await saveIdentity(encrypted);
    await useIdentityStore.getState().initialize();
    native.protect.mockRejectedValueOnce(new Error('Keystore unavailable'));
    await expect(useIdentityStore.getState().disableEncryption(passphrase)).rejects.toThrow('Keystore unavailable');
    expect(await loadIdentity()).toEqual(encrypted);
    expect(useIdentityStore.getState().needsPassphrase).toBe(true);
    await useIdentityStore.getState().disableEncryption(passphrase);
    expect((await loadIdentity())?.privateKey).toMatch(/^native1:/);
    expect(useIdentityStore.getState().identity).toEqual(original);
    await expect(useIdentityStore.getState().disableEncryption('')).rejects.toThrow('cannot be disabled');
    await expect(useIdentityStore.getState().enableEncryption(passphrase)).rejects.toThrow('device protection');
  });

  it('preserves native protection during a profile edit', async () => {
    await useIdentityStore.getState().restoreIdentity(original);
    const saved = await loadIdentity();
    native.protect.mockClear();
    await useIdentityStore.getState().updateProfile({ displayName: 'Renamed' });
    expect((await loadIdentity())?.privateKey).toBe(saved?.privateKey);
    expect(useIdentityStore.getState().identity?.displayName).toBe('Renamed');
    expect(native.protect).not.toHaveBeenCalled();
  });

  it('exports the retrieved key in the existing JSON and QR formats', async () => {
    await useIdentityStore.getState().restoreIdentity(original);
    native.retrieve.mockClear();
    const exported = await useIdentityStore.getState().identityForExport();
    expect(native.retrieve).toHaveBeenCalled();
    expect(importIdentityFromJSON(exportIdentityToJSON(exported))).toEqual(original);
    expect(decodeIdentityFromQR(encodeIdentityForQR(exported)).privateKey).toBe(original.privateKey);
    native.retrieve.mockRejectedValueOnce(new Error('Key unavailable'));
    await expect(useIdentityStore.getState().identityForExport()).rejects.toThrow('Key unavailable');
  });

  it('protects an imported identity on the destination and keeps the old one on failure', async () => {
    await useIdentityStore.getState().restoreIdentity(original);
    const previous = await loadIdentity();
    await database.savePendingProfileUpdate({ displayName: 'Pending' });
    native.protect.mockRejectedValueOnce(new Error('Storage refused'));
    await expect(useIdentityStore.getState().restoreIdentity(imported)).rejects.toThrow('Storage refused');
    expect(await loadIdentity()).toEqual(previous);
    expect(await database.loadPendingProfileUpdate()).toEqual({ displayName: 'Pending' });
    expect(useIdentityStore.getState().identity).toEqual(original);
    await useIdentityStore.getState().restoreIdentity(imported);
    expect(await db.identity.count()).toBe(1);
    expect((await loadIdentity())?.privateKey).toBe(`native1:${platform}:slot-2`);
    expect(useIdentityStore.getState().identity).toEqual(imported);
    expect(await database.loadPendingProfileUpdate()).toBeNull();
    expect(vault.has('slot-1')).toBe(false);
  });

  it('keeps an inaccessible native identity and offers a load error rather than a new identity', async () => {
    await useIdentityStore.getState().restoreIdentity(original);
    const previous = await loadIdentity();
    vault.clear();
    useIdentityStore.setState(useIdentityStore.getInitialState(), true);
    native.protect.mockClear();
    await useIdentityStore.getState().initialize();
    expect(useIdentityStore.getState().loadError).toBe('Secure key unavailable');
    expect(useIdentityStore.getState().identity).toBeNull();
    expect(await loadIdentity()).toEqual(previous);
    expect(native.protect).not.toHaveBeenCalled();
  });

  it('does not release the native key when reset cannot clear the database', async () => {
    await useIdentityStore.getState().restoreIdentity(original);
    const previous = await loadIdentity();
    await database.savePendingProfileUpdate({ displayName: 'Pending' });
    vi.spyOn(db.identity, 'clear').mockRejectedValueOnce(new Error('Write failed'));
    await expect(useIdentityStore.getState().resetIdentity()).rejects.toThrow('Write failed');
    expect(await loadIdentity()).toEqual(previous);
    expect(await database.loadPendingProfileUpdate()).toEqual({ displayName: 'Pending' });
    expect(useIdentityStore.getState().identity).toEqual(original);
    expect(native.remove).not.toHaveBeenCalled();
  });

  it('reports a native delete failure after an explicit reset without saving a plaintext copy', async () => {
    await useIdentityStore.getState().restoreIdentity(original);
    native.remove.mockRejectedValueOnce(new Error('Delete refused'));
    await expect(useIdentityStore.getState().resetIdentity()).rejects.toThrow('Delete refused');
    expect(await loadIdentity()).toBeUndefined();
    expect(useIdentityStore.getState().identity).toBeNull();
    expect(useIdentityStore.getState().loadError).toContain('Delete refused');
    expect(vault.size).toBe(1);
  });

  it('resets the native reference and profile marker without deleting groups', async () => {
    await useIdentityStore.getState().restoreIdentity(original);
    await database.savePendingProfileUpdate({ displayName: 'Pending' });
    await db.groups.put({
      id: 'group-1', name: 'Keep', topic: 'topic', createdAt: original.createdAt,
      state: 'active', memberCount: 1, currency: 'USD',
    });
    await useIdentityStore.getState().resetIdentity();
    expect(await loadIdentity()).toBeUndefined();
    expect(await database.loadPendingProfileUpdate()).toBeNull();
    expect(vault.size).toBe(0);
    expect(useIdentityStore.getState().identity).toBeNull();
    expect(useIdentityStore.getState().isEncryptedOnDisk).toBe(false);
    expect(await db.groups.get('group-1')).toBeDefined();
  });
});

it('keeps the web passphrase lifecycle working without native storage', async () => {
  native.platform = 'web';
  await useIdentityStore.getState().restoreIdentity(original);
  await useIdentityStore.getState().enableEncryption(passphrase);
  const encrypted = await loadIdentity();
  expect(encrypted?.privateKey).toMatch(/^enc1:/);
  useIdentityStore.setState(useIdentityStore.getInitialState(), true);
  await useIdentityStore.getState().initialize();
  expect(useIdentityStore.getState().needsPassphrase).toBe(true);
  await useIdentityStore.getState().unlockWithPassphrase(passphrase);
  expect(await useIdentityStore.getState().identityForExport()).toEqual(original);
  await useIdentityStore.getState().updateProfile({ displayName: 'Web rename' });
  expect((await loadIdentity())?.privateKey).toBe(encrypted?.privateKey);
  await useIdentityStore.getState().disableEncryption(passphrase);
  expect((await loadIdentity())?.privateKey).toBe(original.privateKey);
  expect(useIdentityStore.getState().isEncryptedOnDisk).toBe(false);
  expect(native.protect).not.toHaveBeenCalled();
  expect(native.retrieve).not.toHaveBeenCalled();
});
