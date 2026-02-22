import { statfs } from 'node:fs/promises';
import { tmpdir } from 'node:os';

import { type BackupConfig, type CollectedFile } from '../types.js';

/** 100 MB buffer added on top of estimated archive size */
const DISK_BUFFER_BYTES = 100 * 1024 * 1024;

export interface DiskCheckResult {
  /** Bytes available on the filesystem to unprivileged processes */
  available: number;
  /** Whether available space meets the requirement */
  sufficient: boolean;
}

/**
 * Returns the available disk space on the filesystem containing `dir`
 * (defaults to `os.tmpdir()`), and whether it satisfies `requiredBytes`.
 *
 * Uses `fs.statfs()` (Node 18.15+). `bavail` is the block count available
 * to unprivileged processes — more conservative than `bfree`.
 */
export async function checkDiskSpace(
  requiredBytes: number,
  dir?: string,
): Promise<DiskCheckResult> {
  const checkDir = dir ?? tmpdir();
  const stats = await statfs(checkDir);
  const available = stats.bavail * stats.bsize;
  return { available, sufficient: available >= requiredBytes };
}

/**
 * Pre-flight disk space check for a backup run.
 *
 * Estimates required space as: (sum of file sizes × 2) + 100 MB buffer.
 * The ×2 factor accounts for the unencrypted tar and the encrypted output
 * coexisting briefly on the same filesystem.
 *
 * No-ops when `config.skipDiskCheck` is `true` (useful for network mounts
 * or other environments where `statfs` reports unreliable numbers).
 *
 * Throws a user-facing error when insufficient space is detected.
 */
export async function verifyDiskSpace(
  files: CollectedFile[],
  config: BackupConfig,
): Promise<void> {
  if (config.skipDiskCheck === true) return;

  const totalSize = files.reduce((acc, f) => acc + f.size, 0);
  const needed = totalSize * 2 + DISK_BUFFER_BYTES;
  const checkDir = config.tempDir ?? tmpdir();

  const { available, sufficient } = await checkDiskSpace(needed, checkDir);
  if (sufficient) return;

  const neededMB = Math.ceil(needed / (1024 * 1024));
  const availMB = Math.floor(available / (1024 * 1024));
  throw new Error(
    `Insufficient disk space for backup. Need ~${neededMB}MB, ` +
      `have ${availMB}MB on ${checkDir}. Free up space or change temp directory.`,
  );
}
