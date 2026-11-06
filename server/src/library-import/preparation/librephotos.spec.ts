import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import pgContent from 'src/library-import/fixtures/librephotos/1.5.1-postgres-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/librephotos/1.5.1-postgres18.json' with { type: 'json' };
import { createLibrephotosPostgresDecoder } from 'src/library-import/librephotos-postgres.js';
import { type LibrephotosTable } from 'src/library-import/librephotos.js';
import { postgresSchemaQueries } from 'src/library-import/postgres-schema.js';
import {
  adapter,
  librephotosCaptureOffsets,
  librephotosFiles,
  parseLibrephotosDatabaseUrl,
} from 'src/library-import/preparation/librephotos.js';
import { UNTESTED_VERSION_LOSS, inspectPreparationSource } from 'src/library-import/preparation/prepare.js';

const transport = vi.hoisted(() => ({ reserve: vi.fn(), unsafe: vi.fn(), release: vi.fn(), end: vi.fn() }));
vi.mock('postgres', () => ({ default: vi.fn(() => ({ reserve: transport.reserve, end: transport.end })) }));

const rows = pgContent.rows as Record<string, Record<string, string | null>[]>;
const keyOf = (table: string) =>
  table === 'api_file' ? 'hash' : ['api_photo_caption', 'api_photo_ocr'].includes(table) ? 'photo_id' : 'id';
const decoded = (table: LibrephotosTable) => {
  const decoder = createLibrephotosPostgresDecoder(undefined, '', '', { bestEffort: true });
  return (rows[table] ?? []).map((row) => decoder.decode(table, row));
};
const bob = '9123f215-cc36-5324-88d9-a2f9b0efecd0'.replaceAll('-', '');

/** LibrePhotos 1.5.1 content behind a mocked postgres.js transport; `engine` other than 18.6 is untested. */
const restore = (
  engine = fixture.source.database.version,
  migrations = fixture.migrations.map((row) => ({ ...row, finished: true })),
) => {
  const statements: string[] = [];
  transport.reserve.mockResolvedValue({ unsafe: transport.unsafe, release: transport.release });
  transport.end.mockResolvedValue(undefined);
  transport.unsafe.mockImplementation((statement: string, parameters: unknown[] = []) => {
    statements.push(statement);
    if (statement.includes('rolsuper'))
      return Promise.resolve([
        {
          readonly: 'on',
          rolsuper: false,
          rolbypassrls: false,
          elevated: false,
          writable: false,
          other_clients: false,
        },
      ]);
    if (statement.includes("current_setting('server_version')")) return Promise.resolve([{ version: engine }]);
    if (statement.includes('FROM public.django_migrations')) return Promise.resolve(migrations);
    const catalog = Object.entries(postgresSchemaQueries).find(([, sql]) => sql === statement);
    if (catalog) return Promise.resolve(fixture.structure[catalog[0] as keyof typeof fixture.structure]);
    if (statement.startsWith('SELECT password FROM ONLY public.api_user')) return Promise.resolve([{ password: '' }]);
    const table = /FROM ONLY public\."(\w+)"/u.exec(statement)?.[1];
    if (table && statement.startsWith('SELECT count(*)'))
      return Promise.resolve([{ count: String(rows[table]?.length ?? 0) }]);
    if (table && parameters.length === 0)
      return Promise.resolve((rows[table] ?? []).map((row) => ({ ...row, __frameleaf_cursor: row[keyOf(table)] })));
    return Promise.resolve([]);
  });
  return statements;
};

describe('LibrePhotos preparation adapter', () => {
  let directory: string;
  let originalsRoot: string;
  const input = () => ({
    source: {
      kind: 'librephotos' as const,
      version: '1.5.1',
      identity: 'synthetic-librephotos',
      revision: 'd'.repeat(64),
      schemaSha256: 'e'.repeat(64),
    },
    databaseUrl: 'postgres://reader:private-password@127.0.0.1:5432/librephotos',
    originalsRoot,
    // The fixture library was scanned with its photos mounted at /originals.
    sourceRootPath: '/originals',
  });

  beforeEach(async () => {
    vi.resetAllMocks();
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-prepare-librephotos-'));
    originalsRoot = join(directory, 'photos');
    await mkdir(originalsRoot);
    for (const file of [...rows.api_file, ...rows.api_filecopy])
      await writeFile(join(originalsRoot, String(file.path).slice('/originals/'.length)), 'synthetic-png');
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('inspects a qualified restore through one exclusive snapshot', async () => {
    const statements = restore();
    const result = await inspectPreparationSource(adapter, input());
    expect(result.tested).toBe(true);
    expect(result.source.schemaSha256).toBe('e'.repeat(64));
    expect(result.summary).toMatchObject({ owners: 4, assets: 5, files: 5 });
    expect(result.owners.find((owner) => owner.sourceId === '1')).toMatchObject({
      name: 'fixture_alice',
      restrictions: [],
    });
    expect(result.losses.map((loss) => loss.code)).not.toContain(UNTESTED_VERSION_LOSS);
    expect(statements.filter((sql) => sql.startsWith('BEGIN'))).toHaveLength(1);
    expect(statements).toContain('RELEASE SAVEPOINT frameleaf_qualification');
    expect(transport.end).toHaveBeenCalledOnce();
  });

  it('reads an untested engine best effort and keeps the snapshot usable after the failed pin', async () => {
    const statements = restore('15.4');
    const result = await inspectPreparationSource(adapter, input());
    expect(result.tested).toBe(false);
    expect(result.summary).toMatchObject({ assets: 5 });
    expect(result.losses).toContainEqual({ code: UNTESTED_VERSION_LOSS, count: 1 });
    expect(statements).toContain('ROLLBACK TO SAVEPOINT frameleaf_qualification');
    // PostgreSQL before 16 has no SET role privilege; membership is the stricter pre-16 equivalent.
    expect(statements.find((sql) => sql.includes('rolsuper'))).toContain("writer.oid,'MEMBER'");
  });

  it('refuses an unfinished migration record even when the version is untested', async () => {
    const migrations = fixture.migrations.map((row) => ({ ...row, finished: true }));
    restore('15.4', [...migrations, { app: 'api', name: '9999_future', finished: false }]);
    await expect(inspectPreparationSource(adapter, input())).rejects.toThrow('LIBREPHOTOS_MIGRATIONS_INCOMPLETE');
    // An unfamiliar but finished migration is version drift, read best effort.
    restore('15.4', [...migrations, { app: 'api', name: '9999_future', finished: true }]);
    expect((await inspectPreparationSource(adapter, input())).tested).toBe(false);
  });

  it('maps manual dates with the owner zone and keeps the password channel on the snapshot', async () => {
    restore();
    const source = await adapter.open(input());
    try {
      const files = (await source.files()).map((file) => ({
        ...file,
        bytes: '13',
        sha256: '0'.repeat(64),
        modifiedAt: '2026-11-01T00:00:00.000Z',
      }));
      const { manifest } = await source.manifest(files);
      expect(manifest.assets.find((asset) => asset.id === bob)?.metadata.takenAt).toBe('2021-02-04T15:09:10Z');
      const [owner] = await source.owners();
      await expect(
        owner.password({
          operationId: '11111111-1111-4111-8111-111111111111',
          sourceUserId: owner.sourceId,
          destinationUserId: '22222222-2222-4222-8222-222222222222',
        }),
      ).resolves.toBeUndefined();
    } finally {
      await source.close();
    }
  });

  it('refuses an inactive restore role before reading content', async () => {
    restore();
    const original = transport.unsafe.getMockImplementation()!;
    transport.unsafe.mockImplementation((statement: string, parameters?: unknown[]) =>
      statement.includes('rolsuper')
        ? Promise.resolve([{ readonly: 'on', rolsuper: true }])
        : original(statement, parameters),
    );
    await expect(inspectPreparationSource(adapter, input())).rejects.toThrow('LIBREPHOTOS_SOURCE_NOT_READ_ONLY');
  });
});

describe('LibrePhotos preparation helpers', () => {
  it.each([
    ['postgres://u:p@127.0.0.1:5432/db', true],
    ['postgresql://u:p@[::1]/db', true],
    ['postgres://u:p@localhost/db', 'LIBREPHOTOS_DATABASE_URL_NOT_LOOPBACK'],
    ['postgres://u:p@10.0.0.2/db', 'LIBREPHOTOS_DATABASE_URL_NOT_LOOPBACK'],
    ['mysql://u:p@127.0.0.1/db', 'LIBREPHOTOS_DATABASE_URL_INVALID'],
    ['postgres://u:p@127.0.0.1/', 'LIBREPHOTOS_DATABASE_URL_INVALID'],
    [undefined, 'LIBREPHOTOS_DATABASE_URL_INVALID'],
  ])('checks the restore URL %s', (url, expected) => {
    if (expected === true) expect(parseLibrephotosDatabaseUrl(url)).toBe(new URL(url!).href);
    else expect(() => parseLibrephotosDatabaseUrl(url)).toThrow(expected);
  });

  it('strips the app container root (default /data) from originals and duplicate copies', () => {
    const files = decoded('api_file').map((row) => ({
      ...row,
      path: String(row.path).replace('/originals/', '/data/'),
    }));
    const copies = decoded('api_filecopy').map((row) => ({
      ...row,
      path: String(row.path).replace('/originals/', '/data/'),
    }));
    expect(librephotosFiles(files, copies)).toContainEqual({ id: 'copy:1', path: 'blue-copy.png', role: 'original' });
    expect(librephotosFiles(files, copies)).toContainEqual({
      id: 'file:d067f0414bb92c98250fe0c0c522ecf21',
      path: 'blue.png',
      role: 'original',
    });
    expect(() => librephotosFiles(decoded('api_file'), [])).toThrow('LIBREPHOTOS_FILE_PATH_INVALID');
  });

  it('needs an offset only for wall-clock captures and takes it from the owner zone', () => {
    const users = decoded('api_user');
    expect(librephotosCaptureOffsets(decoded('api_photo'), users)).toEqual({ [bob]: -420 });
    const unknownZone = users.map((user) => ({ ...user, default_timezone: 'Not/AZone' }));
    expect(librephotosCaptureOffsets(decoded('api_photo'), unknownZone)).toEqual({ [bob]: 0 });
  });
});
