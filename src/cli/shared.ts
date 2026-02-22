// ---------------------------------------------------------------------------
// Shared CLI helpers — duck-types, formatting, option extraction, error handling
// ---------------------------------------------------------------------------

import { isRecord } from '../utils.js';

export interface CommandLike {
  command(name: string): CommandLike;
  description(str: string): CommandLike;
  option(flags: string, description: string): CommandLike;
  action(fn: (opts: Record<string, unknown>) => void): CommandLike;
}

export function isCommandLike(v: unknown): v is CommandLike {
  return (
    isRecord(v) &&
    typeof v['command'] === 'function' &&
    typeof v['description'] === 'function' &&
    typeof v['option'] === 'function' &&
    typeof v['action'] === 'function'
  );
}

export function log(msg: string): void {
  // eslint-disable-next-line no-console
  console.log(msg);
}

const KB = 1024;
const MB = 1024 * KB;
const GB = 1024 * MB;

export function formatSize(bytes: number): string {
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

export function getString(opts: Record<string, unknown>, key: string): string | undefined {
  const v = opts[key];
  return typeof v === 'string' ? v : undefined;
}

export function getBoolean(opts: Record<string, unknown>, key: string): boolean {
  return opts[key] === true;
}

export function printError(err: unknown): void {
  const msg = err instanceof Error ? err.message : String(err);
  console.error(`Error: ${msg}`);
}

export function wrapAction(
  fn: (opts: Record<string, unknown>) => Promise<void>,
): (opts: Record<string, unknown>) => void {
  return (opts: Record<string, unknown>): void => {
    void fn(opts).catch((err: unknown) => {
      printError(err);
      process.exitCode = 1;
    });
  };
}
