import type { FileMigrationProviderProps, MigrationProvider } from 'kysely/migration';
/** The only migration discovery implementation used by Frameleaf runtime and CLI. */
export declare const createMigrationProvider: (
  migrationFolder: string,
  options?: Pick<FileMigrationProviderProps, 'import'>,
) => MigrationProvider;
