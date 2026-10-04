import { frozenSource } from './adapters.js';
import { ImmichSource } from './source.js';
import { ImportConfig, ImportDatabase, ImportRow } from './types.js';

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
  const columns = Object.entries(fixture.tables)
    .flatMap(([table, shape]) =>
      [...shape.columns]
        .sort()
        .map((column) => ({ table_name: table, column_name: column, type: shape.types[column], not_null: false })),
    )
    .sort((a, b) => a.table_name.localeCompare(b.table_name) || a.column_name.localeCompare(b.column_name));
  if (overrides.extraColumn) {
    columns.push({ table_name: 'user', column_name: 'unexpected', type: 'text', not_null: false });
  }
  const statements: string[] = [];
  const db: ImportDatabase = {
    query: async (statement): Promise<ImportRow[]> => {
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
    await expect(makeSource(overrides).source.preflight()).rejects.toThrow(String(code));
  });

  it('refuses writersStopped=false before database access', async () => {
    const db = { query: vi.fn(), transaction: vi.fn() } as unknown as ImportDatabase;
    await expect(new ImmichSource(db, { ...config, writersStopped: false }).preflight()).rejects.toThrow(
      'OFFLINE_SOURCE',
    );
    expect(db.query).not.toHaveBeenCalled();
  });
});
