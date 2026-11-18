import { Command, CommandRunner } from 'nest-commander';
import { CliService } from 'src/services/cli.service.js';

/** FL-1673: run by Manager, which sends the answer to Frameleaf Cloud. One line of JSON on success. */
@Command({
  name: 'backup-machine-statement',
  arguments: '<machineInstanceId>',
  description: 'Vouch for the Manager on this machine, so its Server Backup shares this server\u{2019}s licence',
})
export class BackupMachineStatementCommand extends CommandRunner {
  constructor(private service: CliService) {
    super();
  }

  async run([machineInstanceId]: string[]): Promise<void> {
    try {
      console.log(JSON.stringify(await this.service.vouchForBackupMachine(machineInstanceId ?? '')));
    } catch (error) {
      console.error(error instanceof Error ? error.message : String(error));
      process.exitCode = 1;
    }
  }
}
