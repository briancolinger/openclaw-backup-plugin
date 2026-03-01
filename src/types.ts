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
  /** Override machine hostname used in filenames (default: os.hostname(), sanitized) */
  hostname?: string;
  /** Override the temp directory used for archive staging (default: os.tmpdir()) */
  tempDir?: string;
  /** Skip pre-flight disk space check (for environments where statfs is unreliable) */
  skipDiskCheck?: boolean;
  /** Number of consecutive failures before writing to backup-alerts.jsonl (default: 3) */
  alertAfterFailures?: number;
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

  /**
   * List backup archives for the current hostname only, plus old-format
   * root-level files for backward compatibility. Returns relative paths
   * (e.g. `myhostname/myhostname-2024-01-01T00-00-00.tar.gz`).
   */
  list(): Promise<string[]>;

  /**
   * List backup archives across ALL hostname subdirectories and old-format
   * root-level files. Use this when building a multi-machine index.
   * Returns relative paths including any hostname subdir prefix.
   */
  listAll(): Promise<string[]>;

  /** Delete a backup archive by remote path (may include hostname subdir) */
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
  /** Machine hostname that created this backup */
  hostname: string;
  /** Archive relative path (may include hostname subdir, e.g. `host/host-2024.tar.gz`) */
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
  /** Names of destinations that were skipped because they were unavailable */
  skippedDestinations?: string[];
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
  /** Suppress version compatibility warnings (e.g. when --force is passed) */
  suppressVersionWarning?: boolean;
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
// Encryption Key Info
// =============================================================================

export interface KeyInfo {
  /** Whether the key file exists on disk */
  exists: boolean;
  /** Whether the key file is readable by the current process */
  readable: boolean;
  /** Age public key string, or null if the file is missing/unreadable/malformed */
  pubKey: string | null;
  /** 16-char hex SHA-256 fingerprint of the public key, or null if unavailable */
  keyId: string | null;
  /** Number of retired key files found in the backup-keys/ sibling directory */
  retiredKeyCount: number;
}

// =============================================================================
// Notifications
// =============================================================================

export interface BackupNotification {
  type: 'success' | 'failure';
  /** ISO 8601 timestamp of the backup attempt */
  timestamp: string;
  /** Machine hostname */
  hostname: string;
  /** Number of consecutive failures at time of notification (0 on success) */
  consecutiveFailures: number;
  /** Result on success; error string on failure */
  details: BackupResult | { error: string };
}

// =============================================================================
// Constants
// =============================================================================

export const MANIFEST_SCHEMA_VERSION = 1;
export const MANIFEST_FILENAME = 'manifest.json';
export const DEFAULT_ENCRYPT_KEY_PATH = '~/.openclaw/.secrets/backup.age';
export const DEFAULT_RETENTION_COUNT = 168;
export const BACKUP_INDEX_FILENAME = 'backup-index.json';
