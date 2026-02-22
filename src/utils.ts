import { readFileSync } from 'node:fs';
import { chmod, mkdtemp } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { hostname as osHostname, tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';

import { type BackupConfig } from './types.js';

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
 *
 * `base` overrides the parent directory (defaults to `os.tmpdir()`).
 */
export async function makeTmpDir(prefix: string, base?: string): Promise<string> {
  const dir = await mkdtemp(join(base ?? tmpdir(), prefix));
  await chmod(dir, 0o700);
  return dir;
}

/**
 * Sanitizes a hostname for use in filenames and directory names.
 * Allows alphanumeric characters, hyphens, and dots; replaces everything else
 * with hyphens to prevent filesystem or injection issues.
 */
export function sanitizeHostname(name: string): string {
  return name.replace(/[^a-zA-Z0-9.\-]/g, '-');
}

/**
 * Returns the effective hostname for backup naming. Uses `config.hostname` if
 * set (useful for CI or container environments); falls back to `os.hostname()`.
 * Always sanitized for filesystem safety.
 */
export function getHostname(config: BackupConfig): string {
  return sanitizeHostname(config.hostname ?? osHostname());
}

/**
 * Reads the version string from the `openclaw` host package.json, if installed.
 * Returns undefined when openclaw is not present or the version cannot be read.
 * Failures are silently swallowed — this is best-effort metadata, not a hard requirement.
 */
export function readOpenclawVersion(): string | undefined {
  try {
    const require = createRequire(import.meta.url);
    const pkgPath: string = require.resolve('openclaw/package.json');
    const raw: unknown = JSON.parse(readFileSync(pkgPath, 'utf8'));
    if (isRecord(raw) && typeof raw['version'] === 'string') {
      return raw['version'];
    }
  } catch {
    // openclaw not installed or package.json unavailable — not an error
  }
  return undefined;
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
