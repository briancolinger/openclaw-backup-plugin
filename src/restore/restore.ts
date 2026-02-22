import { copyFile, mkdir, mkdtemp, readdir, readFile, rm } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { extractArchive } from '../backup/archive.js';
import { runBackup } from '../backup/backup.js';
import { decryptFile, getKeyId } from '../backup/encrypt.js';
import { deserializeManifest, validateManifest } from '../backup/manifest.js';
import { getIndex } from '../index-manager.js';
import { createStorageProviders } from '../storage/providers.js';
import {
  MANIFEST_FILENAME,
  type BackupConfig,
  type BackupManifest,
  type RestoreOptions,
  type RestoreResult,
  type StorageProvider,
} from '../types.js';
import { getSidecarName, safePath } from '../utils.js';

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ArchiveRef {
  filename: string;
  encrypted: boolean;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveByTimestamp(
  provider: StorageProvider,
  timestamp: string,
): Promise<ArchiveRef> {
  const files = await provider.list();
  const encName = `${timestamp}.tar.gz.age`;
  const rawName = `${timestamp}.tar.gz`;
  if (files.includes(encName)) {
    return { filename: encName, encrypted: true };
  }
  if (files.includes(rawName)) {
    return { filename: rawName, encrypted: false };
  }
  throw new Error(`No archive found for timestamp "${timestamp}" on provider "${provider.name}"`);
}

async function resolveLatestEntry(
  provider: StorageProvider,
  allProviders: StorageProvider[],
): Promise<ArchiveRef> {
  const index = await getIndex(allProviders);
  const entry = index.entries.find((e) => e.providers.includes(provider.name));
  if (entry === undefined) {
    throw new Error(`No backups found on provider "${provider.name}"`);
  }
  return { filename: entry.filename, encrypted: entry.encrypted };
}

async function resolveEntry(
  provider: StorageProvider,
  allProviders: StorageProvider[],
  timestamp: string | undefined,
): Promise<ArchiveRef> {
  if (timestamp !== undefined) {
    return resolveByTimestamp(provider, timestamp);
  }
  return resolveLatestEntry(provider, allProviders);
}

async function pullAndDecrypt(
  provider: StorageProvider,
  ref: ArchiveRef,
  config: BackupConfig,
  tmpDir: string,
): Promise<string> {
  const archivePath = join(tmpDir, ref.filename);
  await provider.pull(ref.filename, archivePath);

  if (!ref.encrypted) {
    return archivePath;
  }

  const sidecarName = getSidecarName(ref.filename);
  const sidecarPath = join(tmpDir, sidecarName);
  await provider.pull(sidecarName, sidecarPath);
  const sidecarContent = await readFile(sidecarPath, 'utf8');
  const sidecarManifest = deserializeManifest(sidecarContent);

  const keyId = sidecarManifest.keyId ?? '';
  const keyPath = await findDecryptionKey(keyId, config);
  if (keyPath === null) {
    throw new Error(
      `No decryption key found for keyId "${keyId}". ` +
        `Check ${config.encryptKeyPath} or ~/.openclaw/.secrets/backup-keys/`,
    );
  }

  const decryptedPath = archivePath.replace(/\.age$/, '');
  await decryptFile(archivePath, decryptedPath, keyPath);
  return decryptedPath;
}

async function assertValidManifest(manifest: BackupManifest, extractedDir: string): Promise<void> {
  const result = await validateManifest(manifest, extractedDir);
  if (!result.valid) {
    const details = result.errors.join('\n  ');
    throw new Error(`Restore aborted: archive integrity check failed:\n  ${details}`);
  }
}

function printDryRunInfo(manifest: BackupManifest): void {
  const totalSize = manifest.files.reduce((acc, f) => acc + f.size, 0);
  console.warn(`openclaw-restore: dry run — ${manifest.files.length} files, ${totalSize} bytes`);
  console.warn(`  timestamp: ${manifest.timestamp}  hostname: ${manifest.hostname}`);
  for (const f of manifest.files) {
    console.warn(`  ${f.path} (${f.size} bytes, modified ${f.modified})`);
  }
}

async function restoreFiles(manifest: BackupManifest, extractedDir: string): Promise<string[]> {
  const errors: string[] = [];
  for (const file of manifest.files) {
    const srcPath = join(extractedDir, file.path);
    const destPath = safePath(homedir(), file.path);
    try {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
    } catch (err) {
      const message = err instanceof Error ? err.message : String(err);
      errors.push(`Failed to restore ${file.path}: ${message}`);
      console.error(`openclaw-restore: failed to restore ${file.path}: ${message}`);
    }
  }
  return errors;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

const RETIRED_KEYS_DIR = '.openclaw/.secrets/backup-keys';

/**
 * Finds the decryption key matching `keyId`. Checks the current key configured
 * in `config` first, then retired keys in ~/.openclaw/.secrets/backup-keys/.
 * Returns the path to the matching key file, or null if none is found.
 */
export async function findDecryptionKey(
  keyId: string,
  config: BackupConfig,
): Promise<string | null> {
  const currentId = await getKeyId(config.encryptKeyPath).catch(() => null);
  if (currentId === keyId) {
    return config.encryptKeyPath;
  }

  const retiredDir = join(homedir(), RETIRED_KEYS_DIR);
  const files = await readdir(retiredDir).catch(() => null);
  if (files === null) {
    return null;
  }

  for (const filename of files) {
    const keyPath = join(retiredDir, filename);
    const retiredId = await getKeyId(keyPath).catch(() => null);
    if (retiredId === keyId) {
      return keyPath;
    }
  }

  return null;
}

/**
 * Orchestrates a full restore: pulls an archive from the specified source,
 * optionally decrypts it, validates checksums, and copies files back to their
 * original locations. Returns a RestoreResult summary.
 *
 * The restore is atomic-ish: all extraction and validation happen in a temp
 * dir before any real files are touched. Copy errors are collected rather than
 * aborting, so a partial restore is preferred over no restore.
 */
export async function runRestore(
  config: BackupConfig,
  options: RestoreOptions,
): Promise<RestoreResult> {
  const providers = createStorageProviders(config, options.source);
  const provider = providers[0];
  if (provider === undefined) {
    throw new Error(`No provider found for source "${options.source}"`);
  }

  const allProviders = createStorageProviders(config);
  const ref = await resolveEntry(provider, allProviders, options.timestamp);

  const tmpDir = await mkdtemp(join(tmpdir(), 'openclaw-restore-'));
  let preBackupCreated = false;

  try {
    const archivePath = await pullAndDecrypt(provider, ref, config, tmpDir);
    const extractedDir = join(tmpDir, 'extracted');
    await extractArchive(archivePath, extractedDir);

    const manifestContent = await readFile(join(extractedDir, MANIFEST_FILENAME), 'utf8');
    const manifest = deserializeManifest(manifestContent);

    await assertValidManifest(manifest, extractedDir);

    if (options.dryRun === true) {
      printDryRunInfo(manifest);
      return {
        timestamp: manifest.timestamp,
        fileCount: manifest.files.length,
        dryRun: true,
        preBackupCreated: false,
        errors: [],
      };
    }

    if (options.skipPreBackup !== true) {
      // Limit the pre-restore safety backup to the same provider being restored
      // from, rather than pushing to all destinations (which would be slow and
      // could spread potentially-in-progress state everywhere).
      await runBackup(config, { destination: options.source });
      preBackupCreated = true;
    }

    const errors = await restoreFiles(manifest, extractedDir);

    return {
      timestamp: manifest.timestamp,
      fileCount: manifest.files.length,
      dryRun: false,
      preBackupCreated,
      errors,
    };
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch((err: unknown) => {
      console.warn(`openclaw-restore: failed to clean up ${tmpDir}: ${String(err)}`);
    });
  }
}
