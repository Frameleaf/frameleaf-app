import type { Kysely } from 'kysely';
import type {
  FileMigrationProviderProps,
  MigrationProvider,
} from 'kysely/migration';
/** The only migration discovery implementation used by Frameleaf runtime and CLI. */
export declare const createMigrationProvider: (
  migrationFolder: string,
  options?: Pick<FileMigrationProviderProps, 'import'>,
) => MigrationProvider;

/** Adopt explicitly renamed bodies before starting strict runtime or CLI migration. */
export declare function adoptMigrationRenames(
  db: Kysely<any>,
  migrationFolder: string,
  options?: Pick<FileMigrationProviderProps, 'import'>,
): Promise<void>;
