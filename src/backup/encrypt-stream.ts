import { spawn } from 'node:child_process';
import { type Readable, type Writable } from 'node:stream';

import { readPublicKey } from './encrypt.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TIMEOUT_MS = 5 * 60 * 1000;

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

export interface EncryptStreamResult {
  /** age's stdin — write plaintext (tar stream) here */
  stdin: Writable;
  /** age's stdout — read ciphertext from here */
  stdout: Readable;
  /**
   * Resolves when age exits with code 0; rejects with a descriptive error
   * (including stderr) when it exits non-zero or encounters a spawn error.
   */
  completed: Promise<void>;
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Spawns `age -e -r <pubKey>` and returns its stdin and stdout as streams,
 * plus a `completed` promise that resolves only on a clean (exit 0) exit.
 *
 * Pipe plaintext into `stdin` and read ciphertext from `stdout`. Always
 * await (or include in Promise.all with) `completed` to detect age failures.
 *
 * Runs: age -e -r <publicKey>  (reads stdin, writes encrypted bytes to stdout)
 */
export async function createEncryptStream(keyPath: string): Promise<EncryptStreamResult> {
  const pubKey = await readPublicKey(keyPath);

  const child = spawn('age', ['-e', '-r', pubKey], { timeout: TIMEOUT_MS });
  const { stdin, stdout } = child;

  if (stdin == null || stdout == null) {
    child.kill();
    throw new Error('Failed to obtain age process streams (spawn did not open stdio pipes)');
  }

  let stderrOutput = '';
  child.stderr?.on('data', (chunk: unknown) => {
    stderrOutput += String(chunk);
  });

  const completed = new Promise<void>((resolve, reject) => {
    child.on('close', (code: number | null) => {
      if (code === 0) {
        resolve();
      } else {
        const detail = stderrOutput.length > 0 ? `: ${stderrOutput.trim()}` : '';
        reject(new Error(`age encryption failed (exit ${code ?? 'null'})${detail}`));
      }
    });
    child.on('error', (err: Error) => {
      reject(new Error(`age encryption process error: ${err.message}`, { cause: err }));
    });
  });

  return { stdin, stdout, completed };
}
