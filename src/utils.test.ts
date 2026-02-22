import { rm, stat } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { getSidecarName, isRecord, makeTmpDir, mapWithConcurrency, safePath } from './utils.js';

// ---------------------------------------------------------------------------
// mapWithConcurrency
// ---------------------------------------------------------------------------

describe('mapWithConcurrency', () => {
  it('should return an empty array for empty input', async () => {
    const result = await mapWithConcurrency([], 4, async (x: number) => x * 2);
    expect(result).toEqual([]);
  });

  it('should map all items and preserve order', async () => {
    const items = [1, 2, 3, 4, 5];
    const result = await mapWithConcurrency(items, 2, async (x) => x * 10);
    expect(result).toEqual([10, 20, 30, 40, 50]);
  });

  it('should not exceed the concurrency limit', async () => {
    let concurrent = 0;
    let maxConcurrent = 0;

    await mapWithConcurrency([1, 2, 3, 4, 5, 6], 3, async (x) => {
      concurrent++;
      maxConcurrent = Math.max(maxConcurrent, concurrent);
      await new Promise<void>((resolve) => setTimeout(resolve, 10));
      concurrent--;
      return x;
    });

    expect(maxConcurrent).toBeLessThanOrEqual(3);
  });

  it('should work when limit exceeds item count', async () => {
    const result = await mapWithConcurrency([7, 8], 100, async (x) => x + 1);
    expect(result).toEqual([8, 9]);
  });

  it('should propagate errors from the mapper function', async () => {
    await expect(
      mapWithConcurrency([1, 2, 3], 2, async (x) => {
        if (x === 2) throw new Error('boom');
        return x;
      }),
    ).rejects.toThrow('boom');
  });
});

// ---------------------------------------------------------------------------
// makeTmpDir
// ---------------------------------------------------------------------------

describe('makeTmpDir', () => {
  it('should create a directory that starts with the given prefix', async () => {
    const dir = await makeTmpDir('openclaw-test-');
    try {
      expect(dir).toContain('openclaw-test-');
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('should create the directory under the system temp path', async () => {
    const dir = await makeTmpDir('openclaw-tmp-');
    try {
      expect(dir.startsWith(tmpdir())).toBe(true);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });

  it('should create the directory with 0o700 permissions', async () => {
    const dir = await makeTmpDir('openclaw-perm-');
    try {
      const info = await stat(dir);
      expect(info.isDirectory()).toBe(true);
      expect(info.mode & 0o777).toBe(0o700);
    } finally {
      await rm(dir, { recursive: true, force: true });
    }
  });
});

// ---------------------------------------------------------------------------
// getSidecarName
// ---------------------------------------------------------------------------

describe('getSidecarName', () => {
  it('should strip .tar.gz and append .manifest.json', () => {
    expect(getSidecarName('2026-02-21T10-30-45.tar.gz')).toBe(
      '2026-02-21T10-30-45.manifest.json',
    );
  });

  it('should strip .tar.gz.age and append .manifest.json', () => {
    expect(getSidecarName('2026-02-21T10-30-45.tar.gz.age')).toBe(
      '2026-02-21T10-30-45.manifest.json',
    );
  });

  it('should prefer .tar.gz.age extension over .tar.gz when both could match', () => {
    // A name ending in .tar.gz.age should strip the full .tar.gz.age suffix
    expect(getSidecarName('backup.tar.gz.age')).toBe('backup.manifest.json');
  });

  it('should handle a filename with no recognised extension unchanged base', () => {
    // No .tar.gz or .tar.gz.age suffix — base is the full filename
    expect(getSidecarName('backup.zip')).toBe('backup.zip.manifest.json');
  });
});

// ---------------------------------------------------------------------------
// isRecord
// ---------------------------------------------------------------------------

describe('isRecord', () => {
  it('should return true for a plain object', () => {
    expect(isRecord({ a: 1 })).toBe(true);
  });

  it('should return false for null', () => {
    expect(isRecord(null)).toBe(false);
  });

  it('should return false for an array', () => {
    expect(isRecord([1, 2, 3])).toBe(false);
  });

  it('should return false for a string', () => {
    expect(isRecord('hello')).toBe(false);
  });

  it('should return false for a number', () => {
    expect(isRecord(42)).toBe(false);
  });

  it('should return false for undefined', () => {
    expect(isRecord(undefined)).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// safePath
// ---------------------------------------------------------------------------

describe('safePath', () => {
  const base = join(tmpdir(), 'safepath-test-base');

  it('should return resolved path for a safe relative name', () => {
    const result = safePath(base, 'backup.tar.gz');
    expect(result).toBe(resolve(base, 'backup.tar.gz'));
  });

  it('should return resolved path for a nested safe relative path', () => {
    const result = safePath(base, 'sub/dir/file.txt');
    expect(result).toBe(resolve(base, 'sub/dir/file.txt'));
  });

  it('should throw when remoteName contains ../ traversal', () => {
    expect(() => safePath(base, '../escape.txt')).toThrow('Path traversal detected');
  });

  it('should throw when remoteName is an absolute path outside base', () => {
    expect(() => safePath(base, '/etc/passwd')).toThrow('Path traversal detected');
  });

  it('should throw when deeply nested traversal escapes base', () => {
    expect(() => safePath(base, 'sub/../../escape.txt')).toThrow('Path traversal detected');
  });

  it('should throw when traversal reaches a sibling directory', () => {
    expect(() => safePath(base, '../sibling/file.txt')).toThrow('Path traversal detected');
  });

  it('should not allow a path that only shares a prefix with base directory name', () => {
    // base = /tmp/safepath-test-base
    // resolved would be /tmp/safepath-test-baseSuffix/file.txt — not a subdir of base
    const result = `..${sep}safepath-test-baseSuffix${sep}file.txt`;
    expect(() => safePath(base, result)).toThrow('Path traversal detected');
  });
});
