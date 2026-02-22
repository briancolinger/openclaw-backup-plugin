import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { type BackupManifest, type CollectedFile, MANIFEST_SCHEMA_VERSION } from '../types.js';

import { checkTarInstalled, createArchiveStreaming } from './archive-streaming.js';
import { extractArchive } from './archive.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testDir: string;
let outputDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'openclaw-streaming-test-'));
  outputDir = await mkdtemp(join(tmpdir(), 'openclaw-streaming-out-'));
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
// createArchiveStreaming (unencrypted)
// ---------------------------------------------------------------------------

describe('createArchiveStreaming (unencrypted)', () => {
  it('should produce an archive extractable by extractArchive', async () => {
    const filePath = join(testDir, 'hello.txt');
    await writeFile(filePath, 'hello streaming', 'utf8');

    const archivePath = join(outputDir, 'test.tar.gz');
    const extractDir = join(outputDir, 'extracted');

    await createArchiveStreaming([makeFile(filePath, 'hello.txt')], makeManifest(), archivePath);
    await extractArchive(archivePath, extractDir);

    const content = await readFile(join(extractDir, 'hello.txt'), 'utf8');
    expect(content).toBe('hello streaming');
  });

  it('should include manifest.json in the archive', async () => {
    const filePath = join(testDir, 'a.txt');
    await writeFile(filePath, 'data', 'utf8');
    const manifest = makeManifest();

    const archivePath = join(outputDir, 'manifest-test.tar.gz');
    const extractDir = join(outputDir, 'extracted');

    await createArchiveStreaming([makeFile(filePath, 'a.txt')], manifest, archivePath);
    await extractArchive(archivePath, extractDir);

    const raw = await readFile(join(extractDir, 'manifest.json'), 'utf8');
    const parsed = JSON.parse(raw);
    expect(parsed).toMatchObject({ schemaVersion: MANIFEST_SCHEMA_VERSION, hostname: 'test-host' });
  });

  it('should work with an empty file list (manifest-only archive)', async () => {
    const archivePath = join(outputDir, 'empty.tar.gz');
    const extractDir = join(outputDir, 'extracted');

    await createArchiveStreaming([], makeManifest(), archivePath);
    await extractArchive(archivePath, extractDir);

    const raw = await readFile(join(extractDir, 'manifest.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ hostname: 'test-host' });
  });

  it('should preserve nested directory structure', async () => {
    const nestedDir = join(testDir, 'sub', 'dir');
    await mkdir(nestedDir, { recursive: true });
    const filePath = join(nestedDir, 'deep.txt');
    await writeFile(filePath, 'deep content', 'utf8');

    const archivePath = join(outputDir, 'nested.tar.gz');
    const extractDir = join(outputDir, 'extracted');

    await createArchiveStreaming(
      [makeFile(filePath, 'sub/dir/deep.txt')],
      makeManifest(),
      archivePath,
    );
    await extractArchive(archivePath, extractDir);

    const content = await readFile(join(extractDir, 'sub', 'dir', 'deep.txt'), 'utf8');
    expect(content).toBe('deep content');
  });

  it('should throw when tar cannot write to a non-existent output directory', async () => {
    const archivePath = join(outputDir, 'nosuchdir', 'output.tar.gz');
    await expect(createArchiveStreaming([], makeManifest(), archivePath)).rejects.toThrow(
      'Failed to create archive',
    );
  });

  it('should correctly archive a 1 MB file and restore its contents', async () => {
    const size = 1024 * 1024;
    const buf = Buffer.alloc(size, 0x41); // fill with 'A'
    const filePath = join(testDir, 'medium.bin');
    await writeFile(filePath, buf);

    const archivePath = join(outputDir, 'medium.tar.gz');
    const extractDir = join(outputDir, 'extracted');

    await createArchiveStreaming([makeFile(filePath, 'medium.bin')], makeManifest(), archivePath);
    await extractArchive(archivePath, extractDir);

    const restored = await readFile(join(extractDir, 'medium.bin'));
    expect(restored.length).toBe(size);
    expect(restored[0]).toBe(0x41);
  });
});

// ---------------------------------------------------------------------------
// checkTarInstalled
// ---------------------------------------------------------------------------

describe('checkTarInstalled', () => {
  it('should return available: true when tar is in PATH', async () => {
    const result = await checkTarInstalled();
    expect(result.name).toBe('tar');
    expect(result.available).toBe(true);
    expect(typeof result.version).toBe('string');
  });
});
