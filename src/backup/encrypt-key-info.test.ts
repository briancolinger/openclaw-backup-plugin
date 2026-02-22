import { createHash } from 'node:crypto';

import { beforeEach, describe, expect, it, vi } from 'vitest';

import { readKeyInfo } from './encrypt.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const { mockReadFile, mockReaddir } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockReaddir: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  readFile: mockReadFile,
  readdir: mockReaddir,
}));

beforeEach(() => {
  vi.resetAllMocks();
});

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY_PATH = '/home/user/.openclaw/.secrets/backup.age';
const PUB_KEY = 'age1testpublickey123';
const KEY_FILE_CONTENT = [
  '# created: 2024-01-01T00:00:00Z',
  `# public key: ${PUB_KEY}`,
  'AGE-SECRET-KEY-1EXAMPLEKEYDATA',
].join('\n');
const EXPECTED_KEY_ID = createHash('sha256').update(PUB_KEY).digest('hex').slice(0, 16);

// ---------------------------------------------------------------------------
// readKeyInfo
// ---------------------------------------------------------------------------

describe('readKeyInfo', () => {
  it('should return full info when the key file exists and is readable', async () => {
    mockReadFile.mockResolvedValue(KEY_FILE_CONTENT);
    mockReaddir.mockResolvedValue([]);

    const info = await readKeyInfo(KEY_PATH);

    expect(info.exists).toBe(true);
    expect(info.readable).toBe(true);
    expect(info.pubKey).toBe(PUB_KEY);
    expect(info.keyId).toBe(EXPECTED_KEY_ID);
    expect(info.retiredKeyCount).toBe(0);
  });

  it('should count only .age files in the backup-keys/ retired directory', async () => {
    mockReadFile.mockResolvedValue(KEY_FILE_CONTENT);
    mockReaddir.mockResolvedValue(['old-key.age', 'another.age', 'notes.txt']);

    const info = await readKeyInfo(KEY_PATH);

    expect(info.retiredKeyCount).toBe(2);
  });

  it('should return 0 retired keys when the backup-keys/ directory does not exist', async () => {
    mockReadFile.mockResolvedValue(KEY_FILE_CONTENT);
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const info = await readKeyInfo(KEY_PATH);

    expect(info.retiredKeyCount).toBe(0);
  });

  it('should return exists:false and nulls when the key file is missing (ENOENT)', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const info = await readKeyInfo(KEY_PATH);

    expect(info.exists).toBe(false);
    expect(info.readable).toBe(false);
    expect(info.pubKey).toBeNull();
    expect(info.keyId).toBeNull();
    expect(info.retiredKeyCount).toBe(0);
  });

  it('should return exists:true, readable:false when file is inaccessible (EACCES)', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('EACCES'), { code: 'EACCES' }));
    mockReaddir.mockResolvedValue([]);

    const info = await readKeyInfo(KEY_PATH);

    expect(info.exists).toBe(true);
    expect(info.readable).toBe(false);
    expect(info.pubKey).toBeNull();
  });

  it('should return nulls for pubKey and keyId when key file content has no public key line', async () => {
    mockReadFile.mockResolvedValue('this is not a valid age key file\n');
    mockReaddir.mockResolvedValue([]);

    const info = await readKeyInfo(KEY_PATH);

    expect(info.exists).toBe(true);
    expect(info.readable).toBe(true);
    expect(info.pubKey).toBeNull();
    expect(info.keyId).toBeNull();
  });
});
