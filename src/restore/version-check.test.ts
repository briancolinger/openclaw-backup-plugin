import { describe, expect, it } from 'vitest';

import { checkVersionCompatibility } from './version-check.js';

describe('checkVersionCompatibility', () => {
  it('should return info when manifestVersion is undefined', () => {
    const result = checkVersionCompatibility(undefined, '2.0.0');

    expect(result.level).toBe('info');
    expect(result.message).toContain('predates version tracking');
  });

  it('should return info when both versions are undefined', () => {
    const result = checkVersionCompatibility(undefined, undefined);

    expect(result.level).toBe('info');
    expect(result.message).toContain('predates version tracking');
  });

  it('should return ok when currentVersion is undefined but manifest has a version', () => {
    const result = checkVersionCompatibility('1.0.0', undefined);

    expect(result.level).toBe('ok');
    expect(result.message).toBe('');
  });

  it('should return ok when major versions match exactly', () => {
    const result = checkVersionCompatibility('1.5.3', '1.9.0');

    expect(result.level).toBe('ok');
    expect(result.message).toBe('');
  });

  it('should return ok when patch versions differ within same major', () => {
    const result = checkVersionCompatibility('2.0.0', '2.3.1');

    expect(result.level).toBe('ok');
    expect(result.message).toBe('');
  });

  it('should return warn when major version is older in manifest', () => {
    const result = checkVersionCompatibility('1.0.0', '2.0.0');

    expect(result.level).toBe('warn');
    expect(result.message).toContain('v1.0.0');
    expect(result.message).toContain('v2.0.0');
    expect(result.message).toContain('WARNING');
  });

  it('should return warn when major version is newer in manifest than current', () => {
    const result = checkVersionCompatibility('3.0.0', '2.5.0');

    expect(result.level).toBe('warn');
    expect(result.message).toContain('v3.0.0');
    expect(result.message).toContain('v2.5.0');
  });

  it('should return ok for malformed manifest version string', () => {
    const result = checkVersionCompatibility('not-a-version', '2.0.0');

    expect(result.level).toBe('ok');
    expect(result.message).toBe('');
  });

  it('should return ok for malformed current version string', () => {
    const result = checkVersionCompatibility('1.0.0', 'dev-build');

    expect(result.level).toBe('ok');
    expect(result.message).toBe('');
  });

  it('should handle prerelease version strings by parsing leading digits', () => {
    const result = checkVersionCompatibility('1.0.0-alpha', '1.0.0-beta');

    expect(result.level).toBe('ok');
  });

  it('should detect major mismatch in prerelease versions', () => {
    const result = checkVersionCompatibility('1.0.0-rc1', '2.0.0');

    expect(result.level).toBe('warn');
  });
});
