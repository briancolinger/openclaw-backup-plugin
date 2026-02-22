import { lstat as fsLstat, readdir, realpath, stat as fsStat } from "node:fs/promises";
import { dirname, join, relative } from "node:path";

import { type BackupConfig, type CollectedFile } from "../types.js";

function isNodeError(err: unknown): err is NodeJS.ErrnoException {
  return err instanceof Error && "code" in err;
}

function wrapError(context: string, err: unknown): Error {
  if (err instanceof Error) {
    return new Error(`${context}: ${err.message}`, { cause: err });
  }
  return new Error(`${context}: ${String(err)}`);
}

/**
 * Returns true when `filename` matches a simple glob `pattern`.
 * Only `*` wildcards are supported; they match any sequence of non-separator chars.
 */
export function globMatch(pattern: string, filename: string): boolean {
  const escaped = pattern.replace(/[.+^${}()|[\]\\]/g, "\\$&");
  const regexStr = escaped.replace(/\*/g, "[^/]*");
  return new RegExp(`^${regexStr}$`).test(filename);
}

function isExcluded(
  absolutePath: string,
  name: string,
  excludePatterns: string[],
): boolean {
  for (const pattern of excludePatterns) {
    if (pattern.includes("*")) {
      if (globMatch(pattern, name)) {
        return true;
      }
    } else if (pattern.includes("/")) {
      // Absolute or relative path pattern — match against full path
      if (
        absolutePath === pattern ||
        absolutePath.startsWith(`${pattern}/`)
      ) {
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
    if (isNodeError(err) && (err.code === "EACCES" || err.code === "EPERM")) {
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
  includeTranscripts: boolean,
  visited: Set<string>,
  results: CollectedFile[],
): Promise<void> {
  const target = await fsStat(absolutePath).catch(() => null);
  if (target === null) {
    console.warn(`openclaw-backup: skipping ${absolutePath} (broken symlink)`);
    return;
  }
  if (target.isDirectory()) {
    await walkDir(absolutePath, rootParent, excludePatterns, includeTranscripts, visited, results);
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
  includeTranscripts: boolean,
  visited: Set<string>,
  results: CollectedFile[],
): Promise<void> {
  const realDir = await realpath(dir).catch(() => null);
  if (realDir === null || visited.has(realDir)) {
    return;
  }
  visited.add(realDir);

  const entries = await readdir(dir, { withFileTypes: true }).catch(
    (err: unknown) => {
      if (isNodeError(err) && err.code === "EACCES") {
        console.warn(`openclaw-backup: skipping ${dir} (permission denied)`);
        return null;
      }
      throw wrapError(`Failed to read directory ${dir}`, err);
    },
  );
  if (entries === null) {
    return;
  }

  for (const entry of entries) {
    const absolutePath = join(dir, entry.name);
    if (isExcluded(absolutePath, entry.name, excludePatterns)) {
      continue;
    }
    if (!includeTranscripts && entry.name.endsWith(".jsonl")) {
      continue;
    }

    if (entry.isDirectory()) {
      await walkDir(
        absolutePath,
        rootParent,
        excludePatterns,
        includeTranscripts,
        visited,
        results,
      );
    } else if (entry.isSymbolicLink()) {
      await processSymlink(
        absolutePath,
        rootParent,
        excludePatterns,
        includeTranscripts,
        visited,
        results,
      );
    } else if (entry.isFile()) {
      await addFile(absolutePath, rootParent, results);
    }
  }
}

/**
 * Walks all paths in `config.include` and `config.extraPaths`, applies
 * include/exclude rules, and returns a flat list of files to back up.
 */
export async function collectFiles(
  config: BackupConfig,
): Promise<CollectedFile[]> {
  const roots = [...config.include, ...config.extraPaths];
  const results: CollectedFile[] = [];
  const visited = new Set<string>();

  for (const root of roots) {
    await walkDir(
      root,
      dirname(root),
      config.exclude,
      config.includeTranscripts,
      visited,
      results,
    );
  }

  return results;
}
