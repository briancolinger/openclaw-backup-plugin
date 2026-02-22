import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { describe, expect, it } from 'vitest';

import { isRecord, safePath } from './utils.js';

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
