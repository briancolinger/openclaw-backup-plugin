import { constants } from 'node:fs';
import { access, copyFile, mkdir, readdir, stat, unlink } from 'node:fs/promises';

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

// ---------------------------------------------------------------------------
// Factory
// ---------------------------------------------------------------------------

/**
 * Creates a local-filesystem StorageProvider that stores backups in a
 * single directory on disk.
 */
export function createLocalProvider(config: { path: string }): StorageProvider {
  return {
    name: 'local',

    async push(localPath: string, remoteName: string): Promise<void> {
      await mkdir(config.path, { recursive: true });
      const destPath = safePath(config.path, remoteName);
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
      let entries: string[];
      try {
        entries = await readdir(config.path);
      } catch (err) {
        throw wrapError(`List failed: cannot read directory ${config.path}`, err);
      }
      return sortNewestFirst(entries.filter((f) => BACKUP_FILE_RE.test(f)));
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
