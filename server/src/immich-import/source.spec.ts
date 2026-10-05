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
  overrides: { writers?: boolean; writable?: boolean; extraMigration?: boolean; extraColumn?: boolean } = {},
) => {
  const columns = Object.entries(fixture.structure.tables).flatMap(([table, shape]) =>
    Object.entries(shape).map(([column, properties]) => ({ table_name: table, column_name: column, ...properties })),
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
      if (statement.includes('pg_stat_activity')) {
        return overrides.writers ? [{ present: 1 }] : [];
      }
      if (statement.includes('SELECT name')) {
        return [...fixture.migrations, ...(overrides.extraMigration ? ['future-migration'] : [])].map((name) => ({
          name,
        }));
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
    [{ extraMigration: true }, 'UNKNOWN_SOURCE_MIGRATIONS'],
    [{ extraColumn: true }, 'UNKNOWN_SOURCE_SCHEMA'],
  ] as const)('fails closed for %j', async (overrides, code) => {
    await expect(makeSource(overrides).source.preflight()).rejects.toThrow(code);
  });

  it('refuses writersStopped=false before database access', async () => {
    const db = { query: vi.fn(), transaction: vi.fn() } as unknown as ImportDatabase;
    await expect(new ImmichSource(db, { ...config, writersStopped: false }).preflight()).rejects.toThrow(
      'OFFLINE_SOURCE',
    );
    expect(db.query).not.toHaveBeenCalled();
  });
});
