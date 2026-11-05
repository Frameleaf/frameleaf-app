import { Command, CommandRunner, Option } from 'nest-commander';
import { Refusal } from '#library-import-transfer/contracts';
import { connectImportDatabase } from 'src/immich-import/database.js';
import { loadLibraryImportConfig, parseLibraryImportArguments } from 'src/library-import/command-input.js';
import { executeLibraryImportCommand } from 'src/library-import/command.js';
import { LocalLibraryImportState } from 'src/library-import/local-transfer-state.js';
import { requestImportSourceAuthority } from 'src/library-import/manager-authority.js';
import { LibraryImportRefused } from 'src/library-import/state.js';
import { JobRepository } from 'src/repositories/job.repository.js';

@Command({
  name: 'import-library',
  arguments: '<action>',
  description: 'Internal offline import: preflight, run, status, resume, verify, rollback, abandon',
})
export class ImportLibraryCommand extends CommandRunner {
  constructor(private readonly jobs: JobRepository) {
    super();
  }

  @Option({ flags: '--config <path>', description: 'Private reviewed import configuration' })
  parseConfig(value: string): string {
    return value;
  }

  @Option({ flags: '--source <type>', description: 'Explicit source family' })
  parseSource(value: string): string {
    return value;
  }

  @Option({ flags: '--activate', description: 'Permit activation only after complete verification' })
  parseActivate(): boolean {
    return true;
  }

  async run([action]: string[], options: { config?: string; source?: string; activate?: boolean } = {}): Promise<void> {
    let target: ReturnType<typeof connectImportDatabase> | undefined;
    let state: LocalLibraryImportState | undefined;
    try {
      const args = parseLibraryImportArguments([
        action,
        '--source',
        options.source ?? '',
        '--config',
        options.config ?? '',
        ...(options.activate ? ['--activate'] : []),
      ]);
      const config = await loadLibraryImportConfig(args.configPath);
      const installation = process.env.FRAMELEAF_MANAGER_INSTALLATION ?? '';
      const manager =
        /^[a-f0-9]{12}$/u.test(installation) && process.env.FRAMELEAF_IMPORT_MANAGER_OPERATION_ID === config.operationId
          ? { installation, operationId: config.operationId }
          : undefined;
      if (args.action !== 'status' && !manager) throw new LibraryImportRefused('IMPORT_MANAGER_AUTHORITY_REQUIRED');
      const destinationUrl = process.env.DB_URL;
      if (!destinationUrl) throw new LibraryImportRefused('DESTINATION_DB_URL_REQUIRED');
      target = connectImportDatabase(destinationUrl, false);
      state = await LocalLibraryImportState.open(config.stateDirectory, {
        create: args.action === 'preflight' || args.action === 'run',
        readOnly: args.action === 'status',
      });
      const result = await executeLibraryImportCommand({
        action: args.action,
        source: args.source,
        activate: args.activate,
        config,
        db: target.db,
        jobs: this.jobs,
        state,
        manager,
        authorize: async (requested, context) => {
          if (!manager) throw new LibraryImportRefused('IMPORT_MANAGER_AUTHORITY_REQUIRED');
          await requestImportSourceAuthority(requested, {
            installation: manager.installation,
            binding: context.binding,
            destinationId: context.destinationId,
          });
        },
      });
      console.log(JSON.stringify(result));
    } catch (error) {
      console.error(
        error instanceof LibraryImportRefused || error instanceof Refusal
          ? error.message
          : 'Library import failed; keep the source stopped and inspect the retained migration state.',
      );
      process.exitCode = 1;
    } finally {
      const cleanup = await Promise.allSettled([state, target].map(async (item) => item?.close()));
      if (cleanup.some((result) => result.status === 'rejected')) {
        console.error('Library import connection cleanup failed.');
        process.exitCode = 1;
      }
    }
  }
}
