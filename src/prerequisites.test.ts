import { beforeEach, describe, expect, it, vi } from 'vitest';

import {
  checkAllPrerequisites,
  checkPrerequisitesJson,
  formatPrerequisiteErrors,
} from './prerequisites.js';
import { type BackupConfig, type DestinationConfig, type PrerequisiteCheck } from './types.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockCheckAgeInstalled, mockCheckRcloneInstalled } = vi.hoisted(() => ({
  mockCheckAgeInstalled: vi.fn(),
  mockCheckRcloneInstalled: vi.fn(),
}));

vi.mock('./backup/encrypt.js', () => ({
  checkAgeInstalled: mockCheckAgeInstalled,
}));

vi.mock('./storage/rclone.js', () => ({
  checkRcloneInstalled: mockCheckRcloneInstalled,
}));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

interface ConfigOverrides {
  encrypt?: boolean;
  destinations?: Record<string, DestinationConfig>;
}

function makeConfig(overrides: ConfigOverrides = {}): BackupConfig {
  return {
    encrypt: overrides.encrypt ?? false,
    encryptKeyPath: '~/.openclaw/.secrets/backup.age',
    include: ['~/.openclaw'],
    exclude: [],
    extraPaths: [],
    includeTranscripts: false,
    includePersistor: false,
    retention: { count: 10 },
    destinations: overrides.destinations ?? { local: { path: '/tmp/backups' } },
  };
}

const AGE_OK: PrerequisiteCheck = { name: 'age', available: true, version: '1.1.1' };
const RCLONE_OK: PrerequisiteCheck = {
  name: 'rclone',
  available: true,
  version: '1.65.0',
  installHint: 'curl https://rclone.org/install.sh | sudo bash',
};
const AGE_MISSING: PrerequisiteCheck = {
  name: 'age',
  available: false,
  error: 'age: command not found',
  installHint: 'sudo apt install age',
};
const RCLONE_MISSING: PrerequisiteCheck = {
  name: 'rclone',
  available: false,
  error: 'rclone: command not found',
  installHint: 'curl https://rclone.org/install.sh | sudo bash',
};

// ---------------------------------------------------------------------------
// checkAllPrerequisites
// ---------------------------------------------------------------------------

describe('checkAllPrerequisites', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return empty array when encrypt is false and destinations are local', async () => {
    const config = makeConfig({ encrypt: false, destinations: { local: { path: '/tmp' } } });
    const checks = await checkAllPrerequisites(config);
    expect(checks).toEqual([]);
    expect(mockCheckAgeInstalled).not.toHaveBeenCalled();
    expect(mockCheckRcloneInstalled).not.toHaveBeenCalled();
  });

  it('should check age when encrypt is true', async () => {
    mockCheckAgeInstalled.mockResolvedValue(AGE_OK);
    const config = makeConfig({ encrypt: true, destinations: { local: { path: '/tmp' } } });
    const checks = await checkAllPrerequisites(config);
    expect(checks).toEqual([AGE_OK]);
    expect(mockCheckAgeInstalled).toHaveBeenCalledOnce();
    expect(mockCheckRcloneInstalled).not.toHaveBeenCalled();
  });

  it('should check rclone when a remote destination is configured', async () => {
    mockCheckRcloneInstalled.mockResolvedValue(RCLONE_OK);
    const config = makeConfig({
      encrypt: false,
      destinations: { gdrive: { remote: 'gdrive:openclaw-backups/' } },
    });
    const checks = await checkAllPrerequisites(config);
    expect(checks).toEqual([RCLONE_OK]);
    expect(mockCheckAgeInstalled).not.toHaveBeenCalled();
    expect(mockCheckRcloneInstalled).toHaveBeenCalledOnce();
  });

  it('should skip rclone when all destinations are local', async () => {
    const config = makeConfig({
      encrypt: false,
      destinations: { home: { path: '/home/user/backups' }, work: { path: '/mnt/nas/backups' } },
    });
    const checks = await checkAllPrerequisites(config);
    expect(checks).toEqual([]);
    expect(mockCheckRcloneInstalled).not.toHaveBeenCalled();
  });

  it('should check both when encrypt is true and a remote destination is configured', async () => {
    mockCheckAgeInstalled.mockResolvedValue(AGE_OK);
    mockCheckRcloneInstalled.mockResolvedValue(RCLONE_OK);
    const config = makeConfig({
      encrypt: true,
      destinations: { gdrive: { remote: 'gdrive:openclaw-backups/' } },
    });
    const checks = await checkAllPrerequisites(config);
    expect(checks).toHaveLength(2);
    expect(checks).toContainEqual(AGE_OK);
    expect(checks).toContainEqual(RCLONE_OK);
  });

  it('should return failing check when age is missing', async () => {
    mockCheckAgeInstalled.mockResolvedValue(AGE_MISSING);
    const config = makeConfig({ encrypt: true, destinations: { local: { path: '/tmp' } } });
    const checks = await checkAllPrerequisites(config);
    expect(checks).toEqual([AGE_MISSING]);
  });

  it('should return failing check when rclone is missing', async () => {
    mockCheckRcloneInstalled.mockResolvedValue(RCLONE_MISSING);
    const config = makeConfig({
      encrypt: false,
      destinations: { s3: { remote: 's3:my-bucket/openclaw/' } },
    });
    const checks = await checkAllPrerequisites(config);
    expect(checks).toEqual([RCLONE_MISSING]);
  });
});

// ---------------------------------------------------------------------------
// formatPrerequisiteErrors
// ---------------------------------------------------------------------------

describe('formatPrerequisiteErrors', () => {
  it('should return empty string when all checks pass', () => {
    expect(formatPrerequisiteErrors([AGE_OK, RCLONE_OK])).toBe('');
  });

  it('should return empty string for empty array', () => {
    expect(formatPrerequisiteErrors([])).toBe('');
  });

  it('should format a missing age check with why, install, and docs', () => {
    const output = formatPrerequisiteErrors([AGE_MISSING]);
    expect(output).toContain('Missing dependency: age');
    expect(output).toContain('Why:');
    expect(output).toContain('encrypt');
    expect(output).toContain('Install: sudo apt install age');
    expect(output).toContain('Docs: https://age-encryption.org');
    expect(output).toContain('Error: age: command not found');
  });

  it('should format a missing rclone check with why, install, and docs', () => {
    const output = formatPrerequisiteErrors([RCLONE_MISSING]);
    expect(output).toContain('Missing dependency: rclone');
    expect(output).toContain('Why:');
    expect(output).toContain('remote storage');
    expect(output).toContain('Install: curl https://rclone.org/install.sh | sudo bash');
    expect(output).toContain('Docs: https://rclone.org');
    expect(output).toContain('Error: rclone: command not found');
  });

  it('should separate multiple errors with a double newline', () => {
    const output = formatPrerequisiteErrors([AGE_MISSING, RCLONE_MISSING]);
    expect(output).toContain('\n\n');
    expect(output).toContain('age');
    expect(output).toContain('rclone');
  });

  it('should omit error line when error field is absent', () => {
    const check: PrerequisiteCheck = {
      name: 'age',
      available: false,
      installHint: 'brew install age',
    };
    const output = formatPrerequisiteErrors([check]);
    expect(output).not.toContain('Error:');
    expect(output).toContain('Install: brew install age');
  });

  it('should fall back to platform install hint when installHint is not set', () => {
    const check: PrerequisiteCheck = { name: 'age', available: false };
    const output = formatPrerequisiteErrors([check]);
    expect(output).toMatch(/Install: (brew install age|sudo apt install age)/);
  });

  it('should use a generic reason for an unknown tool', () => {
    const check: PrerequisiteCheck = {
      name: 'some-tool',
      available: false,
      installHint: 'install some-tool',
    };
    const output = formatPrerequisiteErrors([check]);
    expect(output).toContain('Missing dependency: some-tool');
    expect(output).toContain('Required for backup/restore operations.');
  });

  it('should not include docs line for an unknown tool', () => {
    const check: PrerequisiteCheck = {
      name: 'some-tool',
      available: false,
      installHint: 'install some-tool',
    };
    const output = formatPrerequisiteErrors([check]);
    expect(output).not.toContain('Docs:');
  });
});

// ---------------------------------------------------------------------------
// checkPrerequisitesJson
// ---------------------------------------------------------------------------

describe('checkPrerequisitesJson', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return ok true when all checks pass', async () => {
    mockCheckAgeInstalled.mockResolvedValue(AGE_OK);
    const config = makeConfig({ encrypt: true, destinations: { local: { path: '/tmp' } } });
    const result = await checkPrerequisitesJson(config);
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([AGE_OK]);
  });

  it('should return ok false when any check fails', async () => {
    mockCheckAgeInstalled.mockResolvedValue(AGE_MISSING);
    const config = makeConfig({ encrypt: true, destinations: { local: { path: '/tmp' } } });
    const result = await checkPrerequisitesJson(config);
    expect(result.ok).toBe(false);
    expect(result.checks).toEqual([AGE_MISSING]);
  });

  it('should return ok true with empty checks for local-only no-encrypt config', async () => {
    const config = makeConfig({ encrypt: false, destinations: { local: { path: '/tmp' } } });
    const result = await checkPrerequisitesJson(config);
    expect(result.ok).toBe(true);
    expect(result.checks).toEqual([]);
  });

  it('should return ok false when both age and rclone are missing', async () => {
    mockCheckAgeInstalled.mockResolvedValue(AGE_MISSING);
    mockCheckRcloneInstalled.mockResolvedValue(RCLONE_MISSING);
    const config = makeConfig({
      encrypt: true,
      destinations: { gdrive: { remote: 'gdrive:openclaw-backups/' } },
    });
    const result = await checkPrerequisitesJson(config);
    expect(result.ok).toBe(false);
    expect(result.checks).toHaveLength(2);
    expect(result.checks).toContainEqual(AGE_MISSING);
    expect(result.checks).toContainEqual(RCLONE_MISSING);
  });
});
