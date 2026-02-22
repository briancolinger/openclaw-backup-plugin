import { homedir } from 'node:os';
import { join } from 'node:path';

import { runBackup } from '../backup/backup.js';
import { checkAgeInstalled, readKeyInfo } from '../backup/encrypt.js';
import { rotateKey } from '../backup/rotate.js';
import { loadBackupConfig } from '../config.js';
import { getIndex, loadCachedIndex } from '../index-manager.js';
import { pruneBackups } from '../index-prune.js';
import { getNotificationPaths, readAlerts, readLastResult } from '../notifications.js';
import { createStorageProviders } from '../storage/providers.js';
import { checkRcloneInstalled } from '../storage/rclone.js';
import { type BackupOptions } from '../types.js';

import {
  type CommandLike,
  formatSize,
  getBoolean,
  getString,
  log,
  wrapAction,
} from './shared.js';

// ---------------------------------------------------------------------------
// Handlers
// ---------------------------------------------------------------------------

async function handleBackup(opts: Record<string, unknown>): Promise<void> {
  const config = await loadBackupConfig();
  const backupOpts: BackupOptions = {};
  const dest = getString(opts, 'dest');
  if (dest !== undefined) {
    backupOpts.destination = dest;
  }
  if (getBoolean(opts, 'includeTranscripts')) {
    backupOpts.includeTranscripts = true;
  }
  if (getBoolean(opts, 'includePersistor')) {
    backupOpts.includePersistor = true;
  }
  if (getBoolean(opts, 'dryRun')) {
    backupOpts.dryRun = true;
  }
  const result = await runBackup(config, backupOpts);
  if (result.dryRun) {
    log(`✓ Dry run complete — ${result.fileCount} file(s) would be backed up`);
    return;
  }
  log(`✓ Backup complete`);
  log(`  Timestamp:    ${result.timestamp}`);
  log(`  Files:        ${result.fileCount}`);
  log(`  Size:         ${formatSize(result.archiveSize)}`);
  log(`  Destinations: ${result.destinations.join(', ')}`);
  log(`  Encrypted:    ${result.encrypted ? 'yes 🔒' : 'no'}`);
}

async function handleList(opts: Record<string, unknown>): Promise<void> {
  const source = getString(opts, 'source');
  const refresh = getBoolean(opts, 'refresh');
  const config = await loadBackupConfig();
  const providers = createStorageProviders(config, source);
  const index = await getIndex(providers, refresh);
  const entries =
    source !== undefined
      ? index.entries.filter((e) => e.providers.includes(source))
      : index.entries;
  if (entries.length === 0) {
    log('No backups found.');
    return;
  }
  log(
    `${'Timestamp'.padEnd(20)} ${'Size'.padStart(9)} ${'Files'.padStart(5)}  Providers           Enc`,
  );
  log('─'.repeat(72));
  for (const entry of entries) {
    const ts = entry.timestamp.slice(0, 19).replace('T', ' ');
    const size = formatSize(entry.size).padStart(9);
    const files = String(entry.fileCount).padStart(5);
    const prov = entry.providers.join(', ').padEnd(20);
    const enc = entry.encrypted ? '🔒' : '  ';
    log(`${ts} ${size} ${files}  ${prov}${enc}`);
  }
  log(`\n${entries.length} backup(s). Last refreshed: ${index.lastRefreshed}`);
}

async function handlePrune(opts: Record<string, unknown>): Promise<void> {
  const source = getString(opts, 'source');
  const keepStr = getString(opts, 'keep');
  const config = await loadBackupConfig();
  const providers = createStorageProviders(config, source);
  const count = keepStr !== undefined ? parseInt(keepStr, 10) : config.retention.count;
  if (isNaN(count) || count <= 0) {
    throw new Error(`--keep must be a positive integer, got: ${keepStr ?? ''}`);
  }
  const result = await pruneBackups(providers, { count });
  log(`✓ Pruned: deleted ${result.deleted} backup(s), kept ${result.kept}`);
  for (const e of result.errors) {
    console.error(`  ✗ ${e}`);
  }
}

async function handleStatus(_opts: Record<string, unknown>): Promise<void> {
  const cached = await loadCachedIndex();
  if (cached !== null) {
    const latest = cached.entries[0];
    log(`Last backup:   ${latest?.timestamp ?? 'none'}`);
    log(`Total backups: ${cached.entries.length}`);
    log(`Index updated: ${cached.lastRefreshed}`);
  } else {
    log('No backup index cached. Run "openclaw backup list --refresh" to build one.');
  }
  try {
    const config = await loadBackupConfig();
    const destNames = Object.keys(config.destinations);
    log(`Destinations:  ${destNames.length > 0 ? destNames.join(', ') : 'none configured'}`);
    log(`Encryption:    ${config.encrypt ? 'enabled 🔒' : 'disabled'}`);
  } catch {
    log('Config:        not found');
  }
  const [age, rclone] = await Promise.all([checkAgeInstalled(), checkRcloneInstalled()]);
  log(`age:           ${age.available ? `✓ ${age.version ?? 'installed'}` : '✗ not installed'}`);
  log(
    `rclone:        ${rclone.available ? `✓ ${rclone.version ?? 'installed'}` : '✗ not installed'}`,
  );
}

async function handleRotateKey(opts: Record<string, unknown>): Promise<void> {
  const source = getString(opts, 'source');
  const reencrypt = getBoolean(opts, 'reencrypt');
  const config = await loadBackupConfig();
  const rotateOpts = source !== undefined ? { reencrypt, source } : { reencrypt };
  const result = await rotateKey(config, rotateOpts);
  log(`✓ Key rotated`);
  log(`  Old key ID: ${result.oldKeyId}`);
  log(`  New key ID: ${result.newKeyId}`);
  log(`  Old key archived to: ~/.openclaw/.secrets/backup-keys/${result.oldKeyId}.age`);
  if (reencrypt) {
    log(`  Re-encrypted: ${result.reencrypted} archive(s)`);
    for (const e of result.errors) {
      console.error(`  ✗ ${e}`);
    }
  }
}

async function handleKeyInfo(_opts: Record<string, unknown>): Promise<void> {
  const config = await loadBackupConfig();
  const keyPath = config.encryptKeyPath;
  const info = await readKeyInfo(keyPath);

  log(`Key file path:  ${keyPath}`);
  log(`Exists:         ${info.exists ? 'yes' : 'no'}`);
  log(`Readable:       ${info.readable ? 'yes' : 'no'}`);
  if (info.pubKey !== null) {
    log(`Public key:     ${info.pubKey}`);
  } else {
    log(`Public key:     (unavailable)`);
  }
  if (info.keyId !== null) {
    log(`Key ID:         ${info.keyId}`);
  } else {
    log(`Key ID:         (unavailable)`);
  }
  log(`Retired keys:   ${info.retiredKeyCount}`);

  if (!info.exists) {
    console.error(
      `\n  No key found. Run 'openclaw backup' to generate one on your next backup.`,
    );
  } else if (!info.readable) {
    console.error(`\n  Key file exists but is not readable. Check file permissions.`);
  }
}

const HEALTH_FAILURE_HISTORY = 5;

async function handleHealth(_opts: Record<string, unknown>): Promise<void> {
  const openclawDir = join(homedir(), '.openclaw');
  const paths = getNotificationPaths(openclawDir);

  const lastResult = await readLastResult(paths.lastResult);
  if (lastResult === null) {
    log('No backup history found. Run "openclaw backup" to start.');
    return;
  }

  const statusLabel = lastResult.type === 'success' ? '✓ Success' : '✗ Failed';
  log(`Last backup:        ${statusLabel}`);
  log(`Timestamp:          ${lastResult.timestamp}`);
  log(`Consecutive fails:  ${lastResult.consecutiveFailures}`);

  if (lastResult.type === 'failure' && 'error' in lastResult.details) {
    log(`Last error:         ${lastResult.details.error}`);
  }

  const alerts = await readAlerts(paths.alerts);
  if (alerts.length > 0) {
    log(`\nAlert history (last ${Math.min(HEALTH_FAILURE_HISTORY, alerts.length)} of ${alerts.length} failures):`);
    const recent = alerts.slice(-HEALTH_FAILURE_HISTORY);
    for (const alert of recent) {
      const err = 'error' in alert.details ? alert.details.error : '(success)';
      log(`  ${alert.timestamp.slice(0, 19).replace('T', ' ')}  ${err}`);
    }
  }

  const cached = await loadCachedIndex();
  if (cached !== null && cached.entries.length >= 2) {
    const trendEntries = cached.entries.slice(0, HEALTH_FAILURE_HISTORY);
    log(`\nDisk usage trend (most recent ${trendEntries.length} backups):`);
    for (const entry of trendEntries) {
      const ts = entry.timestamp.slice(0, 19).replace('T', ' ');
      log(`  ${ts}  ${formatSize(entry.size)}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Registration
// ---------------------------------------------------------------------------

export function registerBackupCommands(program: CommandLike): void {
  const backup = program
    .command('backup')
    .description('Backup your OpenClaw data to configured destinations')
    .option('--dest <name>', 'target a specific destination')
    .option('--include-transcripts', 'include session transcript files')
    .option('--include-persistor', 'include Persistor knowledge graph export')
    .option('--dry-run', 'preview files that would be backed up without creating archive')
    .action(wrapAction(handleBackup));

  backup
    .command('list')
    .description('List available backups')
    .option('--source <name>', 'filter by storage provider name')
    .option('--refresh', 'force refresh index from remote providers')
    .action(wrapAction(handleList));

  backup
    .command('prune')
    .description('Apply retention policy and delete old backups')
    .option('--source <name>', 'limit pruning to a specific provider')
    .option('--keep <count>', 'number of backups to retain (overrides config)')
    .action(wrapAction(handlePrune));

  backup
    .command('status')
    .description('Show backup health, last run info, and prerequisite status')
    .action(wrapAction(handleStatus));

  backup
    .command('rotate-key')
    .description('Rotate the age encryption key')
    .option('--reencrypt', 're-encrypt all existing backups with the new key')
    .option('--source <name>', 'limit re-encryption to a specific provider')
    .action(wrapAction(handleRotateKey));

  backup
    .command('key-info')
    .description('Display encryption key path, public key, fingerprint, and retired key count')
    .action(wrapAction(handleKeyInfo));

  backup
    .command('health')
    .description('Show last backup status, consecutive failures, alert history, and disk usage trend')
    .action(wrapAction(handleHealth));
}
