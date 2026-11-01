import { describe, expect, it } from 'vitest';
import fixture from 'src/library-import/fixtures/librephotos/1.5.1-postgres18.json' with { type: 'json' };
import {
  postgresSchemaFingerprint,
  postgresSchemaQueries,
  readPostgresSourceSchema,
} from 'src/library-import/postgres-schema.js';

describe('PostgreSQL source catalog identity', () => {
  it('collects every qualified structural category without source contents or live sequence positions', async () => {
    const expected = new Map<string, Record<string, unknown>[]>(
      Object.entries(postgresSchemaQueries).map(([name, statement]) => [
        statement,
        fixture.structure[name as keyof typeof fixture.structure],
      ]),
    );
    const seen = new Set<string>();
    const schema = await readPostgresSourceSchema((statement) => {
      const rows = expected.get(statement);
      if (!rows) throw new Error('Unexpected catalog query');
      seen.add(statement);
      return Promise.resolve(rows);
    });
    expect(seen.size).toBe(Object.keys(postgresSchemaQueries).length);
    expect(postgresSchemaFingerprint(schema)).toBe(fixture.schemaSha256);
    expect(postgresSchemaQueries.sequences).not.toContain('last_value');
    expect(schema.routines).toEqual([]);
    expect(schema.policies).toEqual([]);
  });

  it('refuses a partial catalog when any category cannot be read', async () => {
    await expect(
      readPostgresSourceSchema((statement) => {
        if (statement === postgresSchemaQueries.policies) throw new Error('Catalog access refused');
        return Promise.resolve([]);
      }),
    ).rejects.toThrow('Catalog access refused');
  });

  it('detects ordinary inheritance between already compatible tables', async () => {
    const baseline = new Map<string, Record<string, unknown>[]>(
      Object.entries(postgresSchemaQueries).map(([name, statement]) => [
        statement,
        fixture.structure[name as keyof typeof fixture.structure],
      ]),
    );
    const read = (inherited: boolean) =>
      readPostgresSourceSchema((statement) =>
        Promise.resolve(
          statement.includes('pg_inherits')
            ? inherited
              ? [
                  {
                    child_schema: 'public',
                    child: 'api_albumthing_cover_photos',
                    parent_schema: 'public',
                    parent: 'api_albumthing_photos',
                    position: '1',
                  },
                ]
              : []
            : baseline.get(statement)!,
        ),
      );
    expect(postgresSchemaFingerprint(await read(true))).not.toBe(postgresSchemaFingerprint(await read(false)));
  });
});
