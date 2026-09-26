import { FileMigrationProvider, type Migration, type MigrationProvider } from 'kysely/migration';
import { readdir } from 'node:fs/promises';
import { join } from 'node:path';
import {
  GENERIC_LEGACY_FORK_MIGRATIONS,
  POST_CERTIFIED_UPSTREAM_MIGRATIONS,
  SUPPORTED_UPSTREAM_MIGRATIONS,
  classifyMigration,
} from 'src/fork-schema/migration-manifest.js';
import { LEGACY_WORKFLOW_MIGRATION, OFFICIAL_WORKFLOW_MIGRATION } from 'src/fork-schema/workflow-compatibility.js';

const fileProvider = (migrationFolder: string) =>
  new FileMigrationProvider({
    fs: { readdir },
    path: { join },
    migrationFolder,
  });

function createClassifiedMigrationProvider(
  migrationFolder: string,
  includeLegacyFork: boolean,
  excluded: ReadonlySet<string> = new Set(),
): MigrationProvider {
  const provider = fileProvider(migrationFolder);

  return {
    async getMigrations(): Promise<Record<string, Migration>> {
      const migrations = await provider.getMigrations();
      const officialMigrations: Record<string, Migration> = {};

      for (const [name, migration] of Object.entries(migrations)) {
        const owner = classifyMigration(name);
        if (owner === 'unknown') {
          throw new Error(`Unknown migration in official migration folder: ${name}`);
        }
        // Post-certified upstream migrations are excluded from the certified
        // official provider: a post-cutover (isolated) database must stay
        // byte-exact with the certified official tag, and the cutover itself
        // reverts them. They run on fresh/legacy installs through the combined
        // legacy provider and are re-applied by the fork return reconciliation.
        if (owner === 'upstream' && !includeLegacyFork && POST_CERTIFIED_UPSTREAM_MIGRATIONS.has(name)) {
          continue;
        }
        if (excluded.has(name)) {
          continue;
        }
        if (owner === 'upstream' || (includeLegacyFork && owner === 'legacy-fork')) {
          officialMigrations[name] = migration;
        }
      }

      return officialMigrations;
    },
  };
}

export function createOfficialMigrationProvider(migrationFolder: string): MigrationProvider {
  return createClassifiedMigrationProvider(migrationFolder, false);
}

export function createCertifiedLedgerMigrationProvider(
  provider: MigrationProvider,
  appliedNames: readonly string[],
): MigrationProvider {
  const certifiedNames = new Set(SUPPORTED_UPSTREAM_MIGRATIONS);
  const appliedCertifiedNames = appliedNames.filter((name) => certifiedNames.has(name));

  return {
    async getMigrations(): Promise<Record<string, Migration>> {
      const migrations = await provider.getMigrations();
      for (const name of appliedCertifiedNames) {
        if (migrations[name]) {
          continue;
        }
        const failClosed = () => Promise.reject(new Error(`Certified migration sentinel ${name} must never execute`));
        migrations[name] = { down: failClosed, up: failClosed };
      }
      return Object.fromEntries(Object.entries(migrations).toSorted(([left], [right]) => left.localeCompare(right)));
    },
  };
}

/**
 * The combined provider for fresh and legacy databases. `appliedNames` is the official ledger: a
 * library adopted from the official server (FL-44) already ran the official workflow rewrite
 * `1778614946174`, so the Frameleaf copy of it (`1779400000000`) is left out there. Running it would
 * rewrite the workflow tables a second time, and the two markers must never both be ledgered.
 */
export function createLegacyMigrationProvider(
  migrationFolder: string,
  appliedNames: readonly string[] = [],
): MigrationProvider {
  const excluded = appliedNames.includes(OFFICIAL_WORKFLOW_MIGRATION)
    ? new Set([LEGACY_WORKFLOW_MIGRATION])
    : new Set<string>();
  return createClassifiedMigrationProvider(migrationFolder, true, excluded);
}

/**
 * FL-180: only the Frameleaf public-schema migrations (`GENERIC_LEGACY_FORK_MIGRATIONS`), in name
 * order. It never yields an upstream migration (certified or post-certified) nor the Frameleaf copy
 * of the workflow rewrite, whose official original a library past the cutover already records. A
 * library past the cutover takes its newer Frameleaf public migrations from here and records them in
 * `immich_fork.migration_audit`, never in `public.kysely_migrations` (see
 * `isolated-frameleaf-migrations.ts`). An unknown file refuses, like every other provider.
 */
export function createFrameleafPublicMigrationProvider(migrationFolder: string): MigrationProvider {
  const provider = fileProvider(migrationFolder);

  return {
    async getMigrations(): Promise<Record<string, Migration>> {
      const migrations = await provider.getMigrations();
      const frameleafMigrations: Record<string, Migration> = {};
      for (const [name, migration] of Object.entries(migrations).toSorted(([left], [right]) =>
        left.localeCompare(right),
      )) {
        if (classifyMigration(name) === 'unknown') {
          throw new Error(`Unknown migration in official migration folder: ${name}`);
        }
        if (GENERIC_LEGACY_FORK_MIGRATIONS.has(name)) {
          frameleafMigrations[name] = migration;
        }
      }
      return frameleafMigrations;
    },
  };
}

export function createForkMigrationProvider(migrationFolder: string): MigrationProvider {
  const provider = fileProvider(migrationFolder);
  return { getMigrations: () => provider.getMigrations() };
}
