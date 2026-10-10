import { Command, CommandRunner, Option } from 'nest-commander';
import { CliService } from 'src/services/cli.service.js';

type SetupCodeOptions = { plain?: boolean };

/**
 * FL-292: print the setup code of a server that is not set up yet, as the server showed it on its
 * console when it started (for when that output is gone). Prints nothing useful once the server
 * has an administrator: the code no longer exists.
 */
@Command({
  name: 'setup-code',
  description: 'Print the code to set up this new server from the Frameleaf app or its web page',
})
export class SetupCodeCommand extends CommandRunner {
  constructor(private service: CliService) {
    super();
  }

  @Option({ flags: '--plain', description: 'Print only the code, for scripts' })
  parsePlain(): boolean {
    return true;
  }

  async run(_parameters: string[], options: SetupCodeOptions = {}): Promise<void> {
    const code = await this.service.getSetupCode();
    if (!code) {
      if (!options.plain) {
        console.log('This server has no setup code: it is already set up, or it has not started yet.');
      }
      process.exitCode = 1;
      return;
    }
    console.log(options.plain ? code : `Setup code: ${code}\nIt changes every time the server starts.`);
  }
}
