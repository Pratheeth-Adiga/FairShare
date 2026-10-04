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

import { downloadTextFile } from '@/lib/io/backup';

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
  });
});