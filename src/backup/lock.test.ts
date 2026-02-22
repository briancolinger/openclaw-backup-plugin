import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import { acquireLock } from './lock.js';

// ---------------------------------------------------------------------------
// Hoisted mocks
// ---------------------------------------------------------------------------

const { mockOpen, mockReadFile, mockRm, mockMkdir, mockHomedir } = vi.hoisted(() => ({
  mockOpen: vi.fn(),
  mockReadFile: vi.fn(),
  mockRm: vi.fn(),
  mockMkdir: vi.fn(),
  mockHomedir: vi.fn(),
}));

vi.mock('node:fs/promises', () => ({
  open: mockOpen,
  readFile: mockReadFile,
  rm: mockRm,
  mkdir: mockMkdir,
}));
vi.mock('node:os', () => ({ homedir: mockHomedir }));

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const LOCK_PATH = '/home/user/.openclaw/.backup.lock';

interface MockFileHandle {
  writeFile: ReturnType<typeof vi.fn>;
  close: ReturnType<typeof vi.fn>;
}

function makeFileHandle(): MockFileHandle {
  return {
    writeFile: vi.fn().mockResolvedValue(undefined),
    close: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeadPidError(): Error {
  return Object.assign(new Error('ESRCH: no such process'), { code: 'ESRCH' });
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
let killSpy: any;

beforeEach(() => {
  vi.resetAllMocks();
  // Default: all PIDs appear alive — tests that don't care about PID liveness work as-is
  killSpy = vi.spyOn(process, 'kill').mockReturnValue(true);
  mockHomedir.mockReturnValue('/home/user');
  mockMkdir.mockResolvedValue(undefined);
  mockRm.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
});

afterEach(() => {
  killSpy.mockRestore();
});

// ---------------------------------------------------------------------------
// acquireLock
// ---------------------------------------------------------------------------

describe('acquireLock', () => {
  it('should create the lock file and return a release handle', async () => {
    const fh = makeFileHandle();
    mockOpen.mockResolvedValue(fh);

    const handle = await acquireLock();

    expect(mockOpen).toHaveBeenCalledWith(LOCK_PATH, 'wx');
    expect(fh.writeFile).toHaveBeenCalledOnce();
    expect(fh.close).toHaveBeenCalledOnce();
    expect(handle.release).toBeTypeOf('function');
  });

  it('should throw when lock exists and is not stale', async () => {
    const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    mockOpen.mockRejectedValue(eexist);
    // PID is alive (default spy) — fresh lock is not stale
    mockReadFile.mockResolvedValue(
      JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }),
    );

    await expect(acquireLock()).rejects.toThrow('Another backup is already running');
  });

  it('should not treat a lock as stale when PID is alive even if the lock is old', async () => {
    const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    mockOpen.mockRejectedValue(eexist);
    // Lock is well past the stale timeout, but the PID is alive (default spy)
    const oldTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    mockReadFile.mockResolvedValue(JSON.stringify({ pid: 99999, startedAt: oldTime }));

    await expect(acquireLock()).rejects.toThrow('Another backup is already running');
  });

  it('should remove a stale lock when PID is dead and lock is old', async () => {
    const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    const fh = makeFileHandle();
    mockOpen
      .mockRejectedValueOnce(eexist) // first attempt fails — lock exists
      .mockResolvedValueOnce(fh); // retry succeeds
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    mockReadFile.mockResolvedValue(JSON.stringify({ pid: 99999, startedAt: staleTime }));
    killSpy.mockImplementation(() => {
      throw makeDeadPidError();
    });

    const handle = await acquireLock();

    expect(mockRm).toHaveBeenCalledWith(LOCK_PATH, { force: true });
    expect(mockOpen).toHaveBeenCalledTimes(2);
    expect(handle.release).toBeTypeOf('function');
  });

  it('should not remove a lock when PID is dead but lock has not reached the stale timeout', async () => {
    const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    mockOpen.mockRejectedValue(eexist);
    // Lock is brand-new: dead PID alone is not enough — wait for the age timeout
    mockReadFile.mockResolvedValue(
      JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }),
    );
    killSpy.mockImplementation(() => {
      throw makeDeadPidError();
    });

    await expect(acquireLock()).rejects.toThrow('Another backup is already running');
    expect(mockRm).not.toHaveBeenCalled();
  });

  it('should back off when two processes race to recover the same stale lock', async () => {
    const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    mockOpen
      .mockRejectedValueOnce(eexist) // initial attempt — stale lock exists
      .mockRejectedValueOnce(eexist); // retry after rm — another process won the race
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    mockReadFile.mockResolvedValue(JSON.stringify({ pid: 99999, startedAt: staleTime }));
    killSpy.mockImplementation(() => {
      throw makeDeadPidError();
    });

    await expect(acquireLock()).rejects.toThrow('Another backup is already running');
    // We still removed the stale lock before discovering we lost the race
    expect(mockRm).toHaveBeenCalledWith(LOCK_PATH, { force: true });
  });

  it('should throw with a clear message on unexpected open errors', async () => {
    const eperm = Object.assign(new Error('EPERM: operation not permitted'), { code: 'EPERM' });
    mockOpen.mockRejectedValue(eperm);

    await expect(acquireLock()).rejects.toThrow('Cannot create backup lock');
  });

  it('release() should delete the lock file', async () => {
    const fh = makeFileHandle();
    mockOpen.mockResolvedValue(fh);

    const handle = await acquireLock();
    await handle.release();

    expect(mockRm).toHaveBeenCalledWith(LOCK_PATH, { force: true });
  });

  it('release() should not throw if the lock file is already gone', async () => {
    const fh = makeFileHandle();
    mockOpen.mockResolvedValue(fh);
    mockRm.mockRejectedValue(Object.assign(new Error('ENOENT'), { code: 'ENOENT' }));

    const handle = await acquireLock();
    await expect(handle.release()).resolves.toBeUndefined();
  });
});
