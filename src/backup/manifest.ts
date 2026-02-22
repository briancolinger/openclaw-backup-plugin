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
import { isRecord, safePath } from '../utils.js';

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
  const manifestFiles = await Promise.all(files.map(buildManifestFile));

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

async function validateFile(
  file: ManifestFile,
  extractedDir: string,
  errors: string[],
): Promise<void> {
  let fullPath: string;
  try {
    fullPath = safePath(extractedDir, file.path);
  } catch {
    errors.push(`Rejected unsafe path for ${file.path}: path traversal detected`);
    return;
  }
  let computed: string;
  try {
    computed = await computeSha256(fullPath);
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);
    errors.push(`Cannot read ${file.path}: ${msg}`);
    return;
  }
  if (computed !== file.sha256) {
    errors.push(`Checksum mismatch for ${file.path}: expected ${file.sha256}, got ${computed}`);
  }
}

export async function validateManifest(
  manifest: BackupManifest,
  extractedDir: string,
): Promise<ValidationResult> {
  const errors: string[] = [];

  if (!SUPPORTED_SCHEMA_VERSIONS.has(manifest.schemaVersion)) {
    errors.push(`Unsupported schema version: ${manifest.schemaVersion}`);
    return { valid: false, errors };
  }

  await Promise.all(manifest.files.map((file) => validateFile(file, extractedDir, errors)));

  return { valid: errors.length === 0, errors };
}

export function serializeManifest(manifest: BackupManifest): string {
  return JSON.stringify(manifest, null, 2);
}

function isValidFileEntry(entry: unknown): boolean {
  if (!isRecord(entry)) {
    return false;
  }
  return (
    typeof entry['path'] === 'string' &&
    typeof entry['sha256'] === 'string' &&
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
