import { checkAgeInstalled } from './backup/encrypt.js';
import { checkRcloneInstalled } from './storage/rclone.js';
import { type BackupConfig, type PrerequisiteCheck } from './types.js';

// ---------------------------------------------------------------------------
// Constants
// ---------------------------------------------------------------------------

const TOOL_REASONS: Record<string, string> = {
  age: 'Required to encrypt and decrypt backup archives.',
  rclone: 'Required to sync backups to remote storage (S3, Google Drive, B2, etc.).',
};

const TOOL_DOCS: Record<string, string> = {
  age: 'https://age-encryption.org',
  rclone: 'https://rclone.org',
};

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

function hasRemoteDestination(config: BackupConfig): boolean {
  return Object.values(config.destinations).some((dest) => dest.remote !== undefined);
}

function getPlatformInstallHint(name: string): string {
  const isMac = process.platform === 'darwin';
  if (name === 'age') {
    return isMac ? 'brew install age' : 'sudo apt install age';
  }
  if (name === 'rclone') {
    return isMac ? 'brew install rclone' : 'sudo apt install rclone';
  }
  return '';
}

function formatCheckError(check: PrerequisiteCheck): string {
  const reason = TOOL_REASONS[check.name] ?? 'Required for backup/restore operations.';
  const installHint = check.installHint ?? getPlatformInstallHint(check.name);
  const docs = TOOL_DOCS[check.name];
  const lines: string[] = [`Missing dependency: ${check.name}`, `  Why: ${reason}`];
  if (installHint.length > 0) {
    lines.push(`  Install: ${installHint}`);
  }
  if (docs !== undefined) {
    lines.push(`  Docs: ${docs}`);
  }
  if (check.error !== undefined) {
    lines.push(`  Error: ${check.error}`);
  }
  return lines.join('\n');
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Checks all external dependencies required by the given config.
 * - age is checked when encryption is enabled
 * - rclone is checked when any non-local destination is configured
 */
export async function checkAllPrerequisites(config: BackupConfig): Promise<PrerequisiteCheck[]> {
  const checks: Promise<PrerequisiteCheck>[] = [];
  if (config.encrypt) {
    checks.push(checkAgeInstalled());
  }
  if (hasRemoteDestination(config)) {
    checks.push(checkRcloneInstalled());
  }
  return Promise.all(checks);
}

/**
 * Formats unavailable prerequisites as user-friendly error messages.
 * Returns an empty string if all prerequisites are met.
 */
export function formatPrerequisiteErrors(checks: PrerequisiteCheck[]): string {
  const failed = checks.filter((c) => !c.available);
  if (failed.length === 0) {
    return '';
  }
  return failed.map(formatCheckError).join('\n\n');
}

/**
 * Checks all prerequisites and returns a structured result suitable for
 * programmatic consumption (e.g., by an agent that auto-installs dependencies).
 */
export async function checkPrerequisitesJson(
  config: BackupConfig,
): Promise<{ ok: boolean; checks: PrerequisiteCheck[] }> {
  const checks = await checkAllPrerequisites(config);
  const ok = checks.every((c) => c.available);
  return { ok, checks };
}
