import { readFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ENCRYPT_KEY_PATH,
  DEFAULT_RETENTION_COUNT,
  type BackupConfig,
  type DestinationConfig,
  type RetentionConfig,
} from './types.js';
import { isRecord, sanitizeHostname } from './utils.js';

const DEFAULT_INCLUDE = ['~/.openclaw'];
const DEFAULT_EXCLUDE = [
  '~/.openclaw/logs',
  '~/.openclaw/media',
  '~/.openclaw/delivery-queue',
  '~/.openclaw/browser',
  '~/.openclaw/canvas',
  '~/.openclaw/memory',
  'node_modules',
  '.venv',
  'venv',
  '.git',
  '__pycache__',
  'dist',
  'coverage',
  '.next',
  '*.jsonl',
  '*.bak*',
  '*.pyc',
  '*.tsbuildinfo',
  'openclaw.json.bak*',
];
const DEFAULT_OPENCLAW_CONFIG = '~/.openclaw/openclaw.json';

function resolvePath(p: string): string {
  if (p.startsWith('~/')) {
    return join(homedir(), p.slice(2));
  }
  return p;
}

function resolvePathArray(paths: string[]): string[] {
  return paths.map(resolvePath);
}

function parseStringArray(raw: unknown, field: string): string[] {
  if (!Array.isArray(raw)) {
    throw new Error(`config.${field} must be an array of strings`);
  }
  return raw.map((item: unknown, i: number) => {
    if (typeof item !== 'string') {
      throw new Error(`config.${field}[${i}] must be a string`);
    }
    return item;
  });
}

function parseBoolean(raw: unknown, field: string, defaultValue: boolean): boolean {
  if (raw == null) {
    return defaultValue;
  }
  if (typeof raw !== 'boolean') {
    throw new Error(`config.${field} must be a boolean`);
  }
  return raw;
}

function parseOptionalPath(raw: unknown, field: string, defaultPath: string): string {
  if (raw == null) {
    return resolvePath(defaultPath);
  }
  if (typeof raw !== 'string') {
    throw new Error(`config.${field} must be a string`);
  }
  return resolvePath(raw);
}

function parsePathArray(raw: unknown, field: string, defaultPaths: string[]): string[] {
  if (raw == null) {
    return resolvePathArray(defaultPaths);
  }
  return resolvePathArray(parseStringArray(raw, field));
}

/** [min, max] inclusive for each cron field: minute, hour, day, month, weekday */
const CRON_FIELD_RANGES: ReadonlyArray<readonly [number, number]> = [
  [0, 59], // minute
  [0, 23], // hour
  [1, 31], // day
  [1, 12], // month
  [0, 7], // weekday (0 and 7 both represent Sunday)
];

function isCronFieldInRange(field: string, min: number, max: number): boolean {
  if (field === '*') return true;
  const nums = field.match(/\d+/g);
  if (nums == null) return false;
  return nums.every((n) => {
    const val = parseInt(n, 10);
    return val >= min && val <= max;
  });
}

function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) return false;
  if (!parts.every((part) => /^[-\d*,/]+$/.test(part))) return false;
  return parts.every((part, i) => {
    const range = CRON_FIELD_RANGES[i];
    if (range == null) return false;
    return isCronFieldInRange(part, range[0], range[1]);
  });
}

/** Strips ASCII control characters (< 0x20 except newline) to prevent log injection. */
function sanitizeForMessage(str: string): string {
  return str.replace(/[\x00-\x09\x0b-\x1f]/g, '');
}

function parseSchedule(raw: unknown): string | undefined {
  if (raw == null) {
    return undefined;
  }
  if (typeof raw !== 'string') {
    throw new Error('config.schedule must be a string');
  }
  if (!isValidCron(raw)) {
    throw new Error(
      `config.schedule "${sanitizeForMessage(raw)}" is not a valid cron expression ` +
        `(expected 5 fields: minute hour day month weekday)`,
    );
  }
  return raw;
}

function parseRetention(raw: unknown): RetentionConfig {
  if (raw == null) {
    return { count: DEFAULT_RETENTION_COUNT };
  }
  if (!isRecord(raw)) {
    throw new Error('config.retention must be an object');
  }
  const countRaw = raw['count'];
  if (countRaw == null) {
    return { count: DEFAULT_RETENTION_COUNT };
  }
  if (typeof countRaw !== 'number' || !Number.isInteger(countRaw) || countRaw <= 0) {
    throw new Error('config.retention.count must be a positive integer');
  }
  if (countRaw > 1000) {
    throw new Error('config.retention.count must not exceed 1000');
  }
  return { count: countRaw };
}

function buildDestinationConfig(
  path: string | undefined,
  remote: string | undefined,
): DestinationConfig {
  if (path !== undefined && remote !== undefined) {
    return { path: resolvePath(path), remote };
  }
  if (path !== undefined) {
    return { path: resolvePath(path) };
  }
  if (remote !== undefined) {
    return { remote };
  }
  throw new Error('Unreachable: both path and remote are undefined');
}

function parseDestination(name: string, raw: unknown): DestinationConfig {
  if (!isRecord(raw)) {
    throw new Error(`config.destinations.${name} must be an object`);
  }
  const pathVal = raw['path'];
  const remoteVal = raw['remote'];
  if (pathVal !== undefined && typeof pathVal !== 'string') {
    throw new Error(`config.destinations.${name}.path must be a string`);
  }
  if (remoteVal !== undefined && typeof remoteVal !== 'string') {
    throw new Error(`config.destinations.${name}.remote must be a string`);
  }
  if (pathVal === undefined && remoteVal === undefined) {
    throw new Error(`config.destinations.${name} must have either "path" or "remote"`);
  }
  return buildDestinationConfig(pathVal, remoteVal);
}

function parseDestinations(raw: unknown): Record<string, DestinationConfig> {
  if (raw == null) {
    return {};
  }
  if (!isRecord(raw)) {
    throw new Error('config.destinations must be an object');
  }
  const result: Record<string, DestinationConfig> = {};
  for (const [name, value] of Object.entries(raw)) {
    result[name] = parseDestination(name, value);
  }
  return result;
}

async function readConfigFile(resolved: string): Promise<unknown> {
  try {
    const parsed: unknown = JSON.parse(await readFile(resolved, 'utf8'));
    return parsed;
  } catch (cause) {
    if (cause instanceof Error) {
      throw new Error(`Failed to read openclaw config from ${resolved}: ${cause.message}`, {
        cause,
      });
    }
    throw new Error(`Failed to read openclaw config from ${resolved}`);
  }
}

export function parseBackupConfig(raw: unknown): BackupConfig {
  if (!isRecord(raw)) {
    throw new Error('backup config must be a JSON object');
  }
  const schedule = parseSchedule(raw['schedule']);
  const destinations = parseDestinations(raw['destinations']);
  if (Object.keys(destinations).length === 0) {
    console.warn(
      'openclaw-backup: no destinations configured — backups will only work in dry-run mode',
    );
  }
  const config: BackupConfig = {
    encrypt: parseBoolean(raw['encrypt'], 'encrypt', true),
    encryptKeyPath: parseOptionalPath(
      raw['encryptKeyPath'],
      'encryptKeyPath',
      DEFAULT_ENCRYPT_KEY_PATH,
    ),
    include: parsePathArray(raw['include'], 'include', DEFAULT_INCLUDE),
    exclude: parsePathArray(raw['exclude'], 'exclude', DEFAULT_EXCLUDE),
    extraPaths: parsePathArray(raw['extraPaths'], 'extraPaths', []),
    includeTranscripts: parseBoolean(raw['includeTranscripts'], 'includeTranscripts', false),
    includePersistor: parseBoolean(raw['includePersistor'], 'includePersistor', false),
    retention: parseRetention(raw['retention']),
    destinations,
  };
  if (schedule !== undefined) {
    config.schedule = schedule;
  }
  const rawHostname = raw['hostname'];
  if (typeof rawHostname === 'string') {
    config.hostname = sanitizeHostname(rawHostname);
  }
  const rawTempDir = raw['tempDir'];
  if (typeof rawTempDir === 'string') {
    config.tempDir = resolvePath(rawTempDir);
  } else if (rawTempDir != null) {
    throw new Error('config.tempDir must be a string');
  }
  const rawSkipDiskCheck = raw['skipDiskCheck'];
  if (typeof rawSkipDiskCheck === 'boolean') {
    config.skipDiskCheck = rawSkipDiskCheck;
  } else if (rawSkipDiskCheck != null) {
    throw new Error('config.skipDiskCheck must be a boolean');
  }
  const rawAlertAfterFailures = raw['alertAfterFailures'];
  if (rawAlertAfterFailures != null) {
    if (
      typeof rawAlertAfterFailures !== 'number' ||
      !Number.isInteger(rawAlertAfterFailures) ||
      rawAlertAfterFailures <= 0
    ) {
      throw new Error('config.alertAfterFailures must be a positive integer');
    }
    config.alertAfterFailures = rawAlertAfterFailures;
  }
  return config;
}

function findBackupBlock(raw: unknown): unknown {
  if (!isRecord(raw)) {
    return undefined;
  }
  // Check root-level "backup" key first (standalone config)
  if (raw['backup'] != null) {
    return raw['backup'];
  }
  // Check plugins.entries.openclaw-backup.config (OpenClaw plugin config)
  const plugins = raw['plugins'];
  if (isRecord(plugins)) {
    const entries = plugins['entries'];
    if (isRecord(entries)) {
      const pluginEntry = entries['openclaw-backup'];
      if (isRecord(pluginEntry)) {
        return pluginEntry['config'];
      }
    }
  }
  return undefined;
}

export async function loadBackupConfig(configPath?: string): Promise<BackupConfig> {
  const resolved = resolvePath(configPath ?? DEFAULT_OPENCLAW_CONFIG);
  const raw = await readConfigFile(resolved);
  const backupRaw = findBackupBlock(raw);
  if (backupRaw == null) {
    throw new Error(
      `No backup configuration found in ${resolved} — ` +
        `add a "backup" key or configure plugins.entries.openclaw-backup.config`,
    );
  }
  return parseBackupConfig(backupRaw);
}

export function getDefaultConfig(): BackupConfig {
  return {
    encrypt: true,
    encryptKeyPath: resolvePath(DEFAULT_ENCRYPT_KEY_PATH),
    include: resolvePathArray(DEFAULT_INCLUDE),
    exclude: resolvePathArray(DEFAULT_EXCLUDE),
    extraPaths: [],
    includeTranscripts: false,
    includePersistor: false,
    retention: { count: DEFAULT_RETENTION_COUNT },
    destinations: {},
  };
}
