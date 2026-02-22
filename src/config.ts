import { readFileSync } from 'node:fs';
import { homedir } from 'node:os';
import { join } from 'node:path';

import {
  DEFAULT_ENCRYPT_KEY_PATH,
  DEFAULT_RETENTION_COUNT,
  type BackupConfig,
  type DestinationConfig,
  type RetentionConfig,
} from './types.js';

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

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

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

function isValidCron(expr: string): boolean {
  const parts = expr.trim().split(/\s+/);
  if (parts.length !== 5) {
    return false;
  }
  return parts.every((part) => /^[-\d*,/]+$/.test(part));
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
      `config.schedule "${raw}" is not a valid cron expression ` +
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

function readConfigFile(resolved: string): unknown {
  try {
    const parsed: unknown = JSON.parse(readFileSync(resolved, 'utf8'));
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
  return config;
}

export function loadBackupConfig(configPath?: string): BackupConfig {
  const resolved = resolvePath(configPath ?? DEFAULT_OPENCLAW_CONFIG);
  const raw = readConfigFile(resolved);
  if (!isRecord(raw)) {
    throw new Error(`openclaw.json at ${resolved} must be a JSON object`);
  }
  const backupRaw = raw['backup'];
  if (backupRaw == null) {
    throw new Error(
      `openclaw.json at ${resolved} has no "backup" configuration block — ` +
        `add a "backup" key to enable backups`,
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
