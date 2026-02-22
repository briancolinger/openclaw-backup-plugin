import { chmod, copyFile, mkdir, readdir, readFile, rm, stat } from 'node:fs/promises';
import { homedir } from 'node:os';
import { basename, dirname, join } from 'node:path';

import { extractArchive } from '../backup/archive.js';
import { createSafetyBackup } from '../backup/backup.js';
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
import { getSidecarName, makeTmpDir, readOpenclawVersion, RETIRED_KEYS_DIR, safePath } from '../utils.js';

import { checkVersionCompatibility } from './version-check.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Current OpenClaw version, resolved once at module load. May be undefined if not installed. */
const CURRENT_OPENCLAW_VERSION = readOpenclawVersion();

// ---------------------------------------------------------------------------
// Internal types
// ---------------------------------------------------------------------------

interface ArchiveRef {
  filename: string;
  encrypted: boolean;
}

interface PullResult {
  archivePath: string;
  sidecarManifest: BackupManifest | null;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function resolveByTimestamp(
  provider: StorageProvider,
  timestamp: string,
): Promise<ArchiveRef> {
  // Use listAll() so we search both hostname subdirs and old-format root files
  const files = await provider.listAll();
  const encFile = files.find((f) => f.endsWith('.tar.gz.age') && f.includes(timestamp));
  if (encFile !== undefined) {
    return { filename: encFile, encrypted: true };
  }
  const rawFile = files.find((f) => f.endsWith('.tar.gz') && !f.endsWith('.age') && f.includes(timestamp));
  if (rawFile !== undefined) {
    return { filename: rawFile, encrypted: false };
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
): Promise<PullResult> {
  // Use basename so the local temp file is a single component even when
  // ref.filename includes a hostname subdir (e.g. 'myhost/myhost-2024.tar.gz')
  const archivePath = join(tmpDir, basename(ref.filename));
  await provider.pull(ref.filename, archivePath);

  if (!ref.encrypted) {
    return { archivePath, sidecarManifest: null };
  }

  const sidecarRemoteName = getSidecarName(ref.filename);
  const sidecarPath = join(tmpDir, basename(sidecarRemoteName));
  await provider.pull(sidecarRemoteName, sidecarPath);
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
  return { archivePath: decryptedPath, sidecarManifest };
}

/**
 * Cross-checks the sidecar manifest (pulled before decryption) against the
 * manifest embedded in the archive (read after decryption). A mismatch in
 * timestamp or hostname indicates the sidecar may have been substituted.
 */
function verifySidecarConsistency(sidecar: BackupManifest, embedded: BackupManifest): void {
  if (sidecar.timestamp !== embedded.timestamp || sidecar.hostname !== embedded.hostname) {
    throw new Error(
      `Sidecar manifest does not match embedded manifest — archive may be tampered with. ` +
        `sidecar.timestamp=${sidecar.timestamp}, embedded.timestamp=${embedded.timestamp}`,
    );
  }
}

async function assertValidManifest(manifest: BackupManifest, extractedDir: string): Promise<void> {
  const result = await validateManifest(manifest, extractedDir);
  if (!result.valid) {
    const details = result.errors.join('\n  ');
    throw new Error(`Restore aborted: archive integrity check failed:\n  ${details}`);
  }
}

function printVersionWarning(manifest: BackupManifest, suppress: boolean): void {
  if (suppress) {
    return;
  }
  const result = checkVersionCompatibility(manifest.openclawVersion, CURRENT_OPENCLAW_VERSION);
  if (result.level !== 'ok') {
    console.warn(`openclaw-restore: ${result.message}`);
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
    // SECURITY: use safePath on both src and dest to prevent manifest-driven
    // path traversal. A malicious manifest could otherwise craft file.path
    // values that escape extractedDir or homedir().
    const srcPath = safePath(extractedDir, file.path);
    const destPath = safePath(homedir(), file.path);
    try {
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(srcPath, destPath);
      // Enforce owner-only permissions on restored files. copyFile does not
      // preserve permissions; strip group + other bits from the source mode.
      const { mode } = await stat(srcPath);
      await chmod(destPath, mode & 0o700);
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

/**
 * Finds the decryption key matching `keyId`. Checks the current key configured
 * in `config` first, then retired keys in ~/.openclaw/.secrets/backup-keys/.
 * Fast path: retired keys are named `${keyId}.age`, so that file is tried
 * directly before scanning the whole directory.
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

  // Fast path: keys are archived as ${keyId}.age — try that name first.
  // SECURITY: safePath prevents a crafted keyId (e.g. "../../../etc/passwd") from
  // escaping the retired keys directory.
  const candidatePath = safePath(retiredDir, `${keyId}.age`);
  const candidateId = await getKeyId(candidatePath).catch(() => null);
  if (candidateId === keyId) {
    return candidatePath;
  }

  // Slow path: scan all retired keys (covers non-standard filenames).
  const files = await readdir(retiredDir).catch(() => null);
  if (files === null) {
    return null;
  }

  for (const filename of files) {
    if (filename === `${keyId}.age`) {
      continue; // already checked in fast path
    }
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
  const allProviders = createStorageProviders(config);
  const provider = allProviders.find((p) => p.name === options.source);
  if (provider === undefined) {
    throw new Error(`No provider found for source "${options.source}"`);
  }

  const ref = await resolveEntry(provider, allProviders, options.timestamp);

  // SECURITY (M1): 0o700 prevents other local users from reading decrypted
  // archive contents while they are staged in the temp directory.
  const tmpDir = await makeTmpDir('openclaw-restore-');
  let preBackupCreated = false;

  try {
    const { archivePath, sidecarManifest } = await pullAndDecrypt(provider, ref, config, tmpDir);
    const extractedDir = join(tmpDir, 'extracted');
    await extractArchive(archivePath, extractedDir);

    const manifestContent = await readFile(join(extractedDir, MANIFEST_FILENAME), 'utf8');
    const manifest = deserializeManifest(manifestContent);

    // SECURITY (M3): cross-verify sidecar against embedded manifest to detect
    // substitution attacks where the sidecar was replaced to redirect key lookup.
    if (sidecarManifest !== null) {
      verifySidecarConsistency(sidecarManifest, manifest);
    }

    printVersionWarning(manifest, options.suppressVersionWarning === true);

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
      await createSafetyBackup(config, options.source);
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
