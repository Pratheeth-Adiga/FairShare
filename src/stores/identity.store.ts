import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { UserIdentity } from '@/types';
import { generateIdentity } from '@/lib/crypto/identity';
import { saveIdentity, loadIdentity, savePendingProfileUpdate, loadPendingProfileUpdate, db } from '@/lib/storage/database';
import { encryptPrivateKey, decryptPrivateKey, isEncryptedKey } from '@/lib/crypto/key-encryption';
import { MAX_LENGTHS } from '@/lib/utils/validation';
import { Capacitor } from '@capacitor/core';
import { isNativeProtected, persistIdentity, retrieveIdentity, removeIdentityProtection } from '@/lib/storage/identity-protection';

interface IdentityState {
  identity: UserIdentity | null;
  isLoading: boolean;
  isInitialized: boolean;
  needsPassphrase: boolean;
  // derive the UI state from disk, not a separate localStorage flag
  isEncryptedOnDisk: boolean;
  isNativeProtectedOnDisk: boolean;
  pendingProfileUpdate: { displayName?: string; avatar?: string } | null;
  // a failed read is not the same as "no identity", Onboarding would replace the real one
  loadError: string | null;

  initialize: () => Promise<void>;
  createIdentity: (displayName: string) => Promise<void>;
  updateProfile: (update: { displayName?: string; avatar?: string }) => Promise<void>;
  resumePendingProfileUpdate: () => Promise<void>;
  restoreIdentity: (identity: UserIdentity) => Promise<void>;
  unlockWithPassphrase: (passphrase: string) => Promise<void>;
  resetIdentity: () => Promise<void>;
  enableEncryption: (passphrase: string) => Promise<void>;
  disableEncryption: (passphrase: string) => Promise<void>;
  identityForExport: () => Promise<UserIdentity>;
}

// immer middleware lets `set` mutate the draft directly below
export const useIdentityStore = create<IdentityState>()(immer((set, get) => ({
  identity: null,
  isLoading: true,
  isInitialized: false,
  needsPassphrase: false,
  isEncryptedOnDisk: false,
  isNativeProtectedOnDisk: false,
  pendingProfileUpdate: null,
  loadError: null,

  initialize: async () => {
    try {
      let stored = await loadIdentity();
      // the marker lives in IndexedDB so an interrupted rename can be retried,
      // and resumePendingProfileUpdate runs it once groups are loaded (and after unlock)
      const persistedPending = await loadPendingProfileUpdate();
      if (stored && isEncryptedKey(stored.privateKey)) {
        // private key is encrypted; request passphrase before use
        set((state) => {
          state.identity = null;
          state.needsPassphrase = true;
          state.isEncryptedOnDisk = true;
          state.isNativeProtectedOnDisk = false;
          state.isLoading = false;
          state.isInitialized = true;
          state.loadError = null;
          state.pendingProfileUpdate = persistedPending;
        });
        return;
      }
      if (stored && Capacitor.isNativePlatform() && !isNativeProtected(stored.privateKey)) {
        stored = await persistIdentity(stored);
      }
      const identity = stored ? await retrieveIdentity(stored) : null;
      set((state) => {
        state.identity = identity;
        state.needsPassphrase = false;
        state.isNativeProtectedOnDisk = !!stored && isNativeProtected(stored.privateKey);
        state.isEncryptedOnDisk = state.isNativeProtectedOnDisk;
        state.isLoading = false;
        state.isInitialized = true;
        state.loadError = null;
        state.pendingProfileUpdate = persistedPending;
      });
    } catch (err) {
      console.error('[identity] failed to load identity', err);
      set((state) => {
        state.identity = null;
        state.needsPassphrase = false;
        state.isLoading = false;
        state.isInitialized = true;
        state.loadError = err instanceof Error ? err.message : String(err);
      });
    }
  },

  createIdentity: async (displayName: string) => {
    // never silently replace an existing key pair
    if (get().identity || get().needsPassphrase || await loadIdentity()) {
      throw new Error('An identity already exists on this device.');
    }
    const identity = await generateIdentity(displayName.trim().slice(0, MAX_LENGTHS.displayName));
    const stored = await persistIdentity(identity);
    set((state) => {
      state.identity = identity;
      state.isNativeProtectedOnDisk = isNativeProtected(stored.privateKey);
      state.isEncryptedOnDisk = state.isNativeProtectedOnDisk;
      state.loadError = null;
    });
  },

  // Used to carry an identity (peerId + keypair) from another device, e.g. via
  // an exported identity JSON file. Overwrites whatever identity is currently
  // stored locally, so callers must confirm with the user before calling this.
  restoreIdentity: async (identity: UserIdentity) => {
    const unlocked = isEncryptedKey(identity.privateKey) ? null : await retrieveIdentity(identity);
    const stored = await persistIdentity(identity, true);
    set((state) => {
      state.identity = unlocked;
      state.isInitialized = true;
      state.isLoading = false;
      state.needsPassphrase = isEncryptedKey(stored.privateKey);
      // reflect the on-disk encryption state of the restored key
      state.isNativeProtectedOnDisk = isNativeProtected(stored.privateKey);
      state.isEncryptedOnDisk = state.needsPassphrase || state.isNativeProtectedOnDisk;
      state.pendingProfileUpdate = null;
      state.loadError = null;
    });
  },

  updateProfile: async (update) => {
    const { identity } = get();
    if (!identity) return;
    // the group schema caps names at 50, a longer one made every group unloadable
    if (update.displayName !== undefined) {
      update = { ...update, displayName: update.displayName.trim().slice(0, MAX_LENGTHS.displayName) };
    }
    const updated = { ...identity, ...update };
    // persist the pending marker to IndexedDB before saving so a
    // crash mid-propagation actually finds a marker to retry on restart. The
    // in-memory copy is set too for immediate consistency within this session.
    set((state) => {
      state.pendingProfileUpdate = update;
    });
    await savePendingProfileUpdate(update);
    // if the on-disk key is currently encrypted, don't overwrite it with
    // the plaintext key we're holding in memory. Only update the mutable
    // display-name/avatar fields on disk.
    const stored = await loadIdentity();
    if (stored && stored.peerId !== identity.peerId) throw new Error('The stored identity has changed. Restart the app.');
    if (stored && (isEncryptedKey(stored.privateKey) || isNativeProtected(stored.privateKey))) {
      await saveIdentity({ ...stored, ...update });
    } else {
      const saved = await persistIdentity(updated);
      set((state) => {
        state.isNativeProtectedOnDisk = isNativeProtected(saved.privateKey);
        state.isEncryptedOnDisk = state.isNativeProtectedOnDisk;
      });
    }
    set((state) => {
      state.identity = updated;
    });

    // Re-stamp member profiles so the display-name update wins the next merge.
    if (update.displayName) {
      const { useGroupsStore, whenSaved } = await import('./groups.store');
      const { documents, updateMemberProfile } = useGroupsStore.getState();
      for (const [groupId, doc] of Object.entries(documents)) {
        if (doc.members[identity.peerId]) {
          updateMemberProfile(groupId, identity.peerId, { displayName: update.displayName });
        }
      }
      // only drop the retry marker once those writes are actually on disk
      await whenSaved();
    }
    set((state) => {
      state.pendingProfileUpdate = null;
    });
    await savePendingProfileUpdate(null);
  },

  // called after groups load and after unlock, when there's something to update
  resumePendingProfileUpdate: async () => {
    const { identity, pendingProfileUpdate } = get();
    if (identity && pendingProfileUpdate) await get().updateProfile(pendingProfileUpdate);
  },

  unlockWithPassphrase: async (passphrase: string) => {
    const stored = await loadIdentity();
    if (!stored) throw new Error('No identity found');
    const decryptedKey = await decryptPrivateKey(stored.privateKey, passphrase);
    const identity = { ...stored, privateKey: decryptedKey };
    set((state) => {
      state.identity = identity;
      state.needsPassphrase = false;
      state.isEncryptedOnDisk = true;
      state.isNativeProtectedOnDisk = false;
      state.loadError = null;
    });
    // an encrypted user's interrupted rename used to never resume
    void get().resumePendingProfileUpdate().catch(err => console.error('[identity] rename retry failed', err));
  },

  // forgotten passphrase. Drops only the key pair, groups stay on the device.
  resetIdentity: async () => {
    const stored = await loadIdentity();
    await db.transaction('rw', db.identity, db.identityMeta, async () => {
      await db.identity.clear();
      await savePendingProfileUpdate(null);
    });
    set((state) => {
      state.identity = null;
      state.needsPassphrase = false;
      state.isEncryptedOnDisk = false;
      state.isNativeProtectedOnDisk = false;
      state.pendingProfileUpdate = null;
      state.loadError = null;
    });
    if (stored) {
      try {
        await removeIdentityProtection(stored);
      } catch (err) {
        set((state) => {
          state.loadError = `Your identity was reset, but a protected key may remain on this device: ${err instanceof Error ? err.message : String(err)}. Tap Retry to continue.`;
        });
        throw err;
      }
    }
  },

  enableEncryption: async (passphrase: string) => {
    if (Capacitor.isNativePlatform()) throw new Error('Native identities use device protection.');
    const { identity } = get();
    if (!identity) throw new Error('No identity to encrypt');
    const encryptedKey = await encryptPrivateKey(identity.privateKey, passphrase);
    await saveIdentity({ ...identity, privateKey: encryptedKey });
    // Keep the decrypted identity in memory for the current session
    set((state) => {
      state.isEncryptedOnDisk = true;
      state.isNativeProtectedOnDisk = false;
    });
  },

  disableEncryption: async (passphrase: string) => {
    const stored = await loadIdentity();
    if (!stored) throw new Error('No identity found');
    if (isNativeProtected(stored.privateKey)) throw new Error('Device protection cannot be disabled.');
    let plainKey: string;
    if (isEncryptedKey(stored.privateKey)) {
      plainKey = await decryptPrivateKey(stored.privateKey, passphrase);
    } else {
      plainKey = stored.privateKey;
    }
    const saved = await persistIdentity({ ...stored, privateKey: plainKey });
    set((state) => {
      state.identity = { ...stored, privateKey: plainKey };
      state.needsPassphrase = false;
      state.isNativeProtectedOnDisk = isNativeProtected(saved.privateKey);
      state.isEncryptedOnDisk = state.isNativeProtectedOnDisk;
    });
  },

  identityForExport: async () => {
    const { identity } = get();
    if (!identity) throw new Error('Unlock your identity before exporting.');
    const stored = await loadIdentity();
    if (!stored || stored.peerId !== identity.peerId) throw new Error('The stored identity has changed. Restart the app.');
    if (isEncryptedKey(stored.privateKey)) return { ...stored, privateKey: identity.privateKey };
    return retrieveIdentity(stored);
  },
})));
