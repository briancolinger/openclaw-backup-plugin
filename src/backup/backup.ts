import { readFileSync } from 'node:fs';
import { access, rm, stat, writeFile } from 'node:fs/promises';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

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
import { isRecord, makeTmpDir } from '../utils.js';

import { createArchive } from './archive.js';
import { collectFiles } from './collector.js';
import { encryptFile, generateKey, getKeyId } from './encrypt.js';
import { acquireLock } from './lock.js';
import { generateManifest, serializeManifest } from './manifest.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

function readPluginVersion(): string {
  try {
    const pkgUrl = new URL('../../package.json', import.meta.url);
    const raw: unknown = JSON.parse(readFileSync(fileURLToPath(pkgUrl), 'utf8'));
    if (isRecord(raw) && typeof raw['version'] === 'string') {
      return raw['version'];
    }
  } catch (err) {
    console.warn(
      `openclaw-backup: could not read package.json version — using 0.0.0: ${err instanceof Error ? err.message : String(err)}`,
    );
  }
  return '0.0.0';
}

const PLUGIN_VERSION = readPluginVersion();

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function formatTimestamp(date: Date): string {
  return date.toISOString().slice(0, 19).replace(/:/g, '-');
}

function buildArchiveFilename(timestamp: string, encrypted: boolean): string {
  return encrypted ? `${timestamp}.tar.gz.age` : `${timestamp}.tar.gz`;
}

function buildManifestFilename(timestamp: string): string {
  return `${timestamp}.manifest.json`;
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
      `  IMPORTANT: Back up this key file! Without it you cannot restore encrypted backups.\n`,
  );
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

function buildManifestOptions(
  config: BackupConfig,
  includeTranscripts: boolean,
  includePersistor: boolean,
  keyId: string | undefined,
): ManifestOptions {
  const opts: ManifestOptions = {
    encrypted: config.encrypt,
    includeTranscripts,
    includePersistor,
    pluginVersion: PLUGIN_VERSION,
  };
  if (keyId !== undefined) {
    opts.keyId = keyId;
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

async function finalizeArchive(
  rawPath: string,
  rawName: string,
  timestamp: string,
  tmpDir: string,
  config: BackupConfig,
): Promise<{ archivePath: string; archiveName: string }> {
  if (!config.encrypt) {
    return { archivePath: rawPath, archiveName: rawName };
  }
  const encName = buildArchiveFilename(timestamp, true);
  const encPath = join(tmpDir, encName);
  await encryptFile(rawPath, encPath, config.encryptKeyPath);
  await rm(rawPath);
  return { archivePath: encPath, archiveName: encName };
}

async function performBackup(
  config: BackupConfig,
  options: BackupOptions,
  files: CollectedFile[],
  manifest: BackupManifest,
  timestamp: string,
  tmpDir: string,
): Promise<BackupResult> {
  const rawName = buildArchiveFilename(timestamp, false);
  const rawPath = join(tmpDir, rawName);
  await createArchive(files, manifest, rawPath);

  const { archivePath, archiveName } = await finalizeArchive(
    rawPath,
    rawName,
    timestamp,
    tmpDir,
    config,
  );

  const manifestFilename = buildManifestFilename(timestamp);
  const manifestPath = join(tmpDir, manifestFilename);
  await writeFile(manifestPath, serializeManifest(manifest), 'utf8');

  const providers = createStorageProviders(config, options.destination);
  const pushOps = providers.flatMap((p) => [
    p.push(archivePath, archiveName),
    p.push(manifestPath, manifestFilename),
  ]);
  const pushResults = await Promise.allSettled(pushOps);
  const pushErrors = pushResults
    .filter((r): r is PromiseRejectedResult => r.status === 'rejected')
    .map((r) => (r.reason instanceof Error ? r.reason.message : String(r.reason)));
  if (pushErrors.length > 0) {
    throw new Error(`Backup push failed: ${pushErrors.join('; ')}`);
  }

  const archiveStat = await stat(archivePath);
  return {
    timestamp: manifest.timestamp,
    archiveSize: archiveStat.size,
    fileCount: files.length,
    encrypted: config.encrypt,
    destinations: providers.map((p) => p.name),
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

/**
 * Runs a full backup: collects files, creates a compressed archive,
 * optionally encrypts it, and pushes it plus a sidecar manifest to all
 * configured destinations (or just the one named in options).
 * Acquires an exclusive lockfile to prevent concurrent backup runs.
 */
export async function runBackup(
  config: BackupConfig,
  options: BackupOptions,
): Promise<BackupResult> {
  await checkPrerequisites(config, options.destination);

  if (config.encrypt) {
    await ensureKeyExists(config.encryptKeyPath);
  }

  const includeTranscripts = options.includeTranscripts ?? config.includeTranscripts;
  const includePersistor = options.includePersistor ?? config.includePersistor;
  const effectiveConfig = buildEffectiveConfig(config, includeTranscripts, includePersistor);
  const files = await collectFiles(effectiveConfig);

  if (options.dryRun === true) {
    return handleDryRun(files, config.encrypt);
  }

  const lock = await acquireLock();
  try {
    const keyId = config.encrypt ? await getKeyId(config.encryptKeyPath) : undefined;
    const manifestOptions = buildManifestOptions(
      config,
      includeTranscripts,
      includePersistor,
      keyId,
    );
    const manifest = await generateManifest(files, manifestOptions);
    const timestamp = formatTimestamp(new Date(manifest.timestamp));

    const tmpDir = await makeTmpDir('openclaw-backup-');
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
