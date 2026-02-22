import { execFile as execFileCallback, spawn } from 'node:child_process';
import { rm, writeFile } from 'node:fs/promises';
import { join } from 'node:path';

import { wrapError } from '../errors.js';
import {
  type BackupManifest,
  type CollectedFile,
  MANIFEST_FILENAME,
  type PrerequisiteCheck,
} from '../types.js';
import { makeTmpDir } from '../utils.js';

import { cleanupDir, populateStagingDir } from './archive.js';
import { readPublicKey } from './encrypt.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

/** Maximum time (ms) allowed for tar/age spawned processes (30 minutes). */
const SPAWN_TIMEOUT_MS = 30 * 60 * 1000;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Collects stderr output from a spawned process into an accumulator string. */
function captureStderr(proc: ReturnType<typeof spawn>): () => string {
  let output = '';
  proc.stderr?.on('data', (chunk: unknown) => {
    output += String(chunk);
  });
  return () => output;
}

/**
 * Returns a Promise that resolves when `proc` exits with code 0, or rejects
 * with a descriptive error (including captured stderr) on non-zero exit or
 * spawn error.
 */
function awaitExit(
  proc: ReturnType<typeof spawn>,
  label: string,
  getStderr: () => string,
): Promise<void> {
  return new Promise<void>((resolve, reject) => {
    proc.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
        return;
      }
      const stderr = getStderr().trim();
      const detail = stderr.length > 0 ? `\n  stderr: ${stderr}` : '';
      reject(new Error(`${label} exited with code ${code ?? 'null'}${detail}`));
    });
    proc.on('error', (err: Error) => {
      reject(new Error(`${label} process error: ${err.message}`, { cause: err }));
    });
  });
}

/** Spawns tar to write directly to outputPath (no piping). */
async function runTarToFile(stagingDir: string, outputPath: string): Promise<void> {
  const proc = spawn('tar', ['czf', outputPath, '--dereference', '-C', stagingDir, '.'], {
    timeout: SPAWN_TIMEOUT_MS,
  });
  const getStderr = captureStderr(proc);
  await awaitExit(proc, 'tar', getStderr);
}

/**
 * Spawns tar writing gzip-compressed output to stdout, then pipes that
 * through an age encryption process which writes ciphertext to outputPath.
 * Waits for both processes to exit, throwing if either exits non-zero.
 */
async function runTarPipeAge(
  stagingDir: string,
  outputPath: string,
  pubKey: string,
): Promise<void> {
  const tar = spawn('tar', ['czf', '-', '--dereference', '-C', stagingDir, '.'], {
    timeout: SPAWN_TIMEOUT_MS,
  });
  const age = spawn('age', ['-e', '-r', pubKey, '-o', outputPath], {
    timeout: SPAWN_TIMEOUT_MS,
  });

  const getTarStderr = captureStderr(tar);
  const getAgeStderr = captureStderr(age);

  if (tar.stdout == null || age.stdin == null) {
    tar.kill();
    age.kill();
    throw new Error('Failed to obtain stdio pipes for tar/age pipeline');
  }

  tar.stdout.pipe(age.stdin);

  const [tarResult, ageResult] = await Promise.allSettled([
    awaitExit(tar, 'tar', getTarStderr),
    awaitExit(age, 'age', getAgeStderr),
  ]);

  if (tarResult.status === 'rejected' || ageResult.status === 'rejected') {
    tar.kill();
    age.kill();
    const msgs: string[] = [];
    if (tarResult.status === 'rejected') {
      msgs.push(tarResult.reason instanceof Error ? tarResult.reason.message : String(tarResult.reason));
    }
    if (ageResult.status === 'rejected') {
      msgs.push(ageResult.reason instanceof Error ? ageResult.reason.message : String(ageResult.reason));
    }
    throw new Error(msgs.join('; '));
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Creates a gzip-compressed tar archive at `outputPath` using the system `tar`
 * CLI, optionally piping through `age` encryption.
 *
 * - Unencrypted: spawns `tar czf outputPath --dereference -C stagingDir .`
 * - Encrypted:   spawns `tar czf - ... | age -e -r <pubKey> -o outputPath`
 *
 * Files are staged via symlinks (same TOCTOU protection as createArchive).
 * Any partial output file is removed if the pipeline fails.
 */
export async function createArchiveStreaming(
  files: CollectedFile[],
  manifest: BackupManifest,
  outputPath: string,
  encryptKeyPath?: string,
): Promise<void> {
  const stagingDir = await makeTmpDir('openclaw-archive-');
  try {
    await populateStagingDir(stagingDir, files);
    await writeFile(join(stagingDir, MANIFEST_FILENAME), JSON.stringify(manifest, null, 2), 'utf8');

    if (encryptKeyPath !== undefined) {
      const pubKey = await readPublicKey(encryptKeyPath);
      await runTarPipeAge(stagingDir, outputPath, pubKey);
    } else {
      await runTarToFile(stagingDir, outputPath);
    }
  } catch (err) {
    await rm(outputPath, { force: true }).catch(() => undefined);
    throw wrapError('Failed to create archive', err);
  } finally {
    await cleanupDir(stagingDir);
  }
}

/**
 * Checks whether the `tar` CLI is installed and accessible in PATH.
 */
export async function checkTarInstalled(): Promise<PrerequisiteCheck> {
  return new Promise<PrerequisiteCheck>((resolve) => {
    execFileCallback('tar', ['--version'], { timeout: 5000, encoding: 'utf8' }, (err, stdout) => {
      if (err != null) {
        resolve({
          name: 'tar',
          available: false,
          error: err.message,
          installHint:
            process.platform === 'darwin' ? 'brew install gnu-tar' : 'sudo apt install tar',
        });
        return;
      }
      const check: PrerequisiteCheck = { name: 'tar', available: true };
      const firstLine = stdout.trim().split('\n')[0] ?? '';
      if (firstLine.length > 0) {
        check.version = firstLine;
      }
      resolve(check);
    });
  });
}
