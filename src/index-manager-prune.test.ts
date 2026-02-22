import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { invalidateCache, pruneBackups } from './index-manager.js';
import { type StorageProvider } from './types.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------
// All modules imported by index-manager.ts must be mocked even if the code
// paths under test don't exercise them directly (e.g. pruneBackups calls
// refreshIndex which calls mkdtemp, readFile, etc.).

const {
  mockUnlinkSync,
  mockMkdtemp,
  mockReadFile,
  mockWriteFile,
  mockMkdir,
  mockRm,
  mockHomedir,
  mockTmpdir,
} = vi.hoisted(() => ({
  mockUnlinkSync: vi.fn(),
  mockMkdtemp: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockRm: vi.fn(),
  mockHomedir: vi.fn(),
  mockTmpdir: vi.fn(),
}));

vi.mock('node:fs', () => ({ readFileSync: vi.fn(), unlinkSync: mockUnlinkSync }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: mockMkdtemp,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  rm: mockRm,
}));
vi.mock('node:os', () => ({ homedir: mockHomedir, tmpdir: mockTmpdir }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockProviderResult {
  provider: StorageProvider;
  listMock: Mock;
  deleteMock: Mock;
}

const makeProvider = (name: string): MockProviderResult => {
  const listMock = vi.fn().mockResolvedValue([]);
  const deleteMock = vi.fn().mockResolvedValue(undefined);
  const provider: StorageProvider = {
    name,
    list: listMock,
    pull: vi.fn().mockResolvedValue(undefined),
    push: vi.fn().mockResolvedValue(undefined),
    delete: deleteMock,
    check: vi.fn().mockResolvedValue({ available: true }),
  };
  return { provider, listMock, deleteMock };
};

const makeEnoent = (): Error & { code: string } =>
  Object.assign(new Error('ENOENT: no such file or directory'), { code: 'ENOENT' });

beforeEach(() => {
  vi.resetAllMocks();
  mockHomedir.mockReturnValue('/home/user');
  mockTmpdir.mockReturnValue('/tmp');
  mockMkdtemp.mockResolvedValue('/tmp/openclaw-index-abc');
  mockRm.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  mockUnlinkSync.mockReturnValue(undefined);
});

// ---------------------------------------------------------------------------
// invalidateCache
// ---------------------------------------------------------------------------

describe('invalidateCache', () => {
  it('should call unlinkSync with the default cache path', () => {
    invalidateCache();

    expect(mockUnlinkSync).toHaveBeenCalledWith('/home/user/.openclaw/backup-index.json');
  });

  it('should call unlinkSync with a custom path when provided', () => {
    invalidateCache('/custom/cache.json');

    expect(mockUnlinkSync).toHaveBeenCalledWith('/custom/cache.json');
  });

  it('should not throw when the cache file does not exist', () => {
    mockUnlinkSync.mockImplementation(() => {
      throw makeEnoent();
    });

    expect(() => {
      invalidateCache();
    }).not.toThrow();
  });

  it('should not throw for non-ENOENT unlink errors', () => {
    mockUnlinkSync.mockImplementation(() => {
      throw new Error('permission denied');
    });

    expect(() => {
      invalidateCache();
    }).not.toThrow();
  });
});

// ---------------------------------------------------------------------------
// pruneBackups
// ---------------------------------------------------------------------------

describe('pruneBackups', () => {
  it('should keep newest entries and delete the rest', async () => {
    const ts1 = { key: '2024-01-15T10-00-00', iso: '2024-01-15T10:00:00.000Z' };
    const ts2 = { key: '2024-01-14T10-00-00', iso: '2024-01-14T10:00:00.000Z' };
    const ts3 = { key: '2024-01-13T10-00-00', iso: '2024-01-13T10:00:00.000Z' };

    const { provider, listMock, deleteMock } = makeProvider('local');
    listMock.mockResolvedValue([
      `${ts1.key}.manifest.json`,
      `${ts2.key}.manifest.json`,
      `${ts3.key}.manifest.json`,
    ]);
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ timestamp: ts1.iso, encrypted: false, files: [] }))
      .mockResolvedValueOnce(JSON.stringify({ timestamp: ts2.iso, encrypted: false, files: [] }))
      .mockResolvedValueOnce(JSON.stringify({ timestamp: ts3.iso, encrypted: false, files: [] }));

    const result = await pruneBackups([provider], { count: 2 });

    expect(result.kept).toBe(2);
    expect(result.deleted).toBe(1);
    expect(result.errors).toHaveLength(0);
    // archive + manifest for the one deleted entry
    expect(deleteMock).toHaveBeenCalledTimes(2);
    expect(deleteMock).toHaveBeenCalledWith(`${ts3.key}.tar.gz`);
    expect(deleteMock).toHaveBeenCalledWith(`${ts3.key}.manifest.json`);
  });

  it('should return { deleted: 0, kept: 0, errors: [] } when index is empty', async () => {
    const { provider } = makeProvider('local');

    const result = await pruneBackups([provider], { count: 5 });

    expect(result).toEqual({ deleted: 0, kept: 0, errors: [] });
  });

  it('should collect errors when delete throws without aborting other deletions', async () => {
    const ts1 = { key: '2024-01-15T10-00-00', iso: '2024-01-15T10:00:00.000Z' };
    const ts2 = { key: '2024-01-14T10-00-00', iso: '2024-01-14T10:00:00.000Z' };

    const { provider, listMock, deleteMock } = makeProvider('local');
    listMock.mockResolvedValue([`${ts1.key}.manifest.json`, `${ts2.key}.manifest.json`]);
    mockReadFile
      .mockResolvedValueOnce(JSON.stringify({ timestamp: ts1.iso, encrypted: false, files: [] }))
      .mockResolvedValueOnce(JSON.stringify({ timestamp: ts2.iso, encrypted: false, files: [] }));
    deleteMock.mockRejectedValue(new Error('permission denied'));

    const result = await pruneBackups([provider], { count: 1 });

    expect(result.deleted).toBe(1);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toMatch(/permission denied/);
  });

  it('should invalidate the cache after pruning', async () => {
    const { provider } = makeProvider('local');

    await pruneBackups([provider], { count: 0 });

    expect(mockUnlinkSync).toHaveBeenCalledWith('/home/user/.openclaw/backup-index.json');
  });
});
