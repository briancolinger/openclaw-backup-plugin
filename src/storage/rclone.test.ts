import { beforeEach, describe, expect, it, vi } from 'vitest';

import { checkRcloneInstalled, createRcloneProvider } from './rclone.js';

// ---------------------------------------------------------------------------
// Mock setup
// ---------------------------------------------------------------------------

const { mockExecFile } = vi.hoisted(() => ({
  mockExecFile: vi.fn(),
}));

vi.mock('node:child_process', () => ({
  execFile: mockExecFile,
}));

// ---------------------------------------------------------------------------
// Test helpers
// ---------------------------------------------------------------------------

type ExecCallback = (err: Error | null, stdout: string, stderr: string) => void;

function succeedWith(stdout: string, stderr = ''): void {
  mockExecFile.mockImplementation((_file: any, _args: any, _opts: any, cb: ExecCallback) => {
    cb(null, stdout, stderr);
  });
}

function failWith(message: string, stderr = ''): void {
  mockExecFile.mockImplementation((_file: any, _args: any, _opts: any, cb: ExecCallback) => {
    cb(new Error(message), '', stderr);
  });
}

const REMOTE = 'gdrive:openclaw-backups/';
const NAME = 'gdrive';
const EXPECTED_OPTS = { timeout: 120000, encoding: 'utf8' };

// ---------------------------------------------------------------------------
// createRcloneProvider
// ---------------------------------------------------------------------------

describe('createRcloneProvider', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should expose the configured name', () => {
    const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
    expect(provider.name).toBe(NAME);
  });

  // -------------------------------------------------------------------------
  // push
  // -------------------------------------------------------------------------

  describe('push', () => {
    it('should call rclone copyto with local path then full remote path', async () => {
      succeedWith('');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await provider.push('/tmp/archive.tar.gz', 'archive.tar.gz');
      expect(mockExecFile).toHaveBeenCalledWith(
        'rclone',
        ['copyto', '/tmp/archive.tar.gz', 'gdrive:openclaw-backups/archive.tar.gz'],
        EXPECTED_OPTS,
        expect.any(Function),
      );
    });

    it('should throw and include stderr when rclone exits non-zero', async () => {
      failWith('Command failed', 'access denied to remote');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await expect(provider.push('/file.tar.gz', 'file.tar.gz')).rejects.toThrow(
        'access denied to remote',
      );
    });

    it('should throw with command name even when there is no stderr', async () => {
      failWith('Command failed');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await expect(provider.push('/file.tar.gz', 'file.tar.gz')).rejects.toThrow(
        'rclone copyto failed',
      );
    });
  });

  // -------------------------------------------------------------------------
  // pull
  // -------------------------------------------------------------------------

  describe('pull', () => {
    it('should call rclone copyto with full remote path then local path', async () => {
      succeedWith('');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await provider.pull('archive.tar.gz', '/tmp/archive.tar.gz');
      expect(mockExecFile).toHaveBeenCalledWith(
        'rclone',
        ['copyto', 'gdrive:openclaw-backups/archive.tar.gz', '/tmp/archive.tar.gz'],
        EXPECTED_OPTS,
        expect.any(Function),
      );
    });

    it('should throw with stderr on pull failure', async () => {
      failWith('Command failed', 'object not found');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await expect(provider.pull('missing.tar.gz', '/tmp/out.tar.gz')).rejects.toThrow(
        'object not found',
      );
    });
  });

  // -------------------------------------------------------------------------
  // list
  // -------------------------------------------------------------------------

  describe('list', () => {
    it('should call rclone lsf with the remote base path', async () => {
      succeedWith('');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await provider.list();
      expect(mockExecFile).toHaveBeenCalledWith(
        'rclone',
        ['lsf', REMOTE],
        EXPECTED_OPTS,
        expect.any(Function),
      );
    });

    it('should return backup files sorted newest-first', async () => {
      // list() makes two rclone calls: first for hostedBase (fails → no hostname-prefixed files),
      // then for remoteBase (succeeds → root-level files only).
      mockExecFile
        .mockImplementationOnce((_file: any, _args: any, _opts: any, cb: ExecCallback) => {
          cb(new Error('no such remote'), '', 'no such remote');
        })
        .mockImplementationOnce((_file: any, _args: any, _opts: any, cb: ExecCallback) => {
          cb(null, '2024-01-10.tar.gz\n2024-01-20.tar.gz\n2024-01-15.tar.gz\n', '');
        });
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      const files = await provider.list();
      expect(files).toEqual(['2024-01-20.tar.gz', '2024-01-15.tar.gz', '2024-01-10.tar.gz']);
    });

    it('should filter out files that are not backup archives', async () => {
      succeedWith(
        'backup.tar.gz\nreadme.txt\nbackup.tar.gz.age\nbackup.manifest.json\nmanifest.json\n',
      );
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      const files = await provider.list();
      expect(files).toContain('backup.tar.gz');
      expect(files).toContain('backup.tar.gz.age');
      expect(files).toContain('backup.manifest.json');
      expect(files).not.toContain('readme.txt');
      // bare 'manifest.json' does not end with '.manifest.json'
      expect(files).not.toContain('manifest.json');
    });

    it('should return an empty array when the remote is empty', async () => {
      succeedWith('');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      expect(await provider.list()).toEqual([]);
    });

    it('should strip leading and trailing whitespace from each filename', async () => {
      succeedWith('  backup.tar.gz  \n  backup.tar.gz.age  \n');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      const files = await provider.list();
      expect(files).toContain('backup.tar.gz');
      expect(files).toContain('backup.tar.gz.age');
    });
  });

  // -------------------------------------------------------------------------
  // delete
  // -------------------------------------------------------------------------

  describe('delete', () => {
    it('should call rclone deletefile with the full remote path', async () => {
      succeedWith('');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await provider.delete('archive.tar.gz');
      expect(mockExecFile).toHaveBeenCalledWith(
        'rclone',
        ['deletefile', 'gdrive:openclaw-backups/archive.tar.gz'],
        EXPECTED_OPTS,
        expect.any(Function),
      );
    });

    it('should throw with stderr when delete fails', async () => {
      failWith('Command failed', 'file does not exist');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await expect(provider.delete('missing.tar.gz')).rejects.toThrow('file does not exist');
    });
  });

  // -------------------------------------------------------------------------
  // check
  // -------------------------------------------------------------------------

  describe('check', () => {
    it('should return available: true when lsd succeeds', async () => {
      succeedWith('');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      const result = await provider.check();
      expect(result.available).toBe(true);
    });

    it('should call rclone lsd with the remote base path', async () => {
      succeedWith('');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await provider.check();
      expect(mockExecFile).toHaveBeenCalledWith(
        'rclone',
        ['lsd', REMOTE],
        EXPECTED_OPTS,
        expect.any(Function),
      );
    });

    it('should return available: false with error message when remote is inaccessible', async () => {
      failWith('rclone lsd failed: remote not configured');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      const result = await provider.check();
      expect(result.available).toBe(false);
      expect(result.error).toBeTruthy();
    });

    it('should not throw when rclone fails — it returns a result object', async () => {
      failWith('some error');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await expect(provider.check()).resolves.toMatchObject({ available: false });
    });
  });

  // -------------------------------------------------------------------------
  // path traversal protection
  // -------------------------------------------------------------------------

  describe('path traversal protection', () => {
    it('should throw synchronously on push when remoteName contains ..', async () => {
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await expect(provider.push('/tmp/file.tar.gz', '../secret/file')).rejects.toThrow(
        'Unsafe remote name rejected',
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should throw synchronously on pull when remoteName contains ..', async () => {
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await expect(provider.pull('../secret/file', '/tmp/out')).rejects.toThrow(
        'Unsafe remote name rejected',
      );
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should throw synchronously on delete when remoteName contains ..', async () => {
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await expect(provider.delete('../secret/file')).rejects.toThrow('Unsafe remote name rejected');
      expect(mockExecFile).not.toHaveBeenCalled();
    });

    it('should throw when remoteName is an absolute path', async () => {
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await expect(provider.push('/tmp/file.tar.gz', '/etc/shadow')).rejects.toThrow(
        'Unsafe remote name rejected',
      );
    });

    it('should allow normal remote names without .. segments', async () => {
      succeedWith('');
      const provider = createRcloneProvider({ remote: REMOTE, name: NAME, hostname: 'test-host' });
      await expect(provider.push('/tmp/file.tar.gz', '2024-01-01.tar.gz')).resolves.toBeUndefined();
    });
  });
});

// ---------------------------------------------------------------------------
// checkRcloneInstalled
// ---------------------------------------------------------------------------

describe('checkRcloneInstalled', () => {
  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('should return available: true with the parsed version string', async () => {
    succeedWith('rclone v1.67.0\n- os/version: linux/5.15.0\n- os/kernel: 5.15.0\n');
    const result = await checkRcloneInstalled();
    expect(result.available).toBe(true);
    expect(result.version).toBe('1.67.0');
    expect(result.name).toBe('rclone');
    expect(result.installHint).toMatch(/brew install rclone|sudo apt install rclone/);
  });

  it('should call rclone version to detect availability', async () => {
    succeedWith('rclone v1.67.0\n');
    await checkRcloneInstalled();
    expect(mockExecFile).toHaveBeenCalledWith(
      'rclone',
      ['version'],
      EXPECTED_OPTS,
      expect.any(Function),
    );
  });

  it('should return available: false when rclone is not installed', async () => {
    failWith('spawn rclone ENOENT');
    const result = await checkRcloneInstalled();
    expect(result.available).toBe(false);
    expect(result.error).toBeTruthy();
    expect(result.name).toBe('rclone');
    expect(result.installHint).toMatch(/brew install rclone|sudo apt install rclone/);
  });

  it('should return available: true even when version string cannot be parsed', async () => {
    succeedWith('unexpected output format');
    const result = await checkRcloneInstalled();
    expect(result.available).toBe(true);
    expect(result.version).toBeUndefined();
  });

  it('should include stderr content in the error message on failure', async () => {
    failWith('Command failed', 'rclone: command not found');
    const result = await checkRcloneInstalled();
    expect(result.available).toBe(false);
    expect(result.error).toContain('rclone: command not found');
  });

  it('should handle timeout errors and return available: false', async () => {
    mockExecFile.mockImplementation((_file: any, _args: any, _opts: any, cb: ExecCallback) => {
      cb(Object.assign(new Error('Command timed out'), { code: 'ETIMEDOUT' }), '', 'timed out');
    });
    const result = await checkRcloneInstalled();
    expect(result.available).toBe(false);
    expect(result.error).toContain('timed out');
  });
});
