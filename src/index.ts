import { access } from 'node:fs/promises';
import { homedir } from 'node:os';
import { join } from 'node:path';

import { registerBackupCli } from './cli.js';
import { loadBackupConfig } from './config.js';
import { getConsecutiveFailures, getNotificationPaths } from './notifications.js';
import { isRecord } from './utils.js';

// Re-export all public types and constants for consumers of the plugin package
export * from './types.js';

// ---------------------------------------------------------------------------
// Plugin API duck-type (OpenClaw host provides the concrete type at runtime)
// ---------------------------------------------------------------------------

interface RegisterCliContext {
  program: unknown;
}

interface PluginApiLike {
  registerCli(registrar: (ctx: RegisterCliContext) => void, opts: { commands: string[] }): void;
}

function isPluginApiLike(v: unknown): v is PluginApiLike {
  return isRecord(v) && typeof v['registerCli'] === 'function';
}

// ---------------------------------------------------------------------------
// Startup checks
// ---------------------------------------------------------------------------

/**
 * Fires once at plugin registration time. Checks backup-last-result.json for
 * pending failures and warns the user if backups have been consistently failing.
 */
async function warnIfBackupsFailing(): Promise<void> {
  try {
    const openclawDir = join(homedir(), '.openclaw');
    const paths = getNotificationPaths(openclawDir);
    const consecutiveFails = await getConsecutiveFailures(paths.lastResult);
    if (consecutiveFails > 0) {
      console.warn(
        `\nopenclaw-backup: WARNING — last ${consecutiveFails} backup(s) have failed.\n` +
          `  Run 'openclaw backup health' for details or 'openclaw backup' to retry.\n`,
      );
    }
  } catch {
    // best-effort — don't fail plugin registration on notification read errors
  }
}

/**
 * Fires once at plugin registration time. If the config enables encryption
 * but no key file exists yet, warns the user so they are not surprised by a
 * key-generation prompt on their first backup run.
 */
async function warnIfKeyMissing(): Promise<void> {
  let keyPath: string;
  try {
    const config = await loadBackupConfig();
    if (!config.encrypt) {
      return;
    }
    keyPath = config.encryptKeyPath;
  } catch {
    return; // no config yet — nothing to warn about
  }
  try {
    await access(keyPath);
  } catch {
    console.warn(
      `\nopenclaw-backup: WARNING — Encrypted backups are configured but no key exists at ${keyPath}.\n` +
        `  Run 'openclaw backup' to generate one, or 'openclaw backup key-info' to see status.\n`,
    );
  }
}

// ---------------------------------------------------------------------------
// Plugin definition
// ---------------------------------------------------------------------------

const plugin = {
  id: 'openclaw-backup',
  name: 'OpenClaw Backup',
  description: 'Backup and restore with multi-provider storage and age encryption',
  version: '0.1.0',
  register: (api: unknown): void => {
    if (!isPluginApiLike(api)) {
      throw new Error('openclaw-backup: invalid plugin API — expected registerCli method');
    }
    api.registerCli(
      (ctx) => {
        registerBackupCli(ctx.program);
      },
      { commands: ['backup', 'restore'] },
    );
    void warnIfKeyMissing();
    void warnIfBackupsFailing();
  },
};

// Named export: import { plugin } from 'openclaw-backup'
export { plugin };

// Default export: OpenClaw's plugin loader discovers plugins via `export default`.
// This intentionally violates the "no default exports" house rule — the named
// export above is the preferred import path for type-safe consumers.
export default plugin;
