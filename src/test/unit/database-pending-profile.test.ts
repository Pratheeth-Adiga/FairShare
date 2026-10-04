// exercise pending-profile persistence against real IndexedDB behavior
import 'fake-indexeddb/auto';
import { describe, it, expect, beforeEach } from 'vitest';
import {
  db,
  savePendingProfileUpdate,
  loadPendingProfileUpdate,
} from '@/lib/storage/database';

beforeEach(async () => {
  if (!db.isOpen()) await db.open();
  await db.identityMeta.clear();
});

describe('pending profile update persistence', () => {
  it('returns null when nothing is pending', async () => {
    expect(await loadPendingProfileUpdate()).toBeNull();
  });

  it('round-trips a display-name update', async () => {
    await savePendingProfileUpdate({ displayName: 'Ada' });
    expect(await loadPendingProfileUpdate()).toEqual({ displayName: 'Ada' });
  });

  it('round-trips an avatar update', async () => {
    await savePendingProfileUpdate({ avatar: 'data:image/png;base64,AAA' });
    expect(await loadPendingProfileUpdate()).toEqual({ avatar: 'data:image/png;base64,AAA' });
  });

  it('round-trips both fields together', async () => {
    await savePendingProfileUpdate({ displayName: 'Ada', avatar: 'x' });
    expect(await loadPendingProfileUpdate()).toEqual({ displayName: 'Ada', avatar: 'x' });
  });

  it('overwrites rather than accumulating markers', async () => {
    await savePendingProfileUpdate({ displayName: 'First' });
    await savePendingProfileUpdate({ displayName: 'Second' });
    expect(await loadPendingProfileUpdate()).toEqual({ displayName: 'Second' });
    expect(await db.identityMeta.count()).toBe(1);
  });

  it('clears the marker when passed null', async () => {
    await savePendingProfileUpdate({ displayName: 'Ada' });
    await savePendingProfileUpdate(null);
    expect(await loadPendingProfileUpdate()).toBeNull();
    expect(await db.identityMeta.count()).toBe(0);
  });

  it('clearing when nothing is stored is a no-op, not an error', async () => {
    await expect(savePendingProfileUpdate(null)).resolves.toBeUndefined();
  });

  it('survives the row being written by a different app version', async () => {
    // Unknown extra keys are dropped rather than replayed into updateProfile.
    await db.identityMeta.put({
      key: 'pendingProfileUpdate',
      value: JSON.stringify({ displayName: 'Ada', somethingNew: 42 }),
    });
    expect(await loadPendingProfileUpdate()).toEqual({ displayName: 'Ada' });
  });

  it('treats a corrupted row as "nothing pending" instead of throwing', async () => {
    // A malformed marker must not be replayed into updateProfile on every launch.
    await db.identityMeta.put({ key: 'pendingProfileUpdate', value: 'not json{{' });
    expect(await loadPendingProfileUpdate()).toBeNull();
  });

  it('treats a non-object row as "nothing pending"', async () => {
    await db.identityMeta.put({ key: 'pendingProfileUpdate', value: '["array"]' });
    expect(await loadPendingProfileUpdate()).toBeNull();
  });

  it('treats wrong-typed fields as "nothing pending"', async () => {
    await db.identityMeta.put({
      key: 'pendingProfileUpdate',
      value: JSON.stringify({ displayName: 12345 }),
    });
    expect(await loadPendingProfileUpdate()).toBeNull();
  });

  it('opens at schema v2 with the identityMeta store present', async () => {
    // The v2 migration is what creates identityMeta; if the version bump were
    // missing, every call above would fail with a NotFoundError instead.
    expect(db.verno).toBeGreaterThanOrEqual(2);
    expect(db.tables.map(t => t.name)).toContain('identityMeta');
  });

  it('keeps the v1 stores intact across the v2 upgrade', async () => {
    const names = db.tables.map(t => t.name);
    for (const expected of ['identity', 'documents', 'groups', 'peers']) {
      expect(names).toContain(expected);
    }
  });
});
