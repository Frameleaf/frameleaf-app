import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { setImmediate } from 'node:timers/promises';
import { frozenSource } from 'src/immich-import/adapters.js';
import { ImmichSource } from 'src/immich-import/source.js';
import { ImportConfig, ImportDatabase, ImportRow } from 'src/immich-import/types.js';

const config: ImportConfig = {
  version: '3.2.4',
  sourceId: 'offline-source-1',
  writersStopped: true,
  mediaRoots: [{ source: '/source', target: '/target' }],
};
const fixture = frozenSource(config.version);
const makeSource = (
  overrides: {
    writers?: boolean;
    writable?: boolean;
    extraMigration?: boolean;
    missingMigration?: boolean;
    extraColumn?: boolean;
    missingColumn?: boolean;
    retypedColumn?: boolean;
    noodle?: boolean;
    /** Gallery-only tables present in the source, and those holding rows. */
    noodleTables?: string[];
    noodleRows?: string[];
  } = {},
) => {
  const columns = Object.entries(fixture.structure.tables)
    .flatMap(([table, shape]) =>
      Object.entries(shape).map(([column, properties]) => ({ table_name: table, column_name: column, ...properties })),
    )
    .filter((column) => !(overrides.missingColumn && column.table_name === 'asset' && column.column_name === 'ownerId'))
    .map((column) =>
      overrides.retypedColumn && column.table_name === 'asset' && column.column_name === 'ownerId'
        ? { ...column, type: 'text' }
        : column,
    );
  if (overrides.extraColumn) {
    columns.push({
      table_name: 'user',
      column_name: 'unexpected',
      type: 'text',
      not_null: false,
      default: null,
      identity: '',
      generated: '',
    });
  }
  const statements: string[] = [];
  const db: ImportDatabase = {
    query: async (statement): Promise<ImportRow[]> => {
      await Promise.resolve();
      statements.push(statement);
      if (statement.includes('current_setting')) {
        return [{ rolsuper: false, rolbypassrls: false, readonly: 'on' }];
      }
      if (statement.includes('has_table_privilege')) {
        return overrides.writable ? [{ present: 1 }] : [];
      }
      if (statement.includes('gallery_migrations')) {
        return [{ present: false, noodle: !!overrides.noodle }];
      }
      if (statement.includes('jsonb_array_elements_text')) {
        return [{ tables: overrides.noodleTables ?? [] }];
      }
      if (statement.includes('asset_favorite f')) {
        return [{ rows: overrides.noodleRows?.includes('asset_favorite') ?? false }];
      }
      const held = /^SELECT EXISTS \(SELECT 1 FROM public\."(\w+)"\)/u.exec(statement);
      if (held) {
        return [{ rows: overrides.noodleRows?.includes(held[1]) ?? false }];
      }
      if (statement.includes('pg_stat_activity')) {
        return overrides.writers ? [{ present: 1 }] : [];
      }
      if (statement.includes('SELECT name')) {
        return [
          ...fixture.migrations.slice(overrides.missingMigration ? 1 : 0),
          ...(overrides.extraMigration ? ['future-migration'] : []),
        ].map((name) => ({ name }));
      }
      if (statement.includes('format_type')) {
        return columns;
      }
      if (statement.includes('pg_constraint p')) return fixture.structure.constraints;
      if (statement.includes('pg_index p')) return fixture.structure.uniqueIndexes;
      if (statement.includes('pg_enum e')) return fixture.structure.enums;
      if (statement.includes('pg_control_system')) {
        return [{ database: 'immich', database_oid: '42', system_identifier: 'source-instance' }];
      }
      return [];
    },
    transaction: async (body) => body(db),
  };
  const source = new ImmichSource(db, config);
  return { source, statements };
};

describe('source preflight', () => {
  it('pins in-place media bytes even when upstream identifies an external asset by its path', async () => {
    const directory = await mkdtemp(join(tmpdir(), 'frameleaf-manager-import-'));
    try {
      const path = join(directory, 'photo.jpg');
      await writeFile(path, 'first');
      const { source: fixtureSource } = makeSource();
      const source = new ImmichSource(fixtureSource.db, {
        ...config,
        mediaRoots: [{ source: directory, target: directory }],
        media: {
          mode: 'manager-in-place',
          authority: 'frameleaf-manager',
          operationId: 'operation-1',
          deploymentId: 'deployment-1',
        },
      });
      vi.spyOn(source, 'batches').mockImplementation(async function* (table) {
        await setImmediate(); // Preserve the asynchronous source cursor boundary.
        if (table === 'asset') yield [{ row: { originalPath: path, checksumAlgorithm: 'sha1-path' }, cursor: ['1'] }];
      });
      const before = await source.preflight();
      expect(await source.preflight()).toBe(before);
      await writeFile(path, 'other');
      expect(await source.preflight()).not.toBe(before);
    } finally {
      await rm(directory, { recursive: true, force: true });
    }
  });

  it('uses only explicit SELECTs and binds schema and instance identity to the fingerprint', async () => {
    const { source, statements } = makeSource();
    const first = await source.preflight();
    expect(first).toMatch(/^[a-f\d]{64}$/u);
    expect(await source.preflight()).toBe(first);
    expect(statements.every((statement) => statement.startsWith('SELECT'))).toBe(true);
    expect(statements.some((statement) => /SELECT\s+\*/u.test(statement))).toBe(false);
  });

  it.each([
    [{ writers: true }, 'SOURCE_WRITERS'],
    [{ writable: true }, 'SOURCE_WRITERS'],
    [{ missingMigration: true }, 'UNKNOWN_SOURCE_MIGRATIONS'],
    [{ missingMigration: true, extraMigration: true }, 'UNKNOWN_SOURCE_MIGRATIONS'],
    [{ extraColumn: true }, 'UNKNOWN_SOURCE_SCHEMA'],
    [{ extraMigration: true, missingColumn: true }, 'UNKNOWN_SOURCE_SCHEMA'],
    [{ extraMigration: true, retypedColumn: true }, 'UNKNOWN_SOURCE_SCHEMA'],
  ] as const)('fails closed for %j', async (overrides, code) => {
    await expect(makeSource(overrides).source.preflight()).rejects.toThrow(code);
  });

  it('admits a newer release whose ledger and read columns still contain the newest frozen shape', async () => {
    await expect(makeSource({ extraMigration: true, extraColumn: true }).source.preflight()).resolves.toMatch(
      /^[a-f\d]{64}$/u,
    );
    const { source } = makeSource({ extraMigration: true });
    await expect(new ImmichSource(source.db, { ...config, version: '3.3.3' }).preflight()).resolves.toBeTruthy();
  });

  it('refuses a version that understates the frozen shape its ledger contains', async () => {
    const { source } = makeSource({ extraMigration: true });
    await expect(new ImmichSource(source.db, { ...config, version: '3.0.0' }).preflight()).rejects.toThrow(
      'UNKNOWN_SOURCE_MIGRATIONS',
    );
  });

  it('reads Noodle Gallery through the Immich base in its ledger, not its own release number', async () => {
    // An exact Immich ledger plus Noodle's own tables and columns: the exact catalog check would refuse it.
    const { source } = makeSource({ noodle: true, extraColumn: true });
    const noodle = new ImmichSource(source.db, { ...config, version: '5.9.0' });
    await expect(noodle.preflight()).resolves.toMatch(/^[a-f\d]{64}$/u);
    expect(noodle.fixture).toMatchObject({ commit: fixture.commit, exact: false });
    await expect(makeSource({ noodle: true, missingColumn: true }).source.preflight()).rejects.toThrow(
      'UNKNOWN_SOURCE_SCHEMA',
    );
  });

  it('names the Gallery-only data that holds rows and stays behind', async () => {
    const { source } = makeSource({
      noodle: true,
      noodleTables: ['shared_space', 'person_pet', 'user_group', 'asset_favorite'],
      noodleRows: ['shared_space', 'person_pet', 'asset_favorite'],
    });
    await source.preflight();
    expect(source.notImported).toEqual(['Spaces', 'pets', 'favourites set by other people']);
    const immich = makeSource({ noodleTables: ['shared_space'], noodleRows: ['shared_space'] }).source;
    await immich.preflight();
    expect(immich.notImported).toEqual([]);
  });

  it('reads a Gallery release without gallery_migrations as Gallery when Manager names it', async () => {
    // Gallery 5.8 and earlier keep their migrations beside upstream's in kysely_migrations.
    const { source } = makeSource({ extraMigration: true, extraColumn: true });
    const gallery = new ImmichSource(source.db, { ...config, version: '5.8.0', product: 'Noodle Gallery' });
    await expect(gallery.preflight()).resolves.toMatch(/^[a-f\d]{64}$/u);
    expect(gallery.fixture).toMatchObject({ commit: fixture.commit, exact: false });
  });

  it('refuses writersStopped=false before database access', async () => {
    const db = { query: vi.fn(), transaction: vi.fn() } as unknown as ImportDatabase;
    await expect(new ImmichSource(db, { ...config, writersStopped: false }).preflight()).rejects.toThrow(
      'OFFLINE_SOURCE',
    );
    expect(db.query).not.toHaveBeenCalled();
  });
});
