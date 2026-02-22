import { readFileSync, unlinkSync } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import {
  BACKUP_INDEX_FILENAME,
  type BackupEntry,
  type BackupIndex,
  type PruneResult,
  type RetentionConfig,
  type StorageProvider,
} from './types.js';
import { getSidecarName, isRecord } from './utils.js';

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

const REMOTE_INDEX_FILENAME = 'openclaw-index.json';
const INDEX_CACHE_TTL_MS = 5 * 60 * 1000; // 5 minutes

function isEnoentError(err: unknown): boolean {
  return isRecord(err) && err['code'] === 'ENOENT';
}

function getDefaultCachePath(): string {
  return join(homedir(), '.openclaw', BACKUP_INDEX_FILENAME);
}

function extractTimestampKey(manifestFilename: string): string | null {
  const suffix = '.manifest.json';
  if (!manifestFilename.endsWith(suffix)) {
    return null;
  }
  return manifestFilename.slice(0, -suffix.length);
}

function buildArchiveName(timestampKey: string, encrypted: boolean): string {
  return encrypted ? `${timestampKey}.tar.gz.age` : `${timestampKey}.tar.gz`;
}

function isBackupIndex(value: unknown): value is BackupIndex {
  if (!isRecord(value)) {
    return false;
  }
  if (typeof value['lastRefreshed'] !== 'string') {
    return false;
  }
  if (!Array.isArray(value['entries'])) {
    return false;
  }
  return true;
}

interface ManifestData {
  timestamp: string;
  encrypted: boolean;
  fileCount: number;
  totalSize: number;
}

function parseManifestData(raw: unknown): ManifestData | null {
  if (!isRecord(raw)) {
    return null;
  }
  const timestamp = raw['timestamp'];
  const encrypted = raw['encrypted'];
  const files = raw['files'];
  if (typeof timestamp !== 'string' || typeof encrypted !== 'boolean' || !Array.isArray(files)) {
    return null;
  }
  let totalSize = 0;
  for (const file of files) {
    if (isRecord(file) && typeof file['size'] === 'number') {
      totalSize += file['size'];
    }
  }
  return { timestamp, encrypted, fileCount: files.length, totalSize };
}

async function fetchProviderEntries(
  provider: StorageProvider,
  tmpDir: string,
): Promise<Map<string, BackupEntry>> {
  const entries = new Map<string, BackupEntry>();
  let files: string[];
  try {
    files = await provider.list();
  } catch (err) {
    console.warn(`openclaw-backup: failed to list ${provider.name}: ${String(err)}`);
    return entries;
  }

  const manifests = files.filter((f) => f.endsWith('.manifest.json'));
  for (const manifestFilename of manifests) {
    const key = extractTimestampKey(manifestFilename);
    if (key === null) {
      continue;
    }
    const localPath = join(tmpDir, `${provider.name}-${manifestFilename}`);
    try {
      await provider.pull(manifestFilename, localPath);
      const content = await readFile(localPath, 'utf8');
      const raw: unknown = JSON.parse(content);
      const data = parseManifestData(raw);
      if (data === null) {
        continue;
      }
      entries.set(key, {
        timestamp: data.timestamp,
        filename: buildArchiveName(key, data.encrypted),
        providers: [provider.name],
        encrypted: data.encrypted,
        size: data.totalSize,
        fileCount: data.fileCount,
      });
    } catch (err) {
      console.warn(
        `openclaw-backup: failed to read manifest ${manifestFilename} from ${provider.name}: ${String(err)}`,
      );
    }
  }
  return entries;
}

function mergeEntries(maps: Map<string, BackupEntry>[]): BackupEntry[] {
  const merged = new Map<string, BackupEntry>();
  for (const map of maps) {
    for (const [key, entry] of map) {
      const existing = merged.get(key);
      if (existing === undefined) {
        merged.set(key, { ...entry, providers: [...entry.providers] });
      } else {
        for (const p of entry.providers) {
          existing.providers.push(p);
        }
      }
    }
  }
  return Array.from(merged.values()).sort((a, b) => b.timestamp.localeCompare(a.timestamp));
}

async function saveCache(index: BackupIndex, cachePath: string): Promise<void> {
  await mkdir(dirname(cachePath), { recursive: true });
  await writeFile(cachePath, JSON.stringify(index, null, 2), 'utf8');
}

/** Tries to pull the remote lightweight index from a provider. Returns null on any failure. */
async function tryPullRemoteIndex(
  provider: StorageProvider,
  dir: string,
): Promise<BackupEntry[] | null> {
  const localPath = join(dir, `${provider.name}-${REMOTE_INDEX_FILENAME}`);
  try {
    await provider.pull(REMOTE_INDEX_FILENAME, localPath);
    const raw: unknown = JSON.parse(await readFile(localPath, 'utf8'));
    return isBackupIndex(raw) ? raw.entries : null;
  } catch {
    return null;
  }
}

/** Uses the remote index if available; falls back to full manifest scan. */
async function fetchEntries(
  provider: StorageProvider,
  dir: string,
): Promise<Map<string, BackupEntry>> {
  const remote = await tryPullRemoteIndex(provider, dir);
  if (remote === null) return fetchProviderEntries(provider, dir);
  return new Map(remote.map((e) => [e.filename.replace(/\.(tar\.gz\.age|tar\.gz)$/, ''), e]));
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Fetches manifests from all providers and rebuilds the backup index from scratch.
 * Remote is source of truth — the local cache is overwritten with the result.
 * Tries the lightweight remote index file first (O(1)); falls back to scanning
 * individual manifests (O(n)) when the remote index is absent.
 */
export async function refreshIndex(providers: StorageProvider[]): Promise<BackupIndex> {
  const tmp = await mkdtemp(join(tmpdir(), 'openclaw-index-'));
  try {
    const maps = await Promise.all(providers.map((p) => fetchEntries(p, tmp)));
    const entries = mergeEntries(maps);
    const index: BackupIndex = { lastRefreshed: new Date().toISOString(), entries };
    await saveCache(index, getDefaultCachePath());
    await pushRemoteIndex(providers, index).catch((err: unknown) => {
      console.warn(`openclaw-backup: failed to push remote index: ${String(err)}`);
    });
    return index;
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch((err: unknown) => {
      console.warn(`openclaw-backup: failed to clean up ${tmp}: ${String(err)}`);
    });
  }
}

/**
 * Reads the local cache file. Returns null if the cache doesn't exist or is invalid.
 */
export function loadCachedIndex(cachePath?: string): BackupIndex | null {
  const path = cachePath ?? getDefaultCachePath();
  try {
    const raw: unknown = JSON.parse(readFileSync(path, 'utf8'));
    if (!isBackupIndex(raw)) {
      console.warn('openclaw-backup: cache file is malformed, ignoring');
      return null;
    }
    return raw;
  } catch (err) {
    if (!isEnoentError(err)) {
      console.warn(`openclaw-backup: failed to read index cache: ${String(err)}`);
    }
    return null;
  }
}

/**
 * Returns the backup index. Uses the local cache when it is present and
 * younger than 5 minutes. Otherwise fetches from remotes via refreshIndex.
 */
export async function getIndex(
  providers: StorageProvider[],
  forceRefresh?: boolean,
): Promise<BackupIndex> {
  if (forceRefresh !== true) {
    const cached = loadCachedIndex();
    if (cached !== null) {
      const ageMs = Date.now() - new Date(cached.lastRefreshed).getTime();
      if (ageMs < INDEX_CACHE_TTL_MS) return cached;
    }
  }
  return refreshIndex(providers);
}

/**
 * Deletes the local cache file so the next getIndex call fetches from remotes.
 * Silently ignores missing cache; logs a warning for other errors.
 */
export function invalidateCache(cachePath?: string): void {
  const path = cachePath ?? getDefaultCachePath();
  try {
    unlinkSync(path);
  } catch (err) {
    if (!isEnoentError(err)) {
      console.warn(`openclaw-backup: failed to invalidate cache at ${path}: ${String(err)}`);
    }
  }
}

/**
 * Serializes the given index and pushes it to all providers as a lightweight
 * remote index file. On next refresh, providers that have this file serve O(1)
 * lookups instead of O(n) individual manifest fetches.
 */
export async function pushRemoteIndex(
  providers: StorageProvider[],
  index: BackupIndex,
): Promise<void> {
  const tmp = await mkdtemp(join(tmpdir(), 'openclaw-ridx-'));
  try {
    const localPath = join(tmp, REMOTE_INDEX_FILENAME);
    await writeFile(localPath, JSON.stringify(index, null, 2), 'utf8');
    await Promise.allSettled(providers.map((p) => p.push(localPath, REMOTE_INDEX_FILENAME)));
  } finally {
    await rm(tmp, { recursive: true, force: true }).catch((err: unknown) => {
      console.warn(`openclaw-backup: failed to clean up ${tmp}: ${String(err)}`);
    });
  }
}

/**
 * Prunes old backups across all providers, keeping only the newest
 * `retention.count` entries. Returns a summary of what was deleted.
 */
export async function pruneBackups(
  providers: StorageProvider[],
  retention: RetentionConfig,
): Promise<PruneResult> {
  const index = await refreshIndex(providers);
  const toKeep = index.entries.slice(0, retention.count);
  const toDelete = index.entries.slice(retention.count);
  const errors: string[] = [];

  for (const entry of toDelete) {
    const manifestFilename = getSidecarName(entry.filename);
    for (const providerName of entry.providers) {
      const provider = providers.find((p) => p.name === providerName);
      if (provider === undefined) {
        continue;
      }
      try {
        await provider.delete(entry.filename);
        await provider.delete(manifestFilename);
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        errors.push(`Failed to delete ${entry.filename} from ${providerName}: ${message}`);
      }
    }
  }

  const updatedIndex: BackupIndex = { lastRefreshed: new Date().toISOString(), entries: toKeep };
  await pushRemoteIndex(providers, updatedIndex).catch((err: unknown) => {
    console.warn(`openclaw-backup: failed to update remote index after prune: ${String(err)}`);
  });
  invalidateCache();
  return { deleted: toDelete.length, kept: toKeep.length, errors };
}
