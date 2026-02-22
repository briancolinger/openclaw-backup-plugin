import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { registerRestoreCommands } from './restore-commands.js';
import { type CommandLike } from './shared.js';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const { mockLoadBackupConfig, mockRunRestore } = vi.hoisted(() => ({
  mockLoadBackupConfig: vi.fn(),
  mockRunRestore: vi.fn(),
}));

vi.mock('../config.js', () => ({ loadBackupConfig: mockLoadBackupConfig }));
vi.mock('../restore/restore.js', () => ({ runRestore: mockRunRestore }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function flushPromises(): Promise<void> {
  await new Promise<void>((resolve) => setTimeout(resolve, 0));
}

type ActionFn = (opts: Record<string, unknown>) => void;

function makeMockProgram(): { mock: CommandLike; getAction(): ActionFn | undefined } {
  let capturedAction: ActionFn | undefined;

  const mock: CommandLike = {
    command(): CommandLike {
      return mock;
    },
    description(): CommandLike {
      return mock;
    },
    option(): CommandLike {
      return mock;
    },
    action(fn: ActionFn): CommandLike {
      capturedAction = fn;
      return mock;
    },
  };

  return { mock, getAction: () => capturedAction };
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
// handleRestore
// ---------------------------------------------------------------------------

describe('handleRestore', () => {
  it('should throw without calling runRestore when --confirm is absent', async () => {
    const { mock, getAction } = makeMockProgram();
    registerRestoreCommands(mock);
    getAction()?.({ source: 'local' }); // confirm absent → defaults to false
    await flushPromises();

    expect(mockRunRestore).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--confirm'));
  });

  it('should throw without calling runRestore when --source is missing', async () => {
    const { mock, getAction } = makeMockProgram();
    registerRestoreCommands(mock);
    getAction()?.({ confirm: true }); // source absent
    await flushPromises();

    expect(mockRunRestore).not.toHaveBeenCalled();
    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('--source'));
  });

  it('should call runRestore with correct options when valid opts are provided', async () => {
    mockRunRestore.mockResolvedValue({
      timestamp: '2026-02-21T10:30:45.000Z',
      fileCount: 5,
      dryRun: false,
      preBackupCreated: true,
      errors: [],
    });

    const { mock, getAction } = makeMockProgram();
    registerRestoreCommands(mock);
    getAction()?.({ confirm: true, source: 'local' });
    await flushPromises();

    expect(mockLoadBackupConfig).toHaveBeenCalledOnce();
    expect(mockRunRestore).toHaveBeenCalledWith(BASE_CONFIG, { source: 'local' });
  });

  it('should pass timestamp option to runRestore when provided', async () => {
    mockRunRestore.mockResolvedValue({
      timestamp: '2026-01-01T10:00:00.000Z',
      fileCount: 2,
      dryRun: false,
      preBackupCreated: false,
      errors: [],
    });

    const { mock, getAction } = makeMockProgram();
    registerRestoreCommands(mock);
    getAction()?.({ confirm: true, source: 'local', timestamp: '2026-01-01T10-00-00' });
    await flushPromises();

    expect(mockRunRestore).toHaveBeenCalledWith(
      BASE_CONFIG,
      expect.objectContaining({ timestamp: '2026-01-01T10-00-00' }),
    );
  });

  it('should pass dryRun and skipPreBackup options when provided', async () => {
    mockRunRestore.mockResolvedValue({
      timestamp: '2026-01-01T10:00:00.000Z',
      fileCount: 2,
      dryRun: true,
      preBackupCreated: false,
      errors: [],
    });

    const { mock, getAction } = makeMockProgram();
    registerRestoreCommands(mock);
    getAction()?.({ confirm: true, source: 'local', dryRun: true, skipPreBackup: true });
    await flushPromises();

    expect(mockRunRestore).toHaveBeenCalledWith(
      BASE_CONFIG,
      expect.objectContaining({ dryRun: true, skipPreBackup: true }),
    );
  });

  it('should log dry-run completion message when result.dryRun is true', async () => {
    mockRunRestore.mockResolvedValue({
      timestamp: '2026-01-01T10:00:00.000Z',
      fileCount: 3,
      dryRun: true,
      preBackupCreated: false,
      errors: [],
    });

    const { mock, getAction } = makeMockProgram();
    registerRestoreCommands(mock);
    getAction()?.({ confirm: true, source: 'local', dryRun: true });
    await flushPromises();

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((line) => line.includes('3 file(s)'))).toBe(true);
    expect(calls.some((line) => line.includes('Dry run'))).toBe(true);
  });

  it('should log restore summary when dryRun is false', async () => {
    mockRunRestore.mockResolvedValue({
      timestamp: '2026-02-21T10:30:45.000Z',
      fileCount: 8,
      dryRun: false,
      preBackupCreated: true,
      errors: [],
    });

    const { mock, getAction } = makeMockProgram();
    registerRestoreCommands(mock);
    getAction()?.({ confirm: true, source: 'local' });
    await flushPromises();

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((line) => line.includes('Restore complete'))).toBe(true);
    expect(calls.some((line) => line.includes('8'))).toBe(true);
    expect(calls.some((line) => line.includes('created'))).toBe(true);
  });

  it('should log per-file errors to stderr when restore has copy failures', async () => {
    mockRunRestore.mockResolvedValue({
      timestamp: '2026-02-21T10:30:45.000Z',
      fileCount: 3,
      dryRun: false,
      preBackupCreated: false,
      errors: ['Failed to restore .openclaw/data.db: EACCES'],
    });

    const { mock, getAction } = makeMockProgram();
    registerRestoreCommands(mock);
    getAction()?.({ confirm: true, source: 'local' });
    await flushPromises();

    const calls = logSpy.mock.calls.map((c) => String(c[0]));
    expect(calls.some((line) => line.includes('1 file(s) failed'))).toBe(true);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('EACCES'));
  });

  it('should set exitCode to 1 when runRestore rejects', async () => {
    mockRunRestore.mockRejectedValue(new Error('archive not found'));

    const { mock, getAction } = makeMockProgram();
    registerRestoreCommands(mock);
    getAction()?.({ confirm: true, source: 'local' });
    await flushPromises();

    expect(process.exitCode).toBe(1);
    expect(errorSpy).toHaveBeenCalledWith(expect.stringContaining('archive not found'));
  });
});
