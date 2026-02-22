import { registerBackupCommands } from './cli/backup-commands.js';
import { registerRestoreCommands } from './cli/restore-commands.js';
import { isCommandLike } from './cli/shared.js';

/**
 * Registers all backup/restore CLI commands with the OpenClaw commander program.
 * The `program` parameter is typed as `unknown` because the concrete type comes
 * from the OpenClaw host — it is verified at runtime via isCommandLike().
 */
export function registerBackupCli(program: unknown): void {
  if (!isCommandLike(program)) {
    throw new Error('registerBackupCli: expected a Commander Command instance');
  }
  registerBackupCommands(program);
  registerRestoreCommands(program);
}
