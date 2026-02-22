import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';

import {
  formatSize,
  getBoolean,
  getString,
  isCommandLike,
  printError,
  wrapAction,
} from './shared.js';

// ---------------------------------------------------------------------------
// formatSize
// ---------------------------------------------------------------------------

describe('formatSize', () => {
  it('should format bytes under 1 KB as "N B"', () => {
    expect(formatSize(0)).toBe('0 B');
    expect(formatSize(1)).toBe('1 B');
    expect(formatSize(1023)).toBe('1023 B');
  });

  it('should format values in the KB range', () => {
    expect(formatSize(1024)).toBe('1.0 KB');
    expect(formatSize(1536)).toBe('1.5 KB');
    expect(formatSize(1024 * 1023)).toBe('1023.0 KB');
  });

  it('should format values in the MB range', () => {
    expect(formatSize(1024 * 1024)).toBe('1.0 MB');
    expect(formatSize(1024 * 1024 * 2.5)).toBe('2.5 MB');
  });

  it('should format values in the GB range', () => {
    expect(formatSize(1024 * 1024 * 1024)).toBe('1.0 GB');
    expect(formatSize(1024 * 1024 * 1024 * 3.7)).toBe('3.7 GB');
  });
});

// ---------------------------------------------------------------------------
// isCommandLike
// ---------------------------------------------------------------------------

describe('isCommandLike', () => {
  it('should return true for an object with all four required methods', () => {
    const obj = {
      command: () => obj,
      description: () => obj,
      option: () => obj,
      action: () => obj,
    };
    expect(isCommandLike(obj)).toBe(true);
  });

  it('should return false for null', () => {
    expect(isCommandLike(null)).toBe(false);
  });

  it('should return false for a string', () => {
    expect(isCommandLike('not-a-command')).toBe(false);
  });

  it('should return false for an empty object', () => {
    expect(isCommandLike({})).toBe(false);
  });

  it('should return false when any method is missing', () => {
    expect(isCommandLike({ command: () => {}, description: () => {}, option: () => {} })).toBe(
      false,
    );
    expect(isCommandLike({ description: () => {}, option: () => {}, action: () => {} })).toBe(
      false,
    );
  });

  it('should return false when a method is not a function', () => {
    expect(
      isCommandLike({ command: 'not-a-fn', description: () => {}, option: () => {}, action: () => {} }),
    ).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// getString
// ---------------------------------------------------------------------------

describe('getString', () => {
  it('should return the string value for a string key', () => {
    expect(getString({ name: 'alice' }, 'name')).toBe('alice');
  });

  it('should return undefined for a missing key', () => {
    expect(getString({}, 'missing')).toBeUndefined();
  });

  it('should return undefined when the value is not a string', () => {
    expect(getString({ count: 42 }, 'count')).toBeUndefined();
    expect(getString({ flag: true }, 'flag')).toBeUndefined();
    expect(getString({ obj: {} }, 'obj')).toBeUndefined();
  });

  it('should return an empty string when the value is an empty string', () => {
    expect(getString({ key: '' }, 'key')).toBe('');
  });
});

// ---------------------------------------------------------------------------
// getBoolean
// ---------------------------------------------------------------------------

describe('getBoolean', () => {
  it('should return true when the value is strictly true', () => {
    expect(getBoolean({ flag: true }, 'flag')).toBe(true);
  });

  it('should return false for false value', () => {
    expect(getBoolean({ flag: false }, 'flag')).toBe(false);
  });

  it('should return false for a missing key', () => {
    expect(getBoolean({}, 'missing')).toBe(false);
  });

  it('should return false for truthy non-boolean values', () => {
    expect(getBoolean({ flag: 1 }, 'flag')).toBe(false);
    expect(getBoolean({ flag: 'yes' }, 'flag')).toBe(false);
    expect(getBoolean({ flag: {} }, 'flag')).toBe(false);
  });
});

// ---------------------------------------------------------------------------
// printError
// ---------------------------------------------------------------------------

describe('printError', () => {
  let errorSpy: ReturnType<typeof vi.spyOn>;

  beforeEach(() => {
    errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
  });

  afterEach(() => {
    errorSpy.mockRestore();
  });

  it('should print the error message for an Error instance', () => {
    printError(new Error('something broke'));
    expect(errorSpy).toHaveBeenCalledWith('Error: something broke');
  });

  it('should print a stringified form for non-Error values', () => {
    printError('plain string error');
    expect(errorSpy).toHaveBeenCalledWith('Error: plain string error');
  });

  it('should print for numeric and object error values', () => {
    printError(42);
    expect(errorSpy).toHaveBeenCalledWith('Error: 42');
  });
});

// ---------------------------------------------------------------------------
// wrapAction
// ---------------------------------------------------------------------------

describe('wrapAction', () => {
  afterEach(() => {
    process.exitCode = undefined;
  });

  it('should call the wrapped async function with opts', async () => {
    const fn = vi.fn().mockResolvedValue(undefined);
    const wrapped = wrapAction(fn);
    wrapped({ key: 'value' });
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(fn).toHaveBeenCalledWith({ key: 'value' });
  });

  it('should not throw when the wrapped function resolves', async () => {
    const wrapped = wrapAction(async () => undefined);
    expect(() => wrapped({})).not.toThrow();
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
  });

  it('should call printError and set exitCode to 1 when the wrapped fn rejects', async () => {
    const errorSpy = vi.spyOn(console, 'error').mockImplementation(() => undefined);
    const wrapped = wrapAction(async () => {
      throw new Error('handler failed');
    });
    wrapped({});
    await new Promise<void>((resolve) => setTimeout(resolve, 0));
    expect(errorSpy).toHaveBeenCalledWith('Error: handler failed');
    expect(process.exitCode).toBe(1);
    errorSpy.mockRestore();
  });
});
