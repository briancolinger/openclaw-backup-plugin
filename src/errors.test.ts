import { describe, expect, it } from 'vitest';

import { wrapError } from './errors.js';

describe('wrapError', () => {
  it('should include the context and original message when err is an Error', () => {
    const original = new Error('original problem');
    const wrapped = wrapError('High-level context', original);

    expect(wrapped.message).toBe('High-level context: original problem');
  });

  it('should set cause to the original Error', () => {
    const original = new Error('cause');
    const wrapped = wrapError('context', original);

    expect(wrapped.cause).toBe(original);
  });

  it('should stringify non-Error values and include in message', () => {
    const wrapped = wrapError('context', 'plain string error');

    expect(wrapped.message).toBe('context: plain string error');
  });

  it('should stringify numeric non-Error values', () => {
    const wrapped = wrapError('context', 42);

    expect(wrapped.message).toBe('context: 42');
  });

  it('should return an Error instance in all cases', () => {
    expect(wrapError('ctx', new Error('e'))).toBeInstanceOf(Error);
    expect(wrapError('ctx', 'string')).toBeInstanceOf(Error);
    expect(wrapError('ctx', null)).toBeInstanceOf(Error);
  });

  it('should not set cause when err is not an Error', () => {
    const wrapped = wrapError('ctx', 'not an error');

    expect(wrapped.cause).toBeUndefined();
  });
});
