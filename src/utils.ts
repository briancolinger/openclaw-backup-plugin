import { resolve, sep } from 'node:path';

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
