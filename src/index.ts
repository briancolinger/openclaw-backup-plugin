import { registerBackupCli } from './cli.js';

// Re-export all public types and constants for consumers of the plugin package
export * from './types.js';

// ---------------------------------------------------------------------------
// Plugin API duck-type (OpenClaw host provides the concrete type at runtime)
// ---------------------------------------------------------------------------

interface RegisterCliContext {
  program: unknown;
}

interface PluginApiLike {
  registerCli(
    registrar: (ctx: RegisterCliContext) => void,
    opts: { commands: string[] },
  ): void;
}

function isRecord(v: unknown): v is Record<string, unknown> {
  return typeof v === 'object' && v !== null && !Array.isArray(v);
}

function isPluginApiLike(v: unknown): v is PluginApiLike {
  return isRecord(v) && typeof v['registerCli'] === 'function';
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
  },
};

// Named export: import { plugin } from 'openclaw-backup'
export { plugin };

// Default export required by OpenClaw's plugin loader
export default plugin;
