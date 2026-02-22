import { beforeEach, describe, expect, it, vi } from 'vitest';

import { type BackupManifest, type CollectedFile } from '../types.js';

import {
  deserializeManifest,
  generateManifest,
  serializeManifest,
  validateManifest,
} from './manifest.js';

// vi.hoisted runs before vi.mock factories, making these available to them.
const { mockReadFile, mockHostname, mockCreateHash } = vi.hoisted(() => ({
  mockReadFile: vi.fn(),
  mockHostname: vi.fn(),
  mockCreateHash: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({ readFile: mockReadFile }));
vi.mock('node:os', () => ({ hostname: mockHostname }));
vi.mock('node:crypto', () => ({ createHash: mockCreateHash }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeMockHash(hexValue: string) {
  const hash = { update: vi.fn(), digest: vi.fn().mockReturnValue(hexValue) };
  hash.update.mockReturnValue(hash);
  return hash;
}

function makeFile(overrides: Partial<CollectedFile> = {}): CollectedFile {
  return {
    absolutePath: '/home/user/.openclaw/config.json',
    relativePath: '.openclaw/config.json',
    size: 512,
    modified: '2025-06-01T00:00:00.000Z',
    ...overrides,
  };
}

const BASE_OPTIONS = {
  encrypted: false,
  includeTranscripts: false,
  includePersistor: false,
  pluginVersion: '1.0.0',
};

const FAKE_HASH = 'a'.repeat(64);

beforeEach(() => {
  vi.resetAllMocks();
  mockHostname.mockReturnValue('test-host');
  mockReadFile.mockResolvedValue(Buffer.from('file content'));
  mockCreateHash.mockReturnValue(makeMockHash(FAKE_HASH));
});

// ---------------------------------------------------------------------------
// generateManifest
// ---------------------------------------------------------------------------

describe('generateManifest', () => {
  it('should populate all required manifest fields', async () => {
    const files = [makeFile()];
    const manifest = await generateManifest(files, BASE_OPTIONS);

    expect(manifest.schemaVersion).toBe(1);
    expect(manifest.pluginVersion).toBe('1.0.0');
    expect(manifest.hostname).toBe('test-host');
    expect(manifest.encrypted).toBe(false);
    expect(manifest.includeTranscripts).toBe(false);
    expect(manifest.includePersistor).toBe(false);
    expect(manifest.timestamp).toMatch(/^\d{4}-\d{2}-\d{2}T/);
    expect(manifest.files).toHaveLength(1);
  });

  it('should compute SHA-256 for each file and include in manifest', async () => {
    const hash1 = 'b'.repeat(64);
    const hash2 = 'c'.repeat(64);
    mockCreateHash
      .mockReturnValueOnce(makeMockHash(hash1))
      .mockReturnValueOnce(makeMockHash(hash2));

    const files = [
      makeFile({ absolutePath: '/a/file1.txt', relativePath: 'file1.txt' }),
      makeFile({ absolutePath: '/a/file2.txt', relativePath: 'file2.txt' }),
    ];
    const manifest = await generateManifest(files, BASE_OPTIONS);

    expect(manifest.files).toHaveLength(2);
    expect(manifest.files[0]).toMatchObject({ path: 'file1.txt', sha256: hash1 });
    expect(manifest.files[1]).toMatchObject({ path: 'file2.txt', sha256: hash2 });
  });

  it('should include optional fields when provided', async () => {
    const options = {
      ...BASE_OPTIONS,
      encrypted: true,
      keyId: 'key-abc',
      openclawVersion: '2.3.4',
      includePersistor: true,
      persistorExport: { schemaVersion: 1, nodeCount: 10, edgeCount: 5 },
    };
    const manifest = await generateManifest([makeFile()], options);

    expect(manifest.keyId).toBe('key-abc');
    expect(manifest.openclawVersion).toBe('2.3.4');
    expect(manifest.persistorExport).toEqual({ schemaVersion: 1, nodeCount: 10, edgeCount: 5 });
    expect(manifest.encrypted).toBe(true);
  });

  it('should omit optional fields when not provided', async () => {
    const manifest = await generateManifest([makeFile()], BASE_OPTIONS);

    expect('keyId' in manifest).toBe(false);
    expect('openclawVersion' in manifest).toBe(false);
    expect('persistorExport' in manifest).toBe(false);
  });

  it('should return empty files array for empty input', async () => {
    const manifest = await generateManifest([], BASE_OPTIONS);
    expect(manifest.files).toEqual([]);
  });

  it('should read each file by its absolutePath', async () => {
    const file = makeFile({ absolutePath: '/real/path/cfg.json' });
    await generateManifest([file], BASE_OPTIONS);
    expect(mockReadFile).toHaveBeenCalledWith('/real/path/cfg.json');
  });

  it('should preserve file size and modified from CollectedFile', async () => {
    const file = makeFile({ size: 9999, modified: '2024-01-15T10:00:00.000Z' });
    const manifest = await generateManifest([file], BASE_OPTIONS);
    expect(manifest.files[0]).toMatchObject({ size: 9999, modified: '2024-01-15T10:00:00.000Z' });
  });
});

// ---------------------------------------------------------------------------
// validateManifest
// ---------------------------------------------------------------------------

const VALID_MANIFEST: BackupManifest = {
  schemaVersion: 1,
  pluginVersion: '1.0.0',
  hostname: 'test-host',
  timestamp: '2025-06-01T00:00:00.000Z',
  encrypted: false,
  includeTranscripts: false,
  includePersistor: false,
  files: [
    { path: 'config.json', sha256: FAKE_HASH, size: 512, modified: '2025-01-01T00:00:00.000Z' },
  ],
};

describe('validateManifest', () => {
  it('should return valid when all file hashes match', async () => {
    const result = await validateManifest(VALID_MANIFEST, '/extract');
    expect(result).toEqual({ valid: true, errors: [] });
  });

  it('should return invalid when a file hash does not match', async () => {
    mockCreateHash.mockReturnValue(makeMockHash('d'.repeat(64)));
    const result = await validateManifest(VALID_MANIFEST, '/extract');

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(1);
    expect(result.errors[0]).toContain('Checksum mismatch');
    expect(result.errors[0]).toContain('config.json');
  });

  it('should report expected and actual hashes on mismatch', async () => {
    const actualHash = 'd'.repeat(64);
    mockCreateHash.mockReturnValue(makeMockHash(actualHash));
    const result = await validateManifest(VALID_MANIFEST, '/extract');

    expect(result.errors[0]).toContain(FAKE_HASH);
    expect(result.errors[0]).toContain(actualHash);
  });

  it('should return an error when a file cannot be read', async () => {
    mockReadFile.mockRejectedValue(new Error('ENOENT: no such file'));
    const result = await validateManifest(VALID_MANIFEST, '/extract');

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Cannot read config.json');
    expect(result.errors[0]).toContain('ENOENT');
  });

  it('should reject unsupported schema versions without reading files', async () => {
    const manifest = { ...VALID_MANIFEST, schemaVersion: 99 };
    const result = await validateManifest(manifest, '/extract');

    expect(result.valid).toBe(false);
    expect(result.errors[0]).toContain('Unsupported schema version: 99');
    expect(mockReadFile).not.toHaveBeenCalled();
  });

  it('should collect errors for all mismatched files', async () => {
    const manifest: BackupManifest = {
      ...VALID_MANIFEST,
      files: [
        { path: 'a.txt', sha256: FAKE_HASH, size: 1, modified: '2025-01-01T00:00:00.000Z' },
        { path: 'b.txt', sha256: FAKE_HASH, size: 2, modified: '2025-01-01T00:00:00.000Z' },
      ],
    };
    const badHash = 'e'.repeat(64);
    mockCreateHash.mockReturnValue(makeMockHash(badHash));

    const result = await validateManifest(manifest, '/extract');

    expect(result.valid).toBe(false);
    expect(result.errors).toHaveLength(2);
  });

  it('should use extractedDir as base when resolving file paths', async () => {
    await validateManifest(VALID_MANIFEST, '/my/extract/dir');
    expect(mockReadFile).toHaveBeenCalledWith('/my/extract/dir/config.json');
  });

  it('should return valid for empty files list', async () => {
    const manifest = { ...VALID_MANIFEST, files: [] };
    const result = await validateManifest(manifest, '/extract');
    expect(result).toEqual({ valid: true, errors: [] });
  });
});

// ---------------------------------------------------------------------------
// serializeManifest / deserializeManifest
// ---------------------------------------------------------------------------

describe('serializeManifest / deserializeManifest', () => {
  it('should round-trip a manifest without data loss', () => {
    const json = serializeManifest(VALID_MANIFEST);
    const restored = deserializeManifest(json);
    expect(restored).toEqual(VALID_MANIFEST);
  });

  it('should serialize with 2-space indentation', () => {
    const json = serializeManifest(VALID_MANIFEST);
    expect(json).toContain('  "schemaVersion"');
  });

  it('should throw on invalid JSON', () => {
    expect(() => deserializeManifest('not json {')).toThrow('Failed to parse manifest JSON');
  });

  it('should throw when required fields are missing', () => {
    const bad = JSON.stringify({ schemaVersion: 1, pluginVersion: '1.0.0' });
    expect(() => deserializeManifest(bad)).toThrow('Invalid manifest');
  });

  it('should throw when top-level value is not an object', () => {
    expect(() => deserializeManifest('[1, 2, 3]')).toThrow('Invalid manifest');
    expect(() => deserializeManifest('"a string"')).toThrow('Invalid manifest');
  });

  it('should preserve optional fields through round-trip', () => {
    const manifest: BackupManifest = {
      ...VALID_MANIFEST,
      keyId: 'key-xyz',
      openclawVersion: '3.0.0',
      persistorExport: { schemaVersion: 1, nodeCount: 42, edgeCount: 7 },
    };
    const restored = deserializeManifest(serializeManifest(manifest));
    expect(restored.keyId).toBe('key-xyz');
    expect(restored.openclawVersion).toBe('3.0.0');
    expect(restored.persistorExport).toEqual({ schemaVersion: 1, nodeCount: 42, edgeCount: 7 });
  });
});
