#!/usr/bin/env node
/**
 * Standalone restore CLI — disaster recovery entry point.
 * Restores OpenClaw backups WITHOUT a running gateway or openclaw.json.
 * All configuration is supplied via command-line flags.
 *
 * Usage:
 *   openclaw-backup restore \
 *     --source=gdrive --path=gdrive:openclaw-backups/ \
 *     --key=~/.openclaw/.secrets/backup.age \
 *     --confirm
 */

import { fileURLToPath } from 'node:url';

import { getDefaultConfig } from '../config.js';
import { type BackupConfig, type DestinationConfig, type RestoreOptions } from '../types.js';

import { runRestore } from './restore.js';

// ---------------------------------------------------------------------------
// Arg types
// ---------------------------------------------------------------------------

export interface StandaloneArgs {
  /** Provider name — used as the key in destinations config */
  source: string;
  /** Storage location: local path or rclone remote (e.g. "gdrive:bucket/") */
  path: string;
  /** ISO 8601 timestamp of backup to restore (default: latest) */
  timestamp?: string;
  /** Path to the age private key for decryption */
  key?: string;
  /** Must be true to proceed; prevents accidental overwrites */
  confirm: boolean;
  /** Preview restore without writing any files */
  dryRun: boolean;
}

// ---------------------------------------------------------------------------
// Arg parser
// ---------------------------------------------------------------------------

/**
 * Parses standalone restore flags from an argv array (process.argv.slice(2)).
 * Supports both `--flag=value` and `--flag value` forms.
 */
export function parseArgs(argv: string[]): StandaloneArgs {
  let source = '';
  let path = '';
  let timestamp: string | undefined;
  let key: string | undefined;
  let confirm = false;
  let dryRun = false;

  const args = [...argv];

  while (args.length > 0) {
    const arg = args.shift();
    if (arg === undefined) {
      break;
    }

    // Boolean flags
    if (arg === '--confirm') {
      confirm = true;
      continue;
    }
    if (arg === '--dry-run') {
      dryRun = true;
      continue;
    }

    // --flag=value form
    const eqIdx = arg.indexOf('=');
    if (eqIdx !== -1) {
      const flag = arg.slice(0, eqIdx);
      const value = arg.slice(eqIdx + 1);
      if (flag === '--source') {
        source = value;
        continue;
      }
      if (flag === '--path') {
        path = value;
        continue;
      }
      if (flag === '--timestamp') {
        timestamp = value;
        continue;
      }
      if (flag === '--key') {
        key = value;
        continue;
      }
      throw new Error(`Unknown flag: ${flag}`);
    }

    // --flag value form
    if (arg === '--source' || arg === '--path' || arg === '--timestamp' || arg === '--key') {
      const next = args.shift();
      if (next === undefined) {
        throw new Error(`${arg} requires a value`);
      }
      if (arg === '--source') {
        source = next;
      } else if (arg === '--path') {
        path = next;
      } else if (arg === '--timestamp') {
        timestamp = next;
      } else {
        key = next;
      }
      continue;
    }

    throw new Error(`Unknown argument: ${arg}`);
  }

  const result: StandaloneArgs = { source, path, confirm, dryRun };
  if (timestamp !== undefined) {
    result.timestamp = timestamp;
  }
  if (key !== undefined) {
    result.key = key;
  }
  return result;
}

// ---------------------------------------------------------------------------
// Config builder
// ---------------------------------------------------------------------------

/** Returns true if `path` looks like a rclone remote spec (e.g. "gdrive:bucket/"). */
function isRcloneRemote(path: string): boolean {
  return (
    !path.startsWith('/') &&
    !path.startsWith('~') &&
    !path.startsWith('.') &&
    path.includes(':')
  );
}

/**
 * Builds a BackupConfig from standalone CLI args.
 * Uses defaults for everything except the storage destination and encryption key.
 */
export function buildConfig(args: StandaloneArgs): BackupConfig {
  const base = getDefaultConfig();

  const dest: DestinationConfig = {};
  if (isRcloneRemote(args.path)) {
    dest.remote = args.path;
  } else {
    dest.path = args.path;
  }

  const config: BackupConfig = {
    encrypt: args.key !== undefined,
    encryptKeyPath: args.key ?? base.encryptKeyPath,
    include: base.include,
    exclude: base.exclude,
    extraPaths: base.extraPaths,
    includeTranscripts: false,
    includePersistor: false,
    retention: base.retention,
    destinations: { [args.source]: dest },
  };
  return config;
}

// ---------------------------------------------------------------------------
// Main logic
// ---------------------------------------------------------------------------

/**
 * Parses argv, validates flags, constructs config, and runs the restore.
 * Exported for testing; called from the entry-point guard below.
 */
export async function runStandalone(argv: string[]): Promise<void> {
  const args = parseArgs(argv);

  if (!args.confirm) {
    throw new Error(
      '--confirm is required: this operation will overwrite your current files',
    );
  }
  if (args.source === '') {
    throw new Error('--source <name> is required');
  }
  if (args.path === '') {
    throw new Error('--path <location> is required (local path or rclone remote)');
  }

  const config = buildConfig(args);
  const restoreOpts: RestoreOptions = {
    source: args.source,
    dryRun: args.dryRun,
    skipPreBackup: true,
  };
  if (args.timestamp !== undefined) {
    restoreOpts.timestamp = args.timestamp;
  }

  const result = await runRestore(config, restoreOpts);

  if (result.dryRun) {
    console.warn(`openclaw-restore: dry run — ${result.fileCount} file(s) would be restored`);
    return;
  }

  console.warn(`openclaw-restore: restore complete`);
  console.warn(`  timestamp:   ${result.timestamp}`);
  console.warn(`  files:       ${result.fileCount}`);

  if (result.errors.length > 0) {
    console.error(`  errors:      ${result.errors.length} file(s) failed`);
    for (const e of result.errors) {
      console.error(`  ✗ ${e}`);
    }
  }
}

// ---------------------------------------------------------------------------
// Entry point (only executes when run directly, not when imported by tests)
// ---------------------------------------------------------------------------

const entryFile = process.argv[1];
if (entryFile !== undefined && fileURLToPath(import.meta.url) === entryFile) {
  void runStandalone(process.argv.slice(2)).catch((err: unknown) => {
    const msg = err instanceof Error ? err.message : String(err);
    console.error(`Error: ${msg}`);
    process.exit(1);
  });
}
