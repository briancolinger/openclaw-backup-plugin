import { type BackupConfig, type DestinationConfig, type StorageProvider } from '../types.js';
import { getHostname } from '../utils.js';

import { createLocalProvider } from './local.js';
import { createRcloneProvider } from './rclone.js';

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function buildProvider(name: string, dest: DestinationConfig, hostname: string): StorageProvider {
  if (dest.path !== undefined) {
    return createLocalProvider({ path: dest.path, hostname, name });
  }
  if (dest.remote !== undefined) {
    return createRcloneProvider({ remote: dest.remote, name, hostname });
  }
  throw new Error(`Destination "${name}" has neither "path" nor "remote" configured`);
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates StorageProvider instances for the configured destinations.
 * If `destination` is specified, returns only that provider.
 * Throws if the named destination is not found in config.
 */
export function createStorageProviders(
  config: BackupConfig,
  destination?: string,
): StorageProvider[] {
  const hostname = getHostname(config);
  if (destination !== undefined) {
    const dest = config.destinations[destination];
    if (dest === undefined) {
      const available = Object.keys(config.destinations).join(', ');
      throw new Error(`Destination "${destination}" not found in config. Available: ${available}`);
    }
    return [buildProvider(destination, dest, hostname)];
  }
  return Object.entries(config.destinations).map(([name, dest]) =>
    buildProvider(name, dest, hostname),
  );
}
