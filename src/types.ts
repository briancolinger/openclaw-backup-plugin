/**
 * Core types and interfaces for the OpenClaw backup plugin.
 * All modules import from this file — it is the single source of truth for shapes.
 */

// =============================================================================
// Manifest
// =============================================================================

export interface ManifestFile {
  /** Relative path within the backup */
  path: string;
  /** SHA-256 hex digest */
  sha256: string;
  /** File size in bytes */
  size: number;
  /** ISO 8601 last modified timestamp */
  modified: string;
}

export interface PersistorExportMeta {
  schemaVersion: number;
  nodeCount: number;
  edgeCount: number;
}

export interface BackupManifest {
  /** Manifest format version — always increment on breaking changes */
  schemaVersion: number;
  /** Plugin version that created this backup */
  pluginVersion: string;
  /** OpenClaw version at backup time (if available) */
  openclawVersion?: string;
  /** Machine hostname */
  hostname: string;
  /** ISO 8601 timestamp of backup creation */
  timestamp: string;
  /** Whether the archive is encrypted */
  encrypted: boolean;
  /** Hash of the age public key used (for key rotation tracking) */
  keyId?: string;
  /** Whether session transcripts were included */
  includeTranscripts: boolean;
  /** Whether Persistor KG data was included */
  includePersistor: boolean;
  /** All files in the archive */
  files: ManifestFile[];
  /** Persistor export metadata (if included) */
  persistorExport?: PersistorExportMeta;
}

// =============================================================================
// Config
// =============================================================================

export interface RetentionConfig {
  /** Number of backups to retain (oldest pruned first) */
  count: number;
}

export interface DestinationConfig {
  /** Local filesystem path (for "local" destination) */
  path?: string;
  /** rclone remote spec, e.g. "gdrive:openclaw-backups/" (for remote destinations) */
  remote?: string;
}

export interface BackupConfig {
  /** Cron schedule expression (e.g., "0 * * * *" for hourly) */
  schedule?: string;
  /** Enable encryption with age */
  encrypt: boolean;
  /** Path to age key file */
  encryptKeyPath: string;
  /** Paths to include in backup */
  include: string[];
  /** Glob patterns or paths to exclude */
  exclude: string[];
  /** Additional paths beyond the defaults */
  extraPaths: string[];
  /** Include session transcript .jsonl files */
  includeTranscripts: boolean;
  /** Include Persistor KG export */
  includePersistor: boolean;
  /** Backup retention policy */
  retention: RetentionConfig;
  /** Named destinations (key = destination name, value = config) */
  destinations: Record<string, DestinationConfig>;
}

// =============================================================================
// Storage
// =============================================================================

export interface StorageProvider {
  /** Provider name (e.g., "local", "gdrive", "s3") */
  readonly name: string;

  /** Push an archive file to the provider */
  push(localPath: string, remoteName: string): Promise<void>;

  /** Pull an archive file from the provider to a local path */
  pull(remoteName: string, localPath: string): Promise<void>;

  /** List all backup archives (returns remote filenames) */
  list(): Promise<string[]>;

  /** Delete a backup archive by remote filename */
  delete(remoteName: string): Promise<void>;

  /** Check if the provider is available and configured */
  check(): Promise<ProviderCheckResult>;
}

export interface ProviderCheckResult {
  available: boolean;
  error?: string;
}

// =============================================================================
// Backup Index
// =============================================================================

export interface BackupEntry {
  /** ISO 8601 timestamp */
  timestamp: string;
  /** Archive filename (without path) */
  filename: string;
  /** Which storage providers hold this backup */
  providers: string[];
  /** Whether the archive is encrypted */
  encrypted: boolean;
  /** Total archive size in bytes */
  size: number;
  /** File count from manifest */
  fileCount: number;
}

export interface BackupIndex {
  /** When this index was last refreshed from remotes */
  lastRefreshed: string;
  /** All known backups, newest first */
  entries: BackupEntry[];
}

export interface PruneResult {
  deleted: number;
  kept: number;
  errors: string[];
}

// =============================================================================
// Prerequisites
// =============================================================================

export interface PrerequisiteCheck {
  name: string;
  available: boolean;
  version?: string;
  error?: string;
  installHint?: string;
}

// =============================================================================
// Backup Result
// =============================================================================

export interface BackupResult {
  /** ISO 8601 timestamp from the manifest */
  timestamp: string;
  /** Final archive size in bytes (0 for dry runs) */
  archiveSize: number;
  /** Number of files included in the backup */
  fileCount: number;
  /** Whether the archive is encrypted */
  encrypted: boolean;
  /** Names of the destinations the archive was pushed to */
  destinations: string[];
  /** Whether this was a dry run (no archive created) */
  dryRun: boolean;
}

// =============================================================================
// Restore Result
// =============================================================================

export interface RestoreResult {
  /** ISO 8601 timestamp of the restored backup */
  timestamp: string;
  /** Number of files restored */
  fileCount: number;
  /** Whether this was a dry run (no files written) */
  dryRun: boolean;
  /** Whether a pre-restore backup was created */
  preBackupCreated: boolean;
  /** Per-file copy errors (partial restore may have errors) */
  errors: string[];
}

// =============================================================================
// Backup/Restore Options
// =============================================================================

export interface BackupOptions {
  /** Specific destination (omit for all configured) */
  destination?: string;
  /** Include session transcripts */
  includeTranscripts?: boolean;
  /** Include Persistor export */
  includePersistor?: boolean;
  /** Dry run — show what would be backed up without doing it */
  dryRun?: boolean;
}

export interface RestoreOptions {
  /** Which storage provider to restore from */
  source: string;
  /** Specific backup timestamp to restore (default: latest) */
  timestamp?: string;
  /** Dry run — show what would be restored without doing it */
  dryRun?: boolean;
  /** Skip creating a pre-restore backup */
  skipPreBackup?: boolean;
}

// =============================================================================
// Manifest Options / Validation
// =============================================================================

export interface ManifestOptions {
  encrypted: boolean;
  keyId?: string;
  includeTranscripts: boolean;
  includePersistor: boolean;
  persistorExport?: PersistorExportMeta;
  pluginVersion: string;
  openclawVersion?: string;
}

export interface ValidationResult {
  valid: boolean;
  errors: string[];
}

// =============================================================================
// Collector
// =============================================================================

export interface CollectedFile {
  /** Absolute path on disk */
  absolutePath: string;
  /** Path relative to the backup root (used inside the archive) */
  relativePath: string;
  /** File size in bytes */
  size: number;
  /** ISO 8601 last modified timestamp */
  modified: string;
}

// =============================================================================
// Constants
// =============================================================================

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_FILENAME = 'manifest.json';
export const DEFAULT_ENCRYPT_KEY_PATH = '~/.openclaw/.secrets/backup.age';
export const DEFAULT_RETENTION_COUNT = 168;
export const BACKUP_INDEX_FILENAME = 'backup-index.json';
