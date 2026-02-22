import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkAgeInstalled, decryptFile, encryptFile, generateKey, getKeyId } from './encrypt.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

// vi.hoisted runs before vi.mock factories, making these available to them.
const { mockExecFile, mockMkdir, mockReadFile, mockWriteFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockReadFile: vi.fn(),
  mockWriteFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({ execFile: mockExecFile }));

vi.mock('node:fs/promises', () => ({
  mkdir: mockMkdir,
  readFile: mockReadFile,
  writeFile: mockWriteFile,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Makes mockExecFile call its callback with success (stdout, stderr). */
function mockExecSuccess(stdout = '', stderr = ''): void {
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    callback(null, stdout, stderr);
  });
}

/** Makes mockExecFile call its callback with a failure error. */
function mockExecFailure(message: string, stderr = ''): void {
  const err = Object.assign(new Error(message), { stderr });
  mockExecFile.mockImplementation((_cmd, _args, _opts, callback) => {
    callback(err);
  });
}

// ---------------------------------------------------------------------------
// encryptFile
// ---------------------------------------------------------------------------

// Key file content returned by mockReadFile for encryptFile tests.
// encryptFile reads the key file to extract the public key then calls
// `age -e -r <pubKey>` (recipient mode) rather than `-i` (identity mode).
const ENCRYPT_KEY_FILE = [
  '# created: 2024-01-01T00:00:00Z',
  '# public key: age1testencryptpubkey789',
  'AGE-SECRET-KEY-1EXAMPLEKEYDATA',
].join('\n');
const ENCRYPT_PUB_KEY = 'age1testencryptpubkey789';

describe('encryptFile', () => {
  it('should call age with encrypt args and resolve on success', async () => {
    mockReadFile.mockResolvedValue(ENCRYPT_KEY_FILE);
    mockExecSuccess();

    await expect(
      encryptFile('/tmp/input.tar.gz', '/tmp/output.age', '/key.age'),
    ).resolves.toBeUndefined();

    expect(mockExecFile).toHaveBeenCalledWith(
      'age',
      ['-e', '-r', ENCRYPT_PUB_KEY, '-o', '/tmp/output.age', '/tmp/input.tar.gz'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('should throw with a clear message when age reports an error', async () => {
    mockReadFile.mockResolvedValue(ENCRYPT_KEY_FILE);
    mockExecFailure('exit code 1', 'no identity found');

    await expect(encryptFile('/tmp/input.tar.gz', '/tmp/output.age', '/key.age')).rejects.toThrow(
      'Failed to encrypt /tmp/input.tar.gz',
    );
  });

  it('should include stderr in the error message on failure', async () => {
    mockReadFile.mockResolvedValue(ENCRYPT_KEY_FILE);
    mockExecFailure('age failed', 'invalid key format');

    await expect(encryptFile('/tmp/input.tar.gz', '/tmp/output.age', '/key.age')).rejects.toThrow(
      'invalid key format',
    );
  });
});

// ---------------------------------------------------------------------------
// decryptFile
// ---------------------------------------------------------------------------

describe('decryptFile', () => {
  it('should call age with decrypt args and resolve on success', async () => {
    mockExecSuccess();

    await expect(
      decryptFile('/tmp/input.age', '/tmp/output.tar.gz', '/key.age'),
    ).resolves.toBeUndefined();

    expect(mockExecFile).toHaveBeenCalledWith(
      'age',
      ['-d', '-i', '/key.age', '-o', '/tmp/output.tar.gz', '/tmp/input.age'],
      expect.objectContaining({ timeout: expect.any(Number) }),
      expect.any(Function),
    );
  });

  it('should throw with a clear message when age decryption fails', async () => {
    mockExecFailure('wrong passphrase', 'no identity matched any of the recipients');

    await expect(decryptFile('/tmp/input.age', '/tmp/output.tar.gz', '/key.age')).rejects.toThrow(
      'Failed to decrypt /tmp/input.age',
    );
  });
});

// ---------------------------------------------------------------------------
// generateKey
// ---------------------------------------------------------------------------

describe('generateKey', () => {
  const KEY_PATH = '/home/user/.openclaw/.secrets/backup.age';
  const PUB_KEY = 'age1testpublickey123456789abcdef';
  // age-keygen stdout when invoked without -o: full key content including comment
  const KEYGEN_STDOUT = [
    '# created: 2024-01-01T00:00:00Z',
    `# public key: ${PUB_KEY}`,
    'AGE-SECRET-KEY-1EXAMPLEKEYDATA',
  ].join('\n');

  it('should throw if the key file already exists (EEXIST from writeFile wx flag)', async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockExecSuccess(KEYGEN_STDOUT);
    const eexistError = Object.assign(new Error('EEXIST: file exists, open ...'), {
      code: 'EEXIST',
    });
    mockWriteFile.mockRejectedValue(eexistError);

    await expect(generateKey(KEY_PATH)).rejects.toThrow('already exists');
  });

  it('should create parent dirs, run age-keygen without -o, write atomically with 0o600', async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockExecSuccess(KEYGEN_STDOUT);
    mockWriteFile.mockResolvedValue(undefined);

    const result = await generateKey(KEY_PATH);

    expect(result).toBe(PUB_KEY);
    expect(mockMkdir).toHaveBeenCalledWith('/home/user/.openclaw/.secrets', { recursive: true });
    // age-keygen called without -o so key content arrives on stdout
    expect(mockExecFile).toHaveBeenCalledWith(
      'age-keygen',
      [],
      expect.any(Object),
      expect.any(Function),
    );
    // written with O_CREAT | O_EXCL (flag 'wx') and 0o600 from creation time
    expect(mockWriteFile).toHaveBeenCalledWith(KEY_PATH, KEYGEN_STDOUT, {
      flag: 'wx',
      mode: 0o600,
    });
  });

  it('should throw a clear error when age-keygen fails', async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockExecFailure('age-keygen: command not found', 'command not found');

    await expect(generateKey(KEY_PATH)).rejects.toThrow('Failed to generate age key');
  });

  it('should throw if age-keygen output contains no recognisable public key', async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockExecSuccess('some unexpected output with no public key line');

    await expect(generateKey(KEY_PATH)).rejects.toThrow('did not output a public key');
    // writeFile should not be called because key parsing fails first
    expect(mockWriteFile).not.toHaveBeenCalled();
  });

  it('should wrap unexpected writeFile errors', async () => {
    mockMkdir.mockResolvedValue(undefined);
    mockExecSuccess(KEYGEN_STDOUT);
    mockWriteFile.mockRejectedValue(new Error('EACCES: permission denied'));

    await expect(generateKey(KEY_PATH)).rejects.toThrow('Failed to write key file');
  });
});

// ---------------------------------------------------------------------------
// getKeyId
// ---------------------------------------------------------------------------

describe('getKeyId', () => {
  const PUB_KEY = 'age1testpublickey123';
  const KEY_FILE_CONTENT = [
    '# created: 2024-01-01T00:00:00Z',
    `# public key: ${PUB_KEY}`,
    'AGE-SECRET-KEY-1EXAMPLEKEYDATA',
  ].join('\n');

  it('should return a 16-character lowercase hex string derived from the public key', async () => {
    mockReadFile.mockResolvedValue(KEY_FILE_CONTENT);
    const expected = createHash('sha256').update(PUB_KEY).digest('hex').slice(0, 16);

    const result = await getKeyId('/key.age');

    expect(result).toBe(expected);
    expect(result).toMatch(/^[0-9a-f]{16}$/);
  });

  it('should throw with a clear message when the key file cannot be read', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));

    await expect(getKeyId('/missing.age')).rejects.toThrow('Failed to read key file /missing.age');
  });

  it('should throw when no public key line is found in the key file', async () => {
    mockReadFile.mockResolvedValue('# this is not a valid age key file\nrandom content\n');

    await expect(getKeyId('/bad.age')).rejects.toThrow('No public key found in key file: /bad.age');
  });
});

// ---------------------------------------------------------------------------
// checkAgeInstalled
// ---------------------------------------------------------------------------

describe('checkAgeInstalled', () => {
  it('should return available: true with the version when age is installed', async () => {
    mockExecSuccess('v1.1.1\n');

    const result = await checkAgeInstalled();

    expect(result.available).toBe(true);
    expect(result.name).toBe('age');
    expect(result.version).toBe('v1.1.1');
  });

  it('should return available: false with an error message when age is not found', async () => {
    mockExecFailure('spawn age ENOENT');

    const result = await checkAgeInstalled();

    expect(result.available).toBe(false);
    expect(result.name).toBe('age');
    expect(result.error).toBeTruthy();
  });

  it('should include an installHint when age is not found', async () => {
    mockExecFailure('not found');

    const result = await checkAgeInstalled();

    expect(result.installHint).toBeTruthy();
    expect(result.installHint).toMatch(/install age/i);
  });
});
