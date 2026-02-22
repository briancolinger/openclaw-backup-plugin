import { chmod, mkdtemp } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

/**
 * Maps `items` through `fn` with at most `limit` promises in flight at once.
 * Preserves input order in the returned array.
 *
 * Use this instead of bare `Promise.all(items.map(fn))` whenever `items` could
 * be large enough to cause EMFILE (too many open file descriptors).
 */
export async function mapWithConcurrency<T, R>(
  items: readonly T[],
  limit: number,
  fn: (item: T) => Promise<R>,
): Promise<R[]> {
  if (items.length === 0) {
    return [];
  }
  let nextIndex = 0;
  const settled: Array<{ index: number; value: R }> = [];

  async function runWorker(): Promise<void> {
    for (;;) {
      const i = nextIndex;
      if (i >= items.length) break;
      nextIndex = i + 1;
      const item = items[i];
      if (item === undefined) break;
      const value = await fn(item);
      settled.push({ index: i, value });
    }
  }

  const workerCount = Math.min(limit, items.length);
  const workers: Array<Promise<void>> = [];
  for (let i = 0; i < workerCount; i++) {
    workers.push(runWorker());
  }
  await Promise.all(workers);
  settled.sort((a, b) => a.index - b.index);
  return settled.map(({ value }) => value);
}

/**
 * Returns true if `value` is a non-null, non-array object.
 * Shared type guard used across all modules.
 */
export function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Returns the sidecar manifest filename for a given archive filename.
 * Handles both `.tar.gz` and `.tar.gz.age` extensions.
 */
export function getSidecarName(archiveFilename: string): string {
  const base = archiveFilename.replace(/\.tar\.gz\.age$|\.tar\.gz$/, '');
  return `${base}.manifest.json`;
}

/**
 * Creates a temp directory with 0o700 permissions (owner-only).
 * Prevents other local users from reading decrypted archive contents or staged
 * files while they are in transit in /tmp.
 */
export async function makeTmpDir(prefix: string): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), prefix));
  await chmod(dir, 0o700);
  return dir;
}

/**
 * Relative path (from homedir) to the directory where retired age keys are
 * archived during key rotation. Shared between rotate.ts and restore.ts.
 */
export const RETIRED_KEYS_DIR = '.openclaw/.secrets/backup-keys';

/**
 * Resolves `relative` against `base` and verifies the result stays within
 * `base`. Throws if the resolved path escapes the base directory (path
 * traversal attempt).
 */
export function safePath(base: string, relative: string): string {
  const resolvedBase = resolve(base);
  const resolvedPath = resolve(base, relative);
  if (!resolvedPath.startsWith(resolvedBase + sep) && resolvedPath !== resolvedBase) {
    throw new Error(`Path traversal detected: "${relative}" escapes "${base}"`);
  }
  return resolvedPath;
}
