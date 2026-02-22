import { beforeEach, describe, expect, it, vi, type Mock } from 'vitest';

import { type BackupConfig, type DestinationConfig } from '../types.js';

import { createStorageProviders } from './backup.js';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const { mockCreateLocalProvider, mockCreateRcloneProvider } = vi.hoisted(() => ({
  mockCreateLocalProvider: vi.fn(),
  mockCreateRcloneProvider: vi.fn(),
}));

vi.mock('../storage/local.js', () => ({ createLocalProvider: mockCreateLocalProvider }));
vi.mock('../storage/rclone.js', () => ({
  checkRcloneInstalled: vi.fn(),
  createRcloneProvider: mockCreateRcloneProvider,
}));

// collector, archive, manifest, encrypt are not called by createStorageProviders
vi.mock('./collector.js', () => ({ collectFiles: vi.fn() }));
vi.mock('./archive.js', () => ({ createArchive: vi.fn() }));
vi.mock('./manifest.js', () => ({ generateManifest: vi.fn(), serializeManifest: vi.fn() }));
vi.mock('./encrypt.js', () => ({
  checkAgeInstalled: vi.fn(),
  encryptFile: vi.fn(),
  generateKey: vi.fn(),
  getKeyId: vi.fn(),
}));
vi.mock('node:fs/promises', () => ({
  access: vi.fn(),
  mkdtemp: vi.fn(),
  rm: vi.fn(),
  stat: vi.fn(),
  writeFile: vi.fn(),
}));

// ---------------------------------------------------------------------------
// Fixtures
// ---------------------------------------------------------------------------

const KEY_PATH = '/home/user/.openclaw/.secrets/backup.age';

interface ConfigOverrides {
  destinations?: Record<string, DestinationConfig>;
}

function makeConfig(overrides: ConfigOverrides = {}): BackupConfig {
  return {
    encrypt: false,
    encryptKeyPath: KEY_PATH,
    include: ['/home/user/.openclaw'],
    exclude: [],
    extraPaths: [],
    includeTranscripts: false,
    includePersistor: false,
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
  push: vi.fn(),
  pull: vi.fn(),
  list: vi.fn(),
  delete: vi.fn(),
  check: vi.fn(),
});

// ---------------------------------------------------------------------------
// createStorageProviders
// ---------------------------------------------------------------------------

describe('createStorageProviders', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    mockCreateLocalProvider.mockReturnValue(makeProvider('local'));
    mockCreateRcloneProvider.mockReturnValue(makeProvider('gdrive'));
  });

  it('should create a local provider for a path destination', () => {
    const config = makeConfig({ destinations: { backup: { path: '/backups' } } });
    const providers = createStorageProviders(config);

    expect(mockCreateLocalProvider).toHaveBeenCalledWith({ path: '/backups' });
    expect(providers).toHaveLength(1);
  });

  it('should create an rclone provider for a remote destination', () => {
    const config = makeConfig({ destinations: { gdrive: { remote: 'gdrive:openclaw/' } } });
    const providers = createStorageProviders(config);

    expect(mockCreateRcloneProvider).toHaveBeenCalledWith({
      remote: 'gdrive:openclaw/',
      name: 'gdrive',
    });
    expect(providers).toHaveLength(1);
  });

  it('should create providers for all destinations when none is specified', () => {
    const config = makeConfig({
      destinations: { local: { path: '/backups' }, gdrive: { remote: 'gdrive:openclaw/' } },
    });
    const providers = createStorageProviders(config);

    expect(providers).toHaveLength(2);
    expect(mockCreateLocalProvider).toHaveBeenCalledOnce();
    expect(mockCreateRcloneProvider).toHaveBeenCalledOnce();
  });

  it('should return only the named destination when specified', () => {
    const config = makeConfig({
      destinations: { local: { path: '/backups' }, gdrive: { remote: 'gdrive:openclaw/' } },
    });
    const providers = createStorageProviders(config, 'local');

    expect(providers).toHaveLength(1);
    expect(mockCreateLocalProvider).toHaveBeenCalledOnce();
    expect(mockCreateRcloneProvider).not.toHaveBeenCalled();
  });

  it('should throw when the named destination does not exist in config', () => {
    const config = makeConfig({ destinations: { local: { path: '/backups' } } });

    expect(() => createStorageProviders(config, 'nonexistent')).toThrow(
      'Destination "nonexistent" not found in config',
    );
  });

  it('should throw when a destination has neither path nor remote configured', () => {
    const config = makeConfig({ destinations: { broken: {} } });

    expect(() => createStorageProviders(config)).toThrow(
      'Destination "broken" has neither "path" nor "remote" configured',
    );
  });
});
