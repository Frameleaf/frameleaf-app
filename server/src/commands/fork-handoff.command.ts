import { Command, CommandRunner, Option, SubCommand } from 'nest-commander';
import { ForkHandoffService } from 'src/services/fork-handoff.service.js';
import { canonicalCutoverJson } from 'src/services/fork-schema-cutover.service.js';

type PrepareForkOptions = { batchSize?: number };
type PrepareOfficialOptions = { acknowledgeSharedLinkPasswords?: boolean };

@SubCommand({ name: 'prepare-official', description: 'Prepare a certified checkpoint for the official Immich image' })
export class ForkHandoffPrepareOfficialCommand extends CommandRunner {
  constructor(private readonly handoff: ForkHandoffService) {
    super();
  }

  @Option({
    flags: '--acknowledge-shared-link-passwords',
    description:
      'Continue although password-protected shared links stay locked on the official server until their passwords are set again there',
  })
  parseAcknowledgeSharedLinkPasswords(): boolean {
    return true;
  }

  async run(passedParams: string[], options: PrepareOfficialOptions = {}): Promise<void> {
    if (passedParams.length > 0) {
      throw new Error('Prepare official accepts no positional arguments');
    }
    const acknowledgeSharedLinkPasswords = options.acknowledgeSharedLinkPasswords === true;
    // FL-161: refuses before the checkpoint unless the locked shared links were acknowledged
    const { hashed, plaintext } = await this.handoff.sharedLinkPasswordPreflight({
      acknowledgeSharedLinkPasswords,
    });
    const checkpoint = await this.handoff.prepareOfficial({ acknowledgeSharedLinkPasswords });
    if (hashed > 0) {
      process.stderr.write(
        `${hashed} password-protected shared link(s) stay locked on the official server until ` +
          'their passwords are set again there.\n',
      );
    }
    if (plaintext > 0) {
      process.stderr.write(`${plaintext} other password-protected shared link(s) keep working there.\n`);
    }
    process.stdout.write(`${canonicalCutoverJson(checkpoint)}\n`);
  }
}

@SubCommand({ name: 'prepare-fork', description: 'Reconcile and reactivate the certified fork schema' })
export class ForkHandoffPrepareForkCommand extends CommandRunner {
  constructor(private readonly handoff: ForkHandoffService) {
    super();
  }

  @Option({
    flags: '--batch-size <positive integer>',
    description: 'Return reconciliation batch size',
    defaultValue: 100,
  })
  parseBatchSize(value: string): number {
    return +value;
  }

  async run(passedParams: string[], options: PrepareForkOptions = {}): Promise<void> {
    if (passedParams.length > 0) {
      throw new Error('Prepare fork accepts named options only');
    }
    const batchSize = options.batchSize ?? 100;
    if (!Number.isSafeInteger(batchSize) || batchSize <= 0) {
      throw new Error('Batch size must be a positive integer');
    }
    const report = await this.handoff.prepareFork({ batchSize });
    process.stdout.write(`${canonicalCutoverJson(report)}\n`);
  }
}

@Command({
  name: 'fork-handoff',
  description: 'Prepare certified transitions between fork and official Immich images',
  subCommands: [ForkHandoffPrepareOfficialCommand, ForkHandoffPrepareForkCommand],
})
export class ForkHandoffCommand extends CommandRunner {
  run(): Promise<void> {
    this.command.outputHelp();
    return Promise.resolve();
  }
}

export const forkHandoffCommands = ForkHandoffCommand.registerWithSubCommands();
