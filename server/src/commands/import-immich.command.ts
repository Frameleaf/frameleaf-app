import { Command, CommandRunner, Option } from 'nest-commander';
import { readFile } from 'node:fs/promises';
import { connectImportDatabase } from 'src/immich-import/database.js';
import { ImmichImportService } from 'src/immich-import/importer.js';
import { assertMediaPolicy } from 'src/immich-import/media.js';
import { getImmichImportState } from 'src/immich-import/state.js';
import { ImportConfig, ImportRefused } from 'src/immich-import/types.js';
import { JobRepository } from 'src/repositories/job.repository.js';

@Command({
  name: 'import-immich',
  arguments: '<action>',
  description: 'One-time offline import: preflight, run, status, resume, verify, abandon',
})
export class ImportImmichCommand extends CommandRunner {
  constructor(private readonly jobs: JobRepository) {
    super();
  }

  @Option({
    flags: '--config <path>',
    description: 'Import configuration JSON; URLs must be supplied through environment variables',
  })
  parseConfig(path: string): string {
    return path;
  }

  async run([action]: string[], options: { config?: string } = {}): Promise<void> {
    let source: ReturnType<typeof connectImportDatabase> | undefined;
    let target: ReturnType<typeof connectImportDatabase> | undefined;
    try {
      if (!['preflight', 'run', 'status', 'resume', 'verify', 'abandon'].includes(action)) {
        throw new ImportRefused('UNKNOWN_ACTION');
      }
      const destinationUrl = process.env.DB_URL;
      if (!destinationUrl) {
        throw new ImportRefused('DESTINATION_DB_URL_REQUIRED');
      }
      target = connectImportDatabase(destinationUrl, false);
      if (action === 'status') {
        console.log(JSON.stringify(await getImmichImportState(target.db)));
        return;
      }
      const sourceUrl = process.env.FRAMELEAF_IMPORT_SOURCE_URL;
      if (!sourceUrl || !options.config) {
        throw new ImportRefused('SOURCE_URL_AND_CONFIG_REQUIRED');
      }
      const config = JSON.parse(await readFile(options.config, 'utf8')) as ImportConfig;
      validateImportConfig(config);
      if (
        config.media?.mode === 'manager-in-place' &&
        process.env.FRAMELEAF_IMPORT_MANAGER_OPERATION_ID !== config.media.operationId
      ) {
        throw new ImportRefused('MANAGER_OPERATION_AUTHORITY_REQUIRED');
      }
      source = connectImportDatabase(sourceUrl, true);
      const importer = new ImmichImportService(target.db, source.db, config);
      switch (action) {
        case 'preflight': {
          const { sourceVersion, sourceCommit, status, embeddings } = await importer.preflight();
          console.log(JSON.stringify({ sourceVersion, sourceCommit, status, embeddings }));
          return;
        }
        case 'run': {
          await importer.run();
          break;
        }
        case 'resume': {
          await importer.run(true);
          break;
        }
        case 'verify': {
          await importer.verify((config) => this.jobs.dispatchImportedWork(config));
          break;
        }
        case 'abandon': {
          await importer.abandon();
          break;
        }
      }
      console.log(JSON.stringify(await importer.status()));
    } catch (error) {
      // Driver errors can include SQL row values and URLs: never print the original error.
      console.error(
        error instanceof ImportRefused
          ? error.message
          : 'Immich import failed; destination remains inactive. Check configuration and database access.',
      );
      process.exitCode = 1;
    } finally {
      try {
        await source?.close();
        await target?.close();
      } catch {
        console.error('Immich import connection cleanup failed.');
        process.exitCode = 1;
      }
    }
  }
}

export const validateImportConfig = (config: ImportConfig): void => {
  if (
    !config ||
    typeof config.version !== 'string' ||
    typeof config.sourceId !== 'string' ||
    config.sourceId.length < 8 ||
    typeof config.writersStopped !== 'boolean' ||
    !config.writersStopped ||
    !Array.isArray(config.mediaRoots) ||
    config.mediaRoots.length === 0 ||
    config.mediaRoots.some((root) => !root || typeof root.source !== 'string' || typeof root.target !== 'string')
  ) {
    throw new ImportRefused('INVALID_IMPORT_CONFIGURATION');
  }
  assertMediaPolicy(config.mediaRoots, config.media);
  if (
    config.embeddings &&
    Object.values(config.embeddings).some((model) => typeof model !== 'string' || model.length === 0)
  ) {
    throw new ImportRefused('INVALID_EMBEDDING_CONFIGURATION');
  }
};
