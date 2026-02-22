import { execFile } from 'node:child_process';

import {
  type PrerequisiteCheck,
  type ProviderCheckResult,
  type StorageProvider,
} from '../types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const EXEC_TIMEOUT_MS = 2 * 60 * 1000;
const RCLONE_INSTALL_HINT = 'curl https://rclone.org/install.sh | sudo bash';
const BACKUP_EXTENSIONS = ['.tar.gz', '.tar.gz.age', '.manifest.json'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isBackupFile(filename: string): boolean {
  return BACKUP_EXTENSIONS.some((ext) => filename.endsWith(ext));
}

function parseListOutput(stdout: string): string[] {
  return stdout
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line.length > 0)
    .filter(isBackupFile)
    .sort()
    .reverse();
}

function parseVersionOutput(stdout: string): string | undefined {
  const match = /rclone v([\d.]+)/.exec(stdout);
  return match?.[1];
}

async function runRclone(args: string[]): Promise<string> {
  return new Promise<string>((resolve, reject) => {
    execFile(
      'rclone',
      args,
      { timeout: EXEC_TIMEOUT_MS, encoding: 'utf8' },
      (err, stdout, stderr) => {
        if (err != null) {
          const firstArg = args[0] ?? 'command';
          const stderrMsg = stderr.trim();
          const detail = stderrMsg ? `: ${stderrMsg}` : '';
          reject(new Error(`rclone ${firstArg} failed${detail}`, { cause: err }));
          return;
        }
        resolve(stdout);
      },
    );
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a StorageProvider backed by rclone, supporting any remote rclone
 * supports (S3, Google Drive, B2, etc.).
 *
 * `config.remote` must already include the trailing path, e.g. `'gdrive:openclaw-backups/'`.
 */
export function createRcloneProvider(config: { remote: string; name: string }): StorageProvider {
  const remoteBase = config.remote;

  return {
    name: config.name,

    async push(localPath: string, remoteName: string): Promise<void> {
      await runRclone(['copyto', localPath, `${remoteBase}${remoteName}`]);
    },

    async pull(remoteName: string, localPath: string): Promise<void> {
      await runRclone(['copyto', `${remoteBase}${remoteName}`, localPath]);
    },

    async list(): Promise<string[]> {
      const stdout = await runRclone(['lsf', remoteBase]);
      return parseListOutput(stdout);
    },

    async delete(remoteName: string): Promise<void> {
      await runRclone(['deletefile', `${remoteBase}${remoteName}`]);
    },

    async check(): Promise<ProviderCheckResult> {
      try {
        await runRclone(['lsd', remoteBase]);
        return { available: true };
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err);
        return { available: false, error: message };
      }
    },
  };
}

/**
 * Checks whether rclone is installed and returns its version.
 * Used by the prerequisites checker.
 */
export async function checkRcloneInstalled(): Promise<PrerequisiteCheck> {
  try {
    const stdout = await runRclone(['version']);
    const version = parseVersionOutput(stdout);
    const result: PrerequisiteCheck = {
      name: 'rclone',
      available: true,
      installHint: RCLONE_INSTALL_HINT,
    };
    if (version !== undefined) {
      result.version = version;
    }
    return result;
  } catch (err) {
    const error = err instanceof Error ? err.message : String(err);
    return {
      name: 'rclone',
      available: false,
      error,
      installHint: RCLONE_INSTALL_HINT,
    };
  }
}
