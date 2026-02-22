import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { createLocalProvider } from './local.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testDir: string;
let storageDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'openclaw-local-test-'));
  storageDir = join(testDir, 'storage');
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// push + pull
// ---------------------------------------------------------------------------

describe('push + pull round-trip', () => {
  it('should preserve file content through push and pull', async () => {
    const provider = createLocalProvider({ path: storageDir });
    const srcFile = join(testDir, 'source.tar.gz');
    await writeFile(srcFile, 'backup archive bytes', 'utf8');

    await provider.push(srcFile, 'backup.tar.gz');

    const destFile = join(testDir, 'restored.tar.gz');
    await provider.pull('backup.tar.gz', destFile);

    const content = await readFile(destFile, 'utf8');
    expect(content).toBe('backup archive bytes');
  });

  it('should create the storage directory on push if it does not exist', async () => {
    const nestedDir = join(storageDir, 'nested', 'deep');
    const provider = createLocalProvider({ path: nestedDir });
    const srcFile = join(testDir, 'source.tar.gz');
    await writeFile(srcFile, 'data', 'utf8');

    await expect(provider.push(srcFile, 'backup.tar.gz')).resolves.toBeUndefined();
  });

  it('should throw on pull when the remote file does not exist', async () => {
    await mkdir(storageDir, { recursive: true });
    const provider = createLocalProvider({ path: storageDir });
    const destFile = join(testDir, 'output.tar.gz');

    await expect(provider.pull('nonexistent.tar.gz', destFile)).rejects.toThrow('Pull failed');
  });
});

// ---------------------------------------------------------------------------
// list
// ---------------------------------------------------------------------------

describe('list', () => {
  it('should return backup files sorted newest-first by filename', async () => {
    await mkdir(storageDir, { recursive: true });
    const provider = createLocalProvider({ path: storageDir });

    const files = [
      'openclaw-2026-02-19.tar.gz',
      'openclaw-2026-02-21.tar.gz',
      'openclaw-2026-02-20.tar.gz',
    ];
    for (const f of files) {
      await writeFile(join(storageDir, f), 'data');
    }

    const result = await provider.list();
    expect(result).toEqual([
      'openclaw-2026-02-21.tar.gz',
      'openclaw-2026-02-20.tar.gz',
      'openclaw-2026-02-19.tar.gz',
    ]);
  });

  it('should only return .tar.gz, .tar.gz.age, and .manifest.json files', async () => {
    await mkdir(storageDir, { recursive: true });
    const provider = createLocalProvider({ path: storageDir });

    const allFiles = [
      'backup.tar.gz',
      'backup.tar.gz.age',
      'backup.manifest.json',
      'backup.txt',
      'backup.zip',
      'notes.json',
    ];
    for (const f of allFiles) {
      await writeFile(join(storageDir, f), 'data');
    }

    const result = await provider.list();
    expect(result).toContain('backup.tar.gz');
    expect(result).toContain('backup.tar.gz.age');
    expect(result).toContain('backup.manifest.json');
    expect(result).not.toContain('backup.txt');
    expect(result).not.toContain('backup.zip');
    expect(result).not.toContain('notes.json');
  });

  it('should return an empty array for an empty storage directory', async () => {
    await mkdir(storageDir, { recursive: true });
    const provider = createLocalProvider({ path: storageDir });

    const result = await provider.list();
    expect(result).toEqual([]);
  });

  it('should throw when the storage directory does not exist', async () => {
    const provider = createLocalProvider({ path: join(testDir, 'nonexistent') });

    await expect(provider.list()).rejects.toThrow('List failed');
  });
});

// ---------------------------------------------------------------------------
// delete
// ---------------------------------------------------------------------------

describe('delete', () => {
  it('should remove an existing file from storage', async () => {
    await mkdir(storageDir, { recursive: true });
    const provider = createLocalProvider({ path: storageDir });
    await writeFile(join(storageDir, 'backup.tar.gz'), 'data');

    await provider.delete('backup.tar.gz');

    const remaining = await provider.list();
    expect(remaining).not.toContain('backup.tar.gz');
  });

  it('should throw when deleting a file that does not exist', async () => {
    await mkdir(storageDir, { recursive: true });
    const provider = createLocalProvider({ path: storageDir });

    await expect(provider.delete('nonexistent.tar.gz')).rejects.toThrow('Delete failed');
  });
});

// ---------------------------------------------------------------------------
// check
// ---------------------------------------------------------------------------

describe('check', () => {
  it('should return available: true for a writable directory', async () => {
    await mkdir(storageDir, { recursive: true });
    const provider = createLocalProvider({ path: storageDir });

    const result = await provider.check();
    expect(result).toEqual({ available: true });
  });

  it('should return available: false with an error for a non-existent directory', async () => {
    const provider = createLocalProvider({ path: join(testDir, 'does-not-exist') });

    const result = await provider.check();
    expect(result.available).toBe(false);
    expect(result.error).toBeDefined();
    expect(typeof result.error).toBe('string');
  });
});
