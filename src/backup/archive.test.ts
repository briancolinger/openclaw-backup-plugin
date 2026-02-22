import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { create } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type BackupManifest, type CollectedFile, MANIFEST_SCHEMA_VERSION } from '../types.js';

import { createArchive, extractArchive, readManifestFromArchive } from './archive.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testDir: string;
let outputDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'openclaw-test-'));
  outputDir = await mkdtemp(join(tmpdir(), 'openclaw-out-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  await rm(outputDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function makeManifest(): BackupManifest {
  return {
    schemaVersion: MANIFEST_SCHEMA_VERSION,
    pluginVersion: '0.1.0',
    hostname: 'test-host',
    timestamp: '2024-01-01T00:00:00.000Z',
    encrypted: false,
    includeTranscripts: false,
    includePersistor: false,
    files: [],
  };
}

function makeFile(absolutePath: string, relativePath: string): CollectedFile {
  return { absolutePath, relativePath, size: 0, modified: '2024-01-01T00:00:00.000Z' };
}

// ---------------------------------------------------------------------------
// createArchive + extractArchive — round-trip
// ---------------------------------------------------------------------------

describe('createArchive + extractArchive round-trip', () => {
  it('should preserve file content through create and extract', async () => {
    const filePath = join(testDir, 'hello.txt');
    await writeFile(filePath, 'hello world', 'utf8');

    const files: CollectedFile[] = [makeFile(filePath, 'hello.txt')];
    const manifest = makeManifest();
    const archivePath = join(outputDir, 'test.tar.gz');
    const extractDir = join(outputDir, 'extracted');

    await createArchive(files, manifest, archivePath);
    await extractArchive(archivePath, extractDir);

    const content = await readFile(join(extractDir, 'hello.txt'), 'utf8');
    expect(content).toBe('hello world');
  });

  it('should preserve nested directory structure', async () => {
    const nestedDir = join(testDir, 'sub', 'dir');
    await mkdir(nestedDir, { recursive: true });
    const filePath = join(nestedDir, 'deep.txt');
    await writeFile(filePath, 'nested content', 'utf8');

    const files: CollectedFile[] = [makeFile(filePath, 'sub/dir/deep.txt')];
    const archivePath = join(outputDir, 'nested.tar.gz');
    const extractDir = join(outputDir, 'extracted');

    await createArchive(files, makeManifest(), archivePath);
    await extractArchive(archivePath, extractDir);

    const content = await readFile(join(extractDir, 'sub', 'dir', 'deep.txt'), 'utf8');
    expect(content).toBe('nested content');
  });

  it('should include manifest.json in extracted output', async () => {
    const filePath = join(testDir, 'a.txt');
    await writeFile(filePath, 'a', 'utf8');

    const archivePath = join(outputDir, 'test.tar.gz');
    const extractDir = join(outputDir, 'extracted');
    const manifest = makeManifest();

    await createArchive([makeFile(filePath, 'a.txt')], manifest, archivePath);
    await extractArchive(archivePath, extractDir);

    const raw = await readFile(join(extractDir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({ schemaVersion: MANIFEST_SCHEMA_VERSION, hostname: 'test-host' });
  });

  it('should create outputDir if it does not exist', async () => {
    const filePath = join(testDir, 'x.txt');
    await writeFile(filePath, 'x', 'utf8');
    const archivePath = join(outputDir, 'test.tar.gz');
    const extractDir = join(outputDir, 'does', 'not', 'exist');

    await createArchive([makeFile(filePath, 'x.txt')], makeManifest(), archivePath);
    await expect(extractArchive(archivePath, extractDir)).resolves.toBeUndefined();

    const content = await readFile(join(extractDir, 'x.txt'), 'utf8');
    expect(content).toBe('x');
  });
});

// ---------------------------------------------------------------------------
// readManifestFromArchive
// ---------------------------------------------------------------------------

describe('readManifestFromArchive', () => {
  it('should return the manifest stored in the archive', async () => {
    const filePath = join(testDir, 'f.txt');
    await writeFile(filePath, 'data', 'utf8');
    const manifest = makeManifest();
    const archivePath = join(outputDir, 'manifest-test.tar.gz');

    await createArchive([makeFile(filePath, 'f.txt')], manifest, archivePath);
    const result = await readManifestFromArchive(archivePath);

    expect(result.schemaVersion).toBe(manifest.schemaVersion);
    expect(result.pluginVersion).toBe(manifest.pluginVersion);
    expect(result.hostname).toBe(manifest.hostname);
    expect(result.timestamp).toBe(manifest.timestamp);
    expect(result.encrypted).toBe(manifest.encrypted);
  });

  it('should throw when manifest.json is absent from the archive', async () => {
    const filePath = join(testDir, 'only.txt');
    await writeFile(filePath, 'only', 'utf8');

    // Build a tar.gz that contains only.txt (no manifest.json)
    const archivePath = join(outputDir, 'no-manifest.tar.gz');
    await create({ file: archivePath, gzip: true, cwd: testDir }, ['only.txt']);

    await expect(readManifestFromArchive(archivePath)).rejects.toThrow('manifest.json');
  });
});

// ---------------------------------------------------------------------------
// Empty file list
// ---------------------------------------------------------------------------

describe('createArchive with empty file list', () => {
  it('should create a valid archive containing only manifest.json', async () => {
    const archivePath = join(outputDir, 'empty.tar.gz');
    const extractDir = join(outputDir, 'extracted');

    await createArchive([], makeManifest(), archivePath);
    await extractArchive(archivePath, extractDir);

    const raw = await readFile(join(extractDir, 'manifest.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ hostname: 'test-host' });
  });

  it('should allow readManifestFromArchive on an archive with no other files', async () => {
    const archivePath = join(outputDir, 'only-manifest.tar.gz');
    await createArchive([], makeManifest(), archivePath);

    const result = await readManifestFromArchive(archivePath);
    expect(result.hostname).toBe('test-host');
  });
});

// ---------------------------------------------------------------------------
// Large file
// ---------------------------------------------------------------------------

describe('large file handling', () => {
  it('should correctly archive and restore a 10 MB file', async () => {
    const size = 10 * 1024 * 1024;
    const buf = Buffer.alloc(size, 0x42); // fill with 'B'
    const filePath = join(testDir, 'large.bin');
    await writeFile(filePath, buf);

    const archivePath = join(outputDir, 'large.tar.gz');
    const extractDir = join(outputDir, 'extracted');

    await createArchive([makeFile(filePath, 'large.bin')], makeManifest(), archivePath);
    await extractArchive(archivePath, extractDir);

    const restored = await readFile(join(extractDir, 'large.bin'));
    expect(restored.length).toBe(size);
    expect(restored[0]).toBe(0x42);
    expect(restored[size - 1]).toBe(0x42);
  });
});
