import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { getIndex, loadCachedIndex, refreshIndex } from './index-manager.js';
import { type StorageProvider } from './types.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const {
  mockReadFileSync,
  mockMkdtemp,
  mockReadFile,
  mockWriteFile,
  mockMkdir,
  mockRm,
  mockHomedir,
  mockTmpdir,
} = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockMkdtemp: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockRm: vi.fn(),
  mockHomedir: vi.fn(),
  mockTmpdir: vi.fn(),
}));

vi.mock('node:fs', () => ({ readFileSync: mockReadFileSync, unlinkSync: vi.fn() }));
vi.mock('node:fs/promises', () => ({
  mkdtemp: mockMkdtemp,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
  mkdir: mockMkdir,
  rm: mockRm,
}));
vi.mock('node:os', () => ({ homedir: mockHomedir, tmpdir: mockTmpdir }));

// ---------------------------------------------------------------------------
// Shared fixtures
// ---------------------------------------------------------------------------

const TS_KEY = '2024-01-15T10-30-00';
const TS_ISO = '2024-01-15T10:30:00.000Z';
const MANIFEST_FILE = `${TS_KEY}.manifest.json`;

const MANIFEST_JSON = JSON.stringify({
  timestamp: TS_ISO,
  encrypted: false,
  files: [{ path: 'a.txt', sha256: 'abc', size: 100, modified: TS_ISO }],
});

const CACHED_INDEX_JSON = JSON.stringify({
  lastRefreshed: TS_ISO,
  entries: [
    {
      timestamp: TS_ISO,
      filename: `${TS_KEY}.tar.gz`,
      providers: ['local'],
      encrypted: false,
      size: 100,
      fileCount: 1,
    },
  ],
});

// A fresh-timestamped index for getIndex TTL tests (avoids stale-cache refresh).
const FRESH_INDEX_JSON = JSON.stringify({
  lastRefreshed: new Date().toISOString(),
  entries: [
    {
      timestamp: TS_ISO,
      filename: `${TS_KEY}.tar.gz`,
      providers: ['local'],
      encrypted: false,
      size: 100,
      fileCount: 1,
    },
  ],
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface MockProviderResult {
  provider: StorageProvider;
  listMock: Mock;
  pullMock: Mock;
}

const REMOTE_INDEX_FILE = 'openclaw-index.json';

const makeProvider = (name: string): MockProviderResult => {
  const listMock = vi.fn().mockResolvedValue([]);
  // Reject the remote index pull by default so tests fall through to manifest scan.
  const pullMock = vi.fn().mockImplementation((remoteName: string) =>
    remoteName === REMOTE_INDEX_FILE
      ? Promise.reject(new Error('not found'))
      : Promise.resolve(undefined),
  );
  const provider: StorageProvider = {
    name,
    list: listMock,
    pull: pullMock,
    push: vi.fn().mockResolvedValue(undefined),
    delete: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue({ available: true }),
  };
  return { provider, listMock, pullMock };
};

beforeEach(() => {
  vi.resetAllMocks();
  mockHomedir.mockReturnValue('/home/user');
  mockTmpdir.mockReturnValue('/tmp');
  mockMkdtemp.mockResolvedValue('/tmp/openclaw-index-abc');
  mockRm.mockResolvedValue(undefined);
  mockMkdir.mockResolvedValue(undefined);
  mockWriteFile.mockResolvedValue(undefined);
  const enoent = Object.assign(new Error('ENOENT'), { code: 'ENOENT' });
  mockReadFileSync.mockImplementation(() => {
    throw enoent;
  });
});

// ---------------------------------------------------------------------------
// refreshIndex
// ---------------------------------------------------------------------------

describe('refreshIndex', () => {
  it('should return empty index when no providers are given', async () => {
    const index = await refreshIndex([]);
    expect(index.entries).toHaveLength(0);
    expect(typeof index.lastRefreshed).toBe('string');
  });

  it('should build a correct BackupEntry from a single manifest', async () => {
    const { provider, listMock } = makeProvider('local');
    listMock.mockResolvedValue([MANIFEST_FILE]);
    mockReadFile.mockResolvedValue(MANIFEST_JSON);

    const index = await refreshIndex([provider]);

    expect(index.entries).toHaveLength(1);
    const entry = index.entries[0];
    expect(entry?.timestamp).toBe(TS_ISO);
    expect(entry?.filename).toBe(`${TS_KEY}.tar.gz`);
    expect(entry?.providers).toEqual(['local']);
    expect(entry?.encrypted).toBe(false);
    expect(entry?.fileCount).toBe(1);
    expect(entry?.size).toBe(100);
  });

  it('should merge entries from two providers sharing the same timestamp', async () => {
    const { provider: p1, listMock: l1 } = makeProvider('local');
    const { provider: p2, listMock: l2 } = makeProvider('gdrive');
    l1.mockResolvedValue([MANIFEST_FILE]);
    l2.mockResolvedValue([MANIFEST_FILE]);
    mockReadFile.mockResolvedValue(MANIFEST_JSON);

    const index = await refreshIndex([p1, p2]);

    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.providers).toHaveLength(2);
    expect(index.entries[0]?.providers).toEqual(expect.arrayContaining(['local', 'gdrive']));
  });

  it('should sort entries newest first', async () => {
    const older = '2024-01-14T10-00-00';
    const newer = '2024-01-15T10-00-00';
    const { provider, listMock } = makeProvider('local');
    listMock.mockResolvedValue([`${older}.manifest.json`, `${newer}.manifest.json`]);
    mockReadFile
      .mockResolvedValueOnce(
        JSON.stringify({ timestamp: '2024-01-14T10:00:00.000Z', encrypted: false, files: [] }),
      )
      .mockResolvedValueOnce(
        JSON.stringify({ timestamp: '2024-01-15T10:00:00.000Z', encrypted: false, files: [] }),
      );

    const index = await refreshIndex([provider]);

    expect(index.entries[0]?.timestamp).toBe('2024-01-15T10:00:00.000Z');
    expect(index.entries[1]?.timestamp).toBe('2024-01-14T10:00:00.000Z');
  });

  it('should skip a provider gracefully when list() throws', async () => {
    const { provider, listMock } = makeProvider('broken');
    listMock.mockRejectedValue(new Error('network error'));

    const index = await refreshIndex([provider]);

    expect(index.entries).toHaveLength(0);
  });

  it('should skip a manifest gracefully when pull() throws', async () => {
    const { provider, listMock, pullMock } = makeProvider('local');
    listMock.mockResolvedValue([MANIFEST_FILE]);
    pullMock.mockRejectedValue(new Error('download failed'));

    const index = await refreshIndex([provider]);

    expect(index.entries).toHaveLength(0);
  });

  it('should skip a manifest gracefully when JSON is malformed', async () => {
    const { provider, listMock } = makeProvider('local');
    listMock.mockResolvedValue([MANIFEST_FILE]);
    mockReadFile.mockResolvedValue('{{{not json');

    const index = await refreshIndex([provider]);

    expect(index.entries).toHaveLength(0);
  });

  it('should use .tar.gz.age filename for encrypted manifests', async () => {
    const { provider, listMock } = makeProvider('local');
    listMock.mockResolvedValue([MANIFEST_FILE]);
    mockReadFile.mockResolvedValue(
      JSON.stringify({ timestamp: TS_ISO, encrypted: true, files: [] }),
    );

    const index = await refreshIndex([provider]);

    expect(index.entries[0]?.filename).toBe(`${TS_KEY}.tar.gz.age`);
  });

  it('should use remote index when present and skip manifest scan', async () => {
    const { provider, listMock, pullMock } = makeProvider('local');
    const remoteIndex = JSON.stringify({
      lastRefreshed: TS_ISO,
      entries: [
        {
          timestamp: TS_ISO,
          filename: `${TS_KEY}.tar.gz`,
          providers: ['local'],
          encrypted: false,
          size: 100,
          fileCount: 1,
        },
      ],
    });
    // Make pull succeed for remote index file; manifest pulls also succeed (but shouldn't happen)
    pullMock.mockResolvedValue(undefined);
    mockReadFile.mockResolvedValue(remoteIndex);

    const index = await refreshIndex([provider]);

    expect(index.entries).toHaveLength(1);
    expect(index.entries[0]?.filename).toBe(`${TS_KEY}.tar.gz`);
    // No manifest scan: list() should not have been called
    expect(listMock).not.toHaveBeenCalled();
  });
});

// ---------------------------------------------------------------------------
// loadCachedIndex
// ---------------------------------------------------------------------------

describe('loadCachedIndex', () => {
  it('should return parsed index when cache file exists', () => {
    mockReadFileSync.mockReturnValue(CACHED_INDEX_JSON);

    const result = loadCachedIndex('/custom/cache.json');

    expect(result).not.toBeNull();
    expect(result?.entries).toHaveLength(1);
    expect(result?.entries[0]?.timestamp).toBe(TS_ISO);
  });

  it('should return null when cache file does not exist (ENOENT)', () => {
    // Default beforeEach throws ENOENT
    expect(loadCachedIndex()).toBeNull();
  });

  it('should return null when cache file contains malformed JSON', () => {
    mockReadFileSync.mockReturnValue('{ bad json');

    expect(loadCachedIndex()).toBeNull();
  });

  it('should return null when cache does not match BackupIndex shape', () => {
    mockReadFileSync.mockReturnValue(JSON.stringify({ wrong: 'shape' }));

    expect(loadCachedIndex()).toBeNull();
  });

  it('should use the default path when no cachePath is given', () => {
    mockReadFileSync.mockReturnValue(CACHED_INDEX_JSON);
    loadCachedIndex();

    expect(mockReadFileSync).toHaveBeenCalledWith('/home/user/.openclaw/backup-index.json', 'utf8');
  });
});

// ---------------------------------------------------------------------------
// getIndex
// ---------------------------------------------------------------------------

describe('getIndex', () => {
  it('should return cached index when cache is fresh and forceRefresh is not set', async () => {
    mockReadFileSync.mockReturnValue(FRESH_INDEX_JSON);

    const result = await getIndex([]);

    expect(result.entries).toHaveLength(1);
    expect(mockMkdtemp).not.toHaveBeenCalled();
  });

  it('should call refreshIndex when forceRefresh is true even if cache is fresh', async () => {
    mockReadFileSync.mockReturnValue(FRESH_INDEX_JSON);

    await getIndex([], true);

    expect(mockMkdtemp).toHaveBeenCalled();
  });

  it('should call refreshIndex when no cache exists', async () => {
    // Default beforeEach: readFileSync throws ENOENT
    await getIndex([]);

    expect(mockMkdtemp).toHaveBeenCalled();
  });

  it('should call refreshIndex when cached index is older than the TTL', async () => {
    const staleIso = new Date(Date.now() - 6 * 60 * 1000).toISOString();
    mockReadFileSync.mockReturnValue(JSON.stringify({ lastRefreshed: staleIso, entries: [] }));

    await getIndex([]);

    expect(mockMkdtemp).toHaveBeenCalled();
  });
});
