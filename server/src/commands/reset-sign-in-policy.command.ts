import { Command, CommandRunner } from 'nest-commander';
import { CliService } from 'src/services/cli.service.js';

@Command({
  name: 'reset-sign-in-policy',
  description: 'Reset "Require a passkey or two-step" to administrators away from home',
})
export class ResetSignInPolicyCommand extends CommandRunner {
  constructor(private service: CliService) {
    super();
  }

  async run(): Promise<void> {
    await this.service.resetSignInPolicy();
    console.log('"Require a passkey or two-step" is back to administrators away from home.');
  }
}
