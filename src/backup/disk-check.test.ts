import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type BackupConfig, type CollectedFile } from '../types.js';
import { checkDiskSpace, verifyDiskSpace } from './disk-check.js';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const { mockStatfs, mockTmpdir } = vi.hoisted(() => ({
  mockStatfs: vi.fn(),
  mockTmpdir: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ statfs: mockStatfs }));
vi.mock('node:os', () => ({ tmpdir: mockTmpdir }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

function makeFiles(sizes: number[]): CollectedFile[] {
  return sizes.map((size, i) => ({
    absolutePath: `/home/user/file${i}.txt`,
    relativePath: `file${i}.txt`,
    size,
    modified: '2026-01-01T00:00:00.000Z',
  }));
}

interface ConfigOverrides {
  tempDir?: string;
  skipDiskCheck?: boolean;
}

function makeConfig(overrides: ConfigOverrides = {}): BackupConfig {
  const config: BackupConfig = {
    encrypt: false,
    encryptKeyPath: '/key',
    include: [],
    exclude: [],
    extraPaths: [],
    includeTranscripts: false,
    includePersistor: false,
    retention: { count: 10 },
    destinations: {},
  };
  if (overrides.tempDir !== undefined) config.tempDir = overrides.tempDir;
  if (overrides.skipDiskCheck !== undefined) config.skipDiskCheck = overrides.skipDiskCheck;
  return config;
}

// ---------------------------------------------------------------------------
// checkDiskSpace
// ---------------------------------------------------------------------------

describe('checkDiskSpace', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockTmpdir.mockReturnValue('/tmp');
  });

  it('should return sufficient: true when available space exceeds required', async () => {
    // bsize=1 so bavail == available bytes directly
    mockStatfs.mockResolvedValue({ bavail: 10 * 1024 * 1024, bsize: 1 }); // 10 MB

    const result = await checkDiskSpace(1024 * 1024); // need 1 MB
    expect(result.available).toBe(10 * 1024 * 1024);
    expect(result.sufficient).toBe(true);
  });

  it('should return sufficient: false when available space is below required', async () => {
    mockStatfs.mockResolvedValue({ bavail: 512 * 1024, bsize: 1 }); // 512 KB

    const result = await checkDiskSpace(1024 * 1024); // need 1 MB
    expect(result.available).toBe(512 * 1024);
    expect(result.sufficient).toBe(false);
  });

  it('should return sufficient: true when available exactly equals required', async () => {
    mockStatfs.mockResolvedValue({ bavail: 1024 * 1024, bsize: 1 }); // exactly 1 MB

    const result = await checkDiskSpace(1024 * 1024);
    expect(result.available).toBe(1024 * 1024);
    expect(result.sufficient).toBe(true);
  });

  it('should use os.tmpdir() as the default directory', async () => {
    mockStatfs.mockResolvedValue({ bavail: 1000, bsize: 1 });
    mockTmpdir.mockReturnValue('/custom/tmp');

    await checkDiskSpace(100);

    expect(mockStatfs).toHaveBeenCalledWith('/custom/tmp');
  });

  it('should use the provided directory when specified', async () => {
    mockStatfs.mockResolvedValue({ bavail: 1000, bsize: 1 });

    await checkDiskSpace(100, '/var/tmp');

    expect(mockStatfs).toHaveBeenCalledWith('/var/tmp');
  });

  it('should propagate errors from statfs', async () => {
    mockStatfs.mockRejectedValue(new Error('ENOENT: no such directory'));

    await expect(checkDiskSpace(1024, '/nonexistent')).rejects.toThrow('ENOENT');
  });

  it('should correctly multiply bavail by bsize', async () => {
    mockStatfs.mockResolvedValue({ bavail: 1000, bsize: 4096 }); // 4,096,000 bytes

    const result = await checkDiskSpace(1);
    expect(result.available).toBe(4096000);
  });
});

// ---------------------------------------------------------------------------
// verifyDiskSpace
// ---------------------------------------------------------------------------

describe('verifyDiskSpace', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockTmpdir.mockReturnValue('/tmp');
  });

  it('should resolve when there is sufficient disk space', async () => {
    // files: 500 + 500 = 1000 bytes; needed = 1000*2 + 100MB ≈ 105 MB
    // provide 200 MB — plenty
    mockStatfs.mockResolvedValue({ bavail: 200 * 1024 * 1024, bsize: 1 });

    await expect(verifyDiskSpace(makeFiles([500, 500]), makeConfig())).resolves.toBeUndefined();
  });

  it('should throw a clear error when disk space is insufficient', async () => {
    // files: 10MB; needed = 10*2 + 100 = 120MB; provide only 50MB
    mockStatfs.mockResolvedValue({ bavail: 50 * 1024 * 1024, bsize: 1 });

    await expect(
      verifyDiskSpace(makeFiles([10 * 1024 * 1024]), makeConfig()),
    ).rejects.toThrow('Insufficient disk space for backup. Need ~120MB, have 50MB on /tmp.');
  });

  it('should include the tempDir in the error message when configured', async () => {
    mockStatfs.mockResolvedValue({ bavail: 1, bsize: 1 });

    await expect(
      verifyDiskSpace(makeFiles([0]), makeConfig({ tempDir: '/mnt/fast-nvme/tmp' })),
    ).rejects.toThrow('have 0MB on /mnt/fast-nvme/tmp.');
  });

  it('should skip the check when skipDiskCheck is true', async () => {
    await expect(
      verifyDiskSpace(makeFiles([1024 * 1024 * 1024]), makeConfig({ skipDiskCheck: true })),
    ).resolves.toBeUndefined();

    expect(mockStatfs).not.toHaveBeenCalled();
  });

  it('should run the check when skipDiskCheck is false', async () => {
    mockStatfs.mockResolvedValue({ bavail: 200 * 1024 * 1024, bsize: 1 });

    await verifyDiskSpace(makeFiles([1000]), makeConfig({ skipDiskCheck: false }));

    expect(mockStatfs).toHaveBeenCalledOnce();
  });

  it('should use config.tempDir as the statfs path when set', async () => {
    mockStatfs.mockResolvedValue({ bavail: 200 * 1024 * 1024, bsize: 1 });

    await verifyDiskSpace(makeFiles([1000]), makeConfig({ tempDir: '/custom/tmp' }));

    expect(mockStatfs).toHaveBeenCalledWith('/custom/tmp');
  });

  it('should fall back to os.tmpdir() when tempDir is not configured', async () => {
    mockStatfs.mockResolvedValue({ bavail: 200 * 1024 * 1024, bsize: 1 });
    mockTmpdir.mockReturnValue('/system/tmp');

    await verifyDiskSpace(makeFiles([1000]), makeConfig());

    expect(mockStatfs).toHaveBeenCalledWith('/system/tmp');
  });
});
