import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type BackupConfig, type BackupManifest, MANIFEST_SCHEMA_VERSION } from '../types.js';

import { findDecryptionKey, runRestore } from './restore.js';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const {
  mockCopyFile,
  mockMkdir,
  mockMkdtemp,
  mockReaddir,
  mockReadFile,
  mockRm,
  mockHomedir,
  mockExtractArchive,
  mockDecryptFile,
  mockGetKeyId,
  mockDeserializeManifest,
  mockValidateManifest,
  mockRunBackup,
  mockCreateStorageProviders,
  mockGetIndex,
} = vi.hoisted(() => ({
  mockCopyFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockMkdtemp: vi.fn(),
  mockReaddir: vi.fn(),
  mockReadFile: vi.fn(),
  mockRm: vi.fn(),
  mockHomedir: vi.fn(),
  mockExtractArchive: vi.fn(),
  mockDecryptFile: vi.fn(),
  mockGetKeyId: vi.fn(),
  mockDeserializeManifest: vi.fn(),
  mockValidateManifest: vi.fn(),
  mockRunBackup: vi.fn(),
  mockCreateStorageProviders: vi.fn(),
  mockGetIndex: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  copyFile: mockCopyFile,
  mkdir: mockMkdir,
  mkdtemp: mockMkdtemp,
  readdir: mockReaddir,
  readFile: mockReadFile,
  rm: mockRm,
}));
vi.mock('node:os', () => ({ homedir: mockHomedir, tmpdir: vi.fn().mockReturnValue('/tmp') }));
vi.mock('../backup/archive.js', () => ({ extractArchive: mockExtractArchive }));
vi.mock('../backup/encrypt.js', () => ({ decryptFile: mockDecryptFile, getKeyId: mockGetKeyId }));
vi.mock('../backup/manifest.js', () => ({
  deserializeManifest: mockDeserializeManifest,
  validateManifest: mockValidateManifest,
}));
vi.mock('../backup/backup.js', () => ({
  runBackup: mockRunBackup,
  createStorageProviders: mockCreateStorageProviders,
}));
vi.mock('../index-manager.js', () => ({ getIndex: mockGetIndex }));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const HOME = '/home/testuser';
const TMP_DIR = '/tmp/openclaw-restore-abc123';
const KEY_PATH = `${HOME}/.openclaw/.secrets/backup.age`;
const TIMESTAMP = '2026-02-21T10-30-45';
const ARCHIVE_NAME = `${TIMESTAMP}.tar.gz`;
const MANIFEST_TIMESTAMP = '2026-02-21T10:30:45.000Z';

function makeManifest(): BackupManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    pluginVersion: '0.1.0',
    hostname: 'test-host',
    timestamp: MANIFEST_TIMESTAMP,
    encrypted: false,
    includeTranscripts: false,
    includePersistor: false,
    files: [
      {
        path: '.openclaw/settings.json',
        sha256: 'aabbcc',
        size: 500,
        modified: '2026-01-01T00:00:00.000Z',
      },
    ],
  };
}

function makeConfig(): BackupConfig {
  return {
    encrypt: false,
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

const makeProvider = (name = 'local') => ({
  name,
  push: vi.fn().mockResolvedValue(undefined),
  pull: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue([ARCHIVE_NAME]),
  delete: vi.fn().mockResolvedValue(undefined),
  check: vi.fn().mockResolvedValue({ available: true }),
});

// ---------------------------------------------------------------------------
// findDecryptionKey
// ---------------------------------------------------------------------------

describe('findDecryptionKey', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockHomedir.mockReturnValue(HOME);
  });

  it('should return the current key path when its keyId matches', async () => {
    mockGetKeyId.mockResolvedValue('abc123def456');

    const result = await findDecryptionKey('abc123def456', makeConfig());

    expect(result).toBe(KEY_PATH);
    expect(mockGetKeyId).toHaveBeenCalledWith(KEY_PATH);
  });

  it('should return a retired key path when its keyId matches', async () => {
    mockGetKeyId.mockResolvedValueOnce('different-id'); // current key — no match
    mockReaddir.mockResolvedValue(['old-key.age', 'older-key.age']);
    mockGetKeyId.mockResolvedValueOnce('no-match'); // old-key.age — no match
    mockGetKeyId.mockResolvedValueOnce('target-id'); // older-key.age — match

    const result = await findDecryptionKey('target-id', makeConfig());

    expect(result).toBe(`${HOME}/.openclaw/.secrets/backup-keys/older-key.age`);
  });

  it('should return null when no key matches', async () => {
    mockGetKeyId.mockResolvedValue('wrong-id');
    mockReaddir.mockResolvedValue(['old-key.age']);

    const result = await findDecryptionKey('target-id', makeConfig());

    expect(result).toBeNull();
  });

  it('should return null when retired keys dir does not exist', async () => {
    mockGetKeyId.mockResolvedValue('wrong-id');
    mockReaddir.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const result = await findDecryptionKey('target-id', makeConfig());

    expect(result).toBeNull();
  });
});

// ---------------------------------------------------------------------------
// runRestore
// ---------------------------------------------------------------------------

describe('runRestore', () => {
  let mockProvider: ReturnType<typeof makeProvider>;
  let manifest: BackupManifest;

  beforeEach(() => {
    vi.resetAllMocks();
    mockProvider = makeProvider();
    manifest = makeManifest();
    mockHomedir.mockReturnValue(HOME);
    mockMkdtemp.mockResolvedValue(TMP_DIR);
    mockRm.mockResolvedValue(undefined);
    mockCreateStorageProviders.mockReturnValue([mockProvider]);
    mockReadFile.mockResolvedValue('{"manifest":"json"}');
    mockDeserializeManifest.mockReturnValue(manifest);
    mockValidateManifest.mockResolvedValue({ valid: true, errors: [] });
    mockExtractArchive.mockResolvedValue(undefined);
    mockRunBackup.mockResolvedValue(undefined);
    mockMkdir.mockResolvedValue(undefined);
    mockCopyFile.mockResolvedValue(undefined);
  });

  it('should run a full restore, create pre-backup, and copy files', async () => {
    const result = await runRestore(makeConfig(), { source: 'local', timestamp: TIMESTAMP });

    expect(mockProvider.pull).toHaveBeenCalledWith(ARCHIVE_NAME, `${TMP_DIR}/${ARCHIVE_NAME}`);
    expect(mockExtractArchive).toHaveBeenCalledOnce();
    expect(mockValidateManifest).toHaveBeenCalledWith(manifest, `${TMP_DIR}/extracted`);
    expect(mockRunBackup).toHaveBeenCalledOnce();
    expect(mockCopyFile).toHaveBeenCalledOnce();
    expect(mockRm).toHaveBeenCalledWith(TMP_DIR, { recursive: true, force: true });
    expect(result).toMatchObject({
      timestamp: MANIFEST_TIMESTAMP,
      fileCount: 1,
      dryRun: false,
      preBackupCreated: true,
      errors: [],
    });
  });

  it('should skip pre-backup when skipPreBackup is true', async () => {
    const result = await runRestore(makeConfig(), {
      source: 'local',
      timestamp: TIMESTAMP,
      skipPreBackup: true,
    });

    expect(mockRunBackup).not.toHaveBeenCalled();
    expect(result.preBackupCreated).toBe(false);
  });

  it('should return dry-run result without copying files or running pre-backup', async () => {
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    const result = await runRestore(makeConfig(), {
      source: 'local',
      timestamp: TIMESTAMP,
      dryRun: true,
    });

    expect(mockCopyFile).not.toHaveBeenCalled();
    expect(mockRunBackup).not.toHaveBeenCalled();
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('dry run'));
    expect(result).toMatchObject({ dryRun: true, preBackupCreated: false, errors: [] });
    warnSpy.mockRestore();
  });

  it('should throw and abort when manifest integrity check fails', async () => {
    mockValidateManifest.mockResolvedValue({
      valid: false,
      errors: ['Checksum mismatch for .openclaw/settings.json'],
    });

    await expect(
      runRestore(makeConfig(), { source: 'local', timestamp: TIMESTAMP }),
    ).rejects.toThrow('Restore aborted: archive integrity check failed');

    expect(mockCopyFile).not.toHaveBeenCalled();
    expect(mockRunBackup).not.toHaveBeenCalled();
  });

  it('should resolve latest archive from index when no timestamp is given', async () => {
    mockGetIndex.mockResolvedValue({
      lastRefreshed: new Date().toISOString(),
      entries: [
        {
          timestamp: MANIFEST_TIMESTAMP,
          filename: ARCHIVE_NAME,
          providers: ['local'],
          encrypted: false,
          size: 5000,
          fileCount: 1,
        },
      ],
    });

    await runRestore(makeConfig(), { source: 'local' });

    expect(mockGetIndex).toHaveBeenCalledOnce();
    expect(mockProvider.pull).toHaveBeenCalledWith(
      ARCHIVE_NAME,
      expect.stringContaining(ARCHIVE_NAME),
    );
  });

  it('should throw when no archive matches the given timestamp', async () => {
    mockProvider.list.mockResolvedValue([]);

    await expect(
      runRestore(makeConfig(), { source: 'local', timestamp: 'no-such-ts' }),
    ).rejects.toThrow('No archive found for timestamp "no-such-ts"');
  });

  it('should collect copy errors without aborting the restore', async () => {
    mockCopyFile.mockRejectedValue(new Error('EACCES: permission denied'));
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);

    const result = await runRestore(makeConfig(), {
      source: 'local',
      timestamp: TIMESTAMP,
      skipPreBackup: true,
    });

    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('EACCES');
    errorSpy.mockRestore();
  });

  it('should clean up temp dir even when extraction fails', async () => {
    mockExtractArchive.mockRejectedValue(new Error('extraction failed'));

    await expect(
      runRestore(makeConfig(), { source: 'local', timestamp: TIMESTAMP }),
    ).rejects.toThrow('extraction failed');

    expect(mockRm).toHaveBeenCalledWith(TMP_DIR, { recursive: true, force: true });
  });
});
