import { access, readFile, rm, stat, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { notifyBackupFailure, notifyBackupSuccess } from '../notifications.js';
import { checkAllPrerequisites, formatPrerequisiteErrors } from '../prerequisites.js';
import { createStorageProviders } from '../storage/providers.js';
import {
  type BackupConfig,
  type BackupManifest,
  type BackupOptions,
  type BackupResult,
  type CollectedFile,
  type ManifestOptions,
} from '../types.js';
import { getHostname, isRecord, makeTmpDir, readOpenclawVersion } from '../utils.js';

import { createArchiveStreaming } from './archive-streaming.js';
import { collectFiles } from './collector.js';
import { verifyDiskSpace } from './disk-check.js';
import { generateKey, getKeyId } from './encrypt.js';
import { acquireLock } from './lock.js';
import { generateManifest, serializeManifest } from './manifest.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const OPENCLAW_VERSION = readOpenclawVersion();

let _pluginVersionPromise: Promise<string> | null = null;

async function getPluginVersion(): Promise<string> {
  _pluginVersionPromise ??= (async () => {
    try {
      const pkgUrl = new URL('../../package.json', import.meta.url);
      const raw: unknown = JSON.parse(await readFile(fileURLToPath(pkgUrl), 'utf8'));
      if (isRecord(raw) && typeof raw['version'] === 'string') {
        return raw['version'];
      }
    } catch (err) {
      console.warn(
        `openclaw-backup: could not read package.json version — using 0.0.0: ${err instanceof Error ? err.message : String(err)}`,
      );
    }
    return '0.0.0';
  })();
  return _pluginVersionPromise;
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, '-');
}

function buildArchiveFilename(hostname: string, timestamp: string, encrypted: boolean): string {
  return encrypted
    ? `${hostname}-${timestamp}.tar.gz.age`
    : `${hostname}-${timestamp}.tar.gz`;
}

function buildManifestFilename(hostname: string, timestamp: string): string {
  return `${hostname}-${timestamp}.manifest.json`;
}

async function keyFileExists(keyPath: string): Promise<boolean> {
  return access(keyPath).then(
    () => true,
    () => false,
  );
}

async function checkPrerequisites(config: BackupConfig, destination?: string): Promise<void> {
  const destinations =
    destination !== undefined
      ? Object.fromEntries(Object.entries(config.destinations).filter(([n]) => n === destination))
      : config.destinations;
  const scopedConfig: BackupConfig = {
    encrypt: config.encrypt,
    encryptKeyPath: config.encryptKeyPath,
    include: config.include,
    exclude: config.exclude,
    extraPaths: config.extraPaths,
    includeTranscripts: config.includeTranscripts,
    includePersistor: config.includePersistor,
    retention: config.retention,
    destinations,
  };
  if (config.schedule !== undefined) {
    scopedConfig.schedule = config.schedule;
  }
  const checks = await checkAllPrerequisites(scopedConfig);
  const errors = formatPrerequisiteErrors(checks);
  if (errors.length > 0) {
    throw new Error(errors);
  }
}

async function ensureKeyExists(keyPath: string): Promise<void> {
  const exists = await keyFileExists(keyPath);
  if (exists) {
    return;
  }
  const pubKey = await generateKey(keyPath);
  console.warn(
    `\nopenclaw-backup: Generated new age key at ${keyPath}\n` +
      `  Public key: ${pubKey}\n` +
      `  IMPORTANT: Back up this key file! Without it you cannot restore encrypted backups.\n` +
      `  The public key is also saved to ${keyPath.replace(/[^/]+$/, 'backup-pubkey.txt')}\n`,
  );
}

async function verifyKeyReadable(keyPath: string): Promise<void> {
  try {
    await access(keyPath);
  } catch {
    throw new Error(
      `Encryption key not found at ${keyPath}. Your encrypted backups cannot be ` +
        `created without this key. If you've lost it, existing encrypted backups are unrecoverable.`,
    );
  }
}

function buildEffectiveConfig(
  config: BackupConfig,
  includeTranscripts: boolean,
  includePersistor: boolean,
): BackupConfig {
  const effective: BackupConfig = {
    encrypt: config.encrypt,
    encryptKeyPath: config.encryptKeyPath,
    include: config.include,
    exclude: config.exclude,
    extraPaths: config.extraPaths,
    includeTranscripts,
    includePersistor,
    retention: config.retention,
    destinations: config.destinations,
  };
  if (config.schedule !== undefined) {
    effective.schedule = config.schedule;
  }
  return effective;
}

async function buildManifestOptions(
  config: BackupConfig,
  includeTranscripts: boolean,
  includePersistor: boolean,
  keyId: string | undefined,
): Promise<ManifestOptions> {
  const opts: ManifestOptions = {
    encrypted: config.encrypt,
    includeTranscripts,
    includePersistor,
    pluginVersion: await getPluginVersion(),
  };
  if (keyId !== undefined) {
    opts.keyId = keyId;
  }
  if (OPENCLAW_VERSION !== undefined) {
    opts.openclawVersion = OPENCLAW_VERSION;
  }
  return opts;
}

function handleDryRun(files: CollectedFile[], encrypted: boolean): BackupResult {
  const totalSize = files.reduce((acc, f) => acc + f.size, 0);
  console.warn(`openclaw-backup: dry run — ${files.length} files, ${totalSize} bytes`);
  for (const f of files) {
    console.warn(`  ${f.relativePath} (${f.size} bytes)`);
  }
  return {
    timestamp: new Date().toISOString(),
    archiveSize: 0,
    fileCount: files.length,
    encrypted,
    destinations: [],
    dryRun: true,
  };
}

async function performBackup(
  config: BackupConfig,
  options: BackupOptions,
  files: CollectedFile[],
  manifest: BackupManifest,
  timestamp: string,
  tmpDir: string,
): Promise<BackupResult> {
  const hostname = getHostname(config);
  const archiveName = buildArchiveFilename(hostname, timestamp, config.encrypt);
  const remoteArchiveName = `${hostname}/${archiveName}`;
  const archivePath = join(tmpDir, archiveName);

  await createArchiveStreaming(
    files,
    manifest,
    archivePath,
    config.encrypt ? config.encryptKeyPath : undefined,
  );

  const manifestFilename = buildManifestFilename(hostname, timestamp);
  const remoteManifestFilename = `${hostname}/${manifestFilename}`;
  const manifestPath = join(tmpDir, manifestFilename);
  await writeFile(manifestPath, serializeManifest(manifest), 'utf8');

  const providers = createStorageProviders(config, options.destination);

  // Check availability of each provider before pushing
  const checkResults = await Promise.all(
    providers.map(async (p) => ({ provider: p, check: await p.check() })),
  );

  const skippedDestinations: string[] = [];
  const availableProviders: typeof providers = [];
  for (const { provider, check } of checkResults) {
    if (check.available) {
      availableProviders.push(provider);
    } else {
      const reason = check.error ?? 'path not accessible';
      console.warn(`Skipping destination '${provider.name}': ${reason}`);
      skippedDestinations.push(provider.name);
    }
  }

  if (availableProviders.length === 0) {
    throw new Error(
      `No backup destinations available. Skipped: ${skippedDestinations.join(', ')}`,
    );
  }

  const providerPushResults = await Promise.allSettled(
    availableProviders.map(async (p) => {
      await p.push(archivePath, remoteArchiveName);
      await p.push(manifestPath, remoteManifestFilename);
      return p.name;
    }),
  );

  const succeededDestinations = providerPushResults
    .filter((r): r is PromiseFulfilledResult<string> => r.status === 'fulfilled')
    .map((r) => r.value);

  if (succeededDestinations.length === 0) {
    const pushErrors = providerPushResults
      .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
      .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
    throw new Error(`Backup push failed: ${pushErrors.join('; ')}`);
  }

  const archiveStat = await stat(archivePath);
  return {
    timestamp: manifest.timestamp,
    archiveSize: archiveStat.size,
    fileCount: files.length,
    encrypted: config.encrypt,
    destinations: succeededDestinations,
    ...(skippedDestinations.length > 0 && { skippedDestinations }),
    dryRun: false,
  };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a minimal safety backup before a destructive operation (e.g. restore).
 * Pushes to a single named destination using default options.
 */
export async function createSafetyBackup(
  config: BackupConfig,
  destination: string | undefined,
): Promise<void> {
  await runBackup(config, destination ? { destination } : {});
}

async function runBackupCore(config: BackupConfig, options: BackupOptions): Promise<BackupResult> {
  await checkPrerequisites(config, options.destination);

  if (config.encrypt) {
    await ensureKeyExists(config.encryptKeyPath);
    await verifyKeyReadable(config.encryptKeyPath);
  }

  const includeTranscripts = options.includeTranscripts ?? config.includeTranscripts;
  const includePersistor = options.includePersistor ?? config.includePersistor;
  const effectiveConfig = buildEffectiveConfig(config, includeTranscripts, includePersistor);
  const files = await collectFiles(effectiveConfig);

  if (options.dryRun === true) {
    return handleDryRun(files, config.encrypt);
  }

  await verifyDiskSpace(files, config);

  const lock = await acquireLock();
  try {
    const keyId = config.encrypt ? await getKeyId(config.encryptKeyPath) : undefined;
    const manifestOptions = await buildManifestOptions(
      config,
      includeTranscripts,
      includePersistor,
      keyId,
    );
    const manifest = await generateManifest(files, manifestOptions);
    const timestamp = formatTimestamp(new Date(manifest.timestamp));

    const tmpDir = await makeTmpDir('openclaw-backup-', config.tempDir);
    try {
      return await performBackup(config, options, files, manifest, timestamp, tmpDir);
    } finally {
      await rm(tmpDir, { recursive: true, force: true }).catch((err: unknown) => {
        console.warn(`openclaw-backup: failed to clean up ${tmpDir}: ${String(err)}`);
      });
    }
  } finally {
    await lock.release();
  }
}

/**
 * Runs a full backup: collects files, creates a compressed archive via the
 * system `tar` CLI (optionally piped through `age` for encryption), and pushes
 * the archive plus a sidecar manifest to all configured destinations.
 *
 * When encryption is enabled, the unencrypted bytes never touch the filesystem
 * — tar's stdout is piped directly to age's stdin.
 *
 * Acquires an exclusive lockfile to prevent concurrent backup runs.
 * Records outcome to ~/.openclaw/backup-last-result.json on both success and failure.
 */
export async function runBackup(
  config: BackupConfig,
  options: BackupOptions,
): Promise<BackupResult> {
  const openclawDir = join(homedir(), '.openclaw');
  try {
    const result = await runBackupCore(config, options);
    if (!result.dryRun) {
      await notifyBackupSuccess(config, result, openclawDir).catch((err: unknown) => {
        console.warn(`openclaw-backup: notification write failed: ${String(err)}`);
      });
    }
    return result;
  } catch (err) {
    await notifyBackupFailure(config, err, openclawDir).catch((notifyErr: unknown) => {
      console.warn(`openclaw-backup: notification write failed: ${String(notifyErr)}`);
    });
    throw err;
  }
}
