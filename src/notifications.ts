/**
 * Backup notification I/O.
 *
 * Two files written to ~/.openclaw/:
 *   backup-last-result.json  — latest outcome (always overwritten)
 *   backup-alerts.jsonl      — append-only log of failures past the threshold
 *
 * The host process (OpenClaw) can read backup-last-result.json for health checks
 * and consume backup-alerts.jsonl to surface persistent failure alerts to the user.
 */

import { appendFile, mkdir, readFile, unlink, writeFile } from 'node:fs/promises';
import { hostname as osHostname } from 'node:os';
import { join } from 'node:path';

import {
  type BackupConfig,
  type BackupNotification,
  type BackupResult,
} from './types.js';
import { isRecord, sanitizeHostname } from './utils.js';

// ---------------------------------------------------------------------------
// Paths
// ---------------------------------------------------------------------------

const DEFAULT_ALERT_AFTER_FAILURES = 3;

export function getNotificationPaths(openclawDir: string): {
  lastResult: string;
  alerts: string;
} {
  return {
    lastResult: join(openclawDir, 'backup-last-result.json'),
    alerts: join(openclawDir, 'backup-alerts.jsonl'),
  };
}

// ---------------------------------------------------------------------------
// Parsing helpers
// ---------------------------------------------------------------------------

function isBackupNotification(value: unknown): value is BackupNotification {
  if (!isRecord(value)) return false;
  if (value['type'] !== 'success' && value['type'] !== 'failure') return false;
  if (typeof value['timestamp'] !== 'string') return false;
  if (typeof value['hostname'] !== 'string') return false;
  if (typeof value['consecutiveFailures'] !== 'number') return false;
  if (!isRecord(value['details'])) return false;
  return true;
}

// ---------------------------------------------------------------------------
// Read
// ---------------------------------------------------------------------------

/**
 * Reads the last backup result file. Returns null if absent or malformed.
 */
export async function readLastResult(lastResultPath: string): Promise<BackupNotification | null> {
  try {
    const raw: unknown = JSON.parse(await readFile(lastResultPath, 'utf8'));
    return isBackupNotification(raw) ? raw : null;
  } catch {
    return null;
  }
}

/**
 * Reads all entries from the alerts JSONL file.
 * Silently skips malformed lines.
 */
export async function readAlerts(alertsPath: string): Promise<BackupNotification[]> {
  let content: string;
  try {
    content = await readFile(alertsPath, 'utf8');
  } catch {
    return [];
  }
  const results: BackupNotification[] = [];
  for (const line of content.split('\n')) {
    const trimmed = line.trim();
    if (trimmed.length === 0) continue;
    try {
      const raw: unknown = JSON.parse(trimmed);
      if (isBackupNotification(raw)) {
        results.push(raw);
      }
    } catch {
      // skip malformed line
    }
  }
  return results;
}

/**
 * Deletes the alerts JSONL file. Silently ignores ENOENT.
 */
export async function clearAlerts(alertsPath: string): Promise<void> {
  try {
    await unlink(alertsPath);
  } catch (err) {
    if (isRecord(err) && err['code'] !== 'ENOENT') {
      throw new Error(`Failed to clear alerts: ${String(err)}`, { cause: err });
    }
  }
}

// ---------------------------------------------------------------------------
// Write helpers
// ---------------------------------------------------------------------------

async function ensureDir(dir: string): Promise<void> {
  await mkdir(dir, { recursive: true });
}

async function writeNotification(path: string, notification: BackupNotification): Promise<void> {
  await writeFile(path, JSON.stringify(notification, null, 2), { encoding: 'utf8', mode: 0o600 });
}

async function appendNotification(path: string, notification: BackupNotification): Promise<void> {
  await appendFile(path, JSON.stringify(notification) + '\n', { encoding: 'utf8', mode: 0o600 });
}

// ---------------------------------------------------------------------------
// Public notify API
// ---------------------------------------------------------------------------

/**
 * Records a successful backup outcome to backup-last-result.json.
 * Resets the consecutive-failure counter.
 */
export async function notifyBackupSuccess(
  config: BackupConfig,
  result: BackupResult,
  openclawDir: string,
): Promise<void> {
  const paths = getNotificationPaths(openclawDir);
  await ensureDir(openclawDir);
  const hostname = sanitizeHostname(config.hostname ?? osHostname());
  const notification: BackupNotification = {
    type: 'success',
    timestamp: result.timestamp,
    hostname,
    consecutiveFailures: 0,
    details: result,
  };
  await writeNotification(paths.lastResult, notification);
}

/**
 * Records a failed backup outcome to backup-last-result.json.
 * If the consecutive failure count reaches the configured threshold,
 * also appends the notification to backup-alerts.jsonl.
 */
export async function notifyBackupFailure(
  config: BackupConfig,
  error: unknown,
  openclawDir: string,
): Promise<void> {
  const paths = getNotificationPaths(openclawDir);
  await ensureDir(openclawDir);

  const prior = await readLastResult(paths.lastResult);
  const priorFails = prior?.type === 'failure' ? prior.consecutiveFailures : 0;
  const consecutiveFailures = priorFails + 1;

  const hostname = sanitizeHostname(config.hostname ?? osHostname());
  const errorMsg = error instanceof Error ? error.message : String(error);
  const notification: BackupNotification = {
    type: 'failure',
    timestamp: new Date().toISOString(),
    hostname,
    consecutiveFailures,
    details: { error: errorMsg },
  };

  await writeNotification(paths.lastResult, notification);

  const threshold = config.alertAfterFailures ?? DEFAULT_ALERT_AFTER_FAILURES;
  if (consecutiveFailures >= threshold) {
    await appendNotification(paths.alerts, notification);
  }
}

/**
 * Returns the number of consecutive failures from the last result file.
 * Returns 0 if no result exists or the last backup was successful.
 */
export async function getConsecutiveFailures(lastResultPath: string): Promise<number> {
  const last = await readLastResult(lastResultPath);
  if (last === null || last.type !== 'failure') return 0;
  return last.consecutiveFailures;
}
