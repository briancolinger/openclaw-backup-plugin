import { constants, type Dirent } from 'node:fs';
import { access, copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';
import { dirname, join } from 'node:path';

import { wrapError } from '../errors.js';
import { type ProviderCheckResult, type StorageProvider } from '../types.js';
import { safePath } from '../utils.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Matches the three backup file extensions we manage. */
const BACKUP_FILE_RE = /\.(?:tar\.gz|tar\.gz\.age|manifest\.json)$/;

function sortNewestFirst(names: string[]): string[] {
  return [...names].sort((a, b) => b.localeCompare(a));
}

/**
 * Lists all backup files in `dir`, returning only base filenames.
 * Returns [] if the directory does not exist.
 */
async function listBackupFilesIn(dir: string): Promise<string[]> {
  let entries: string[];
  try {
    entries = await readdir(dir);
  } catch {
    return [];
  }
  return entries.filter((f) => BACKUP_FILE_RE.test(f));
}

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a local-filesystem StorageProvider that stores backups under a
 * per-hostname subdirectory: `{path}/{hostname}/`. Old-format files at the
 * root of `{path}` are still discoverable for backward compatibility.
 */
export function createLocalProvider(config: { path: string; hostname: string }): StorageProvider {
  return {
    name: 'local',

    async push(localPath: string, remoteName: string): Promise<void> {
      const destPath = safePath(config.path, remoteName);
      await mkdir(dirname(destPath), { recursive: true });
      await copyFile(localPath, destPath);

      const [srcStat, destStat] = await Promise.all([stat(localPath), stat(destPath)]);
      if (srcStat.size !== destStat.size) {
        throw new Error(
          `Push verification failed for ${remoteName}: ` +
            `size mismatch (src=${srcStat.size}, dest=${destStat.size})`,
        );
      }
    },

    async pull(remoteName: string, localPath: string): Promise<void> {
      const srcPath = safePath(config.path, remoteName);
      try {
        await access(srcPath);
      } catch (err) {
        throw wrapError(`Pull failed: ${remoteName} not found in ${config.path}`, err);
      }
      await copyFile(srcPath, localPath);
    },

    async list(): Promise<string[]> {
      // New format: hostname subdir
      const hostnameDir = join(config.path, config.hostname);
      const hostedFiles = (await listBackupFilesIn(hostnameDir)).map(
        (f) => `${config.hostname}/${f}`,
      );

      // Old format: root-level files (backward compat — no subdir component)
      let rootFiles: string[] = [];
      try {
        const entries = await readdir(config.path);
        rootFiles = entries.filter((f) => BACKUP_FILE_RE.test(f));
      } catch (err) {
        throw wrapError(`List failed: cannot read directory ${config.path}`, err);
      }

      return sortNewestFirst([...hostedFiles, ...rootFiles]);
    },

    async listAll(): Promise<string[]> {
      let rootEntries: Dirent[];
      try {
        rootEntries = await readdir(config.path, { withFileTypes: true });
      } catch (err) {
        throw wrapError(`List failed: cannot read directory ${config.path}`, err);
      }

      const results: string[] = [];

      // Root-level files (old format, no hostname subdir)
      for (const entry of rootEntries) {
        if (entry.isFile() && BACKUP_FILE_RE.test(entry.name)) {
          results.push(entry.name);
        }
      }

      // Hostname subdir files (new format)
      for (const entry of rootEntries) {
        if (entry.isDirectory()) {
          const subFiles = await listBackupFilesIn(join(config.path, entry.name));
          for (const f of subFiles) {
            results.push(`${entry.name}/${f}`);
          }
        }
      }

      return sortNewestFirst(results);
    },

    async delete(remoteName: string): Promise<void> {
      const filePath = safePath(config.path, remoteName);
      try {
        await access(filePath);
      } catch (err) {
        throw wrapError(`Delete failed: ${remoteName} not found in ${config.path}`, err);
      }
      await unlink(filePath);
    },

    async check(): Promise<ProviderCheckResult> {
      try {
        await access(config.path, constants.W_OK);
        return { available: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { available: false, error: `Storage path not accessible: ${message}` };
      }
    },
  };
}
