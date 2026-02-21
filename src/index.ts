/**
 * OpenClaw Backup Plugin — entry point.
 *
 * Registers CLI commands and lifecycle hooks with the OpenClaw plugin API.
 * This file is loaded by OpenClaw's plugin loader via openclaw.plugin.json.
 */

export { MANIFEST_SCHEMA_VERSION } from './types.js';

export type {
  BackupConfig,
  BackupEntry,
  BackupIndex,
  BackupManifest,
  BackupOptions,
  RestoreOptions,
  StorageProvider,
} from './types.js';
