import { execFile as execFileCallback } from 'node:child_process';
import { createHash } from 'node:crypto';
import { access, chmod, mkdir, readFile } from 'node:fs/promises';
import { dirname } from 'node:path';

import { type PrerequisiteCheck } from '../types.js';

// ---------------------------------------------------------------------------
// Types / constants
// ---------------------------------------------------------------------------

interface ExecResult {
  stdout: string;
  stderr: string;
}

const TIMEOUT_MS = 5 * 60 * 1000;
const KEY_FILE_PERMISSIONS = 0o600;

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Safely pulls stderr out of a child-process error without type assertions. */
function extractStderr(err: unknown): string {
  if (err instanceof Error && isRecord(err)) {
    const stderr = err['stderr'];
    if (typeof stderr === 'string' && stderr.length > 0) {
      return stderr;
    }
  }
  return '';
}

function wrapError(context: string, err: unknown): Error {
  if (err instanceof Error) {
    return new Error(`${context}: ${err.message}`, { cause: err });
  }
  return new Error(`${context}: ${String(err)}`);
}

/** Wraps a child-process error, appending stderr to the message when present. */
function buildExecError(context: string, err: unknown): Error {
  const stderr = extractStderr(err);
  const base = err instanceof Error ? err.message : String(err);
  const detail = stderr.length > 0 ? `\n  stderr: ${stderr}` : '';
  const msg = `${context}: ${base}${detail}`;
  const cause = err instanceof Error ? err : undefined;
  if (cause !== undefined) {
    return new Error(msg, { cause });
  }
  return new Error(msg);
}

/**
 * Finds the age public key in output text.
 * Handles both age-keygen -o stdout ("Public key: age1...") and
 * key-file content ("# public key: age1...").
 */
function parsePublicKey(text: string): string | undefined {
  for (const line of text.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.startsWith('Public key: ')) {
      return trimmed.slice('Public key: '.length).trim();
    }
    if (trimmed.startsWith('# public key: ')) {
      return trimmed.slice('# public key: '.length).trim();
    }
  }
  return undefined;
}

function getInstallHint(): string {
  if (process.platform === 'darwin') {
    return 'brew install age';
  }
  return 'sudo apt install age';
}

/** Runs a command with execFile and returns { stdout, stderr } as strings. */
async function execToPromise(
  cmd: string,
  args: string[],
  timeoutMs: number,
): Promise<ExecResult> {
  return new Promise<ExecResult>((resolve, reject) => {
    execFileCallback(cmd, args, { timeout: timeoutMs }, (err, stdout, stderr) => {
      if (err != null) {
        reject(err);
        return;
      }
      resolve({ stdout: String(stdout), stderr: String(stderr) });
    });
  });
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Encrypts `inputPath` to `outputPath` using the age identity at `keyPath`.
 * Runs: age -e -i <keyPath> -o <outputPath> <inputPath>
 */
export async function encryptFile(
  inputPath: string,
  outputPath: string,
  keyPath: string,
): Promise<void> {
  try {
    await execToPromise('age', ['-e', '-i', keyPath, '-o', outputPath, inputPath], TIMEOUT_MS);
  } catch (err) {
    throw buildExecError(`Failed to encrypt ${inputPath}`, err);
  }
}

/**
 * Decrypts `inputPath` to `outputPath` using the age identity at `keyPath`.
 * Runs: age -d -i <keyPath> -o <outputPath> <inputPath>
 */
export async function decryptFile(
  inputPath: string,
  outputPath: string,
  keyPath: string,
): Promise<void> {
  try {
    await execToPromise('age', ['-d', '-i', keyPath, '-o', outputPath, inputPath], TIMEOUT_MS);
  } catch (err) {
    throw buildExecError(`Failed to decrypt ${inputPath}`, err);
  }
}

/**
 * Generates a new age key pair at `keyPath`.
 * Throws if the key file already exists (safety guard).
 * Sets file permissions to 0o600 and returns the public key string.
 */
export async function generateKey(keyPath: string): Promise<string> {
  const exists = await access(keyPath).then(
    () => true,
    () => false,
  );
  if (exists) {
    throw new Error(
      `Key file already exists at ${keyPath}. Remove it first or choose a different path.`,
    );
  }
  await mkdir(dirname(keyPath), { recursive: true });
  const result = await execToPromise('age-keygen', ['-o', keyPath], TIMEOUT_MS).catch(
    (err: unknown) => {
      throw buildExecError('Failed to generate age key', err);
    },
  );
  await chmod(keyPath, KEY_FILE_PERMISSIONS);
  const pubKey = parsePublicKey(result.stdout);
  if (pubKey == null) {
    throw new Error(`age-keygen did not output a public key. stdout: ${result.stdout}`);
  }
  return pubKey;
}

/**
 * Reads the age key file at `keyPath`, extracts the public key, and returns
 * the first 16 hex characters of its SHA-256 hash for use in manifests.
 */
export async function getKeyId(keyPath: string): Promise<string> {
  let content: string;
  try {
    content = await readFile(keyPath, 'utf8');
  } catch (err) {
    throw wrapError(`Failed to read key file ${keyPath}`, err);
  }
  const pubKey = parsePublicKey(content);
  if (pubKey == null) {
    throw new Error(`No public key found in key file: ${keyPath}`);
  }
  return createHash('sha256').update(pubKey).digest('hex').slice(0, 16);
}

/**
 * Checks whether the `age` CLI is installed and returns its version.
 */
export async function checkAgeInstalled(): Promise<PrerequisiteCheck> {
  try {
    const { stdout } = await execToPromise('age', ['--version'], TIMEOUT_MS);
    const check: PrerequisiteCheck = { name: 'age', available: true };
    const versionStr = stdout.trim();
    if (versionStr.length > 0) {
      check.version = versionStr;
    }
    return check;
  } catch (err) {
    return {
      name: 'age',
      available: false,
      error: err instanceof Error ? err.message : String(err),
      installHint: getInstallHint(),
    };
  }
}
