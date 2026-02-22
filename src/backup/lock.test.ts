import { beforeEach, describe, expect, it, vi } from 'vitest';

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

beforeEach(() => {
  vi.resetAllMocks();
  mockHomedir.mockReturnValue('/home/user');
  mockMkdir.mockResolvedValue(undefined);
  mockRm.mockResolvedValue(undefined);
  mockReadFile.mockResolvedValue(
    JSON.stringify({ pid: process.pid, startedAt: new Date().toISOString() }),
  );
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
    // readFile returns a fresh lock (not stale)
    mockReadFile.mockResolvedValue(
      JSON.stringify({ pid: 99999, startedAt: new Date().toISOString() }),
    );

    await expect(acquireLock()).rejects.toThrow('Another backup is already running');
  });

  it('should remove a stale lock, then succeed', async () => {
    const eexist = Object.assign(new Error('EEXIST'), { code: 'EEXIST' });
    const fh = makeFileHandle();
    mockOpen
      .mockRejectedValueOnce(eexist) // first attempt fails — lock exists
      .mockResolvedValueOnce(fh);    // second attempt succeeds
    // Return a timestamp 31 minutes in the past so the lock is stale
    const staleTime = new Date(Date.now() - 31 * 60 * 1000).toISOString();
    mockReadFile.mockResolvedValue(JSON.stringify({ pid: 99999, startedAt: staleTime }));

    const handle = await acquireLock();

    expect(mockRm).toHaveBeenCalledWith(LOCK_PATH, { force: true });
    expect(mockOpen).toHaveBeenCalledTimes(2);
    expect(handle.release).toBeTypeOf('function');
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
