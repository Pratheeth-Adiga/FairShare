import { beforeEach, describe, expect, it, vi } from 'vitest';

const nativePlatform = vi.hoisted(() => vi.fn());
const writeFile = vi.hoisted(() => vi.fn());
const share = vi.hoisted(() => vi.fn());

vi.mock('@capacitor/core', () => ({
  Capacitor: { isNativePlatform: nativePlatform },
}));

vi.mock('@capacitor/filesystem', () => ({
  Directory: { Cache: 'CACHE' },
  Encoding: { UTF8: 'utf8' },
  Filesystem: { writeFile },
}));

vi.mock('@capacitor/share', () => ({
  Share: { share },
}));

import { downloadTextFile, isShareCancel } from '@/lib/io/backup';

describe('downloadTextFile on a native platform', () => {
  beforeEach(() => {
    nativePlatform.mockReset();
    writeFile.mockReset();
    share.mockReset();
    nativePlatform.mockReturnValue(true);
    writeFile.mockResolvedValue({ uri: 'file:///cache/fairshare-identity.json' });
    share.mockResolvedValue({ activityType: '' });
  });

  it('writes the export as a UTF-8 cache file and opens the share sheet', async () => {
    await expect(downloadTextFile('fairshare-identity.json', '{"peerId":"p1"}', 'application/json'))
      .resolves.toBe('Export ready: fairshare-identity.json');

    expect(writeFile).toHaveBeenCalledWith({
      path: 'fairshare-identity.json',
      data: '{"peerId":"p1"}',
      directory: 'CACHE',
      encoding: 'utf8',
      recursive: true,
    });
    expect(share).toHaveBeenCalledWith({
      title: 'fairshare-identity.json',
      url: 'file:///cache/fairshare-identity.json',
      dialogTitle: 'Export FairShare file',
    });
  });

  it('rejects so the calling UI can show a failed export message', async () => {
    writeFile.mockRejectedValueOnce(new Error('Storage unavailable'));

    await expect(downloadTextFile('backup.json', '{}', 'application/json'))
      .rejects.toThrow('Storage unavailable');
    expect(share).not.toHaveBeenCalled();
    expect(isShareCancel(new Error('Storage unavailable'))).toBe(false);
  });

  it('passes the share sheet cancel through as a share cancel', async () => {
    share.mockRejectedValueOnce(new Error('Share canceled'));

    const err = await downloadTextFile('backup.json', '{}', 'application/json').catch(e => e);
    expect(err).toBeInstanceOf(Error);
    expect(isShareCancel(err)).toBe(true);
    expect(writeFile).toHaveBeenCalled();
  });

  it('keeps other share errors as real failures', async () => {
    share.mockRejectedValueOnce(new Error("Can't share while sharing is in progress"));

    const err = await downloadTextFile('backup.json', '{}', 'application/json').catch(e => e);
    expect(err.message).toBe("Can't share while sharing is in progress");
    expect(isShareCancel(err)).toBe(false);
  });

  it.each(['fairshare-identity-', 'fairshare-identity-backup-'])(
    'keeps .json when truncating a %s export with a full peer ID',
    async prefix => {
      const filename = `${prefix}peer-${'a'.repeat(64)}.json`;
      const path = filename.slice(0, 80) + '.json';
      writeFile.mockResolvedValueOnce({ uri: `file:///cache/${path}` });

      await expect(downloadTextFile(filename, '{}', 'application/json'))
        .resolves.toBe(`Export ready: ${path}`);
      expect(writeFile).toHaveBeenCalledWith(expect.objectContaining({ path }));
      expect(share).toHaveBeenCalledWith(expect.objectContaining({
        title: path,
        url: `file:///cache/${path}`,
      }));
    },
  );
});