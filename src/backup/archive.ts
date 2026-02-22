import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { create, extract } from 'tar';

import { type BackupManifest, type CollectedFile, MANIFEST_FILENAME } from '../types.js';
import { isRecord } from '../utils.js';

// ---------------------------------------------------------------------------
// Type guards
// ---------------------------------------------------------------------------

function isBackupManifest(value: unknown): value is BackupManifest {
  if (!isRecord(value)) {
    return false;
  }
  return (
    typeof value['schemaVersion'] === 'number' &&
    typeof value['pluginVersion'] === 'string' &&
    typeof value['hostname'] === 'string' &&
    typeof value['timestamp'] === 'string' &&
    typeof value['encrypted'] === 'boolean' &&
    typeof value['includeTranscripts'] === 'boolean' &&
    typeof value['includePersistor'] === 'boolean' &&
    Array.isArray(value['files'])
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function wrapError(context: string, err: unknown): Error {
  if (err instanceof Error) {
    return new Error(`${context}: ${err.message}`, { cause: err });
  }
  return new Error(`${context}: ${String(err)}`);
}

async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
    console.warn(`openclaw-backup: failed to remove temp dir ${dir}: ${String(err)}`);
  });
}

async function populateStagingDir(stagingDir: string, files: CollectedFile[]): Promise<void> {
  for (const file of files) {
    const dest = join(stagingDir, file.relativePath);
    await mkdir(dirname(dest), { recursive: true });
    await symlink(file.absolutePath, dest);
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a gzip-compressed tar archive at `outputPath` containing all
 * `files` (at their relative paths) plus the manifest as manifest.json.
 *
 * Files are staged via symlinks so they can come from different root
 * directories while preserving permissions and timestamps.
 */
export async function createArchive(
  files: CollectedFile[],
  manifest: BackupManifest,
  outputPath: string,
): Promise<void> {
  const stagingDir = await mkdtemp(join(tmpdir(), 'openclaw-archive-'));
  try {
    await populateStagingDir(stagingDir, files);
    await writeFile(
      join(stagingDir, MANIFEST_FILENAME),
      JSON.stringify(manifest, null, 2),
      'utf8',
    );
    await create({ file: outputPath, gzip: true, cwd: stagingDir, follow: true }, ['.']);
  } catch (err) {
    throw wrapError(`Failed to create archive at ${outputPath}`, err);
  } finally {
    await cleanupDir(stagingDir);
  }
}

/**
 * Extracts a tar.gz archive to `outputDir`, creating the directory if needed.
 */
export async function extractArchive(archivePath: string, outputDir: string): Promise<void> {
  let traversalError: Error | undefined;
  try {
    await mkdir(outputDir, { recursive: true });
    await extract({
      file: archivePath,
      cwd: outputDir,
      filter: (entryPath: string) => {
        if (entryPath.split('/').includes('..')) {
          traversalError = new Error(`Path traversal detected in archive entry: ${entryPath}`);
          return false;
        }
        return true;
      },
    });
    if (traversalError !== undefined) {
      throw traversalError;
    }
  } catch (err) {
    throw wrapError(`Failed to extract archive ${archivePath}`, err);
  }
}

/**
 * Reads and parses only manifest.json from a tar.gz archive without
 * extracting the rest of its contents.
 */
export async function readManifestFromArchive(archivePath: string): Promise<BackupManifest> {
  const stagingDir = await mkdtemp(join(tmpdir(), 'openclaw-manifest-'));
  try {
    await extract({
      file: archivePath,
      cwd: stagingDir,
      filter: (p) => p === MANIFEST_FILENAME || p === `./${MANIFEST_FILENAME}`,
    });
    const content = await readFile(join(stagingDir, MANIFEST_FILENAME), 'utf8').catch(
      () => null,
    );
    if (content == null) {
      throw new Error(`manifest.json not found in archive`);
    }
    const parsed: unknown = JSON.parse(content);
    if (!isBackupManifest(parsed)) {
      throw new Error(`Invalid manifest format in archive`);
    }
    return parsed;
  } catch (err) {
    throw wrapError(`Failed to read manifest from ${archivePath}`, err);
  } finally {
    await cleanupDir(stagingDir);
  }
}
