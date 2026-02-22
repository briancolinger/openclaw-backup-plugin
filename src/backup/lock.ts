import { mkdir, open, readFile, rm } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join } from 'node:path';

import { isRecord } from '../utils.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const LOCK_STALE_MS = 30 * 60 * 1000; // 30 minutes — auto-expire after a crash

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

function getLockPath(): string {
  return join(homedir(), '.openclaw', '.backup.lock');
}

interface LockData {
  pid: number;
  startedAt: string;
}

function isLockData(v: unknown): v is LockData {
  return isRecord(v) && typeof v['pid'] === 'number' && typeof v['startedAt'] === 'string';
}

/**
 * Returns true if the given PID has a live process. EPERM means the process
 * exists but we cannot signal it (different user) — still counts as alive.
 * ESRCH means no such process — dead.
 */
function isPidAlive(pid: number): boolean {
  try {
    process.kill(pid, 0);
    return true;
  } catch (err) {
    if (isRecord(err) && err['code'] === 'EPERM') return true;
    return false;
  }
}

async function isLockStale(lockPath: string): Promise<boolean> {
  try {
    const raw: unknown = JSON.parse(await readFile(lockPath, 'utf8'));
    if (!isLockData(raw)) return true; // corrupt lock → treat as stale
    if (isPidAlive(raw.pid)) return false; // process is running → not stale
    return Date.now() - new Date(raw.startedAt).getTime() >= LOCK_STALE_MS;
  } catch {
    return true;
  }
}

async function writeLockFile(lockPath: string, content: string): Promise<void> {
  const fh = await open(lockPath, 'wx');
  await fh.writeFile(content, 'utf8');
  await fh.close();
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

export interface LockHandle {
  release(): Promise<void>;
}

/**
 * Acquires an exclusive lockfile at ~/.openclaw/.backup.lock.
 * Writes the current PID and timestamp. A lock is stale when its PID is dead
 * AND it is older than 30 minutes — it is then removed and the lock re-acquired.
 * If two processes race to recover a stale lock, the loser backs off with an
 * error rather than both acquiring the lock (TOCTOU-safe via EEXIST on retry).
 * Throws if another backup is actively running.
 */
export async function acquireLock(): Promise<LockHandle> {
  const lockPath = getLockPath();
  await mkdir(dirname(lockPath), { recursive: true });
  const content = JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() });

  try {
    await writeLockFile(lockPath, content);
  } catch (err) {
    if (!isRecord(err) || err['code'] !== 'EEXIST') {
      const msg = err instanceof Error ? err.message : String(err);
      throw new Error(`Cannot create backup lock at ${lockPath}: ${msg}`, { cause: err });
    }
    const stale = await isLockStale(lockPath);
    if (!stale) {
      throw new Error(
        `Another backup is already running. ` +
          `If not, delete ${lockPath} manually and retry.`,
      );
    }
    await rm(lockPath, { force: true });
    try {
      await writeLockFile(lockPath, content);
    } catch (retryErr) {
      if (isRecord(retryErr) && retryErr['code'] === 'EEXIST') {
        // Another process won the race after we removed the stale lock — back off.
        throw new Error(
          `Another backup is already running. ` +
            `If not, delete ${lockPath} manually and retry.`,
        );
      }
      const msg = retryErr instanceof Error ? retryErr.message : String(retryErr);
      throw new Error(`Cannot create backup lock at ${lockPath}: ${msg}`, { cause: retryErr });
    }
  }

  return {
    release: async (): Promise<void> => {
      await rm(lockPath, { force: true }).catch(() => undefined);
    },
  };
}
