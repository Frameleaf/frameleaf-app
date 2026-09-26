import { Command, CommandRunner } from 'nest-commander';
import { CliService } from 'src/services/cli.service.js';
import { maintenanceLoginHint } from 'src/utils/maintenance.js';

@Command({
  name: 'enable-maintenance-mode',
  description: 'Enable maintenance mode or regenerate the maintenance token',
})
export class EnableMaintenanceModeCommand extends CommandRunner {
  constructor(private service: CliService) {
    super();
  }

  async run(): Promise<void> {
    const { authUrl, alreadyEnabled } = await this.service.enableMaintenanceMode();

    console.info(alreadyEnabled ? 'The server is already in maintenance mode!' : 'Maintenance mode has been enabled.');
    console.info(`\n${maintenanceLoginHint(authUrl)}:\n${authUrl}`);
  }
}

@Command({
  name: 'disable-maintenance-mode',
  description: 'Disable maintenance mode',
})
export class DisableMaintenanceModeCommand extends CommandRunner {
  constructor(private service: CliService) {
    super();
  }

  async run(): Promise<void> {
    const { alreadyDisabled } = await this.service.disableMaintenanceMode();

    console.log(
      alreadyDisabled ? 'The server is already out of maintenance mode!' : 'Maintenance mode has been disabled.',
    );
  }
}
