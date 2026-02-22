import { readFileSync } from 'node:fs';
import { access, mkdtemp, rm, stat, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { fileURLToPath } from 'node:url';

import { createStorageProviders } from '../storage/providers.js';
import { checkRcloneInstalled } from '../storage/rclone.js';
import {
  type BackupConfig,
  type BackupManifest,
  type BackupOptions,
  type BackupResult,
  type CollectedFile,
  type ManifestOptions,
} from '../types.js';
import { isRecord } from '../utils.js';

import { createArchive } from './archive.js';
import { collectFiles } from './collector.js';
import { checkAgeInstalled, encryptFile, generateKey, getKeyId } from './encrypt.js';
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
  } catch {
    // package.json unreadable at startup; fall through to default
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

function hasRemoteDestinations(config: BackupConfig, destination?: string): boolean {
  const entries =
    destination !== undefined
      ? Object.entries(config.destinations).filter(([n]) => n === destination)
      : Object.entries(config.destinations);
  return entries.some(([, dest]) => dest.remote !== undefined);
}

async function keyFileExists(keyPath: string): Promise<boolean> {
  return access(keyPath).then(
    () => true,
    () => false,
  );
}

async function checkPrerequisites(config: BackupConfig, destination?: string): Promise<void> {
  if (config.encrypt) {
    const check = await checkAgeInstalled();
    if (!check.available) {
      const hint = check.installHint ?? 'see age documentation';
      throw new Error(`age is not installed: ${check.error ?? 'unknown'}. Install with: ${hint}`);
    }
  }
  if (hasRemoteDestinations(config, destination)) {
    const check = await checkRcloneInstalled();
    if (!check.available) {
      const hint = check.installHint ?? 'see rclone documentation';
      throw new Error(
        `rclone is not installed: ${check.error ?? 'unknown'}. Install with: ${hint}`,
      );
    }
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
  for (const provider of providers) {
    await provider.push(archivePath, archiveName);
    await provider.push(manifestPath, manifestFilename);
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
 * Runs a full backup: collects files, creates a compressed archive,
 * optionally encrypts it, and pushes it plus a sidecar manifest to all
 * configured destinations (or just the one named in options).
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

  const keyId = config.encrypt ? await getKeyId(config.encryptKeyPath) : undefined;
  const manifestOptions = buildManifestOptions(config, includeTranscripts, includePersistor, keyId);
  const manifest = await generateManifest(files, manifestOptions);
  const timestamp = formatTimestamp(new Date(manifest.timestamp));

  const tmpDir = await mkdtemp(join(tmpdir(), 'openclaw-backup-'));
  try {
    return await performBackup(config, options, files, manifest, timestamp, tmpDir);
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch((err: unknown) => {
      console.warn(`openclaw-backup: failed to clean up ${tmpDir}: ${String(err)}`);
    });
  }
}
