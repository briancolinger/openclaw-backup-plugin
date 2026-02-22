import { runBackup } from './backup/backup.js';
import { checkAgeInstalled } from './backup/encrypt.js';
import { rotateKey } from './backup/rotate.js';
import { loadBackupConfig } from './config.js';
import { getIndex, loadCachedIndex, pruneBackups } from './index-manager.js';
import { runRestore } from './restore/restore.js';
import { createStorageProviders } from './storage/providers.js';
import { checkRcloneInstalled } from './storage/rclone.js';
import { type BackupOptions, type RestoreOptions } from './types.js';

// ---------------------------------------------------------------------------
// Commander duck-type (program is typed as unknown because it comes from OpenClaw)
// ---------------------------------------------------------------------------

interface CommandLike {
  command(name: string): CommandLike;
  description(str: string): CommandLike;
  option(flags: string, description: string): CommandLike;
  action(fn: (opts: Record<string, unknown>) => void): CommandLike;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isCommandLike(v: unknown): v is CommandLike {
  return (
    isRecord(v) &&
    typeof v['command'] === 'function' &&
    typeof v['description'] === 'function' &&
    typeof v['option'] === 'function' &&
    typeof v['action'] === 'function'
  );
}

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

const log = (msg: string): void => {
  // eslint-disable-next-line no-console
  console.log(msg);
};

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

function formatSize(bytes: number): string {
  if (bytes >= GB) {
    return `${(bytes / GB).toFixed(1)} GB`;
  }
  if (bytes >= MB) {
    return `${(bytes / MB).toFixed(1)} MB`;
  }
  if (bytes >= KB) {
    return `${(bytes / KB).toFixed(1)} KB`;
  }
  return `${bytes} B`;
}

function getString(opts: Record<string, unknown>, key: string): string | undefined {
  const v = opts[key];
  return typeof v === 'string' ? v : undefined;
}

function getBoolean(opts: Record<string, unknown>, key: string): boolean {
  return opts[key] === true;
}

function printError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
}

function wrapAction(
  fn: (opts: Record<string, unknown>) => Promise<void>,
): (opts: Record<string, unknown>) => void {
  return (opts: Record<string, unknown>): void => {
    void fn(opts).catch((err: unknown) => {
      printError(err);
      // Set exit code rather than calling process.exit() so that cleanup
      // handlers registered by the host (OpenClaw) can still run.
      process.exitCode = 1;
    });
  };
}

// ---------------------------------------------------------------------------
// Command handlers
// ---------------------------------------------------------------------------

async function handleBackup(opts: Record<string, unknown>): Promise<void> {
  const config = loadBackupConfig();
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
  const config = loadBackupConfig();
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
  const config = loadBackupConfig();
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
  const cached = loadCachedIndex();
  if (cached !== null) {
    const latest = cached.entries[0];
    log(`Last backup:   ${latest?.timestamp ?? 'none'}`);
    log(`Total backups: ${cached.entries.length}`);
    log(`Index updated: ${cached.lastRefreshed}`);
  } else {
    log('No backup index cached. Run "openclaw backup list --refresh" to build one.');
  }
  try {
    const config = loadBackupConfig();
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
  const config = loadBackupConfig();
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

async function handleRestore(opts: Record<string, unknown>): Promise<void> {
  if (!getBoolean(opts, 'confirm')) {
    throw new Error(
      'Restore requires --confirm flag. This operation will overwrite your current files!',
    );
  }
  const source = getString(opts, 'source');
  if (source === undefined) {
    throw new Error('--source <name> is required for restore');
  }
  const config = loadBackupConfig();
  const restoreOpts: RestoreOptions = { source };
  const ts = getString(opts, 'timestamp');
  if (ts !== undefined) {
    restoreOpts.timestamp = ts;
  }
  if (getBoolean(opts, 'dryRun')) {
    restoreOpts.dryRun = true;
  }
  if (getBoolean(opts, 'skipPreBackup')) {
    restoreOpts.skipPreBackup = true;
  }
  const result = await runRestore(config, restoreOpts);
  const restoreMsg = result.dryRun
    ? `✓ Dry run — ${result.fileCount} file(s) would be restored`
    : `✓ Restore complete`;
  log(restoreMsg);
  if (!result.dryRun) {
    log(`  Timestamp:      ${result.timestamp}`);
    log(`  Files restored: ${result.fileCount}`);
    log(`  Pre-backup:     ${result.preBackupCreated ? 'created' : 'skipped'}`);
    if (result.errors.length > 0) {
      log(`  Errors:         ${result.errors.length} file(s) failed`);
      for (const e of result.errors) {
        console.error(`  ✗ ${e}`);
      }
    }
  }
}

// ---------------------------------------------------------------------------
// Public API
// ---------------------------------------------------------------------------

/**
 * Registers all backup/restore CLI commands with the OpenClaw commander program.
 * The `program` parameter is typed as `unknown` because the concrete type comes
 * from the OpenClaw host — it is verified at runtime via isCommandLike().
 */
export function registerBackupCli(program: unknown): void {
  if (!isCommandLike(program)) {
    throw new Error('registerBackupCli: expected a Commander Command instance');
  }

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

  program
    .command('restore')
    .description('Restore files from a backup')
    .option('--source <name>', 'storage provider to restore from')
    .option('--timestamp <ts>', 'specific backup timestamp to restore (default: latest)')
    .option('--dry-run', 'preview files that would be restored without writing')
    .option('--skip-pre-backup', 'skip creating a safety backup before restoring')
    .option('--confirm', 'required: acknowledge that current files will be overwritten')
    .action(wrapAction(handleRestore));
}
