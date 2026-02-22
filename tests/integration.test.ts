/**
 * Integration test: full backup → list → restore → prune cycle.
 *
 * Uses real filesystem I/O (no fs mocks). Encryption and rclone are both
 * disabled so no external tools are required in CI.
 *
 * homedir() is redirected to an isolated temp directory so the test never
 * touches the real home directory.
 */
import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterAll, beforeAll, describe, expect, it, vi } from 'vitest';

import { runBackup } from '../src/backup/backup.js';
import { createStorageProviders } from '../src/storage/providers.js';
import { refreshIndex } from '../src/index-manager.js';
import { pruneBackups } from '../src/index-prune.js';
import { runRestore } from '../src/restore/restore.js';
import { type BackupConfig } from '../src/types.js';

// ---------------------------------------------------------------------------
// Redirect homedir() to a temp directory so nothing touches the real home.
// fakeHome is set in beforeAll; the closure captures it by reference so
// homedir() returns the correct path when the production code calls it.
// ---------------------------------------------------------------------------

let fakeHome = '';

vi.mock('node:os', async (importOriginal) => {
  const actual = await importOriginal<typeof import('node:os')>();
  return { ...actual, homedir: () => fakeHome };
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Mirrors the formatTimestamp helper in backup.ts. */
function formatTimestamp(isoTs: string): string {
  return isoTs.slice(0, 19).replace(/:/g, '-');
}

// ---------------------------------------------------------------------------
// Test suite
// ---------------------------------------------------------------------------

describe('backup → list → restore → prune (local storage, no encryption)', () => {
  let rootDir: string;
  let storageDir: string;
  let settingsPath: string;
  let configPath: string;

  beforeAll(async () => {
    rootDir = await mkdtemp(join(tmpdir(), 'openclaw-integration-'));
    fakeHome = join(rootDir, 'home');
    storageDir = join(rootDir, 'storage');

    await mkdir(join(fakeHome, '.openclaw'), { recursive: true });
    await mkdir(storageDir, { recursive: true });

    settingsPath = join(fakeHome, '.openclaw', 'settings.json');
    configPath = join(fakeHome, '.openclaw', 'config.json');

    await writeFile(settingsPath, JSON.stringify({ theme: 'dark' }), 'utf8');
    await writeFile(configPath, JSON.stringify({ version: 1 }), 'utf8');
  });

  afterAll(async () => {
    await rm(rootDir, { recursive: true, force: true });
  });

  function makeConfig(): BackupConfig {
    return {
      encrypt: false,
      encryptKeyPath: join(fakeHome, '.openclaw', '.secrets', 'backup.age'),
      include: [join(fakeHome, '.openclaw')],
      exclude: [],
      extraPaths: [],
      includeTranscripts: false,
      includePersistor: false,
      retention: { count: 3 },
      destinations: { local: { path: storageDir } },
    };
  }

  it(
    'should run backup, list, restore, and prune without errors',
    async () => {
      const config = makeConfig();

      // -----------------------------------------------------------------------
      // Step 1: Run backup — archive + manifest sidecar must appear in storage
      // -----------------------------------------------------------------------

      const backupResult = await runBackup(config, {});

      expect(backupResult.dryRun).toBe(false);
      expect(backupResult.encrypted).toBe(false);
      expect(backupResult.fileCount).toBe(2);
      expect(backupResult.archiveSize).toBeGreaterThan(0);
      expect(backupResult.destinations).toEqual(['local']);

      const storedFiles = await readdir(storageDir);
      expect(storedFiles.filter((f) => f.endsWith('.tar.gz'))).toHaveLength(1);
      expect(storedFiles.filter((f) => f.endsWith('.manifest.json'))).toHaveLength(1);

      // -----------------------------------------------------------------------
      // Step 2: Build backup index — entry must reflect the correct metadata
      // -----------------------------------------------------------------------

      const providers = createStorageProviders(config);
      const index = await refreshIndex(providers);

      expect(index.entries).toHaveLength(1);
      const entry = index.entries[0]!;
      expect(entry.encrypted).toBe(false);
      expect(entry.fileCount).toBe(2);
      expect(entry.providers).toContain('local');
      expect(entry.timestamp).toBe(backupResult.timestamp);

      // -----------------------------------------------------------------------
      // Step 3: Mutate a source file so we can tell restore worked
      // -----------------------------------------------------------------------

      await writeFile(
        settingsPath,
        JSON.stringify({ theme: 'light', modified: true }),
        'utf8',
      );
      expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toMatchObject({ theme: 'light' });

      // -----------------------------------------------------------------------
      // Step 4: Restore — skip pre-backup to keep the test self-contained
      // -----------------------------------------------------------------------

      const restoreResult = await runRestore(config, {
        source: 'local',
        timestamp: formatTimestamp(backupResult.timestamp),
        skipPreBackup: true,
      });

      expect(restoreResult.dryRun).toBe(false);
      expect(restoreResult.fileCount).toBe(2);
      expect(restoreResult.errors).toHaveLength(0);
      expect(restoreResult.preBackupCreated).toBe(false);
      expect(restoreResult.timestamp).toBe(backupResult.timestamp);

      // -----------------------------------------------------------------------
      // Step 5: Verify manifest checksums passed and content was restored
      //         (zero errors means all checksums matched before copying)
      // -----------------------------------------------------------------------

      expect(JSON.parse(await readFile(settingsPath, 'utf8'))).toEqual({ theme: 'dark' });
      expect(JSON.parse(await readFile(configPath, 'utf8'))).toEqual({ version: 1 });

      // -----------------------------------------------------------------------
      // Step 6: Prune with keep=0 — all backups must be removed from storage
      // -----------------------------------------------------------------------

      const pruneResult = await pruneBackups(providers, { count: 0 });

      expect(pruneResult.deleted).toBe(1);
      expect(pruneResult.kept).toBe(0);
      expect(pruneResult.errors).toHaveLength(0);

      const filesAfterPrune = await readdir(storageDir);
      expect(filesAfterPrune.filter((f) => f.endsWith('.tar.gz'))).toHaveLength(0);
      expect(filesAfterPrune.filter((f) => f.endsWith('.manifest.json'))).toHaveLength(0);
    },
    30_000,
  );
});
