import { describe, it, expect, vi, beforeEach } from 'vitest';
import type { UserIdentity } from '@/types';

const saveIdentity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const loadIdentity = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const savePendingProfileUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(undefined));
const loadPendingProfileUpdate = vi.hoisted(() => vi.fn().mockResolvedValue(null));

vi.mock('@/lib/storage/database', () => ({
  saveIdentity,
  loadIdentity,
  savePendingProfileUpdate,
  loadPendingProfileUpdate,
  db: { identity: { clear: vi.fn().mockResolvedValue(undefined) } },
}));

// A caller-visible identity: displayName + real-looking peer/keys.
const fakeIdentity: UserIdentity = {
  peerId: 'peer-abcdef0123456789',
  publicKey: 'a'.repeat(64),
  privateKey: 'b'.repeat(96),
  displayName: 'Tester',
  avatar: '',
  createdAt: '2026-01-01T00:00:00Z',
};

const generateIdentity = vi.hoisted(() =>
  vi.fn().mockResolvedValue({
    peerId: 'peer-abcdef0123456789',
    publicKey: 'a'.repeat(64),
    privateKey: 'b'.repeat(96),
    displayName: 'Tester',
    avatar: '',
    createdAt: '2026-01-01T00:00:00Z',
  })
);

vi.mock('@/lib/crypto/identity', () => ({
  generateIdentity,
}));

const encryptPrivateKey = vi.hoisted(() => vi.fn(async (key: string, _pass: string) => `ENC:${key}`));
const decryptPrivateKey = vi.hoisted(() => vi.fn(async (encKey: string, _pass: string) => encKey.replace(/^ENC:/, '')));
const isEncryptedKey = vi.hoisted(() => vi.fn((key: string) => key.startsWith('ENC:')));

vi.mock('@/lib/crypto/key-encryption', () => ({
  encryptPrivateKey,
  decryptPrivateKey,
  isEncryptedKey,
}));

// Groups store is dynamically imported by updateProfile; stub it so the test
// doesn't try to boot the real store.
const updateMemberProfile = vi.hoisted(() => vi.fn());
vi.mock('@/stores/groups.store', () => ({
  useGroupsStore: {
    getState: () => ({
      documents: { g1: { members: { 'peer-abcdef0123456789': {} } } },
      updateMemberProfile,
    }),
  },
  whenSaved: vi.fn().mockResolvedValue(undefined),
}));

const { useIdentityStore } = await import('@/stores/identity.store');

function resetStore() {
  useIdentityStore.setState({
    identity: null,
    isLoading: true,
    isInitialized: false,
    needsPassphrase: false,
    pendingProfileUpdate: null,
    loadError: null,
  });
}

describe('identity.store (createIdentity)', () => {
  beforeEach(() => {
    resetStore();
    saveIdentity.mockClear();
    generateIdentity.mockClear();
  });

  it('generates, persists, and stores an identity', async () => {
    await useIdentityStore.getState().createIdentity('Tester');
    expect(generateIdentity).toHaveBeenCalledWith('Tester');
    expect(saveIdentity).toHaveBeenCalledTimes(1);
    expect(useIdentityStore.getState().identity?.displayName).toBe('Tester');
  });
});

describe('identity.store (initialize)', () => {
  beforeEach(() => {
    resetStore();
    loadIdentity.mockReset();
    encryptPrivateKey.mockClear();
    decryptPrivateKey.mockClear();
  });

  it('loads a plaintext identity from storage on startup', async () => {
    loadIdentity.mockResolvedValue(fakeIdentity);
    await useIdentityStore.getState().initialize();

    const s = useIdentityStore.getState();
    expect(s.identity?.peerId).toBe(fakeIdentity.peerId);
    expect(s.needsPassphrase).toBe(false);
    expect(s.isLoading).toBe(false);
    expect(s.isInitialized).toBe(true);
  });

  it('sets needsPassphrase=true when the stored identity is encrypted', async () => {
    loadIdentity.mockResolvedValue({ ...fakeIdentity, privateKey: 'ENC:blob' });
    await useIdentityStore.getState().initialize();

    const s = useIdentityStore.getState();
    expect(s.needsPassphrase).toBe(true);
    expect(s.identity).toBeNull(); // must NOT expose the encrypted identity
    expect(s.isLoading).toBe(false);
  });

  it('recovers cleanly when loadIdentity throws', async () => {
    loadIdentity.mockRejectedValue(new Error('db unavailable'));
    await useIdentityStore.getState().initialize();

    const s = useIdentityStore.getState();
    expect(s.isLoading).toBe(false);
    expect(s.isInitialized).toBe(true);
    expect(s.identity).toBeNull();
  });
});

describe('identity.store (unlockWithPassphrase)', () => {
  beforeEach(() => {
    resetStore();
    loadIdentity.mockReset();
    decryptPrivateKey.mockClear();
  });

  it('decrypts the stored key and clears needsPassphrase on success', async () => {
    const encrypted = { ...fakeIdentity, privateKey: 'ENC:secret' };
    loadIdentity.mockResolvedValue(encrypted);
    useIdentityStore.setState({ needsPassphrase: true });

    await useIdentityStore.getState().unlockWithPassphrase('correct-horse-battery-staple');

    expect(decryptPrivateKey).toHaveBeenCalledWith('ENC:secret', 'correct-horse-battery-staple');
    const s = useIdentityStore.getState();
    expect(s.identity?.privateKey).toBe('secret');
    expect(s.needsPassphrase).toBe(false);
  });

  it('surfaces the decryption error so the UI can show it', async () => {
    loadIdentity.mockResolvedValue({ ...fakeIdentity, privateKey: 'ENC:secret' });
    decryptPrivateKey.mockRejectedValueOnce(new Error('bad passphrase'));

    await expect(
      useIdentityStore.getState().unlockWithPassphrase('wrong')
    ).rejects.toThrow('bad passphrase');
  });

  it('throws when there is no stored identity to unlock', async () => {
    loadIdentity.mockResolvedValue(undefined);
    await expect(
      useIdentityStore.getState().unlockWithPassphrase('anything')
    ).rejects.toThrow('No identity found');
  });
});

describe('identity.store (enable/disable encryption)', () => {
  beforeEach(() => {
    resetStore();
    loadIdentity.mockReset();
    saveIdentity.mockClear();
    encryptPrivateKey.mockClear();
    decryptPrivateKey.mockClear();
  });

  it('enableEncryption persists an encrypted key without losing the in-memory session', async () => {
    useIdentityStore.setState({ identity: fakeIdentity });
    await useIdentityStore.getState().enableEncryption('pass');

    expect(encryptPrivateKey).toHaveBeenCalledWith(fakeIdentity.privateKey, 'pass');
    expect(saveIdentity).toHaveBeenCalledTimes(1);
    // The in-memory identity keeps the decrypted key so the current session works.
    expect(useIdentityStore.getState().identity?.privateKey).toBe(fakeIdentity.privateKey);
  });

  it('disableEncryption writes back a plaintext key', async () => {
    loadIdentity.mockResolvedValue({ ...fakeIdentity, privateKey: 'ENC:secret' });
    await useIdentityStore.getState().disableEncryption('pass');
    expect(decryptPrivateKey).toHaveBeenCalledWith('ENC:secret', 'pass');
    expect(saveIdentity).toHaveBeenCalledTimes(1);
  });
});

describe('identity.store (updateProfile)', () => {
  beforeEach(() => {
    resetStore();
    loadIdentity.mockReset();
    saveIdentity.mockClear();
    savePendingProfileUpdate.mockClear();
  });

  it('preserves the encrypted stored key when updating the display name', async () => {
    // Simulate: user enabled encryption (encrypted key on disk, plaintext in memory
    // for the current session), then renames themselves in Settings.
    useIdentityStore.setState({ identity: fakeIdentity });
    loadIdentity.mockResolvedValue({ ...fakeIdentity, privateKey: 'ENC:secret' });

    await useIdentityStore.getState().updateProfile({ displayName: 'Renamed' });

    // saveIdentity must have been called with the ENCRYPTED key, not the plaintext
    // one from the in-memory identity.
    expect(saveIdentity).toHaveBeenCalledTimes(1);
    const savedArg = saveIdentity.mock.calls[0][0];
    expect(savedArg.privateKey).toBe('ENC:secret');
    expect(savedArg.displayName).toBe('Renamed');
    // In-memory identity is updated with the new display name (session unaffected).
    expect(useIdentityStore.getState().identity?.displayName).toBe('Renamed');
  });

  it('writes the plaintext key normally when encryption is NOT enabled', async () => {
    useIdentityStore.setState({ identity: fakeIdentity });
    // Stored key is plaintext (encryption disabled).
    loadIdentity.mockResolvedValue(fakeIdentity);

    await useIdentityStore.getState().updateProfile({ displayName: 'Renamed' });

    expect(saveIdentity).toHaveBeenCalledTimes(1);
    const savedArg = saveIdentity.mock.calls[0][0];
    expect(savedArg.privateKey).toBe(fakeIdentity.privateKey);
    expect(savedArg.displayName).toBe('Renamed');
  });
});

describe('identity.store (pendingProfileUpdate crash recovery)', () => {
  beforeEach(() => {
    resetStore();
    loadIdentity.mockReset();
    saveIdentity.mockClear();
    savePendingProfileUpdate.mockClear();
    loadPendingProfileUpdate.mockReset();
  });

  it('persists pendingProfileUpdate to IndexedDB before saving the identity', async () => {
    useIdentityStore.setState({ identity: fakeIdentity });
    loadIdentity.mockResolvedValue(fakeIdentity);

    await useIdentityStore.getState().updateProfile({ displayName: 'Renamed' });

    // First call: persist the pending flag (so a crash mid-propagation is recoverable).
    // Second call: clear it after the propagation loop completes.
    expect(savePendingProfileUpdate).toHaveBeenCalledTimes(2);
    expect(savePendingProfileUpdate).toHaveBeenNthCalledWith(1, { displayName: 'Renamed' });
    expect(savePendingProfileUpdate).toHaveBeenNthCalledWith(2, null);
  });

  it('replays a persisted pendingProfileUpdate on initialize (crash recovery)', async () => {
    // Simulate a prior session that crashed after saveIdentity but before the
    // per-group propagation completed.
    loadIdentity.mockResolvedValue({ ...fakeIdentity, displayName: 'Renamed' });
    loadPendingProfileUpdate.mockResolvedValue({ displayName: 'Renamed' });

    await useIdentityStore.getState().initialize();

    // The persisted flag is now visible on the store (before the retry runs).
    // updateProfile will fire off asynchronously; verify the DB was queried.
    expect(loadPendingProfileUpdate).toHaveBeenCalledTimes(1);
    // And the store picked up the persisted value.
    // (After the async updateProfile completes, it will clear itself back to null.)
    const s = useIdentityStore.getState();
    expect(s.identity?.displayName).toBe('Renamed');
  });

  it('does not attempt a retry when nothing is persisted', async () => {
    loadIdentity.mockResolvedValue(fakeIdentity);
    loadPendingProfileUpdate.mockResolvedValue(null);

    await useIdentityStore.getState().initialize();

    // updateProfile is NOT invoked (no pending update) so saveIdentity should
    // not be called by initialize().
    expect(saveIdentity).not.toHaveBeenCalled();
    expect(useIdentityStore.getState().pendingProfileUpdate).toBeNull();
  });

  // the retry waits for groups (and for unlock on an encrypted key)
  it('resumes a pending rename into groups once asked to', async () => {
    updateMemberProfile.mockClear();
    loadIdentity.mockResolvedValue(fakeIdentity);
    loadPendingProfileUpdate.mockResolvedValue({ displayName: 'Renamed' });
    await useIdentityStore.getState().initialize();
    expect(updateMemberProfile).not.toHaveBeenCalled();

    await useIdentityStore.getState().resumePendingProfileUpdate();

    expect(updateMemberProfile).toHaveBeenCalledWith('g1', fakeIdentity.peerId, { displayName: 'Renamed' });
    expect(useIdentityStore.getState().pendingProfileUpdate).toBeNull();
  });

  it('keeps the pending rename for an encrypted identity until unlock', async () => {
    loadIdentity.mockResolvedValue({ ...fakeIdentity, privateKey: 'ENC:secret' });
    loadPendingProfileUpdate.mockResolvedValue({ displayName: 'Renamed' });
    await useIdentityStore.getState().initialize();
    expect(useIdentityStore.getState().needsPassphrase).toBe(true);
    expect(useIdentityStore.getState().pendingProfileUpdate).toEqual({ displayName: 'Renamed' });
  });
});

describe('identity.store (safety rails)', () => {
  beforeEach(() => {
    resetStore();
    loadIdentity.mockReset();
    saveIdentity.mockClear();
  });

  it('refuses to create a second identity over an existing one', async () => {
    loadIdentity.mockResolvedValue(fakeIdentity);
    await expect(useIdentityStore.getState().createIdentity('Someone')).rejects.toThrow('already exists');
    expect(saveIdentity).not.toHaveBeenCalled();
  });

  it('records a load failure instead of looking like a fresh install', async () => {
    loadIdentity.mockRejectedValue(new Error('db unavailable'));
    await useIdentityStore.getState().initialize();
    expect(useIdentityStore.getState().identity).toBeNull();
    expect(useIdentityStore.getState().loadError).toBe('db unavailable');
  });

  it('trims a display name to the schema cap', async () => {
    useIdentityStore.setState({ identity: fakeIdentity });
    loadIdentity.mockResolvedValue(fakeIdentity);
    await useIdentityStore.getState().updateProfile({ displayName: 'x'.repeat(80) });
    expect(useIdentityStore.getState().identity?.displayName).toHaveLength(50);
  });
});
