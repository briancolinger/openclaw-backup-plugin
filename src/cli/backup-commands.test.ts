import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerBackupCommands } from './backup-commands.js';
import { type CommandLike } from './shared.js';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const {
  mockLoadBackupConfig,
  mockRunBackup,
  mockGetIndex,
  mockLoadCachedIndex,
  mockPruneBackups,
  mockCreateStorageProviders,
  mockCheckAgeInstalled,
  mockCheckRcloneInstalled,
  mockRotateKey,
} = vi.hoisted(() => ({
  mockLoadBackupConfig: vi.fn(),
  mockRunBackup: vi.fn(),
  mockGetIndex: vi.fn(),
  mockLoadCachedIndex: vi.fn(),
  mockPruneBackups: vi.fn(),
  mockCreateStorageProviders: vi.fn(),
  mockCheckAgeInstalled: vi.fn(),
  mockCheckRcloneInstalled: vi.fn(),
  mockRotateKey: vi.fn(),
}));

vi.mock('../config.js', () => ({ loadBackupConfig: mockLoadBackupConfig }));
vi.mock('../backup/backup.js', () => ({ runBackup: mockRunBackup }));
vi.mock('../index-manager.js', () => ({
  getIndex: mockGetIndex,
  loadCachedIndex: mockLoadCachedIndex,
}));
vi.mock('../index-prune.js', () => ({
  pruneBackups: mockPruneBackups,
}));
vi.mock('../storage/providers.js', () => ({ createStorageProviders: mockCreateStorageProviders }));
vi.mock('../backup/encrypt.js', () => ({ checkAgeInstalled: mockCheckAgeInstalled }));
vi.mock('../storage/rclone.js', () => ({ checkRcloneInstalled: mockCheckRcloneInstalled }));
vi.mock('../backup/rotate.js', () => ({ rotateKey: mockRotateKey }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

/** Flush all pending microtasks and macrotasks so wrapAction-wrapped handlers complete. */
async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

type ActionFn = (opts: Record<string, unknown>) => void;

/**
 * Builds a minimal mock Commander that captures the action callback for each
 * subcommand by name. The mock chains are all stateful (same object returned
 * from every fluent method call), so the `current` variable tracks which
 * command is currently being built.
 */
function makeMockProgram(): { mock: CommandLike; getAction(name: string): ActionFn | undefined } {
  const captured = new Map<string, ActionFn>();
  let currentName = '__root__';

  const mock: CommandLike = {
    command(name: string): CommandLike {
      currentName = name;
      return mock;
    },
    description(): CommandLike {
      return mock;
    },
    option(): CommandLike {
      return mock;
    },
    action(fn: ActionFn): CommandLike {
      captured.set(currentName, fn);
      return mock;
    },
  };

  return {
    mock,
    getAction: (name: string) => captured.get(name),
  };
}

const BASE_CONFIG = {
  encrypt: false,
  encryptKeyPath: '/home/user/.openclaw/.secrets/backup.age',
  include: ['/home/user/.openclaw'],
  exclude: [],
  extraPaths: [],
  includeTranscripts: false,
  includePersistor: false,
  retention: { count: 10 },
  destinations: { local: { path: '/backups' } },
};

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let logSpy: ReturnType<typeof vi.spyOn>;
let errorSpy: ReturnType<typeof vi.spyOn>;

beforeEach(() => {
  vi.resetAllMocks();
  logSpy = vi.spyOn(console, 'log').mockImplementation(() => undefined);
  errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  mockLoadBackupConfig.mockReturnValue(BASE_CONFIG);
  process.exitCode = undefined;
});

afterEach(() => {
  logSpy.mockRestore();
  errorSpy.mockRestore();
  process.exitCode = undefined;
});

// ---------------------------------------------------------------------------
// handleBackup
// ---------------------------------------------------------------------------

describe('handleBackup', () => {
  it('should call runBackup with config from loadBackupConfig', async () => {
    mockRunBackup.mockResolvedValue({
      dryRun: false,
      fileCount: 5,
      archiveSize: 2048,
      destinations: ['local'],
      encrypted: false,
      timestamp: '2026-01-01T12:00:00.000Z',
    });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('backup')?.({});
    await flushPromises();

    expect(mockLoadBackupConfig).toHaveBeenCalledOnce();
    expect(mockRunBackup).toHaveBeenCalledWith(BASE_CONFIG, {});
  });

  it('should pass dest, includeTranscripts, includePersistor, and dryRun options to runBackup', async () => {
    mockRunBackup.mockResolvedValue({
      dryRun: true,
      fileCount: 3,
      archiveSize: 0,
      destinations: [],
      encrypted: false,
      timestamp: '2026-01-01T12:00:00.000Z',
    });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('backup')?.({
      dest: 'gdrive',
      includeTranscripts: true,
      includePersistor: true,
      dryRun: true,
    });
    await flushPromises();

    expect(mockRunBackup).toHaveBeenCalledWith(BASE_CONFIG, {
      destination: 'gdrive',
      includeTranscripts: true,
      includePersistor: true,
      dryRun: true,
    });
  });

  it('should log dry-run completion message when dryRun is true', async () => {
    mockRunBackup.mockResolvedValue({
      dryRun: true,
      fileCount: 7,
      archiveSize: 0,
      destinations: [],
      encrypted: false,
      timestamp: '2026-01-01T12:00:00.000Z',
    });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('backup')?.({ dryRun: true });
    await flushPromises();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('7 file(s)'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Dry run'));
  });

  it('should log backup summary when dryRun is false', async () => {
    mockRunBackup.mockResolvedValue({
      dryRun: false,
      fileCount: 4,
      archiveSize: 10 * 1024 * 1024,
      destinations: ['local', 'gdrive'],
      encrypted: true,
      timestamp: '2026-01-01T12:00:00.000Z',
    });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('backup')?.({});
    await flushPromises();

    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('Backup complete'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('4'));
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('local, gdrive'));
  });

  it('should set exitCode to 1 when runBackup rejects', async () => {
    mockRunBackup.mockRejectedValue(new Error('age not installed'));

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('backup')?.({});
    await flushPromises();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('age not installed'));
  });
});

// ---------------------------------------------------------------------------
// handleList
// ---------------------------------------------------------------------------

describe('handleList', () => {
  it('should log "No backups found" when index is empty', async () => {
    mockCreateStorageProviders.mockReturnValue([]);
    mockGetIndex.mockResolvedValue({ lastRefreshed: new Date().toISOString(), entries: [] });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('list')?.({});
    await flushPromises();

    expect(logSpy).toHaveBeenCalledWith('No backups found.');
  });

  it('should log table rows for each backup entry', async () => {
    mockCreateStorageProviders.mockReturnValue([]);
    mockGetIndex.mockResolvedValue({
      lastRefreshed: new Date().toISOString(),
      entries: [
        {
          timestamp: '2026-02-21T10:30:45.000Z',
          filename: '2026-02-21T10-30-45.tar.gz',
          providers: ['local'],
          encrypted: false,
          size: 5000,
          fileCount: 3,
        },
      ],
    });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('list')?.({});
    await flushPromises();

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((line) => line.includes('2026-02-21'))).toBe(true);
    expect(calls.some((line) => line.includes('1 backup'))).toBe(true);
  });

  it('should pass refresh option to getIndex', async () => {
    mockCreateStorageProviders.mockReturnValue([]);
    mockGetIndex.mockResolvedValue({ lastRefreshed: new Date().toISOString(), entries: [] });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('list')?.({ refresh: true });
    await flushPromises();

    expect(mockGetIndex).toHaveBeenCalledWith(expect.anything(), true);
  });

  it('should filter entries by source when --source is provided', async () => {
    mockCreateStorageProviders.mockReturnValue([]);
    mockGetIndex.mockResolvedValue({
      lastRefreshed: new Date().toISOString(),
      entries: [
        {
          timestamp: '2026-02-20T10:00:00.000Z',
          filename: '2026-02-20T10-00-00.tar.gz',
          providers: ['local'],
          encrypted: false,
          size: 1000,
          fileCount: 1,
        },
        {
          timestamp: '2026-02-21T10:00:00.000Z',
          filename: '2026-02-21T10-00-00.tar.gz',
          providers: ['gdrive'],
          encrypted: false,
          size: 2000,
          fileCount: 2,
        },
      ],
    });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('list')?.({ source: 'gdrive' });
    await flushPromises();

    // Only the gdrive entry should appear — 1 backup total
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((line) => line.includes('1 backup'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handlePrune
// ---------------------------------------------------------------------------

describe('handlePrune', () => {
  it('should prune using config retention count by default', async () => {
    mockCreateStorageProviders.mockReturnValue([]);
    mockPruneBackups.mockResolvedValue({ deleted: 2, kept: 10, errors: [] });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('prune')?.({});
    await flushPromises();

    expect(mockPruneBackups).toHaveBeenCalledWith(expect.anything(), { count: 10 });
    expect(logSpy).toHaveBeenCalledWith(expect.stringContaining('deleted 2'));
  });

  it('should use --keep value when provided', async () => {
    mockCreateStorageProviders.mockReturnValue([]);
    mockPruneBackups.mockResolvedValue({ deleted: 5, kept: 3, errors: [] });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('prune')?.({ keep: '3' });
    await flushPromises();

    expect(mockPruneBackups).toHaveBeenCalledWith(expect.anything(), { count: 3 });
  });

  it('should set exitCode to 1 when --keep is not a positive integer', async () => {
    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('prune')?.({ keep: 'not-a-number' });
    await flushPromises();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--keep'));
  });

  it('should print each prune error to stderr', async () => {
    mockCreateStorageProviders.mockReturnValue([]);
    mockPruneBackups.mockResolvedValue({
      deleted: 1,
      kept: 5,
      errors: ['Failed to delete 2026-01-01.tar.gz from gdrive'],
    });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('prune')?.({});
    await flushPromises();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to delete'));
  });
});

// ---------------------------------------------------------------------------
// handleStatus
// ---------------------------------------------------------------------------

describe('handleStatus', () => {
  it('should display last backup info from cached index', async () => {
    mockLoadCachedIndex.mockReturnValue({
      lastRefreshed: '2026-02-21T10:00:00.000Z',
      entries: [
        {
          timestamp: '2026-02-21T09:00:00.000Z',
          filename: '2026-02-21T09-00-00.tar.gz',
          providers: ['local'],
          encrypted: false,
          size: 1000,
          fileCount: 2,
        },
      ],
    });
    mockCheckAgeInstalled.mockResolvedValue({ name: 'age', available: true, version: 'v1.1.1' });
    mockCheckRcloneInstalled.mockResolvedValue({
      name: 'rclone',
      available: true,
      version: 'v1.68.0',
    });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('status')?.({});
    await flushPromises();

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((line) => line.includes('2026-02-21'))).toBe(true);
    expect(calls.some((line) => line.includes('age'))).toBe(true);
    expect(calls.some((line) => line.includes('rclone'))).toBe(true);
  });

  it('should suggest refreshing when no cached index exists', async () => {
    mockLoadCachedIndex.mockReturnValue(null);
    mockCheckAgeInstalled.mockResolvedValue({ name: 'age', available: false });
    mockCheckRcloneInstalled.mockResolvedValue({ name: 'rclone', available: false });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('status')?.({});
    await flushPromises();

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((line) => line.includes('--refresh'))).toBe(true);
  });

  it('should show "Config: not found" when loadBackupConfig throws', async () => {
    mockLoadCachedIndex.mockReturnValue(null);
    mockLoadBackupConfig.mockImplementation(() => {
      throw new Error('Config file missing');
    });
    mockCheckAgeInstalled.mockResolvedValue({ name: 'age', available: false });
    mockCheckRcloneInstalled.mockResolvedValue({ name: 'rclone', available: false });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('status')?.({});
    await flushPromises();

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((line) => line.includes('not found'))).toBe(true);
  });
});

// ---------------------------------------------------------------------------
// handleRotateKey
// ---------------------------------------------------------------------------

describe('handleRotateKey', () => {
  it('should call rotateKey with the loaded config and log results', async () => {
    mockRotateKey.mockResolvedValue({
      oldKeyId: 'old-abc123',
      newKeyId: 'new-def456',
      reencrypted: 0,
      errors: [],
    });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('rotate-key')?.({});
    await flushPromises();

    expect(mockRotateKey).toHaveBeenCalledWith(BASE_CONFIG, { reencrypt: false });
    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((line) => line.includes('old-abc123'))).toBe(true);
    expect(calls.some((line) => line.includes('new-def456'))).toBe(true);
  });

  it('should pass reencrypt and source options to rotateKey', async () => {
    mockRotateKey.mockResolvedValue({
      oldKeyId: 'a',
      newKeyId: 'b',
      reencrypted: 3,
      errors: [],
    });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('rotate-key')?.({ reencrypt: true, source: 'gdrive' });
    await flushPromises();

    expect(mockRotateKey).toHaveBeenCalledWith(BASE_CONFIG, { reencrypt: true, source: 'gdrive' });
  });

  it('should log re-encrypted count when --reencrypt is set', async () => {
    mockRotateKey.mockResolvedValue({
      oldKeyId: 'a',
      newKeyId: 'b',
      reencrypted: 5,
      errors: [],
    });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('rotate-key')?.({ reencrypt: true });
    await flushPromises();

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((line) => line.includes('5 archive'))).toBe(true);
  });

  it('should print errors to stderr after re-encryption', async () => {
    mockRotateKey.mockResolvedValue({
      oldKeyId: 'a',
      newKeyId: 'b',
      reencrypted: 2,
      errors: ['Failed to re-encrypt 2026-01-01.tar.gz'],
    });

    const { mock, getAction } = makeMockProgram();
    registerBackupCommands(mock);
    getAction('rotate-key')?.({ reencrypt: true });
    await flushPromises();

    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('Failed to re-encrypt'));
  });
});
