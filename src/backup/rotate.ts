import { copyFile, mkdir, mkdtemp, readFile, rm, unlink, writeFile } from 'node:fs/promises';
import { homedir, tmpdir } from 'node:os';
import { join } from 'node:path';

import { refreshIndex } from '../index-manager.js';
import { type BackupConfig, type StorageProvider } from '../types.js';

import { createStorageProviders } from './backup.js';
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

function getSidecarName(archiveFilename: string): string {
  const base = archiveFilename.replace(/\.tar\.gz\.age$|\.tar\.gz$/, '');
  return `${base}.manifest.json`;
}

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
  manifest.keyId = newKeyId;
  await writeFile(sidecarPath, serializeManifest(manifest), 'utf8');
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
 * Rotates the encryption key: archives the old key to the retired-keys
 * directory, generates a new key at the configured path, and optionally
 * re-encrypts all existing backups.
 */
export async function rotateKey(
  config: BackupConfig,
  options: RotateKeyOptions,
): Promise<RotateKeyResult> {
  const oldKeyId = await getKeyId(config.encryptKeyPath);
  const retiredDir = join(homedir(), RETIRED_KEYS_DIR);
  await mkdir(retiredDir, { recursive: true });
  const retiredKeyPath = join(retiredDir, `${oldKeyId}.age`);

  await copyFile(config.encryptKeyPath, retiredKeyPath);
  await unlink(config.encryptKeyPath);
  await generateKey(config.encryptKeyPath);
  const newKeyId = await getKeyId(config.encryptKeyPath);

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
