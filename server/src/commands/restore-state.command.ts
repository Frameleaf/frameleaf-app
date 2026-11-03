import { Command, CommandRunner } from 'nest-commander';
import { hasManagerRestoreAuthority } from 'src/commands/validate-restore.command.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { DatabaseService } from 'src/services/database.service.js';

/** Manager invokes this once on its fresh canonical target, before starting workers. */
@Command({ name: 'restore-state', description: 'Reconstruct a Manager-restored database with workers stopped' })
export class RestoreStateCommand extends CommandRunner {
  constructor(
    private database: DatabaseService,
    private repository: DatabaseRepository,
  ) {
    super();
  }

  async run(): Promise<void> {
    try {
      if (!hasManagerRestoreAuthority()) {
        throw new Error('Manager offline restore authority required');
      }
      await this.database.initialize();
      await this.repository.resetTransientExecutionState();
      console.log(JSON.stringify({ reconstructed: true }));
    } catch {
      // Driver/configuration errors can contain credentials and paths. Never print them.
      console.error('Manager restore reconstruction failed; keep workers stopped and resume recovery.');
      process.exitCode = 1;
    }
  }
}
