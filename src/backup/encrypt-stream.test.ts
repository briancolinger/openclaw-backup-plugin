import { EventEmitter } from 'node:events';
import { PassThrough } from 'node:stream';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { createEncryptStream } from './encrypt-stream.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockSpawn, mockReadFile } = vi.hoisted(() => ({
  mockSpawn: vi.fn(),
  mockReadFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({ spawn: mockSpawn }));
vi.mock('node:fs/promises', () => ({ readFile: mockReadFile }));

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const KEY_FILE = [
  '# created: 2024-01-01T00:00:00Z',
  '# public key: age1testpubkey123',
  'AGE-SECRET-KEY-1EXAMPLEDATA',
].join('\n');

const PUB_KEY = 'age1testpubkey123';

/**
 * Returns a fake ChildProcess-like object backed by an EventEmitter so tests
 * can call `child.emit('close', code)` to trigger the handlers registered by
 * `createEncryptStream` without needing to inspect mock call arguments.
 */
function makeChild() {
  const emitter = new EventEmitter();
  return {
    stdin: new PassThrough(),
    stdout: new PassThrough(),
    stderr: new PassThrough(),
    on: emitter.on.bind(emitter),
    emit: emitter.emit.bind(emitter),
    kill: vi.fn(),
  };
}

// ---------------------------------------------------------------------------
// createEncryptStream
// ---------------------------------------------------------------------------

describe('createEncryptStream', () => {
  it('should spawn age with -e -r <pubKey> and expose its stdin and stdout', async () => {
    mockReadFile.mockResolvedValue(KEY_FILE);
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const result = await createEncryptStream('/key.age');

    expect(mockSpawn).toHaveBeenCalledWith(
      'age',
      ['-e', '-r', PUB_KEY],
      expect.objectContaining({ timeout: expect.any(Number) }),
    );
    expect(result.stdin).toBe(child.stdin);
    expect(result.stdout).toBe(child.stdout);
  });

  it('should resolve completed when age exits with code 0', async () => {
    mockReadFile.mockResolvedValue(KEY_FILE);
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const { completed } = await createEncryptStream('/key.age');

    child.emit('close', 0);
    await expect(completed).resolves.toBeUndefined();
  });

  it('should reject completed when age exits with a non-zero code', async () => {
    mockReadFile.mockResolvedValue(KEY_FILE);
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const { completed } = await createEncryptStream('/key.age');

    child.emit('close', 1);
    await expect(completed).rejects.toThrow('age encryption failed (exit 1)');
  });

  it('should include stderr output in the rejection message on non-zero exit', async () => {
    mockReadFile.mockResolvedValue(KEY_FILE);
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const { completed } = await createEncryptStream('/key.age');

    // Push data to the real PassThrough stderr — the data listener registered
    // by createEncryptStream will capture it into stderrOutput.
    child.stderr.push('no matching recipients\n');
    child.emit('close', 1);
    await expect(completed).rejects.toThrow('no matching recipients');
  });

  it('should reject completed when the spawn process emits an error event', async () => {
    mockReadFile.mockResolvedValue(KEY_FILE);
    const child = makeChild();
    mockSpawn.mockReturnValue(child);

    const { completed } = await createEncryptStream('/key.age');

    child.emit('error', new Error('spawn age ENOENT'));
    await expect(completed).rejects.toThrow('age encryption process error');
  });

  it('should throw when the key file cannot be read', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT'));

    await expect(createEncryptStream('/missing.age')).rejects.toThrow(
      'Failed to read key file /missing.age',
    );
  });

  it('should throw when no public key is found in the key file', async () => {
    mockReadFile.mockResolvedValue('# this is not a valid age key file\n');

    await expect(createEncryptStream('/bad.age')).rejects.toThrow(
      'No public key found in key file: /bad.age',
    );
  });
});
