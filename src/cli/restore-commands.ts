import { loadBackupConfig } from '../config.js';
import { runRestore } from '../restore/restore.js';
import { type RestoreOptions } from '../types.js';

import { type CommandLike, getBoolean, getString, log, wrapAction } from './shared.js';

// ---------------------------------------------------------------------------
// Handler
// ---------------------------------------------------------------------------

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
  const config = await loadBackupConfig();
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
// Registration
// ---------------------------------------------------------------------------

export function registerRestoreCommands(program: CommandLike): void {
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
