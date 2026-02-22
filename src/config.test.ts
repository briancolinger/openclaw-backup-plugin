import { beforeEach, describe, expect, it, vi } from 'vitest';

import { getDefaultConfig, loadBackupConfig, parseBackupConfig } from './config.js';

// vi.hoisted runs before vi.mock factories, making these available to them.
const { mockReadFileSync, mockReadFile, mockHomedir } = vi.hoisted(() => ({
  mockReadFileSync: vi.fn(),
  mockReadFile: vi.fn(),
  mockHomedir: vi.fn(),
}));

vi.mock('node:fs', () => ({ readFileSync: mockReadFileSync }));
vi.mock('node:fs/promises', () => ({ readFile: mockReadFile }));
vi.mock('node:os', () => ({ homedir: mockHomedir }));

const HOME = '/home/testuser';

beforeEach(() => {
  vi.resetAllMocks();
  mockHomedir.mockReturnValue(HOME);
});

// ---------------------------------------------------------------------------
// getDefaultConfig
// ---------------------------------------------------------------------------

describe('getDefaultConfig', () => {
  it('should return sensible defaults with resolved paths', () => {
    const config = getDefaultConfig();
    expect(config.encrypt).toBe(true);
    expect(config.encryptKeyPath).toBe(`${HOME}/.openclaw/.secrets/backup.age`);
    expect(config.include).toEqual([`${HOME}/.openclaw`]);
    expect(config.exclude).toContain(`${HOME}/.openclaw/logs`);
    expect(config.exclude).toContain('*.jsonl');
    expect(config.extraPaths).toEqual([]);
    expect(config.includeTranscripts).toBe(false);
    expect(config.includePersistor).toBe(false);
    expect(config.retention).toEqual({ count: 168 });
    expect(config.destinations).toEqual({});
    expect(config.schedule).toBeUndefined();
  });
});

// ---------------------------------------------------------------------------
// parseBackupConfig
// ---------------------------------------------------------------------------

describe('parseBackupConfig', () => {
  it('should parse a complete valid config and resolve ~ in all path fields', () => {
    const config = parseBackupConfig({
      encrypt: false,
      encryptKeyPath: '~/.age/key',
      include: ['~/.openclaw', '~/notes'],
      exclude: ['*.log'],
      extraPaths: ['~/projects'],
      includeTranscripts: true,
      includePersistor: true,
      schedule: '0 * * * *',
      retention: { count: 48 },
      destinations: {
        local: { path: '~/backups' },
        cloud: { remote: 'gdrive:openclaw/' },
        hybrid: { path: '~/alt', remote: 's3:bucket/' },
      },
    });

    expect(config.encrypt).toBe(false);
    expect(config.encryptKeyPath).toBe(`${HOME}/.age/key`);
    expect(config.include).toEqual([`${HOME}/.openclaw`, `${HOME}/notes`]);
    expect(config.exclude).toEqual(['*.log']);
    expect(config.extraPaths).toEqual([`${HOME}/projects`]);
    expect(config.includeTranscripts).toBe(true);
    expect(config.includePersistor).toBe(true);
    expect(config.schedule).toBe('0 * * * *');
    expect(config.retention).toEqual({ count: 48 });
    expect(config.destinations['local']).toEqual({ path: `${HOME}/backups` });
    expect(config.destinations['cloud']).toEqual({ remote: 'gdrive:openclaw/' });
    expect(config.destinations['hybrid']).toEqual({
      path: `${HOME}/alt`,
      remote: 's3:bucket/',
    });
  });

  it('should apply defaults for all missing fields', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    const config = parseBackupConfig({});
    expect(config.encrypt).toBe(true);
    expect(config.encryptKeyPath).toBe(`${HOME}/.openclaw/.secrets/backup.age`);
    expect(config.include).toEqual([`${HOME}/.openclaw`]);
    expect(config.extraPaths).toEqual([]);
    expect(config.includeTranscripts).toBe(false);
    expect(config.includePersistor).toBe(false);
    expect(config.retention).toEqual({ count: 168 });
    expect(config.destinations).toEqual({});
    expect(config.schedule).toBeUndefined();
    spy.mockRestore();
  });

  it('should warn but not throw when no destinations are configured', () => {
    const spy = vi.spyOn(console, 'warn').mockImplementation(() => undefined);
    expect(() => parseBackupConfig({})).not.toThrow();
    expect(spy).toHaveBeenCalledOnce();
    expect(spy).toHaveBeenCalledWith(expect.stringContaining('no destinations configured'));
    spy.mockRestore();
  });

  it('should throw when raw is not an object', () => {
    for (const bad of ['string', null, 42, []]) {
      expect(() => parseBackupConfig(bad)).toThrow('backup config must be a JSON object');
    }
  });

  it('should throw when encrypt is not a boolean', () => {
    expect(() => parseBackupConfig({ encrypt: 'yes', destinations: { l: { path: '/' } } })).toThrow(
      'config.encrypt must be a boolean',
    );
  });

  it('should throw when include is not an array of strings', () => {
    expect(() =>
      parseBackupConfig({ include: '~/.openclaw', destinations: { l: { path: '/' } } }),
    ).toThrow('config.include must be an array of strings');

    expect(() =>
      parseBackupConfig({ include: ['~/.openclaw', 42], destinations: { l: { path: '/' } } }),
    ).toThrow('config.include[1] must be a string');
  });

  it('should throw when retention is invalid', () => {
    expect(() =>
      parseBackupConfig({ retention: '7days', destinations: { l: { path: '/' } } }),
    ).toThrow('config.retention must be an object');

    for (const bad of [0, -5, 1.5, '7']) {
      expect(() =>
        parseBackupConfig({ retention: { count: bad }, destinations: { l: { path: '/' } } }),
      ).toThrow('config.retention.count must be a positive integer');
    }
  });

  it('should throw when schedule is not a valid cron expression', () => {
    for (const bad of ['not-a-cron', '0 * * *', 'a b c d e']) {
      expect(() =>
        parseBackupConfig({ schedule: bad, destinations: { l: { path: '/' } } }),
      ).toThrow('is not a valid cron expression');
    }
    expect(() => parseBackupConfig({ schedule: 42, destinations: { l: { path: '/' } } })).toThrow(
      'config.schedule must be a string',
    );
  });

  it('should throw when cron fields are out of range', () => {
    // minute > 59
    expect(() =>
      parseBackupConfig({ schedule: '60 * * * *', destinations: { l: { path: '/' } } }),
    ).toThrow('is not a valid cron expression');
    // hour > 23
    expect(() =>
      parseBackupConfig({ schedule: '* 24 * * *', destinations: { l: { path: '/' } } }),
    ).toThrow('is not a valid cron expression');
    // month > 12
    expect(() =>
      parseBackupConfig({ schedule: '* * * 13 *', destinations: { l: { path: '/' } } }),
    ).toThrow('is not a valid cron expression');
    // all fields obviously invalid
    expect(() =>
      parseBackupConfig({ schedule: '99 99 99 99 99', destinations: { l: { path: '/' } } }),
    ).toThrow('is not a valid cron expression');
  });

  it('should strip control characters from cron expression in error message', () => {
    const expr = '0 \x01bad\x1f * * *';
    let caughtMessage = '';
    try {
      parseBackupConfig({ schedule: expr, destinations: { l: { path: '/' } } });
    } catch (e) {
      if (e instanceof Error) caughtMessage = e.message;
    }
    expect(caughtMessage).toContain('is not a valid cron expression');
    expect(caughtMessage).not.toMatch(/[\x00-\x09\x0b-\x1f]/);
  });

  it('should accept valid cron expressions', () => {
    for (const schedule of ['0 * * * *', '30 2 * * 0', '*/15 * * * *', '0 0 1 1 *']) {
      const config = parseBackupConfig({
        schedule,
        destinations: { l: { path: '/' } },
      });
      expect(config.schedule).toBe(schedule);
    }
  });

  it('should throw when destination configuration is invalid', () => {
    expect(() => parseBackupConfig({ destinations: { broken: {} } })).toThrow(
      'config.destinations.broken must have either "path" or "remote"',
    );

    expect(() => parseBackupConfig({ destinations: ['not', 'an', 'object'] })).toThrow(
      'config.destinations must be an object',
    );

    expect(() => parseBackupConfig({ destinations: { local: { path: 123 } } })).toThrow(
      'config.destinations.local.path must be a string',
    );

    expect(() => parseBackupConfig({ destinations: { cloud: { remote: true } } })).toThrow(
      'config.destinations.cloud.remote must be a string',
    );
  });
});

// ---------------------------------------------------------------------------
// loadBackupConfig
// ---------------------------------------------------------------------------

describe('loadBackupConfig', () => {
  const validContent = JSON.stringify({
    backup: { destinations: { local: { path: '/tmp/backups' } } },
  });

  it('should read from the default path when no path is provided', async () => {
    mockReadFile.mockResolvedValue(validContent);
    const config = await loadBackupConfig();
    expect(mockReadFile).toHaveBeenCalledWith(`${HOME}/.openclaw/openclaw.json`, 'utf8');
    expect(config.destinations['local']).toEqual({ path: '/tmp/backups' });
  });

  it('should read from the provided path and resolve ~', async () => {
    mockReadFile.mockResolvedValue(validContent);

    await loadBackupConfig('/custom/path/openclaw.json');
    expect(mockReadFile).toHaveBeenCalledWith('/custom/path/openclaw.json', 'utf8');

    vi.resetAllMocks();
    mockHomedir.mockReturnValue(HOME);
    mockReadFile.mockResolvedValue(validContent);
    await loadBackupConfig('~/.custom/openclaw.json');
    expect(mockReadFile).toHaveBeenCalledWith(`${HOME}/.custom/openclaw.json`, 'utf8');
  });

  it('should throw a clear error when the file cannot be read', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file or directory'));
    await expect(loadBackupConfig()).rejects.toThrow('Failed to read openclaw config from');
    await expect(loadBackupConfig()).rejects.toThrow('ENOENT: no such file or directory');
  });

  it('should throw when openclaw.json contains invalid JSON', async () => {
    mockReadFile.mockResolvedValue('{ invalid json }');
    await expect(loadBackupConfig()).rejects.toThrow('Failed to read openclaw config from');
  });

  it('should throw when openclaw.json has no backup key', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify({ other: 'config' }));
    await expect(loadBackupConfig()).rejects.toThrow('No backup configuration found');
  });

  it('should throw when openclaw.json is not a JSON object', async () => {
    mockReadFile.mockResolvedValue(JSON.stringify([1, 2, 3]));
    await expect(loadBackupConfig()).rejects.toThrow('No backup configuration found');
  });
});
