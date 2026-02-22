import domain from 'node:domain';
import { createWriteStream } from 'node:fs';
import { mkdir, mkdtemp, readFile, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { pipeline } from 'node:stream/promises';
import { createGzip } from 'node:zlib';

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

/** Writes the archive stream to `archivePath` so extract tests can use it. */
async function writeArchive(
  files: CollectedFile[],
  manifest: BackupManifest,
  archivePath: string,
): Promise<void> {
  const stream = await createArchive(files, manifest);
  await pipeline(stream, createWriteStream(archivePath));
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

    await writeArchive(files, manifest, archivePath);
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

    await writeArchive(files, makeManifest(), archivePath);
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

    await writeArchive([makeFile(filePath, 'a.txt')], manifest, archivePath);
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

    await writeArchive([makeFile(filePath, 'x.txt')], makeManifest(), archivePath);
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

    await writeArchive([makeFile(filePath, 'f.txt')], manifest, archivePath);
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

    await writeArchive([], makeManifest(), archivePath);
    await extractArchive(archivePath, extractDir);

    const raw = await readFile(join(extractDir, 'manifest.json'), 'utf8');
    expect(JSON.parse(raw)).toMatchObject({ hostname: 'test-host' });
  });

  it('should allow readManifestFromArchive on an archive with no other files', async () => {
    const archivePath = join(outputDir, 'only-manifest.tar.gz');
    await writeArchive([], makeManifest(), archivePath);

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

    await writeArchive([makeFile(filePath, 'large.bin')], makeManifest(), archivePath);
    await extractArchive(archivePath, extractDir);

    const restored = await readFile(join(extractDir, 'large.bin'));
    expect(restored.length).toBe(size);
    expect(restored[0]).toBe(0x42);
    expect(restored[size - 1]).toBe(0x42);
  });
});

// ---------------------------------------------------------------------------
// Symlink source file handling
// ---------------------------------------------------------------------------

describe('createArchive with symlinked source files', () => {
  it('should archive the content of a symlink target, not the raw symlink', async () => {
    const realPath = join(testDir, 'real.txt');
    await writeFile(realPath, 'real content', 'utf8');
    const linkPath = join(testDir, 'link.txt');
    await symlink(realPath, linkPath);

    const files: CollectedFile[] = [makeFile(linkPath, 'link.txt')];
    const archivePath = join(outputDir, 'symlink-test.tar.gz');
    const extractDir = join(outputDir, 'extracted');

    await writeArchive(files, makeManifest(), archivePath);
    await extractArchive(archivePath, extractDir);

    const content = await readFile(join(extractDir, 'link.txt'), 'utf8');
    expect(content).toBe('real content');
  });
});

// ---------------------------------------------------------------------------
// Path traversal protection
// ---------------------------------------------------------------------------

/**
 * Builds a minimal POSIX tar header block for a single regular file entry.
 * Used only in tests to craft archives that the `tar` package would normally
 * refuse to create (entries with `..` path segments).
 */
function makeTarHeader(name: string, contentSize: number): Buffer {
  const block = Buffer.alloc(512, 0);
  block.write(name, 0, 100, 'ascii');
  block.write('0000644\0', 100, 8, 'ascii'); // mode
  block.write('0000000\0', 108, 8, 'ascii'); // uid
  block.write('0000000\0', 116, 8, 'ascii'); // gid
  block.write(contentSize.toString(8).padStart(11, '0') + '\0', 124, 12, 'ascii'); // size
  block.write('00000000000\0', 136, 12, 'ascii'); // mtime
  block.fill(0x20, 148, 156); // checksum placeholder = spaces
  block.write('0', 156, 1, 'ascii'); // typeflag: regular file
  const checksum = Array.from(block).reduce((acc, b) => acc + b, 0);
  block.write(checksum.toString(8).padStart(6, '0') + '\0 ', 148, 8, 'ascii');
  return block;
}

function padTo512(data: Buffer): Buffer {
  const rem = data.length % 512;
  if (rem === 0) {
    return data;
  }
  return Buffer.concat([data, Buffer.alloc(512 - rem, 0)]);
}

async function createTarGzWithTraversalEntry(outputPath: string): Promise<void> {
  const content = Buffer.from('evil\n', 'utf8');
  const header = makeTarHeader('../escape.txt', content.length);
  const paddedContent = padTo512(content);
  const eof = Buffer.alloc(1024, 0);
  const tarBytes = Buffer.concat([header, paddedContent, eof]);
  await pipeline(Readable.from([tarBytes]), createGzip(), createWriteStream(outputPath));
}

describe('path traversal protection in extractArchive', () => {
  it('should throw when the archive contains an entry with .. path segment', async () => {
    const archivePath = join(outputDir, 'malicious.tar.gz');
    await createTarGzWithTraversalEntry(archivePath);
    const extractDir = join(outputDir, 'extracted');

    // The tar `filter` callback throws synchronously inside the stream event
    // handler, which propagates as an uncaught exception rather than a Promise
    // rejection (tar does not catch filter errors and propagate them back to
    // the returned Promise). A Node.js domain captures these async exceptions
    // before they reach the process uncaughtException handler.
    const err = await new Promise<Error>((resolve, reject) => {
      // eslint-disable-next-line @typescript-eslint/no-deprecated -- domain is the correct tool to capture exceptions thrown from within stream event handlers (uncaught exceptions). AsyncLocalStorage does not capture these.
      const d = domain.create();
      d.on('error', (domainErr: Error) => {
        d.exit();
        resolve(domainErr);
      });
      d.run(() => {
        void extractArchive(archivePath, extractDir).catch((e: unknown) => {
          // If the promise does reject (future tar versions may fix this),
          // accept it as a valid outcome too.
          d.exit();
          resolve(e instanceof Error ? e : new Error(String(e)));
        });
      });
      // Safety: reject if neither branch fires within the test timeout
      setTimeout(() => {
        reject(new Error('timed out waiting for path traversal error'));
      }, 8000);
    });

    expect(err.message).toContain('Path traversal detected');
  });
});
