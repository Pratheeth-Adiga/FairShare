import { create } from 'zustand';
import { immer } from 'zustand/middleware/immer';
import type { UserIdentity } from '@/types';
import { generateIdentity } from '@/lib/crypto/identity';
import { saveIdentity, loadIdentity, savePendingProfileUpdate, loadPendingProfileUpdate, db } from '@/lib/storage/database';
import { encryptPrivateKey, decryptPrivateKey, isEncryptedKey } from '@/lib/crypto/key-encryption';
import { MAX_LENGTHS } from '@/lib/utils/validation';

interface IdentityState {
  identity: UserIdentity | null;
  isLoading: boolean;
  isInitialized: boolean;
  needsPassphrase: boolean;
  // derive the UI state from disk, not a separate localStorage flag
  isEncryptedOnDisk: boolean;
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
}

// immer middleware lets `set` mutate the draft directly below
export const useIdentityStore = create<IdentityState>()(immer((set, get) => ({
  identity: null,
  isLoading: true,
  isInitialized: false,
  needsPassphrase: false,
  isEncryptedOnDisk: false,
  pendingProfileUpdate: null,
  loadError: null,

  initialize: async () => {
    try {
      const stored = await loadIdentity();
      // the marker lives in IndexedDB so an interrupted rename can be retried,
      // and resumePendingProfileUpdate runs it once groups are loaded (and after unlock)
      const persistedPending = await loadPendingProfileUpdate();
      if (stored && isEncryptedKey(stored.privateKey)) {
        // private key is encrypted; request passphrase before use
        set((state) => {
          state.needsPassphrase = true;
          state.isEncryptedOnDisk = true;
          state.isLoading = false;
          state.isInitialized = true;
          state.loadError = null;
          state.pendingProfileUpdate = persistedPending;
        });
        return;
      }
      set((state) => {
        state.identity = stored || null;
        state.isEncryptedOnDisk = false;
        state.isLoading = false;
        state.isInitialized = true;
        state.loadError = null;
        state.pendingProfileUpdate = persistedPending;
      });
    } catch (err) {
      console.error('[identity] failed to load identity', err);
      set((state) => {
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
    await saveIdentity(identity);
    set((state) => {
      state.identity = identity;
      state.isEncryptedOnDisk = false;
    });
  },

  // Used to carry an identity (peerId + keypair) from another device, e.g. via
  // an exported identity JSON file. Overwrites whatever identity is currently
  // stored locally, so callers must confirm with the user before calling this.
  restoreIdentity: async (identity: UserIdentity) => {
    await saveIdentity(identity);
    set((state) => {
      state.identity = identity;
      state.isInitialized = true;
      state.isLoading = false;
      state.needsPassphrase = false;
      // reflect the on-disk encryption state of the restored key
      state.isEncryptedOnDisk = isEncryptedKey(identity.privateKey);
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
    if (stored && isEncryptedKey(stored.privateKey)) {
      await saveIdentity({ ...stored, ...update });
    } else {
      await saveIdentity(updated);
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
    });
    // an encrypted user's interrupted rename used to never resume
    void get().resumePendingProfileUpdate().catch(err => console.error('[identity] rename retry failed', err));
  },

  // forgotten passphrase. Drops only the key pair, groups stay on the device.
  resetIdentity: async () => {
    await db.identity.clear();
    await savePendingProfileUpdate(null);
    set((state) => {
      state.identity = null;
      state.needsPassphrase = false;
      state.isEncryptedOnDisk = false;
      state.pendingProfileUpdate = null;
    });
  },

  enableEncryption: async (passphrase: string) => {
    const { identity } = get();
    if (!identity) throw new Error('No identity to encrypt');
    const encryptedKey = await encryptPrivateKey(identity.privateKey, passphrase);
    await saveIdentity({ ...identity, privateKey: encryptedKey });
    // Keep the decrypted identity in memory for the current session
    set((state) => { state.isEncryptedOnDisk = true; });
  },

  disableEncryption: async (passphrase: string) => {
    const stored = await loadIdentity();
    if (!stored) throw new Error('No identity found');
    let plainKey: string;
    if (isEncryptedKey(stored.privateKey)) {
      plainKey = await decryptPrivateKey(stored.privateKey, passphrase);
    } else {
      plainKey = stored.privateKey;
    }
    await saveIdentity({ ...stored, privateKey: plainKey });
    set((state) => { state.isEncryptedOnDisk = false; });
  },
})));
