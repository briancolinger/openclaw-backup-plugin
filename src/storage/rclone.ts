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
const RCLONE_INSTALL_HINT =
  process.platform === 'darwin' ? 'brew install rclone' : 'sudo apt install rclone';
const BACKUP_EXTENSIONS = ['.tar.gz', '.tar.gz.age', '.manifest.json'];

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/**
 * Rejects remote names that contain path-traversal segments (`..`), are
 * absolute paths, contain backslashes (Windows-style paths), or contain null
 * bytes. Since rclone receives the full remote string verbatim, any of these
 * could escape the configured remote base directory or cause injection issues.
 * Forward slashes are allowed — they represent hostname subdirectories.
 */
function assertSafeRemoteName(remoteName: string): void {
  if (
    remoteName.startsWith('/') ||
    remoteName.split('/').some((seg) => seg === '..') ||
    remoteName.includes('\\') ||
    remoteName.includes('\0')
  ) {
    throw new Error(`Unsafe remote name rejected: "${remoteName}"`);
  }
}

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
 * Archives are stored under a per-hostname subdirectory:
 * `{remote}{hostname}/{filename}`. Old-format root-level files are still
 * discoverable for backward compatibility.
 *
 * `config.remote` must already include the trailing path, e.g. `'gdrive:openclaw-backups/'`.
 */
export function createRcloneProvider(config: {
  remote: string;
  name: string;
  hostname: string;
}): StorageProvider {
  const remoteBase = config.remote;

  return {
    name: config.name,

    async push(localPath: string, remoteName: string): Promise<void> {
      assertSafeRemoteName(remoteName);
      await runRclone(['copyto', localPath, `${remoteBase}${remoteName}`]);
    },

    async pull(remoteName: string, localPath: string): Promise<void> {
      assertSafeRemoteName(remoteName);
      await runRclone(['copyto', `${remoteBase}${remoteName}`, localPath]);
    },

    async list(): Promise<string[]> {
      const hostedBase = `${remoteBase}${config.hostname}/`;

      // New format: files in the hostname subdir
      let hostedFiles: string[] = [];
      try {
        const stdout = await runRclone(['lsf', hostedBase]);
        hostedFiles = parseListOutput(stdout).map((f) => `${config.hostname}/${f}`);
      } catch {
        // Hostname subdir may not exist yet — not an error
      }

      // Old format: root-level files only (no slash = not in a subdir)
      let rootFiles: string[] = [];
      try {
        const stdout = await runRclone(['lsf', remoteBase]);
        rootFiles = stdout
          .split('\n')
          .map((l) => l.trim())
          .filter((l) => l.length > 0 && !l.includes('/') && isBackupFile(l));
      } catch {
        // Remote base may not exist yet
      }

      return [...hostedFiles, ...rootFiles].sort().reverse();
    },

    async listAll(): Promise<string[]> {
      try {
        const stdout = await runRclone(['lsf', remoteBase, '--recursive']);
        return parseListOutput(stdout);
      } catch {
        return [];
      }
    },

    async delete(remoteName: string): Promise<void> {
      assertSafeRemoteName(remoteName);
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
