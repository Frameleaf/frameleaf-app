import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve } from 'node:path';
import type { Migration, MigrationProvider } from 'kysely/migration';
import {
  CERTIFIED_TAG_MIGRATIONS,
  GENERIC_LEGACY_FORK_MIGRATIONS,
  POST_CERTIFIED_UPSTREAM_MIGRATIONS,
} from 'src/fork-schema/migration-manifest.js';
import {
  createCertifiedLedgerMigrationProvider,
  createFrameleafPublicMigrationProvider,
  createLegacyMigrationProvider,
  createOfficialMigrationProvider,
} from 'src/fork-schema/migration-provider.js';
import {
  ADD_PLUGIN_METHOD_ALLOWED_HOSTS_MIGRATION,
  ADD_PLUGIN_TEMPLATES_MIGRATION,
  LEGACY_WORKFLOW_MIGRATION,
  OFFICIAL_WORKFLOW_MIGRATION,
} from 'src/fork-schema/workflow-compatibility.js';

const migration = (): Migration => ({
  down: vi.fn(),
  up: vi.fn(),
});

const provider = (migrations: Record<string, Migration>): MigrationProvider => ({
  getMigrations: () => Promise.resolve(migrations),
});

describe(createCertifiedLedgerMigrationProvider, () => {
  it('exposes only audited protected names that are already recorded in the official ledger', async () => {
    const base = migration();
    const wrapped = createCertifiedLedgerMigrationProvider(provider({ '1000-Base': base }), [
      OFFICIAL_WORKFLOW_MIGRATION,
      ADD_PLUGIN_TEMPLATES_MIGRATION,
    ]);

    const migrations = await wrapped.getMigrations();

    expect(Object.keys(migrations).toSorted()).toEqual(
      ['1000-Base', OFFICIAL_WORKFLOW_MIGRATION, ADD_PLUGIN_TEMPLATES_MIGRATION].toSorted(),
    );
    expect(migrations[ADD_PLUGIN_METHOD_ALLOWED_HOSTS_MIGRATION]).toBeUndefined();
    expect(migrations['1000-Base']).toBe(base);
  });

  it.each(['up', 'down'] as const)('fails closed if Kysely tries to execute sentinel %s', async (direction) => {
    const wrapped = createCertifiedLedgerMigrationProvider(provider({}), [OFFICIAL_WORKFLOW_MIGRATION]);
    const migrations = await wrapped.getMigrations();
    const sentinel = migrations[OFFICIAL_WORKFLOW_MIGRATION]!;

    await expect(sentinel[direction]!({} as never)).rejects.toThrow(
      `Certified migration sentinel ${OFFICIAL_WORKFLOW_MIGRATION} must never execute`,
    );
  });

  it('does not expose a sentinel for a missing or unknown ledger name', async () => {
    const wrapped = createCertifiedLedgerMigrationProvider(provider({}), [
      ADD_PLUGIN_METHOD_ALLOWED_HOSTS_MIGRATION,
      '9999999999999-Unknown',
    ]);

    expect(Object.keys(await wrapped.getMigrations())).toEqual([ADD_PLUGIN_METHOD_ALLOWED_HOSTS_MIGRATION]);
  });

  it('preserves a bundled implementation instead of replacing it with a sentinel', async () => {
    const bundled = migration();
    const wrapped = createCertifiedLedgerMigrationProvider(provider({ [OFFICIAL_WORKFLOW_MIGRATION]: bundled }), [
      OFFICIAL_WORKFLOW_MIGRATION,
    ]);

    const migrations = await wrapped.getMigrations();
    expect(migrations[OFFICIAL_WORKFLOW_MIGRATION]).toBe(bundled);
  });

  it('returns sentinels in migration-name order when legacy migrations are interleaved', async () => {
    const wrapped = createCertifiedLedgerMigrationProvider(
      provider({
        '1778000000000-LegacyBefore': migration(),
        '1779000000000-LegacyAfter': migration(),
      }),
      [OFFICIAL_WORKFLOW_MIGRATION],
    );

    expect(Object.keys(await wrapped.getMigrations())).toEqual([
      '1778000000000-LegacyBefore',
      OFFICIAL_WORKFLOW_MIGRATION,
      '1779000000000-LegacyAfter',
    ]);
  });
});

describe(createLegacyMigrationProvider, () => {
  const folder = resolve('src/schema/migrations');

  it('bundles the Frameleaf workflow rewrite for fresh and legacy databases', async () => {
    const names = Object.keys(await createLegacyMigrationProvider(folder).getMigrations());

    expect(names).toContain(LEGACY_WORKFLOW_MIGRATION);
    expect(names).toContain('2100000000570-AddWorkflowDefinitions');
  });

  it('leaves the Frameleaf workflow rewrite out once the official original is ledgered (FL-44)', async () => {
    const names = Object.keys(
      await createLegacyMigrationProvider(folder, [OFFICIAL_WORKFLOW_MIGRATION]).getMigrations(),
    );

    expect(names).not.toContain(LEGACY_WORKFLOW_MIGRATION);
    expect(names).toContain('1778000000000-PhysicalDeduplication');
    expect(names).toContain('2100000000570-AddWorkflowDefinitions');
    expect(names).toContain('1787148183729-ClusterGroups');
  });
});

describe(createFrameleafPublicMigrationProvider, () => {
  const folder = resolve('src/schema/migrations');

  it('yields exactly the Frameleaf public migrations, in name order (FL-180)', async () => {
    const names = Object.keys(await createFrameleafPublicMigrationProvider(folder).getMigrations());

    expect(names).toEqual([...GENERIC_LEGACY_FORK_MIGRATIONS].toSorted());
    expect(names).toContain('2100000000610-AddClassificationRule');
    expect(names).toContain('2100000000620-FrameleafCloudMlDestination');
  });

  it('never yields an upstream migration or the Frameleaf copy of the workflow rewrite (FL-180)', async () => {
    const names = new Set(Object.keys(await createFrameleafPublicMigrationProvider(folder).getMigrations()));

    expect(names.has(LEGACY_WORKFLOW_MIGRATION)).toBe(false);
    expect(names.has(OFFICIAL_WORKFLOW_MIGRATION)).toBe(false);
    expect(CERTIFIED_TAG_MIGRATIONS.filter((name) => names.has(name))).toEqual([]);
    expect([...POST_CERTIFIED_UPSTREAM_MIGRATIONS].filter((name) => names.has(name))).toEqual([]);
  });

  it('shares no migration with the certified official provider (FL-180)', async () => {
    const official = Object.keys(await createOfficialMigrationProvider(folder).getMigrations());
    const frameleaf = new Set(Object.keys(await createFrameleafPublicMigrationProvider(folder).getMigrations()));

    expect(official.filter((name) => frameleaf.has(name))).toEqual([]);
  });

  it('refuses an unknown migration file (FL-180)', async () => {
    const unknownFolder = await mkdtemp(join(tmpdir(), 'frameleaf-public-provider-'));
    try {
      await writeFile(join(unknownFolder, '9999999999999-Unknown.mjs'), 'export async function up() {}\n');

      await expect(createFrameleafPublicMigrationProvider(unknownFolder).getMigrations()).rejects.toThrow(
        `Unknown migration in the Frameleaf public migration folder (${unknownFolder}): 9999999999999-Unknown`,
      );
    } finally {
      await rm(unknownFolder, { recursive: true, force: true });
    }
  });
});
