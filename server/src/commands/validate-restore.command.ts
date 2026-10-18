import { Command, CommandRunner } from 'nest-commander';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { CliService } from 'src/services/cli.service.js';

/** Inspect an offline restored database without initialization, migrations, or worker startup. */
@Command({ name: 'validate-restore', description: 'Validate a restored canonical database without changing it' })
export class ValidateRestoreCommand extends CommandRunner {
  constructor(
    private service: CliService,
    private repository: DatabaseRepository,
  ) {
    super();
  }

  async run(): Promise<void> {
    try {
      const installationId = process.env.FRAMELEAF_MANAGER_INSTALLATION;
      const operationId = process.env.FRAMELEAF_MANAGER_RESTORE_OPERATION_ID;
      if (
        process.env.FRAMELEAF_MANAGER_ORIGIN !== 'restored_library' ||
        !/^[a-f0-9]{12}$/.test(installationId ?? '') ||
        !/^[a-f0-9]{8}(?:-[a-f0-9]{4}){3}-[a-f0-9]{12}$/.test(operationId ?? '') ||
        operationId === '00000000-0000-0000-0000-000000000000'
      ) {
        throw new Error('Manager offline restore authority required');
      }
      await this.repository.assertFrameleafDatabase();
      await this.repository.assertImportActivated();
      const { migrations, drift } = await this.service.schemaReport();
      if (migrations.length === 0 || migrations.some((item) => item.status !== 'applied') || drift.items.length > 0) {
        throw new Error('Restored database does not match the canonical runtime schema');
      }
      console.log(JSON.stringify({ protocolVersion: 1, state: 'restore-schema-valid', installationId, operationId }));
    } catch {
      // Schema and driver errors can contain private SQL, paths, or credentials.
      console.error('Restore schema validation failed; keep the server stopped and resume recovery.');
      process.exitCode = 1;
    }
  }
}
