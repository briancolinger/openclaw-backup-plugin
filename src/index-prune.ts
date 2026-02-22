import { type BackupIndex, type PruneResult, type RetentionConfig, type StorageProvider } from './types.js';
import { getSidecarName } from './utils.js';

import { invalidateCache, pushRemoteIndex, refreshIndex } from './index-manager.js';

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
  await invalidateCache();
  return { deleted: toDelete.length, kept: toKeep.length, errors };
}
