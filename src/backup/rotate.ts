import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

import { refreshIndex } from '../index-manager.js';
import { createStorageProviders } from '../storage/providers.js';
import { type BackupConfig, type BackupManifest, type StorageProvider } from '../types.js';
import { getSidecarName, RETIRED_KEYS_DIR } from '../utils.js';

import { decryptFile, encryptFile, generateKey, getKeyId } from './encrypt.js';
import { deserializeManifest, serializeManifest } from './manifest.js';

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface RotateKeyOptions {
  reencrypt: boolean;
  source?: string;
}

export interface RotateKeyResult {
  oldKeyId: string;
  newKeyId: string;
  reencrypted: number;
  errors: string[];
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function reencryptOnProvider(
  archiveFilename: string,
  provider: StorageProvider,
  oldKeyPath: string,
  newKeyPath: string,
  newKeyId: string,
  tmpDir: string,
): Promise<void> {
  const prefix = `${provider.name}-${archiveFilename}`;
  const archivePath = join(tmpDir, prefix);
  const decryptedPath = archivePath.replace(/\.age$/, '');
  const sidecarName = getSidecarName(archiveFilename);
  const sidecarPath = join(tmpDir, `${provider.name}-${sidecarName}`);

  await provider.pull(archiveFilename, archivePath);
  await decryptFile(archivePath, decryptedPath, oldKeyPath);
  await rm(archivePath);
  await encryptFile(decryptedPath, archivePath, newKeyPath);
  await rm(decryptedPath);
  await provider.push(archivePath, archiveFilename);

  await provider.pull(sidecarName, sidecarPath);
  const manifest = deserializeManifest(await readFile(sidecarPath, 'utf8'));
  // Spread into a new object rather than mutating the deserialized manifest.
  const updated: BackupManifest = { ...manifest, keyId: newKeyId };
  await writeFile(sidecarPath, serializeManifest(updated), 'utf8');
  await provider.push(sidecarPath, sidecarName);
}

async function reencryptAll(
  config: BackupConfig,
  oldKeyPath: string,
  newKeyId: string,
  source: string | undefined,
): Promise<{ reencrypted: number; errors: string[] }> {
  const providers = createStorageProviders(config, source);
  const index = await refreshIndex(providers);
  const errors: string[] = [];
  let reencrypted = 0;

  const tmpDir = await mkdtemp(join(tmpdir(), 'openclaw-reenc-'));
  try {
    for (const entry of index.entries) {
      if (!entry.encrypted) {
        continue;
      }
      for (const providerName of entry.providers) {
        const provider = providers.find((p) => p.name === providerName);
        if (provider === undefined) {
          continue;
        }
        try {
          await reencryptOnProvider(
            entry.filename,
            provider,
            oldKeyPath,
            config.encryptKeyPath,
            newKeyId,
            tmpDir,
          );
          reencrypted++;
        } catch (err) {
          const msg = err instanceof Error ? err.message : String(err);
          errors.push(`Failed to re-encrypt ${entry.filename} on ${providerName}: ${msg}`);
        }
      }
    }
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch((e: unknown) => {
      console.warn(`openclaw-backup: failed to clean up ${tmpDir}: ${String(e)}`);
    });
  }

  return { reencrypted, errors };
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Generates a new key in a randomly-named temp directory within the same
 * directory as `keyPath`, then copies the old key to `retiredKeyPath` and
 * atomically renames the new key into place. Using a temp dir in the same
 * directory (same filesystem) guarantees `rename` is atomic and the temp
 * path cannot be predicted or pre-occupied by an attacker.
 *
 * Returns the new key ID. The temp directory is always cleaned up.
 */
async function generateAndSwapKey(keyPath: string, retiredKeyPath: string): Promise<string> {
  const keyDir = dirname(keyPath);
  const tmpDir = await mkdtemp(join(keyDir, '.openclaw-tmp-'));
  const tmpKeyPath = join(tmpDir, 'new.age');
  try {
    await generateKey(tmpKeyPath);
    const newKeyId = await getKeyId(tmpKeyPath);
    await copyFile(keyPath, retiredKeyPath);
    await rename(tmpKeyPath, keyPath);
    return newKeyId;
  } finally {
    await rm(tmpDir, { recursive: true, force: true }).catch((e: unknown) => {
      console.warn(`openclaw-backup: failed to clean up ${tmpDir}: ${String(e)}`);
    });
  }
}

/**
 * Rotates the encryption key: generates a new key in a randomly-named temp
 * directory (preventing symlink pre-emption), archives the old key to the
 * retired-keys directory, then atomically replaces the current key file.
 */
export async function rotateKey(
  config: BackupConfig,
  options: RotateKeyOptions,
): Promise<RotateKeyResult> {
  const oldKeyId = await getKeyId(config.encryptKeyPath);
  const retiredDir = join(homedir(), RETIRED_KEYS_DIR);
  await mkdir(retiredDir, { recursive: true });
  const retiredKeyPath = join(retiredDir, `${oldKeyId}.age`);

  const newKeyId = await generateAndSwapKey(config.encryptKeyPath, retiredKeyPath);

  if (!options.reencrypt) {
    return { oldKeyId, newKeyId, reencrypted: 0, errors: [] };
  }

  const { reencrypted, errors } = await reencryptAll(
    config,
    retiredKeyPath,
    newKeyId,
    options.source,
  );
  return { oldKeyId, newKeyId, reencrypted, errors };
}
