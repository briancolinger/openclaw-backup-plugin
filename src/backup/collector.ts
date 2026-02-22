import { lstat as fsLstat, readdir, realpath, stat as fsStat } from 'node:fs/promises';
import { dirname, join, relative } from 'node:path';

import { wrapError } from '../errors.js';
import { type BackupConfig, type CollectedFile } from '../types.js';

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && 'code' in err;
}

/**
 * Returns true when `filename` matches a simple glob `pattern`.
 *
 * **Supported**: `*` — matches any sequence of characters (including none).
 * **Not supported**: `?` (single-char wildcard) and `**` (recursive wildcard)
 * are treated as literal characters or collapsed into a single `*`. Users
 * expecting shell-style `**` glob semantics should be aware of this limitation.
 *
 * Uses a linear-time split-and-scan algorithm to avoid ReDoS from user-supplied
 * patterns. Throws if the pattern exceeds 500 characters.
 */
export function globMatch(pattern: string, filename: string): boolean {
  if (pattern.length > 500) {
    throw new Error(`Glob pattern too long: ${pattern.length} chars`);
  }
  // Collapse consecutive wildcards, then split on '*'.
  const parts = pattern.replace(/\*+/g, '*').split('*');
  if (parts.length === 1) {
    return pattern === filename;
  }
  const first = parts[0] ?? '';
  const last = parts[parts.length - 1] ?? '';
  if (!filename.startsWith(first)) return false;
  if (last !== '' && !filename.endsWith(last)) return false;
  if (filename.length < first.length + last.length) return false;
  let pos = first.length;
  const end = filename.length - last.length;
  for (let i = 1; i < parts.length - 1; i++) {
    const seg = parts[i] ?? '';
    const found = filename.indexOf(seg, pos);
    if (found === -1 || found + seg.length > end) return false;
    pos = found + seg.length;
  }
  return true;
}

function isExcluded(absolutePath: string, name: string, excludePatterns: string[]): boolean {
  for (const pattern of excludePatterns) {
    if (pattern.includes('*')) {
      if (globMatch(pattern, name)) {
        return true;
      }
    } else if (pattern.includes('/')) {
      // Absolute or relative path pattern — match against full path
      if (absolutePath === pattern || absolutePath.startsWith(`${pattern}/`)) {
        return true;
      }
    } else {
      // Bare directory/file name — match against any path component
      if (name === pattern) {
        return true;
      }
    }
  }
  return false;
}

async function addFile(
  absolutePath: string,
  rootParent: string,
  results: CollectedFile[],
): Promise<void> {
  try {
    const s = await fsLstat(absolutePath);
    results.push({
      absolutePath,
      relativePath: relative(rootParent, absolutePath),
      size: s.size,
      modified: s.mtime.toISOString(),
    });
  } catch (err) {
    if (isNodeError(err) && (err.code === 'EACCES' || err.code === 'EPERM')) {
      console.warn(`openclaw-backup: skipping ${absolutePath} (permission denied)`);
      return;
    }
    throw wrapError(`Failed to stat ${absolutePath}`, err);
  }
}

async function processSymlink(
  absolutePath: string,
  rootParent: string,
  excludePatterns: string[],
  visited: Set<string>,
  results: CollectedFile[],
): Promise<void> {
  const target = await fsStat(absolutePath).catch((err: unknown) => {
    if (isNodeError(err) && err.code === 'ENOENT') {
      return null;
    }
    throw wrapError(`Failed to stat symlink target ${absolutePath}`, err);
  });
  if (target === null) {
    console.warn(`openclaw-backup: skipping ${absolutePath} (broken symlink)`);
    return;
  }
  if (target.isDirectory()) {
    await walkDir(absolutePath, rootParent, excludePatterns, visited, results);
  } else if (target.isFile()) {
    results.push({
      absolutePath,
      relativePath: relative(rootParent, absolutePath),
      size: target.size,
      modified: target.mtime.toISOString(),
    });
  }
}

async function walkDir(
  dir: string,
  rootParent: string,
  excludePatterns: string[],
  visited: Set<string>,
  results: CollectedFile[],
): Promise<void> {
  const realDir = await realpath(dir).catch(() => null);
  if (realDir === null || visited.has(realDir)) {
    return;
  }
  visited.add(realDir);

  const entries = await readdir(dir, { withFileTypes: true }).catch((err: unknown) => {
    if (isNodeError(err) && err.code === 'EACCES') {
      console.warn(`openclaw-backup: skipping ${dir} (permission denied)`);
      return null;
    }
    throw wrapError(`Failed to read directory ${dir}`, err);
  });
  if (entries === null) {
    return;
  }

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (isExcluded(absolutePath, entry.name, excludePatterns)) {
      continue;
    }

    if (entry.isDirectory()) {
      await walkDir(absolutePath, rootParent, excludePatterns, visited, results);
    } else if (entry.isSymbolicLink()) {
      await processSymlink(absolutePath, rootParent, excludePatterns, visited, results);
    } else if (entry.isFile()) {
      await addFile(absolutePath, rootParent, results);
    }
  }
}

/**
 * Walks all paths in `config.include` and `config.extraPaths`, applies
 * include/exclude rules, and returns a flat list of files to back up.
 */
export async function collectFiles(config: BackupConfig): Promise<CollectedFile[]> {
  const roots = [...config.include, ...config.extraPaths];
  const results: CollectedFile[] = [];
  const visited = new Set<string>();

  for (const root of roots) {
    await walkDir(root, dirname(root), config.exclude, visited, results);
  }

  return results;
}
