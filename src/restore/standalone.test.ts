import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type RestoreResult } from '../types.js';

import { buildConfig, parseArgs, runStandalone } from './standalone.js';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const { mockRunRestore } = vi.hoisted(() => ({
  mockRunRestore: vi.fn(),
}));

vi.mock('./restore.js', () => ({
  runRestore: mockRunRestore,
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const DEFAULT_RESULT: RestoreResult = {
  timestamp: '2024-01-15T10-30-00',
  fileCount: 5,
  dryRun: false,
  preBackupCreated: false,
  errors: [],
};

const DRY_RUN_RESULT: RestoreResult = {
  timestamp: '2024-01-15T10-30-00',
  fileCount: 5,
  dryRun: true,
  preBackupCreated: false,
  errors: [],
};

// ---------------------------------------------------------------------------
// parseArgs
// ---------------------------------------------------------------------------

describe('parseArgs', () => {
  it('should parse --flag=value form for all named flags', () => {
    const args = parseArgs([
      '--source=gdrive',
      '--path=gdrive:backups/',
      '--timestamp=2024-01-15T10-30-00',
      '--key=~/.openclaw/.secrets/backup.age',
      '--confirm',
      '--dry-run',
    ]);
    expect(args.source).toBe('gdrive');
    expect(args.path).toBe('gdrive:backups/');
    expect(args.timestamp).toBe('2024-01-15T10-30-00');
    expect(args.key).toBe('~/.openclaw/.secrets/backup.age');
    expect(args.confirm).toBe(true);
    expect(args.dryRun).toBe(true);
  });

  it('should parse --flag value (space-separated) form', () => {
    const args = parseArgs([
      '--source',
      'local',
      '--path',
      '/tmp/backups',
      '--confirm',
    ]);
    expect(args.source).toBe('local');
    expect(args.path).toBe('/tmp/backups');
    expect(args.confirm).toBe(true);
  });

  it('should default confirm and dryRun to false when not provided', () => {
    const args = parseArgs(['--source=local', '--path=/tmp']);
    expect(args.confirm).toBe(false);
    expect(args.dryRun).toBe(false);
  });

  it('should leave optional fields undefined when not provided', () => {
    const args = parseArgs(['--source=local', '--path=/tmp', '--confirm']);
    expect(args.timestamp).toBeUndefined();
    expect(args.key).toBeUndefined();
  });

  it('should throw when a named flag is missing its value', () => {
    expect(() => parseArgs(['--source'])).toThrow('--source requires a value');
    expect(() => parseArgs(['--path'])).toThrow('--path requires a value');
    expect(() => parseArgs(['--timestamp'])).toThrow('--timestamp requires a value');
    expect(() => parseArgs(['--key'])).toThrow('--key requires a value');
  });

  it('should throw on unknown arguments', () => {
    expect(() => parseArgs(['--unknown-flag'])).toThrow('Unknown argument: --unknown-flag');
  });

  it('should throw on unknown --flag=value flags', () => {
    expect(() => parseArgs(['--bogus=value'])).toThrow('Unknown flag: --bogus');
  });
});

// ---------------------------------------------------------------------------
// buildConfig
// ---------------------------------------------------------------------------

describe('buildConfig', () => {
  it('should build a local destination when path starts with /', () => {
    const args = parseArgs(['--source=local', '--path=/tmp/backups', '--confirm']);
    const config = buildConfig(args);
    expect(config.destinations['local']?.path).toBe('/tmp/backups');
    expect(config.destinations['local']?.remote).toBeUndefined();
  });

  it('should build a local destination when path starts with ~', () => {
    const args = parseArgs(['--source=local', '--path=~/backups', '--confirm']);
    const config = buildConfig(args);
    expect(config.destinations['local']?.path).toBe('~/backups');
  });

  it('should build a rclone destination when path looks like a remote spec', () => {
    const args = parseArgs(['--source=gdrive', '--path=gdrive:openclaw/', '--confirm']);
    const config = buildConfig(args);
    expect(config.destinations['gdrive']?.remote).toBe('gdrive:openclaw/');
    expect(config.destinations['gdrive']?.path).toBeUndefined();
  });

  it('should set encrypt=true and encryptKeyPath when --key is provided', () => {
    const args = parseArgs([
      '--source=local',
      '--path=/tmp',
      '--key=/home/user/.openclaw/.secrets/backup.age',
      '--confirm',
    ]);
    const config = buildConfig(args);
    expect(config.encrypt).toBe(true);
    expect(config.encryptKeyPath).toBe('/home/user/.openclaw/.secrets/backup.age');
  });

  it('should set encrypt=false when --key is not provided', () => {
    const args = parseArgs(['--source=local', '--path=/tmp', '--confirm']);
    const config = buildConfig(args);
    expect(config.encrypt).toBe(false);
  });

  it('should use the source name as the destination key', () => {
    const args = parseArgs(['--source=my-s3', '--path=s3:my-bucket/', '--confirm']);
    const config = buildConfig(args);
    expect(Object.keys(config.destinations)).toEqual(['my-s3']);
  });
});

// ---------------------------------------------------------------------------
// runStandalone — wiring to runRestore
// ---------------------------------------------------------------------------

describe('runStandalone', () => {
  beforeEach(() => {
    mockRunRestore.mockResolvedValue(DEFAULT_RESULT);
  });

  it('should call runRestore with config and options derived from flags', async () => {
    await runStandalone(['--source=local', '--path=/tmp/backups', '--confirm']);

    expect(mockRunRestore).toHaveBeenCalledOnce();
    expect(mockRunRestore).toHaveBeenCalledWith(
      expect.objectContaining({
        destinations: { local: { path: '/tmp/backups' } },
      }),
      expect.objectContaining({
        source: 'local',
        skipPreBackup: true,
      }),
    );
  });

  it('should pass dryRun=true when --dry-run flag is set', async () => {
    mockRunRestore.mockResolvedValue(DRY_RUN_RESULT);

    await runStandalone(['--source=local', '--path=/tmp', '--confirm', '--dry-run']);

    expect(mockRunRestore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ dryRun: true }),
    );
  });

  it('should pass timestamp when --timestamp is provided', async () => {
    await runStandalone([
      '--source=local',
      '--path=/tmp',
      '--timestamp=2024-01-15T10-30-00',
      '--confirm',
    ]);

    expect(mockRunRestore).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ timestamp: '2024-01-15T10-30-00' }),
    );
  });

  it('should throw when --confirm is missing', async () => {
    await expect(
      runStandalone(['--source=local', '--path=/tmp']),
    ).rejects.toThrow('--confirm is required');
  });

  it('should throw when --source is missing', async () => {
    await expect(runStandalone(['--path=/tmp', '--confirm'])).rejects.toThrow(
      '--source <name> is required',
    );
  });

  it('should throw when --path is missing', async () => {
    await expect(runStandalone(['--source=local', '--confirm'])).rejects.toThrow(
      '--path <location> is required',
    );
  });
});
