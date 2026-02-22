import { copyFile, mkdir, mkdtemp, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { refreshIndex } from '../index-manager.js';
import { createStorageProviders } from '../storage/providers.js';
import { type BackupConfig, type BackupManifest, type StorageProvider } from '../types.js';
import { getSidecarName } from '../utils.js';

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
// Constants
// ---------------------------------------------------------------------------

const RETIRED_KEYS_DIR = '.openclaw/.secrets/backup-keys';

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
 * Rotates the encryption key: generates a new key, archives the old key to the
 * retired-keys directory, then atomically replaces the current key with the new
 * one. The new key is written to a temporary path first so that a crash between
 * steps never leaves the key slot empty.
 */
export async function rotateKey(
  config: BackupConfig,
  options: RotateKeyOptions,
): Promise<RotateKeyResult> {
  const oldKeyId = await getKeyId(config.encryptKeyPath);
  const retiredDir = join(homedir(), RETIRED_KEYS_DIR);
  await mkdir(retiredDir, { recursive: true });
  const retiredKeyPath = join(retiredDir, `${oldKeyId}.age`);

  // Generate the new key to a temp path first and verify it is readable before
  // touching the old key.  This way a crash between steps never leaves the key
  // slot empty.
  const tmpKeyPath = `${config.encryptKeyPath}.tmp`;
  await generateKey(tmpKeyPath);
  const newKeyId = await getKeyId(tmpKeyPath);

  // Archive the old key, then atomically swap the new key into place.
  await copyFile(config.encryptKeyPath, retiredKeyPath);
  await rename(tmpKeyPath, config.encryptKeyPath);

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
