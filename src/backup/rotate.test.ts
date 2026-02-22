import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { rotateKey } from './rotate.js';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const {
  mockChmod,
  mockCopyFile,
  mockMkdir,
  mockMkdtemp,
  mockReadFile,
  mockRename,
  mockRm,
  mockWriteFile,
  mockHomedir,
  mockTmpdir,
  mockDecryptFile,
  mockEncryptFile,
  mockGenerateKey,
  mockGetKeyId,
  mockDeserializeManifest,
  mockSerializeManifest,
  mockRefreshIndex,
  mockCreateStorageProviders,
} = vi.hoisted(() => ({
  mockChmod: vi.fn(),
  mockCopyFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockMkdtemp: vi.fn(),
  mockReadFile: vi.fn(),
  mockRename: vi.fn(),
  mockRm: vi.fn(),
  mockWriteFile: vi.fn(),
  mockHomedir: vi.fn(),
  mockTmpdir: vi.fn(),
  mockDecryptFile: vi.fn(),
  mockEncryptFile: vi.fn(),
  mockGenerateKey: vi.fn(),
  mockGetKeyId: vi.fn(),
  mockDeserializeManifest: vi.fn(),
  mockSerializeManifest: vi.fn(),
  mockRefreshIndex: vi.fn(),
  mockCreateStorageProviders: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  chmod: mockChmod,
  copyFile: mockCopyFile,
  mkdir: mockMkdir,
  mkdtemp: mockMkdtemp,
  readFile: mockReadFile,
  rename: mockRename,
  rm: mockRm,
  writeFile: mockWriteFile,
}));
vi.mock('node:os', () => ({ homedir: mockHomedir, tmpdir: mockTmpdir }));
vi.mock('./encrypt.js', () => ({
  decryptFile: mockDecryptFile,
  encryptFile: mockEncryptFile,
  generateKey: mockGenerateKey,
  getKeyId: mockGetKeyId,
}));
vi.mock('./manifest.js', () => ({
  deserializeManifest: mockDeserializeManifest,
  serializeManifest: mockSerializeManifest,
}));
vi.mock('../index-manager.js', () => ({ refreshIndex: mockRefreshIndex }));
vi.mock('../storage/providers.js', () => ({
  createStorageProviders: mockCreateStorageProviders,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOME = '/home/testuser';
const KEY_PATH = `${HOME}/.openclaw/.secrets/backup.age`;
const OLD_KEY_ID = 'old1234567890abc';
const NEW_KEY_ID = 'new1234567890abc';
const TMP_DIR = `${HOME}/.openclaw/.secrets/.openclaw-tmp-abc123`;

function makeConfig() {
  return {
    encrypt: true,
    encryptKeyPath: KEY_PATH,
    include: [`${HOME}/.openclaw`],
    exclude: [],
    extraPaths: [],
    includeTranscripts: false,
    includePersistor: false,
    retention: { count: 10 },
    destinations: { local: { path: '/backups' } },
  };
}

interface MockStorageProvider {
  name: string;
  push: Mock;
  pull: Mock;
  list: Mock;
  delete: Mock;
  check: Mock;
}

function makeProvider(name = 'local'): MockStorageProvider {
  return {
    name,
    push: vi.fn().mockResolvedValue(undefined),
    pull: vi.fn().mockResolvedValue(undefined),
    list: vi.fn().mockResolvedValue([]),
    delete: vi.fn().mockResolvedValue(undefined),
    check: vi.fn().mockResolvedValue({ available: true }),
  };
}

// ---------------------------------------------------------------------------
// rotateKey
// ---------------------------------------------------------------------------

describe('rotateKey', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockHomedir.mockReturnValue(HOME);
    mockTmpdir.mockReturnValue('/tmp');

    // Default: old key resolves to OLD_KEY_ID on first call, NEW_KEY_ID after swap
    mockGetKeyId.mockResolvedValueOnce(OLD_KEY_ID).mockResolvedValueOnce(NEW_KEY_ID);

    mockChmod.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockMkdtemp.mockResolvedValue(TMP_DIR);
    mockGenerateKey.mockResolvedValue(NEW_KEY_ID);
    mockCopyFile.mockResolvedValue(undefined);
    mockRename.mockResolvedValue(undefined);
    mockRm.mockResolvedValue(undefined);
  });

  it('should return old and new key IDs without re-encrypting when reencrypt is false', async () => {
    const result = await rotateKey(makeConfig(), { reencrypt: false });

    expect(result.oldKeyId).toBe(OLD_KEY_ID);
    expect(result.newKeyId).toBe(NEW_KEY_ID);
    expect(result.reencrypted).toBe(0);
    expect(result.errors).toEqual([]);
  });

  it('should generate the new key in a temp dir within the key directory', async () => {
    await rotateKey(makeConfig(), { reencrypt: false });

    // mkdtemp should be called with the key file's directory as prefix
    expect(mockMkdtemp).toHaveBeenCalledWith(
      expect.stringContaining(`${HOME}/.openclaw/.secrets/.openclaw-tmp-`),
    );
    expect(mockGenerateKey).toHaveBeenCalledWith(`${TMP_DIR}/new.age`);
  });

  it('should copy old key to retired dir before replacing it', async () => {
    await rotateKey(makeConfig(), { reencrypt: false });

    const retiredPath = `${HOME}/.openclaw/.secrets/backup-keys/${OLD_KEY_ID}.age`;
    expect(mockMkdir).toHaveBeenCalledWith(
      `${HOME}/.openclaw/.secrets/backup-keys`,
      { recursive: true },
    );
    expect(mockCopyFile).toHaveBeenCalledWith(KEY_PATH, retiredPath);
  });

  it('should atomically rename new key into place', async () => {
    await rotateKey(makeConfig(), { reencrypt: false });

    expect(mockRename).toHaveBeenCalledWith(`${TMP_DIR}/new.age`, KEY_PATH);
  });

  it('should clean up temp dir even if rename succeeds', async () => {
    await rotateKey(makeConfig(), { reencrypt: false });

    expect(mockRm).toHaveBeenCalledWith(TMP_DIR, { recursive: true, force: true });
  });

  it('should re-encrypt all encrypted archives when reencrypt is true', async () => {
    const provider = makeProvider();
    mockCreateStorageProviders.mockReturnValue([provider]);
    const ARCHIVE = '2026-01-01T00-00-00.tar.gz.age';
    const SIDECAR = '2026-01-01T00-00-00.manifest.json';
    mockRefreshIndex.mockResolvedValue({
      lastRefreshed: new Date().toISOString(),
      entries: [
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          filename: ARCHIVE,
          providers: ['local'],
          encrypted: true,
          size: 1000,
          fileCount: 1,
        },
      ],
    });
    mockDeserializeManifest.mockReturnValue({
      schemaVersion: 1,
      pluginVersion: '0.1.0',
      hostname: 'host',
      timestamp: '2026-01-01T00:00:00.000Z',
      encrypted: true,
      includeTranscripts: false,
      includePersistor: false,
      files: [],
    });
    mockSerializeManifest.mockReturnValue('{}');
    mockReadFile.mockResolvedValue('{}');

    const result = await rotateKey(makeConfig(), { reencrypt: true });

    expect(result.reencrypted).toBe(1);
    expect(result.errors).toEqual([]);
    expect(provider.pull).toHaveBeenCalledWith(ARCHIVE, expect.any(String));
    expect(mockDecryptFile).toHaveBeenCalledOnce();
    expect(mockEncryptFile).toHaveBeenCalledOnce();
    expect(provider.push).toHaveBeenCalledWith(expect.any(String), ARCHIVE);
    expect(provider.pull).toHaveBeenCalledWith(SIDECAR, expect.any(String));
    expect(provider.push).toHaveBeenCalledWith(expect.any(String), SIDECAR);
  });

  it('should skip non-encrypted entries during re-encryption', async () => {
    const provider = makeProvider();
    mockCreateStorageProviders.mockReturnValue([provider]);
    mockRefreshIndex.mockResolvedValue({
      lastRefreshed: new Date().toISOString(),
      entries: [
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          filename: '2026-01-01T00-00-00.tar.gz',
          providers: ['local'],
          encrypted: false,
          size: 500,
          fileCount: 1,
        },
      ],
    });

    const result = await rotateKey(makeConfig(), { reencrypt: true });

    expect(result.reencrypted).toBe(0);
    expect(mockDecryptFile).not.toHaveBeenCalled();
  });

  it('should collect re-encryption errors without aborting', async () => {
    const provider = makeProvider();
    mockCreateStorageProviders.mockReturnValue([provider]);
    mockRefreshIndex.mockResolvedValue({
      lastRefreshed: new Date().toISOString(),
      entries: [
        {
          timestamp: '2026-01-01T00:00:00.000Z',
          filename: '2026-01-01T00-00-00.tar.gz.age',
          providers: ['local'],
          encrypted: true,
          size: 1000,
          fileCount: 1,
        },
      ],
    });
    provider.pull.mockRejectedValue(new Error('network timeout'));
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await rotateKey(makeConfig(), { reencrypt: true });

    expect(result.reencrypted).toBe(0);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('network timeout');
    warnSpy.mockRestore();
  });
});
