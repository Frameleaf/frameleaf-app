import { beforeEach, describe, expect, it, vi } from 'vitest';
import content from 'src/library-import/fixtures/librephotos/1.5.1-postgres-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/librephotos/1.5.1-postgres18.json' with { type: 'json' };
import { openLibrephotosPostgresSnapshot } from 'src/library-import/librephotos-postgres-source.js';
import { postgresSchemaQueries } from 'src/library-import/postgres-schema.js';

const transport = vi.hoisted(() => ({ reserve: vi.fn(), unsafe: vi.fn(), release: vi.fn(), end: vi.fn() }));
vi.mock('postgres', () => ({ default: vi.fn(() => ({ reserve: transport.reserve, end: transport.end })) }));
const guard = {
  readonly: 'on',
  rolsuper: false,
  rolbypassrls: false,
  elevated: false,
  writable: false,
  other_clients: false,
};
const url = 'postgres://fixture:private-password@localhost/fixture';

describe('LibrePhotos PostgreSQL snapshot stream', () => {
  beforeEach(() => {
    vi.resetAllMocks();
    transport.reserve.mockResolvedValue({ unsafe: transport.unsafe, release: transport.release });
    transport.end.mockResolvedValue(undefined);
    transport.unsafe.mockImplementation((statement: string) => {
      if (statement.includes('rolsuper')) return Promise.resolve([guard]);
      if (statement.includes("current_setting('server_version')")) return Promise.resolve([{ version: '18.6' }]);
      if (statement.includes('FROM public.django_migrations'))
        return Promise.resolve(fixture.migrations.map((row) => ({ ...row, finished: true })));
      const entry = Object.entries(postgresSchemaQueries).find(([, sql]) => sql === statement);
      if (entry) return Promise.resolve(fixture.structure[entry[0] as keyof typeof fixture.structure]);
      if (statement.includes('FROM ONLY public.')) return Promise.resolve([]);
      return Promise.resolve([]);
    });
  });

  it('pins an exclusive read-only repeatable-read transaction and closes it explicitly', async () => {
    const source = await openLibrephotosPostgresSnapshot(url, '1.5.1', true);
    expect(transport.reserve).toHaveBeenCalledOnce();
    expect(transport.unsafe).toHaveBeenCalledWith('BEGIN ISOLATION LEVEL REPEATABLE READ READ ONLY');
    expect(source.schemaSha256).toBe(fixture.schemaSha256);
    await source.close();
    expect(transport.unsafe).not.toHaveBeenCalledWith('ROLLBACK');
    expect(transport.release).toHaveBeenCalledOnce();
    expect(transport.end).toHaveBeenCalledOnce();
    await source.close();
    expect(transport.release).toHaveBeenCalledOnce();
  });

  it('does not connect without a qualified version and explicit stopped-writer evidence', async () => {
    await expect(openLibrephotosPostgresSnapshot(url, 'unknown', true)).rejects.toThrow(
      'LIBREPHOTOS_VERSION_UNQUALIFIED',
    );
    await expect(openLibrephotosPostgresSnapshot(url, '1.5.1', false)).rejects.toThrow(
      'LIBREPHOTOS_WRITERS_NOT_FENCED',
    );
    expect(transport.reserve).not.toHaveBeenCalled();
  });

  it('checks table write privileges reachable through non-inherited SET ROLE membership', async () => {
    const source = await openLibrephotosPostgresSnapshot(url, '1.5.1', true);
    const guardQuery = transport.unsafe.mock.calls.find(([sql]) => sql.includes('rolsuper'))![0];
    expect(guardQuery).toContain("pg_catalog.pg_has_role(current_user,writer.oid,'SET')");
    expect(guardQuery).toContain("pg_catalog.has_any_column_privilege(current_user,c.oid,'INSERT,UPDATE')");
    expect(guardQuery).toContain("pg_catalog.has_any_column_privilege(writer.oid,c.oid,'INSERT,UPDATE')");
    expect(guardQuery).toContain(
      "pg_catalog.has_table_privilege(writer.oid,c.oid,'INSERT,UPDATE,DELETE,TRUNCATE,TRIGGER')",
    );
    await source.close();
  });

  it.each(['rolsuper', 'rolbypassrls', 'elevated', 'writable', 'other_clients'])(
    'refuses %s authority or another client before reading content',
    async (field) => {
      const original = transport.unsafe.getMockImplementation()!;
      transport.unsafe.mockImplementation((statement: string) =>
        statement.includes('rolsuper') ? Promise.resolve([{ ...guard, [field]: true }]) : original(statement),
      );
      await expect(openLibrephotosPostgresSnapshot(url, '1.5.1', true)).rejects.toThrow(
        'LIBREPHOTOS_SOURCE_NOT_READ_ONLY',
      );
      expect(transport.unsafe.mock.calls.some(([sql]) => sql.includes('FROM ONLY public.'))).toBe(false);
      expect(transport.release).toHaveBeenCalledOnce();
      expect(transport.end).toHaveBeenCalledOnce();
    },
  );

  it.each(['missing', 'duplicate', 'unfinished', 'extra'])(
    'refuses %s migration evidence even with a matching schema',
    async (kind) => {
      const original = transport.unsafe.getMockImplementation()!;
      transport.unsafe.mockImplementation((statement: string) => {
        if (!statement.includes('FROM public.django_migrations')) return original(statement);
        const rows = fixture.migrations.map((row) => ({ ...row, finished: true }));
        switch (kind) {
          case 'missing': {
            rows.pop();
            break;
          }
          case 'duplicate': {
            rows.push(rows[0]);
            break;
          }
          case 'unfinished': {
            rows[0].finished = false;
            break;
          }
          case 'extra': {
            rows.push({ app: 'api', name: 'unqualified', finished: true });
            break;
          }
          // No default
        }
        return Promise.resolve(rows);
      });
      await expect(openLibrephotosPostgresSnapshot(url, '1.5.1', true)).rejects.toThrow(
        'LIBREPHOTOS_MIGRATIONS_INCOMPLETE',
      );
      expect(transport.end).toHaveBeenCalledOnce();
    },
  );

  it('closes and refuses an unqualified database engine before schema or content reads', async () => {
    const original = transport.unsafe.getMockImplementation()!;
    transport.unsafe.mockImplementation((statement: string) =>
      statement.includes("current_setting('server_version')")
        ? Promise.resolve([{ version: '18.5' }])
        : original(statement),
    );
    await expect(openLibrephotosPostgresSnapshot(url, '1.5.1', true)).rejects.toThrow(
      'LIBREPHOTOS_POSTGRES_ENGINE_UNQUALIFIED',
    );
    expect(transport.end).toHaveBeenCalledOnce();
    expect(transport.unsafe.mock.calls.some(([sql]) => sql === postgresSchemaQueries.columns)).toBe(false);
  });

  it('closes and refuses catalog drift before migration or content reads', async () => {
    const original = transport.unsafe.getMockImplementation()!;
    transport.unsafe.mockImplementation((statement: string) =>
      statement === postgresSchemaQueries.columns
        ? Promise.resolve(fixture.structure.columns.slice(1))
        : original(statement),
    );
    await expect(openLibrephotosPostgresSnapshot(url, '1.5.1', true)).rejects.toThrow(
      'LIBREPHOTOS_POSTGRES_SCHEMA_UNQUALIFIED',
    );
    expect(transport.end).toHaveBeenCalledOnce();
    expect(transport.unsafe.mock.calls.some(([sql]) => sql.includes('FROM public.django_migrations'))).toBe(false);
  });

  it('streams actual source values while keeping native indexed keys for pagination', async () => {
    const source = await openLibrephotosPostgresSnapshot(url, '1.5.1', true);
    const page = content.rows.api_photo.map((row) => ({ ...row, __frameleaf_cursor: row.id }));
    transport.unsafe.mockResolvedValueOnce(page).mockResolvedValueOnce([]);
    const rows = [];
    for await (const batch of source.rows('api_photo')) rows.push(...batch);
    expect(rows).toHaveLength(5);
    expect(rows.every((row) => typeof row.owner_id === 'bigint')).toBe(true);
    const query = transport.unsafe.mock.calls.find(([sql]) => sql.includes('FROM ONLY public."api_photo"'))![0];
    expect(query).toContain('ORDER BY "id" LIMIT 1000');
    expect(query).not.toContain('ORDER BY "id"::text');
    const next = transport.unsafe.mock.calls.at(-1)!;
    expect(next[0]).toContain('WHERE "id">$1');
    expect(next[1]).toEqual([page.at(-1)!.id]);
    expect(rows[0]).not.toHaveProperty('__frameleaf_cursor');
    await source.close();
  });

  it('projects only credential-free user columns and rejects unapproved tables without SQL', async () => {
    const source = await openLibrephotosPostgresSnapshot(url, '1.5.1', true);
    for await (const _batch of source.rows('api_user')) {
      /* empty source */
    }
    const query = transport.unsafe.mock.calls.at(-1)![0];
    expect(query).toContain('"username"::text');
    expect(query).not.toContain('"password"');
    expect(query).not.toContain('nextcloud_app_password');
    const count = transport.unsafe.mock.calls.length;
    await expect(source.rows('django_session' as never).next()).rejects.toThrow('LIBREPHOTOS_TABLE_NOT_ALLOWED');
    expect(transport.unsafe).toHaveBeenCalledTimes(count);
    await source.close();
  });

  it('continues through a full page using the native primary key and keeps batches bounded', async () => {
    const source = await openLibrephotosPostgresSnapshot(url, '1.5.1', true);
    const rows = Array.from({ length: 1001 }, (_, index) => ({
      ...content.rows.api_filecopy[0],
      id: String(index + 1),
      __frameleaf_cursor: String(index + 1),
    }));
    transport.unsafe
      .mockResolvedValueOnce(rows.slice(0, 1000))
      .mockResolvedValueOnce(rows.slice(1000))
      .mockResolvedValueOnce([]);
    const sizes = [];
    for await (const batch of source.rows('api_filecopy')) sizes.push(batch.length);
    expect(sizes).toEqual([1000, 1]);
    expect(transport.unsafe.mock.calls.at(-2)![1]).toEqual(['1000']);
    expect(transport.unsafe.mock.calls.at(-1)![1]).toEqual(['1001']);
    await source.close();
  });

  it('refuses malformed or non-advancing transport cursors instead of repeating pages', async () => {
    const source = await openLibrephotosPostgresSnapshot(url, '1.5.1', true);
    const page = content.rows.api_filecopy.map((row) => ({ ...row, __frameleaf_cursor: row.id }));
    transport.unsafe.mockResolvedValue(page);
    const stream = source.rows('api_filecopy');
    await expect(stream.next()).resolves.toMatchObject({ done: false });
    await expect(stream.next()).rejects.toThrow('LIBREPHOTOS_POSTGRES_READ_FAILED');
    await source.close();
  });

  it('redacts connection and query failures, closes resources, and never reconnects a failed reservation', async () => {
    const source = await openLibrephotosPostgresSnapshot(url, '1.5.1', true);
    transport.unsafe.mockRejectedValueOnce(new Error(`connection lost ${url} private row content`));
    await expect(source.rows('api_photo').next()).rejects.toThrow('LIBREPHOTOS_POSTGRES_READ_FAILED');
    expect(transport.reserve).toHaveBeenCalledOnce();
    await source.close();
    await expect(source.rows('api_photo').next()).rejects.toThrow('LIBREPHOTOS_POSTGRES_SNAPSHOT_CLOSED');
    transport.reserve.mockRejectedValue(new Error(url));
    await expect(openLibrephotosPostgresSnapshot(url, '1.5.1', true)).rejects.toThrow(
      'LIBREPHOTOS_POSTGRES_SNAPSHOT_UNAVAILABLE',
    );
  });

  it('ends the private pool even when releasing the reservation fails, without leaking driver errors', async () => {
    const source = await openLibrephotosPostgresSnapshot(url, '1.5.1', true);
    transport.release.mockImplementation(() => {
      throw new Error(url);
    });
    await expect(source.close()).rejects.toThrow('LIBREPHOTOS_POSTGRES_CLOSE_FAILED');
    expect(transport.end).toHaveBeenCalledOnce();
  });

  it('starts bounded pool termination without waiting for SQL on an unresponsive connection', async () => {
    const source = await openLibrephotosPostgresSnapshot(url, '1.5.1', true);
    transport.unsafe.mockImplementation(() => new Promise(() => {}));
    const closing = source.close();
    await Promise.resolve();
    expect(transport.end).toHaveBeenCalledWith({ timeout: 5 });
    await closing;
  });
});
