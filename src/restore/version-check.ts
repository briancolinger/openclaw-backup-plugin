/**
 * Version compatibility checking for restore operations.
 *
 * Compares the OpenClaw version embedded in a backup manifest against the
 * currently installed version using semver major comparison. Different major
 * versions may have incompatible file formats or config schemas.
 */

// ---------------------------------------------------------------------------
// Types
// ---------------------------------------------------------------------------

/** Severity level of a version compatibility check result. */
export type VersionCompatLevel = 'ok' | 'info' | 'warn';

export interface VersionCompatResult {
  level: VersionCompatLevel;
  /** Human-readable message; empty string when level is 'ok'. */
  message: string;
}

// ---------------------------------------------------------------------------
// Implementation
// ---------------------------------------------------------------------------

function parseMajor(version: string): number | null {
  const match = /^(\d+)/.exec(version);
  if (match === null || match[1] === undefined) {
    return null;
  }
  return parseInt(match[1], 10);
}

/**
 * Compares the OpenClaw version embedded in a backup manifest against the
 * currently installed version.
 *
 * - `ok`   — same major version, or current version is unknown; safe to proceed
 * - `info` — manifest has no version (predates version tracking); proceed
 * - `warn` — major versions differ; restore may encounter compatibility issues
 *
 * Neither 'info' nor 'warn' blocks the restore — a potentially-wrong restore
 * is better than no restore in a disaster recovery scenario.
 */
export function checkVersionCompatibility(
  manifestVersion: string | undefined,
  currentVersion: string | undefined,
): VersionCompatResult {
  if (manifestVersion === undefined) {
    return {
      level: 'info',
      message: 'This backup predates version tracking; compatibility cannot be verified. Proceeding.',
    };
  }

  if (currentVersion === undefined) {
    // Cannot compare — assume compatible and proceed silently.
    return { level: 'ok', message: '' };
  }

  const manifestMajor = parseMajor(manifestVersion);
  const currentMajor = parseMajor(currentVersion);

  if (manifestMajor === null || currentMajor === null) {
    // Malformed version strings — skip check rather than block.
    return { level: 'ok', message: '' };
  }

  if (manifestMajor !== currentMajor) {
    return {
      level: 'warn',
      message:
        `WARNING: Version mismatch. This backup was created with OpenClaw v${manifestVersion} ` +
        `but the current version is v${currentVersion}. Different major versions may not be ` +
        `fully compatible. Proceeding anyway — verify restored files carefully.`,
    };
  }

  return { level: 'ok', message: '' };
}
