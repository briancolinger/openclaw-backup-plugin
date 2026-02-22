import { lstat, mkdir, mkdtemp, readFile, realpath, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { create, extract } from 'tar';

import { wrapError } from '../errors.js';
import { type BackupManifest, type CollectedFile, MANIFEST_FILENAME } from '../types.js';
import { safePath } from '../utils.js';

import { isValidManifestShape } from './manifest.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum time (ms) allowed for a tar create operation (5 minutes). */
const TAR_CREATE_TIMEOUT_MS = 5 * 60 * 1000;

/** Maximum time (ms) allowed for a tar extract operation (2 minutes). */
const TAR_EXTRACT_TIMEOUT_MS = 2 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function cleanupDir(dir: string): Promise<void> {
  await rm(dir, { recursive: true, force: true }).catch((err: unknown) => {
    console.warn(`openclaw-backup: failed to remove temp dir ${dir}: ${String(err)}`);
  });
}

/**
 * Races `promise` against a timeout. Rejects with a descriptive error if the
 * timeout fires first. Always clears the timer when the promise settles.
 */
function withTimeout<T>(promise: Promise<T>, ms: number, label: string): Promise<T> {
  return new Promise<T>((resolve, reject) => {
    const timer = setTimeout(() => {
      reject(new Error(`${label} timed out after ${Math.round(ms / 1000)}s`));
    }, ms);
    void promise.then(
      (val) => {
        clearTimeout(timer);
        resolve(val);
      },
      (err: unknown) => {
        clearTimeout(timer);
        reject(err);
      },
    );
  });
}

/**
 * Creates symlinks in `stagingDir` pointing to each file's real absolute path.
 * Uses `lstat` to detect symlinks in the source list; if a source file is
 * itself a symlink, follows it to the true target via `realpath` before
 * creating the staging symlink. This prevents TOCTOU symlink substitution
 * between collection time and archive time.
 */
async function populateStagingDir(stagingDir: string, files: CollectedFile[]): Promise<void> {
  for (const file of files) {
    const dest = join(stagingDir, file.relativePath);
    await mkdir(dirname(dest), { recursive: true });
    const stat = await lstat(file.absolutePath);
    const srcPath = stat.isSymbolicLink()
      ? await realpath(file.absolutePath)
      : file.absolutePath;
    await symlink(srcPath, dest);
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
    await writeFile(join(stagingDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8');
    await withTimeout(
      create({ file: outputPath, gzip: true, cwd: stagingDir, follow: true }, ['.']),
      TAR_CREATE_TIMEOUT_MS,
      'Archive creation',
    );
  } catch (err) {
    throw wrapError(`Failed to create archive at ${outputPath}`, err);
  } finally {
    await cleanupDir(stagingDir);
  }
}

/**
 * Extracts a tar.gz archive to `outputDir`, creating the directory if needed.
 * Rejects any archive entry whose resolved path would escape `outputDir`.
 */
export async function extractArchive(archivePath: string, outputDir: string): Promise<void> {
  try {
    await mkdir(outputDir, { recursive: true });
    await withTimeout(
      extract({
        file: archivePath,
        cwd: outputDir,
        filter: (entryPath: string) => {
          try {
            safePath(outputDir, entryPath);
          } catch {
            throw new Error(`Path traversal detected in archive entry: ${entryPath}`);
          }
          return true;
        },
      }),
      TAR_EXTRACT_TIMEOUT_MS,
      'Archive extraction',
    );
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
    await withTimeout(
      extract({
        file: archivePath,
        cwd: stagingDir,
        filter: (p) => p === MANIFEST_FILENAME || p === `./${MANIFEST_FILENAME}`,
      }),
      TAR_EXTRACT_TIMEOUT_MS,
      'Manifest extraction',
    );
    const content = await readFile(join(stagingDir, MANIFEST_FILENAME), 'utf8').catch(() => null);
    if (content == null) {
      throw new Error(`manifest.json not found in archive`);
    }
    const parsed: unknown = JSON.parse(content);
    if (!isValidManifestShape(parsed)) {
      throw new Error(`Invalid manifest format in archive`);
    }
    return parsed;
  } catch (err) {
    throw wrapError(`Failed to read manifest from ${archivePath}`, err);
  } finally {
    await cleanupDir(stagingDir);
  }
}
