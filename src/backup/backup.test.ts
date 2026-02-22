import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import {
  type BackupConfig,
  type BackupManifest,
  type DestinationConfig,
  MANIFEST_SCHEMA_VERSION,
} from '../types.js';

import { runBackup } from './backup.js';

// ---------------------------------------------------------------------------
// Mock setup — all hoisted in one call so vi.mock factories can reference them
// ---------------------------------------------------------------------------

const {
  mockAccess,
  mockChmod,
  mockMkdtemp,
  mockReadFile,
  mockRm,
  mockStat,
  mockWriteFile,
  mockCheckAllPrerequisites,
  mockFormatPrerequisiteErrors,
  mockGenerateKey,
  mockGetKeyId,
  mockCreateRcloneProvider,
  mockCreateLocalProvider,
  mockCollectFiles,
  mockCreateArchiveStreaming,
  mockGenerateManifest,
  mockSerializeManifest,
  mockAcquireLock,
  mockVerifyDiskSpace,
  mockNotifyBackupSuccess,
  mockNotifyBackupFailure,
} = vi.hoisted(() => ({
  mockAccess: vi.fn(),
  mockChmod: vi.fn(),
  mockMkdtemp: vi.fn(),
  mockReadFile: vi.fn(),
  mockRm: vi.fn(),
  mockStat: vi.fn(),
  mockWriteFile: vi.fn(),
  mockCheckAllPrerequisites: vi.fn(),
  mockFormatPrerequisiteErrors: vi.fn(),
  mockGenerateKey: vi.fn(),
  mockGetKeyId: vi.fn(),
  mockCreateRcloneProvider: vi.fn(),
  mockCreateLocalProvider: vi.fn(),
  mockCollectFiles: vi.fn(),
  mockCreateArchiveStreaming: vi.fn(),
  mockGenerateManifest: vi.fn(),
  mockSerializeManifest: vi.fn(),
  mockAcquireLock: vi.fn(),
  mockVerifyDiskSpace: vi.fn(),
  mockNotifyBackupSuccess: vi.fn(),
  mockNotifyBackupFailure: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  access: mockAccess,
  chmod: mockChmod,
  mkdtemp: mockMkdtemp,
  readFile: mockReadFile,
  rm: mockRm,
  stat: mockStat,
  writeFile: mockWriteFile,
}));

vi.mock('./encrypt.js', () => ({
  generateKey: mockGenerateKey,
  getKeyId: mockGetKeyId,
}));

vi.mock('../storage/rclone.js', () => ({
  createRcloneProvider: mockCreateRcloneProvider,
}));

vi.mock('../prerequisites.js', () => ({
  checkAllPrerequisites: mockCheckAllPrerequisites,
  formatPrerequisiteErrors: mockFormatPrerequisiteErrors,
}));

vi.mock('../storage/local.js', () => ({ createLocalProvider: mockCreateLocalProvider }));
vi.mock('./collector.js', () => ({ collectFiles: mockCollectFiles }));
vi.mock('./archive-streaming.js', () => ({ createArchiveStreaming: mockCreateArchiveStreaming }));
vi.mock('./manifest.js', () => ({
  generateManifest: mockGenerateManifest,
  serializeManifest: mockSerializeManifest,
}));
vi.mock('./lock.js', () => ({ acquireLock: mockAcquireLock }));
vi.mock('./disk-check.js', () => ({ verifyDiskSpace: mockVerifyDiskSpace }));
vi.mock('../notifications.js', () => ({
  notifyBackupSuccess: mockNotifyBackupSuccess,
  notifyBackupFailure: mockNotifyBackupFailure,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY_PATH = '/home/user/.openclaw/.secrets/backup.age';
const TMP_DIR = '/tmp/openclaw-backup-abc123';

const sampleFiles = [
  {
    absolutePath: '/home/user/.openclaw/settings.json',
    relativePath: '.openclaw/settings.json',
    size: 500,
    modified: '2026-01-01T00:00:00.000Z',
  },
  {
    absolutePath: '/home/user/.openclaw/data.db',
    relativePath: '.openclaw/data.db',
    size: 2000,
    modified: '2026-01-15T12:00:00.000Z',
  },
];

interface ManifestOverrides {
  encrypted?: boolean;
}

function makeManifest(overrides: ManifestOverrides = {}): BackupManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    pluginVersion: '0.1.0',
    hostname: 'test-host',
    timestamp: '2026-02-21T10:30:45.000Z',
    encrypted: overrides.encrypted ?? false,
    includeTranscripts: false,
    includePersistor: false,
    files: [],
  };
}

interface ConfigOverrides {
  encrypt?: boolean;
  destinations?: Record<string, DestinationConfig>;
  includeTranscripts?: boolean;
  includePersistor?: boolean;
}

function makeConfig(overrides: ConfigOverrides = {}): BackupConfig {
  return {
    hostname: 'test-host',
    encrypt: overrides.encrypt ?? false,
    encryptKeyPath: KEY_PATH,
    include: ['/home/user/.openclaw'],
    exclude: [],
    extraPaths: [],
    includeTranscripts: overrides.includeTranscripts ?? false,
    includePersistor: overrides.includePersistor ?? false,
    retention: { count: 10 },
    destinations: overrides.destinations ?? { local: { path: '/backups' } },
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

const makeProvider = (name: string): MockStorageProvider => ({
  name,
  push: vi.fn().mockResolvedValue(undefined),
  pull: vi.fn().mockResolvedValue(undefined),
  list: vi.fn().mockResolvedValue([]),
  delete: vi.fn().mockResolvedValue(undefined),
  check: vi.fn().mockResolvedValue({ available: true }),
});

// ---------------------------------------------------------------------------
// runBackup
// ---------------------------------------------------------------------------

describe('runBackup', () => {
  let mockLocalProvider: ReturnType<typeof makeProvider>;

  beforeEach(() => {
    vi.resetAllMocks();
    mockLocalProvider = makeProvider('local');
    mockCreateLocalProvider.mockReturnValue(mockLocalProvider);
    mockCheckAllPrerequisites.mockResolvedValue([]);
    mockFormatPrerequisiteErrors.mockReturnValue('');
    mockAccess.mockResolvedValue(undefined);
    mockChmod.mockResolvedValue(undefined);
    mockMkdtemp.mockResolvedValue(TMP_DIR);
    mockReadFile.mockResolvedValue('{"version":"0.1.0"}');
    mockRm.mockResolvedValue(undefined);
    mockStat.mockResolvedValue({ size: 5000 });
    mockWriteFile.mockResolvedValue(undefined);
    mockCollectFiles.mockResolvedValue(sampleFiles);
    mockGenerateManifest.mockResolvedValue(makeManifest());
    mockSerializeManifest.mockReturnValue('{"serialized":"manifest"}');
    mockCreateArchiveStreaming.mockResolvedValue(undefined);
    mockGetKeyId.mockResolvedValue('abc123def456abcd');
    mockGenerateKey.mockResolvedValue('age1publickey...');
    mockAcquireLock.mockResolvedValue({ release: vi.fn().mockResolvedValue(undefined) });
    mockVerifyDiskSpace.mockResolvedValue(undefined);
    mockNotifyBackupSuccess.mockResolvedValue(undefined);
    mockNotifyBackupFailure.mockResolvedValue(undefined);
  });

  it('should run a complete backup and return a correct BackupResult', async () => {
    const result = await runBackup(makeConfig(), {});

    expect(mockCollectFiles).toHaveBeenCalledOnce();
    expect(mockCreateArchiveStreaming).toHaveBeenCalledOnce();
    expect(mockLocalProvider.push).toHaveBeenCalledTimes(2);
    expect(result).toMatchObject({
      dryRun: false,
      encrypted: false,
      fileCount: 2,
      archiveSize: 5000,
      destinations: ['local'],
      timestamp: '2026-02-21T10:30:45.000Z',
    });
    // Verify hostname-prefixed remote names (from manifest.timestamp + config.hostname)
    const calls = mockLocalProvider.push.mock.calls;
    expect(calls[0]?.[1]).toBe('test-host/test-host-2026-02-21T10-30-45.tar.gz');
    expect(calls[1]?.[1]).toBe('test-host/test-host-2026-02-21T10-30-45.manifest.json');
  });

  it('should pass encryptKeyPath to createArchiveStreaming when encryption is enabled', async () => {
    mockGenerateManifest.mockResolvedValue(makeManifest({ encrypted: true }));

    const result = await runBackup(makeConfig({ encrypt: true }), {});

    expect(mockGetKeyId).toHaveBeenCalledWith(KEY_PATH);
    expect(mockCreateArchiveStreaming).toHaveBeenCalledWith(
      expect.anything(),
      expect.anything(),
      expect.stringMatching(/test-host-.*\.tar\.gz\.age$/),
      KEY_PATH,
    );
    expect(result.encrypted).toBe(true);
    expect(mockLocalProvider.push.mock.calls[0]?.[1]).toMatch(/test-host\/test-host-.+\.tar\.gz\.age$/);
  });

  it('should return dry run result without creating an archive or acquiring a lock', async () => {
    const result = await runBackup(makeConfig(), { dryRun: true });

    expect(mockCreateArchiveStreaming).not.toHaveBeenCalled();
    expect(mockMkdtemp).not.toHaveBeenCalled();
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(result).toMatchObject({ dryRun: true, archiveSize: 0, fileCount: 2, destinations: [] });
  });

  it('should pass option overrides for includeTranscripts and includePersistor to collector', async () => {
    await runBackup(makeConfig({ includeTranscripts: false, includePersistor: false }), {
      includeTranscripts: true,
      includePersistor: true,
    });

    expect(mockCollectFiles).toHaveBeenCalledWith(
      expect.objectContaining({ includeTranscripts: true, includePersistor: true }),
    );
  });

  it('should push only to the specified destination when options.destination is set', async () => {
    const mockRcloneProvider = makeProvider('gdrive');
    mockCreateRcloneProvider.mockReturnValue(mockRcloneProvider);

    await runBackup(
      makeConfig({ destinations: { local: { path: '/backups' }, gdrive: { remote: 'gdrive:/' } } }),
      { destination: 'local' },
    );

    expect(mockCreateLocalProvider).toHaveBeenCalledOnce();
    expect(mockCreateRcloneProvider).not.toHaveBeenCalled();
    expect(mockLocalProvider.push).toHaveBeenCalledTimes(2);
    expect(mockRcloneProvider.push).not.toHaveBeenCalled();
  });

  it('should throw when age is not installed and encryption is enabled', async () => {
    mockCheckAllPrerequisites.mockResolvedValue([
      { name: 'age', available: false, error: 'command not found', installHint: 'brew install age' },
    ]);
    mockFormatPrerequisiteErrors.mockReturnValue('Missing dependency: age\n  Error: command not found');

    await expect(runBackup(makeConfig({ encrypt: true }), {})).rejects.toThrow(
      'Missing dependency: age',
    );
  });

  it('should throw when rclone is not installed and a remote destination is configured', async () => {
    mockCheckAllPrerequisites.mockResolvedValue([
      { name: 'rclone', available: false, error: 'command not found' },
    ]);
    mockFormatPrerequisiteErrors.mockReturnValue(
      'Missing dependency: rclone\n  Error: command not found',
    );

    await expect(
      runBackup(makeConfig({ destinations: { gdrive: { remote: 'gdrive:openclaw/' } } }), {}),
    ).rejects.toThrow('Missing dependency: rclone');
  });

  it('should generate a key and warn when the key file does not exist', async () => {
    // First access (keyFileExists) → key absent → generate. Second access (verifyKeyReadable) → passes.
    mockAccess
      .mockRejectedValueOnce(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }))
      .mockResolvedValue(undefined);
    const warnSpy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);

    await runBackup(makeConfig({ encrypt: true }), {});

    expect(mockGenerateKey).toHaveBeenCalledWith(KEY_PATH);
    expect(warnSpy).toHaveBeenCalledWith(expect.stringContaining('Generated new age key'));
    warnSpy.mockRestore();
  });

  it('should abort with a clear error when the key is inaccessible at verify time', async () => {
    // access always fails — key never becomes readable even after generation
    mockAccess.mockRejectedValue(new Error('ENOENT'));

    await expect(runBackup(makeConfig({ encrypt: true }), {})).rejects.toThrow(
      'Encryption key not found at',
    );
  });

  it('should clean up the temp dir and release the lock even when a push fails', async () => {
    const mockRelease = vi.fn().mockResolvedValue(undefined);
    mockAcquireLock.mockResolvedValue({ release: mockRelease });
    mockLocalProvider.push.mockRejectedValue(new Error('push failed'));

    await expect(runBackup(makeConfig(), {})).rejects.toThrow('push failed');
    expect(mockRm).toHaveBeenCalledWith(TMP_DIR, { recursive: true, force: true });
    expect(mockRelease).toHaveBeenCalledOnce();
  });

  it('should abort with a clear error when disk space is insufficient', async () => {
    mockVerifyDiskSpace.mockRejectedValue(
      new Error('Insufficient disk space for backup. Need ~120MB, have 50MB on /tmp.'),
    );

    await expect(runBackup(makeConfig(), {})).rejects.toThrow('Insufficient disk space');
    expect(mockAcquireLock).not.toHaveBeenCalled();
    expect(mockCreateArchiveStreaming).not.toHaveBeenCalled();
  });

  it('should push to all providers concurrently even when one push fails', async () => {
    const mockRcloneProvider = makeProvider('gdrive');
    mockCreateRcloneProvider.mockReturnValue(mockRcloneProvider);
    mockLocalProvider.push.mockRejectedValue(new Error('local push failed'));

    await expect(
      runBackup(
        makeConfig({ destinations: { local: { path: '/backups' }, gdrive: { remote: 'gdrive:/' } } }),
        {},
      ),
    ).rejects.toThrow('local push failed');

    // With Promise.allSettled, gdrive push is still attempted even after local fails
    expect(mockRcloneProvider.push).toHaveBeenCalled();
  });
});
