import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type BackupConfig } from '../types.js';

import { collectFiles } from './collector.js';

// vi.hoisted runs before vi.mock factories, making these available to them.
const { mockReaddir, mockLstat, mockStat, mockRealpath } = vi.hoisted(() => ({
  mockReaddir: vi.fn(),
  mockLstat: vi.fn(),
  mockStat: vi.fn(),
  mockRealpath: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readdir: mockReaddir,
  lstat: mockLstat,
  stat: mockStat,
  realpath: mockRealpath,
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

interface MockDirent {
  name: string;
  isFile: () => boolean;
  isDirectory: () => boolean;
  isSymbolicLink: () => boolean;
}

interface MockStat {
  size: number;
  mtime: Date;
  isDirectory: () => boolean;
  isFile: () => boolean;
}

const makeDirent = (name: string, type: 'file' | 'dir' | 'symlink'): MockDirent => ({
  name,
  isFile: () => type === 'file',
  isDirectory: () => type === 'dir',
  isSymbolicLink: () => type === 'symlink',
});

const makeStat = (size = 1024, mtime = new Date('2025-01-01T00:00:00.000Z')): MockStat => ({
  size,
  mtime,
  isDirectory: () => false,
  isFile: () => true,
});

const makeDirStat = (): MockStat => ({
  size: 4096,
  mtime: new Date('2025-01-01T00:00:00.000Z'),
  isDirectory: () => true,
  isFile: () => false,
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const ROOT = '/home/user/.openclaw';

const BASE_CONFIG: BackupConfig = {
  encrypt: false,
  encryptKeyPath: '/home/user/.openclaw/.secrets/backup.age',
  include: [ROOT],
  exclude: [],
  extraPaths: [],
  includeTranscripts: false,
  includePersistor: false,
  retention: { count: 168 },
  destinations: {},
};

beforeEach(() => {
  vi.resetAllMocks();
  mockRealpath.mockImplementation((p: string) => Promise.resolve(p));
});

// ---------------------------------------------------------------------------
// Normal collection
// ---------------------------------------------------------------------------

describe('collectFiles — normal collection', () => {
  it('should collect files recursively and set correct relative paths', async () => {
    mockReaddir.mockImplementation((dir: string) => {
      if (dir === ROOT) {
        return Promise.resolve([makeDirent('config.json', 'file'), makeDirent('data', 'dir')]);
      }
      if (dir === `${ROOT}/data`) {
        return Promise.resolve([makeDirent('record.db', 'file')]);
      }
      return Promise.resolve([]);
    });
    mockLstat.mockResolvedValue(makeStat(512, new Date('2025-06-01T12:00:00.000Z')));

    const result = await collectFiles(BASE_CONFIG);

    expect(result).toHaveLength(2);
    expect(result[0]).toMatchObject({
      absolutePath: `${ROOT}/config.json`,
      relativePath: '.openclaw/config.json',
      size: 512,
      modified: '2025-06-01T12:00:00.000Z',
    });
    expect(result[1]).toMatchObject({
      absolutePath: `${ROOT}/data/record.db`,
      relativePath: '.openclaw/data/record.db',
    });
  });

  it('should return an empty array when directories are empty', async () => {
    mockReaddir.mockResolvedValue([]);
    const result = await collectFiles(BASE_CONFIG);
    expect(result).toEqual([]);
  });

  it('should collect files from extraPaths in addition to include', async () => {
    const config = { ...BASE_CONFIG, extraPaths: ['/home/user/notes'] };
    mockReaddir.mockImplementation((dir: string) => {
      if (dir === ROOT) {
        return Promise.resolve([makeDirent('cfg.json', 'file')]);
      }
      if (dir === '/home/user/notes') {
        return Promise.resolve([makeDirent('note.txt', 'file')]);
      }
      return Promise.resolve([]);
    });
    mockLstat.mockResolvedValue(makeStat());

    const result = await collectFiles(config);
    const paths = result.map((f) => f.absolutePath);
    expect(paths).toContain(`${ROOT}/cfg.json`);
    expect(paths).toContain('/home/user/notes/note.txt');
  });
});

// ---------------------------------------------------------------------------
// Exclusions
// ---------------------------------------------------------------------------

describe('collectFiles — exclusions', () => {
  it('should exclude directories and their contents when path matches exactly', async () => {
    const config = { ...BASE_CONFIG, exclude: [`${ROOT}/logs`] };
    mockReaddir.mockResolvedValue([makeDirent('notes.txt', 'file'), makeDirent('logs', 'dir')]);
    mockLstat.mockResolvedValue(makeStat());

    const result = await collectFiles(config);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ absolutePath: `${ROOT}/notes.txt` });
  });

  it('should exclude files matching wildcard glob patterns', async () => {
    const config = { ...BASE_CONFIG, exclude: ['*.bak*'] };
    mockReaddir.mockResolvedValue([
      makeDirent('notes.txt', 'file'),
      makeDirent('data.bak', 'file'),
      makeDirent('data.bak2', 'file'),
    ]);
    mockLstat.mockResolvedValue(makeStat());

    const result = await collectFiles(config);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ absolutePath: `${ROOT}/notes.txt` });
  });

  it("should collect .jsonl files regardless of includeTranscripts (filtering is the backup layer's concern)", async () => {
    mockReaddir.mockResolvedValue([
      makeDirent('session.jsonl', 'file'),
      makeDirent('config.json', 'file'),
    ]);
    mockLstat.mockResolvedValue(makeStat());

    const result = await collectFiles(BASE_CONFIG);
    expect(result).toHaveLength(2);
    const paths = result.map((f) => f.absolutePath);
    expect(paths).toContain(`${ROOT}/session.jsonl`);
    expect(paths).toContain(`${ROOT}/config.json`);
  });

  it('should include .jsonl files when includeTranscripts is true', async () => {
    const config = { ...BASE_CONFIG, includeTranscripts: true };
    mockReaddir.mockResolvedValue([
      makeDirent('session.jsonl', 'file'),
      makeDirent('config.json', 'file'),
    ]);
    mockLstat.mockResolvedValue(makeStat());

    const result = await collectFiles(config);
    expect(result).toHaveLength(2);
  });
});

// ---------------------------------------------------------------------------
// Permission errors
// ---------------------------------------------------------------------------

describe('collectFiles — permission errors', () => {
  it("should warn and skip files that cannot be stat'd due to permission errors", async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockReaddir.mockResolvedValue([
      makeDirent('open.txt', 'file'),
      makeDirent('private.txt', 'file'),
    ]);
    const permError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockLstat.mockResolvedValueOnce(makeStat()).mockRejectedValueOnce(permError);

    const result = await collectFiles(BASE_CONFIG);
    expect(result).toHaveLength(1);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
    warnSpy.mockRestore();
  });

  it('should warn and skip directories that cannot be read due to permission errors', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const permError = Object.assign(new Error('EACCES'), { code: 'EACCES' });
    mockReaddir
      .mockResolvedValueOnce([makeDirent('locked', 'dir'), makeDirent('open.txt', 'file')])
      .mockRejectedValueOnce(permError);
    mockLstat.mockResolvedValue(makeStat());

    const result = await collectFiles(BASE_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({ absolutePath: `${ROOT}/open.txt` });
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('permission denied'));
    warnSpy.mockRestore();
  });
});

// ---------------------------------------------------------------------------
// Symlinks
// ---------------------------------------------------------------------------

describe('collectFiles — symlinks', () => {
  it('should include symlinks to files with stats from the link target', async () => {
    mockReaddir.mockResolvedValue([makeDirent('link.txt', 'symlink')]);
    mockStat.mockResolvedValue(makeStat(2048, new Date('2025-03-01T00:00:00.000Z')));

    const result = await collectFiles(BASE_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      absolutePath: `${ROOT}/link.txt`,
      size: 2048,
      modified: '2025-03-01T00:00:00.000Z',
    });
  });

  it('should recurse into symlinked directories', async () => {
    mockRealpath.mockImplementation((p: string) => {
      if (p === `${ROOT}/linked-dir`) {
        return Promise.resolve('/real/dir');
      }
      return Promise.resolve(p);
    });
    mockReaddir
      .mockResolvedValueOnce([makeDirent('linked-dir', 'symlink')])
      .mockResolvedValueOnce([makeDirent('inner.txt', 'file')]);
    mockStat.mockResolvedValue(makeDirStat());
    mockLstat.mockResolvedValue(makeStat());

    const result = await collectFiles(BASE_CONFIG);
    expect(result).toHaveLength(1);
    expect(result[0]).toMatchObject({
      absolutePath: `${ROOT}/linked-dir/inner.txt`,
    });
  });

  it('should detect and silently skip circular symlinks', async () => {
    mockRealpath.mockImplementation((p: string) => {
      if (p === `${ROOT}/cycle`) {
        return Promise.resolve('/real/other');
      }
      if (p === `${ROOT}/cycle/back`) {
        return Promise.resolve(ROOT);
      }
      return Promise.resolve(p);
    });
    mockReaddir
      .mockResolvedValueOnce([makeDirent('cycle', 'symlink')])
      .mockResolvedValueOnce([makeDirent('back', 'symlink')]);
    mockStat.mockResolvedValue(makeDirStat());

    const result = await collectFiles(BASE_CONFIG);
    expect(result).toEqual([]);
  });

  it('should warn and skip broken symlinks', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    mockReaddir.mockResolvedValue([makeDirent('broken', 'symlink')]);
    mockStat.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    const result = await collectFiles(BASE_CONFIG);
    expect(result).toEqual([]);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('broken symlink'));
    warnSpy.mockRestore();
  });
});
