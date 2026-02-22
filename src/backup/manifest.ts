import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import { hostname } from 'node:os';

import {
  type BackupManifest,
  type CollectedFile,
  type ManifestFile,
  type ManifestOptions,
  type ValidationResult,
  MANIFEST_SCHEMA_VERSION,
} from '../types.js';
import { isRecord, mapWithConcurrency, safePath } from '../utils.js';

/** Maximum concurrent sha256 reads during manifest generation or validation. */
const FILE_IO_CONCURRENCY = 16;

async function computeSha256(filePath: string): Promise<string> {
  const data = await readFile(filePath);
  return createHash('sha256').update(data).digest('hex');
}

async function buildManifestFile(file: CollectedFile): Promise<ManifestFile> {
  const sha256 = await computeSha256(file.absolutePath);
  return {
    path: file.relativePath,
    sha256,
    size: file.size,
    modified: file.modified,
  };
}

export async function generateManifest(
  files: CollectedFile[],
  options: ManifestOptions,
): Promise<BackupManifest> {
  const manifestFiles = await mapWithConcurrency(files, FILE_IO_CONCURRENCY, buildManifestFile);

  const manifest: BackupManifest = {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    pluginVersion: options.pluginVersion,
    hostname: hostname(),
    timestamp: new Date().toISOString(),
    encrypted: options.encrypted,
    includeTranscripts: options.includeTranscripts,
    includePersistor: options.includePersistor,
    files: manifestFiles,
  };

  if (options.keyId !== undefined) {
    manifest.keyId = options.keyId;
  }
  if (options.openclawVersion !== undefined) {
    manifest.openclawVersion = options.openclawVersion;
  }
  if (options.persistorExport !== undefined) {
    manifest.persistorExport = options.persistorExport;
  }

  return manifest;
}

const SUPPORTED_SCHEMA_VERSIONS = new Set([MANIFEST_SCHEMA_VERSION]);

async function validateFile(file: ManifestFile, extractedDir: string): Promise<string[]> {
  let fullPath: string;
  try {
    fullPath = safePath(extractedDir, file.path);
  } catch {
    return [`Rejected unsafe path for ${file.path}: path traversal detected`];
  }
  let computed: string;
  try {
    computed = await computeSha256(fullPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    return [`Cannot read ${file.path}: ${msg}`];
  }
  if (computed !== file.sha256) {
    return [`Checksum mismatch for ${file.path}: expected ${file.sha256}, got ${computed}`];
  }
  return [];
}

export async function validateManifest(
  manifest: BackupManifest,
  extractedDir: string,
): Promise<ValidationResult> {
  if (!SUPPORTED_SCHEMA_VERSIONS.has(manifest.schemaVersion)) {
    return { valid: false, errors: [`Unsupported schema version: ${manifest.schemaVersion}`] };
  }

  const fileErrors = await mapWithConcurrency(
    manifest.files,
    FILE_IO_CONCURRENCY,
    (file) => validateFile(file, extractedDir),
  );
  const errors = fileErrors.flat();
  return { valid: errors.length === 0, errors };
}

export function serializeManifest(manifest: BackupManifest): string {
  return JSON.stringify(manifest, null, 2);
}

function isValidFileEntry(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  const sha256 = entry['sha256'];
  return (
    typeof entry['path'] === 'string' &&
    typeof sha256 === 'string' &&
    /^[0-9a-f]{64}$/.test(sha256) &&
    typeof entry['size'] === 'number' &&
    typeof entry['modified'] === 'string'
  );
}

export function isValidManifestShape(value: unknown): value is BackupManifest {
  if (!isRecord(value)) {
    return false;
  }
  if (
    !(
      typeof value['schemaVersion'] === 'number' &&
      typeof value['pluginVersion'] === 'string' &&
      typeof value['hostname'] === 'string' &&
      typeof value['timestamp'] === 'string' &&
      typeof value['encrypted'] === 'boolean' &&
      typeof value['includeTranscripts'] === 'boolean' &&
      typeof value['includePersistor'] === 'boolean'
    )
  ) {
    return false;
  }
  const keyId = value['keyId'];
  if (keyId !== undefined && typeof keyId !== 'string') {
    return false;
  }
  const openclawVersion = value['openclawVersion'];
  if (openclawVersion !== undefined && typeof openclawVersion !== 'string') {
    return false;
  }
  const files = value['files'];
  if (!Array.isArray(files)) {
    return false;
  }
  return files.every(isValidFileEntry);
}

export function deserializeManifest(json: string): BackupManifest {
  let parsed: unknown;
  try {
    parsed = JSON.parse(json);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    throw new Error(`Failed to parse manifest JSON: ${msg}`, { cause: err });
  }

  if (!isValidManifestShape(parsed)) {
    throw new Error('Invalid manifest: missing or malformed required fields');
  }

  return parsed;
}
