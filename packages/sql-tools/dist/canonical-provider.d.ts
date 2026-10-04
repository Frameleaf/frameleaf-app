import type { MigrationProvider } from 'kysely/migration';
/** The only migration discovery implementation used by Frameleaf runtime and CLI. */
export declare const createMigrationProvider: (migrationFolder: string) => MigrationProvider;
