import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type BackupConfig, type BackupNotification, type BackupResult } from './types.js';

import {
  clearAlerts,
  getConsecutiveFailures,
  notifyBackupFailure,
  notifyBackupSuccess,
  readAlerts,
  readLastResult,
} from './notifications.js';

// ---------------------------------------------------------------------------
// Mocks
// ---------------------------------------------------------------------------

const {
  mockAppendFile,
  mockMkdir,
  mockReadFile,
  mockUnlink,
  mockWriteFile,
  mockOsHostname,
} = vi.hoisted(() => ({
  mockAppendFile: vi.fn(),
  mockMkdir: vi.fn(),
  mockReadFile: vi.fn(),
  mockUnlink: vi.fn(),
  mockWriteFile: vi.fn(),
  mockOsHostname: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  appendFile: mockAppendFile,
  mkdir: mockMkdir,
  readFile: mockReadFile,
  unlink: mockUnlink,
  writeFile: mockWriteFile,
}));

vi.mock('node:os', () => ({
  hostname: mockOsHostname,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const OPENCLAW_DIR = '/home/user/.openclaw';
const LAST_RESULT_PATH = `${OPENCLAW_DIR}/backup-last-result.json`;
const ALERTS_PATH = `${OPENCLAW_DIR}/backup-alerts.jsonl`;

const baseConfig: BackupConfig = {
  hostname: 'test-host',
  encrypt: false,
  encryptKeyPath: '/path/to/key.age',
  include: [],
  exclude: [],
  extraPaths: [],
  includeTranscripts: false,
  includePersistor: false,
  retention: { count: 10 },
  destinations: {},
};

const successResult: BackupResult = {
  timestamp: '2026-02-22T10:00:00.000Z',
  archiveSize: 1024,
  fileCount: 5,
  encrypted: false,
  destinations: ['local'],
  dryRun: false,
};

function makeSuccessNotification(
  overrides: Partial<BackupNotification> = {},
): BackupNotification {
  return {
    type: 'success',
    timestamp: '2026-02-22T10:00:00.000Z',
    hostname: 'test-host',
    consecutiveFailures: 0,
    details: successResult,
    ...overrides,
  };
}

function makeFailureNotification(
  overrides: Partial<BackupNotification> = {},
): BackupNotification {
  return {
    type: 'failure',
    timestamp: '2026-02-22T11:00:00.000Z',
    hostname: 'test-host',
    consecutiveFailures: 1,
    details: { error: 'push failed' },
    ...overrides,
  };
}

// ---------------------------------------------------------------------------
// readLastResult
// ---------------------------------------------------------------------------

describe('readLastResult', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return null when file is missing', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    const result = await readLastResult(LAST_RESULT_PATH);
    expect(result).toBeNull();
  });

  it('should return null when file contains invalid JSON', async () => {
    mockReadFile.mockResolvedValue('not json');
    const result = await readLastResult(LAST_RESULT_PATH);
    expect(result).toBeNull();
  });

  it('should return null when JSON does not match BackupNotification shape', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ type: 'unknown', timestamp: 'x' }));
    const result = await readLastResult(LAST_RESULT_PATH);
    expect(result).toBeNull();
  });

  it('should return a valid success notification', async () => {
    const notification = makeSuccessNotification();
    mockReadFile.mockResolvedValue(JSON.stringify(notification));
    const result = await readLastResult(LAST_RESULT_PATH);
    expect(result).toEqual(notification);
  });

  it('should return a valid failure notification', async () => {
    const notification = makeFailureNotification();
    mockReadFile.mockResolvedValue(JSON.stringify(notification));
    const result = await readLastResult(LAST_RESULT_PATH);
    expect(result).toEqual(notification);
  });
});

// ---------------------------------------------------------------------------
// readAlerts
// ---------------------------------------------------------------------------

describe('readAlerts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return empty array when file is missing', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await readAlerts(ALERTS_PATH)).toEqual([]);
  });

  it('should parse multiple valid JSONL lines', async () => {
    const n1 = makeFailureNotification({ consecutiveFailures: 3 });
    const n2 = makeFailureNotification({ consecutiveFailures: 4 });
    mockReadFile.mockResolvedValue(`${JSON.stringify(n1)}\n${JSON.stringify(n2)}\n`);
    const result = await readAlerts(ALERTS_PATH);
    expect(result).toHaveLength(2);
    expect(result[0]).toEqual(n1);
    expect(result[1]).toEqual(n2);
  });

  it('should skip malformed lines silently', async () => {
    const n1 = makeFailureNotification();
    mockReadFile.mockResolvedValue(`${JSON.stringify(n1)}\nbad json\n{"type":"also bad"}\n`);
    const result = await readAlerts(ALERTS_PATH);
    expect(result).toHaveLength(1);
  });
});

// ---------------------------------------------------------------------------
// clearAlerts
// ---------------------------------------------------------------------------

describe('clearAlerts', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should unlink the alerts file', async () => {
    mockUnlink.mockResolvedValue(undefined);
    await clearAlerts(ALERTS_PATH);
    expect(mockUnlink).toHaveBeenCalledWith(ALERTS_PATH);
  });

  it('should silently ignore ENOENT', async () => {
    mockUnlink.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    await expect(clearAlerts(ALERTS_PATH)).resolves.toBeUndefined();
  });

  it('should rethrow non-ENOENT errors', async () => {
    mockUnlink.mockRejectedValue(Object.assign(new Error('EPERM'), { code: 'EPERM' }));
    await expect(clearAlerts(ALERTS_PATH)).rejects.toThrow('Failed to clear alerts');
  });
});

// ---------------------------------------------------------------------------
// notifyBackupSuccess
// ---------------------------------------------------------------------------

describe('notifyBackupSuccess', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockOsHostname.mockReturnValue('os-host');
  });

  it('should write a success notification to the last result file', async () => {
    await notifyBackupSuccess(baseConfig, successResult, OPENCLAW_DIR);

    expect(mockMkdir).toHaveBeenCalledWith(OPENCLAW_DIR, { recursive: true });
    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [path, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    expect(path).toBe(LAST_RESULT_PATH);
    const written: unknown = JSON.parse(content);
    expect(written).toMatchObject({
      type: 'success',
      hostname: 'test-host',
      consecutiveFailures: 0,
      timestamp: successResult.timestamp,
    });
  });

  it('should use os.hostname() when config.hostname is not set', async () => {
    // Remove hostname so the production code falls back to os.hostname()
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    const { hostname: _remove, ...rest } = baseConfig;
    const configNoHostname: BackupConfig = rest;
    await notifyBackupSuccess(configNoHostname, successResult, OPENCLAW_DIR);
    const [, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    const written: unknown = JSON.parse(content);
    expect(written).toMatchObject({ hostname: 'os-host' });
  });
});

// ---------------------------------------------------------------------------
// notifyBackupFailure
// ---------------------------------------------------------------------------

describe('notifyBackupFailure', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockMkdir.mockResolvedValue(undefined);
    mockWriteFile.mockResolvedValue(undefined);
    mockAppendFile.mockResolvedValue(undefined);
    mockOsHostname.mockReturnValue('os-host');
    // Default: no prior result
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
  });

  it('should write a failure notification with consecutiveFailures=1 on first failure', async () => {
    await notifyBackupFailure(baseConfig, new Error('disk full'), OPENCLAW_DIR);

    expect(mockWriteFile).toHaveBeenCalledOnce();
    const [path, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    expect(path).toBe(LAST_RESULT_PATH);
    const written: unknown = JSON.parse(content);
    expect(written).toMatchObject({
      type: 'failure',
      consecutiveFailures: 1,
      hostname: 'test-host',
      details: { error: 'disk full' },
    });
  });

  it('should increment consecutiveFailures from prior failure', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(makeFailureNotification({ consecutiveFailures: 2 })));
    await notifyBackupFailure(baseConfig, new Error('push failed'), OPENCLAW_DIR);

    const [, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    const written: unknown = JSON.parse(content);
    expect(written).toMatchObject({ consecutiveFailures: 3 });
  });

  it('should reset count when prior result was success', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(makeSuccessNotification()));
    await notifyBackupFailure(baseConfig, new Error('oops'), OPENCLAW_DIR);

    const [, content] = mockWriteFile.mock.calls[0] as [string, string, unknown];
    const written: unknown = JSON.parse(content);
    expect(written).toMatchObject({ consecutiveFailures: 1 });
  });

  it('should NOT append to alerts before reaching the threshold', async () => {
    const config: BackupConfig = { ...baseConfig, alertAfterFailures: 3 };
    // 1st failure — below threshold
    await notifyBackupFailure(config, new Error('fail'), OPENCLAW_DIR);
    expect(mockAppendFile).not.toHaveBeenCalled();
  });

  it('should append to alerts when consecutiveFailures reaches the threshold', async () => {
    const config: BackupConfig = { ...baseConfig, alertAfterFailures: 3 };
    mockReadFile.mockResolvedValue(JSON.stringify(makeFailureNotification({ consecutiveFailures: 2 })));
    await notifyBackupFailure(config, new Error('persistent'), OPENCLAW_DIR);

    expect(mockAppendFile).toHaveBeenCalledOnce();
    const [alertPath] = mockAppendFile.mock.calls[0] as [string, ...unknown[]];
    expect(alertPath).toBe(ALERTS_PATH);
  });

  it('should use default threshold of 3 when alertAfterFailures is not configured', async () => {
    // 2 prior failures → 3rd failure triggers alert
    mockReadFile.mockResolvedValue(JSON.stringify(makeFailureNotification({ consecutiveFailures: 2 })));
    await notifyBackupFailure(baseConfig, new Error('again'), OPENCLAW_DIR);
    expect(mockAppendFile).toHaveBeenCalledOnce();
  });
});

// ---------------------------------------------------------------------------
// getConsecutiveFailures
// ---------------------------------------------------------------------------

describe('getConsecutiveFailures', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return 0 when no last result file exists', async () => {
    mockReadFile.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));
    expect(await getConsecutiveFailures(LAST_RESULT_PATH)).toBe(0);
  });

  it('should return 0 when last result was a success', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(makeSuccessNotification()));
    expect(await getConsecutiveFailures(LAST_RESULT_PATH)).toBe(0);
  });

  it('should return the stored count when last result was a failure', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify(makeFailureNotification({ consecutiveFailures: 5 })));
    expect(await getConsecutiveFailures(LAST_RESULT_PATH)).toBe(5);
  });
});
