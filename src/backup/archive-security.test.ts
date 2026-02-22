import { mkdtemp, rm, symlink, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

import { create } from 'tar';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';

import { extractArchive } from './archive.js';

// ---------------------------------------------------------------------------
// Setup
// ---------------------------------------------------------------------------

let testDir: string;
let outputDir: string;

beforeEach(async () => {
  testDir = await mkdtemp(join(tmpdir(), 'openclaw-sec-test-'));
  outputDir = await mkdtemp(join(tmpdir(), 'openclaw-sec-out-'));
});

afterEach(async () => {
  await rm(testDir, { recursive: true, force: true });
  await rm(outputDir, { recursive: true, force: true });
});

// ---------------------------------------------------------------------------
// Symlink escape protection
// ---------------------------------------------------------------------------

describe('symlink escape protection in extractArchive', () => {
  it('should throw when the archive contains a symlink pointing outside outputDir', async () => {
    // Create a symlink targeting an absolute path outside any outputDir.
    // /etc/passwd is a stable, always-present path on Linux.
    const linkPath = join(testDir, 'evil-link');
    await symlink('/etc/passwd', linkPath);

    // Archive the symlink WITHOUT follow:true so the symlink entry is preserved.
    const archivePath = join(outputDir, 'symlink-escape.tar.gz');
    await create({ file: archivePath, gzip: true, cwd: testDir }, ['evil-link']);

    const extractDir = join(outputDir, 'extracted');
    await expect(extractArchive(archivePath, extractDir)).rejects.toThrow(
      'Archive symlink escapes output directory',
    );
  });

  it('should allow symlinks whose target stays within outputDir', async () => {
    // Create a real file and a relative symlink pointing to it — both within testDir.
    await writeFile(join(testDir, 'real.txt'), 'content', 'utf8');
    await symlink('real.txt', join(testDir, 'safe-link'));

    const archivePath = join(outputDir, 'safe-symlink.tar.gz');
    await create({ file: archivePath, gzip: true, cwd: testDir }, ['real.txt', 'safe-link']);

    const extractDir = join(outputDir, 'extracted');
    await expect(extractArchive(archivePath, extractDir)).resolves.toBeUndefined();
  });
});
