/**
 * Integration test: full backup → restore pipeline using real I/O.
 *
 * Uses real archive, manifest, collector, and local storage modules.
 * The only mock is `homedir()` from `node:os`, redirected to a per-test temp
 * dir so the backup lock file and restore destination are isolated from the
 * real home directory.
 *
 * Architecture assumptions verified here:
 *  - collectFiles walks real filesystem and computes correct relative paths
 *  - generateManifest computes real SHA-256 checksums
 *  - createArchive produces a valid tar.gz containing files + manifest.json
 *  - local StorageProvider push/pull round-trips files byte-for-byte
 *  - extractArchive unpacks the archive and validates checksums
 *  - restoreFiles copies files to join(homedir(), relativePath)
 */

import { mkdir, mkdtemp, readdir, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { runRestore } from '../restore/restore.js';
import { type BackupConfig } from '../types.js';

import { runBackup } from './backup.js';

// ---------------------------------------------------------------------------
// Partial mock: replace homedir() with a controllable temp dir, keep the rest
// ---------------------------------------------------------------------------

// vi.mock() calls are hoisted by Vitest's transform to run before any import
// is evaluated, so this mock is active for every module that transitively
// imports 'node:os' — including backup.ts, lock.ts, restore.ts, and
// index-manager.ts. The static imports above already see the mock.

const { mockHomedir } = vi.hoisted(() => ({ mockHomedir: vi.fn() }));

vi.mock('node:os', async () => {
  const actual = await vi.importActual<typeof import('node:os')>('node:os');
  return { ...actual, homedir: mockHomedir };
});

// ---------------------------------------------------------------------------
// Test directories and cleanup
// ---------------------------------------------------------------------------

let srcDir: string;
let backupDir: string;
let mockHome: string;
let warnSpy: ReturnType<typeof vi.spyOn>;

beforeEach(async () => {
  srcDir = await mkdtemp(join(tmpdir(), 'openclaw-int-src-'));
  backupDir = await mkdtemp(join(tmpdir(), 'openclaw-int-bak-'));
  mockHome = await mkdtemp(join(tmpdir(), 'openclaw-int-home-'));
  mockHomedir.mockReturnValue(mockHome);
  // Suppress non-error console.warn output (key generation notices, cleanup notices)
  warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
});

afterEach(async () => {
  warnSpy.mockRestore();
  await rm(srcDir, { recursive: true, force: true });
  await rm(backupDir, { recursive: true, force: true });
  await rm(mockHome, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeConfig(include: string[]): BackupConfig {
  return {
    encrypt: false,
    encryptKeyPath: join(mockHome, '.openclaw', '.secrets', 'backup.age'),
    include,
    exclude: [],
    extraPaths: [],
    includeTranscripts: false,
    includePersistor: false,
    retention: { count: 10 },
    destinations: { local: { path: backupDir } },
  };
}

// ---------------------------------------------------------------------------
// Full backup → restore pipeline
// ---------------------------------------------------------------------------

describe('backup-restore integration', () => {
  it('should back up files and restore them with matching content', async () => {
    // --- Arrange: create source files ---
    const dataDir = join(srcDir, 'data');
    await mkdir(dataDir);
    await writeFile(join(dataDir, 'settings.json'), '{"theme":"dark","lang":"en"}', 'utf8');
    await writeFile(join(dataDir, 'notes.txt'), 'integration test note', 'utf8');

    const config = makeConfig([join(srcDir, 'data')]);

    // --- Act: run backup ---
    const backupResult = await runBackup(config, {});

    // --- Assert: backup metadata ---
    expect(backupResult.dryRun).toBe(false);
    expect(backupResult.fileCount).toBe(2);
    expect(backupResult.encrypted).toBe(false);
    expect(backupResult.destinations).toEqual(['local']);

    // --- Assert: archive and manifest files exist in backupDir ---
    const backupFiles = await readdir(backupDir);
    const archiveFile = backupFiles.find((f) => f.endsWith('.tar.gz'));
    const manifestFile = backupFiles.find((f) => f.endsWith('.manifest.json'));
    expect(archiveFile).toBeDefined();
    expect(manifestFile).toBeDefined();

    // --- Assert: sidecar manifest contains the correct file count ---
    const manifestJson = await readFile(join(backupDir, manifestFile!), 'utf8');
    const manifest = JSON.parse(manifestJson);
    expect(manifest.files).toHaveLength(2);
    expect(manifest.encrypted).toBe(false);

    // --- Act: run restore using the timestamp derived from the archive filename ---
    const timestamp = archiveFile!.replace('.tar.gz', '');
    const restoreResult = await runRestore(config, {
      source: 'local',
      timestamp,
      skipPreBackup: true,
    });

    // --- Assert: restore metadata ---
    expect(restoreResult.dryRun).toBe(false);
    expect(restoreResult.fileCount).toBe(2);
    expect(restoreResult.errors).toHaveLength(0);
    expect(restoreResult.preBackupCreated).toBe(false);

    // --- Assert: restored files match originals ---
    // relativePath = relative(dirname(include[0]), absolutePath)
    //              = relative(srcDir, join(srcDir, 'data', 'file'))
    //              = 'data/file'
    // destPath = join(homedir(), relativePath) = join(mockHome, 'data', 'file')
    const restoredSettings = await readFile(join(mockHome, 'data', 'settings.json'), 'utf8');
    expect(restoredSettings).toBe('{"theme":"dark","lang":"en"}');

    const restoredNotes = await readFile(join(mockHome, 'data', 'notes.txt'), 'utf8');
    expect(restoredNotes).toBe('integration test note');
  });

  it('should preserve nested directory structure through backup and restore', async () => {
    // --- Arrange ---
    const configDir = join(srcDir, 'config');
    const subDir = join(configDir, 'profiles', 'default');
    await mkdir(subDir, { recursive: true });
    await writeFile(join(subDir, 'profile.json'), '{"name":"default"}', 'utf8');
    await writeFile(join(configDir, 'global.json'), '{"version":1}', 'utf8');

    const config = makeConfig([join(srcDir, 'config')]);

    // --- Act ---
    await runBackup(config, {});
    const archiveFile = (await readdir(backupDir)).find((f) => f.endsWith('.tar.gz'));
    const timestamp = archiveFile!.replace('.tar.gz', '');

    await runRestore(config, { source: 'local', timestamp, skipPreBackup: true });

    // --- Assert: nested file restored correctly ---
    const restoredProfile = await readFile(
      join(mockHome, 'config', 'profiles', 'default', 'profile.json'),
      'utf8',
    );
    expect(restoredProfile).toBe('{"name":"default"}');

    const restoredGlobal = await readFile(join(mockHome, 'config', 'global.json'), 'utf8');
    expect(restoredGlobal).toBe('{"version":1}');
  });

  it('should not write any files when dryRun is true', async () => {
    // --- Arrange ---
    const dataDir = join(srcDir, 'data');
    await mkdir(dataDir);
    await writeFile(join(dataDir, 'file.txt'), 'dry run content', 'utf8');

    const config = makeConfig([join(srcDir, 'data')]);
    await runBackup(config, {});

    const archiveFile = (await readdir(backupDir)).find((f) => f.endsWith('.tar.gz'));
    const timestamp = archiveFile!.replace('.tar.gz', '');

    // --- Act ---
    const result = await runRestore(config, {
      source: 'local',
      timestamp,
      skipPreBackup: true,
      dryRun: true,
    });

    // --- Assert: dry-run result returned but no file created ---
    expect(result.dryRun).toBe(true);
    expect(result.fileCount).toBe(1);
    await expect(readFile(join(mockHome, 'data', 'file.txt'), 'utf8')).rejects.toThrow();
  });

  it('should produce an archive whose sidecar manifest has valid SHA-256 checksums', async () => {
    // --- Arrange ---
    const dataDir = join(srcDir, 'data');
    await mkdir(dataDir);
    await writeFile(join(dataDir, 'a.json'), '{"a":1}', 'utf8');
    await writeFile(join(dataDir, 'b.json'), '{"b":2}', 'utf8');
    await writeFile(join(dataDir, 'c.json'), '{"c":3}', 'utf8');

    const config = makeConfig([join(srcDir, 'data')]);

    // --- Act ---
    const backupResult = await runBackup(config, {});

    // --- Assert: sidecar manifest in backupDir has valid structure ---
    const backupFiles = await readdir(backupDir);
    const manifestFile = backupFiles.find((f) => f.endsWith('.manifest.json'));
    const manifestJson = await readFile(join(backupDir, manifestFile!), 'utf8');
    const manifest = JSON.parse(manifestJson);

    expect(manifest.timestamp).toBe(backupResult.timestamp);
    expect(manifest.schemaVersion).toBeGreaterThan(0);
    expect(manifest.files).toHaveLength(3);
    expect(
      manifest.files.every((f: { sha256: string }) => /^[0-9a-f]{64}$/.test(f.sha256)),
    ).toBe(true);
    expect(manifest.encrypted).toBe(false);
  });
});
