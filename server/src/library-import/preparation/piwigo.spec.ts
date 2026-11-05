import { createConnection } from 'mysql2/promise';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import content from 'src/library-import/fixtures/piwigo/16.4.0-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/piwigo/16.4.0-mariadb.json' with { type: 'json' };
import { ImportedPassword, verifyImportedPassword } from 'src/library-import/passwords.js';
import { type PiwigoRow, type PiwigoTable } from 'src/library-import/piwigo-source.js';
import {
  adapter,
  derivePiwigoReview,
  parsePiwigoDatabaseUrl,
  piwigoFiles,
} from 'src/library-import/preparation/piwigo.js';
import { UNTESTED_VERSION_LOSS, inspectPreparationSource } from 'src/library-import/preparation/prepare.js';

vi.mock('mysql2/promise', () => ({ createConnection: vi.fn() }));

const bigints = (row: Record<string, unknown>) =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [key, typeof value === 'number' ? BigInt(value) : value]),
  );
const contentTables = () =>
  new Map(
    Object.entries(content.rows).map(([table, rows]) => [
      table as PiwigoTable,
      rows.map((row) => bigints(row) as PiwigoRow),
    ]),
  );
const metadataTables = [
  'TABLES',
  'COLUMNS',
  'STATISTICS',
  'TABLE_CONSTRAINTS',
  'KEY_COLUMN_USAGE',
  'TRIGGERS',
  'ROUTINES',
  'EVENTS',
];
const sections = Object.keys(fixture.schema) as (keyof typeof fixture.schema)[];
const privileges = ['SELECT', 'LOCK TABLES', 'TRIGGER', 'EVENT', 'SHOW VIEW', 'SHOW CREATE ROUTINE'];

/** A restored Piwigo (fixture prefix `flq_`) behind a mocked mysql2 transport; `engine` other than the fixture is untested. */
const restore = (options: { engine?: string; wsrep?: string; readOnly?: bigint; password?: string } = {}) => {
  const statements: string[] = [];
  const destroy = vi.fn();
  const answer = ({ sql }: { sql: string }, parameters: unknown[] = []) => {
    statements.push(sql);
    if (sql.startsWith('SELECT TABLE_NAME AS name FROM information_schema.TABLES'))
      return [[...fixture.schema.tables.map((row) => ({ name: row.TABLE_NAME })), { name: 'other_users' }], []];
    if (sql.includes('VERSION()'))
      return [
        [
          {
            version: options.engine ?? fixture.runtime.databaseVersion,
            read_only: options.readOnly ?? 1n,
            wsrep_on: 0n,
            account: 'root@localhost',
          },
        ],
        [],
      ];
    if (sql.startsWith('SHOW VARIABLES'))
      return [options.wsrep ? [{ Variable_name: 'wsrep_on', Value: options.wsrep }] : [], []];
    if (sql.includes('USER_PRIVILEGES')) return [privileges.map((PRIVILEGE_TYPE) => ({ PRIVILEGE_TYPE })), []];
    const index = metadataTables.findIndex((table) => sql.includes('FROM information_schema.' + table + ' '));
    if (index !== -1) return [[{ records: JSON.stringify(fixture.schema[sections[index]]) }], []];
    if (sql.startsWith('SELECT status FROM ')) return [[{ status: 'webmaster' }], []];
    if (sql.startsWith('SELECT password FROM ')) return [[{ password: options.password ?? '' }], []];
    const table = Object.keys(content.rows).find((name) => sql.includes('FROM `piwigo`.`flq_' + name + '`'));
    if (table && parameters.length === 0)
      return [content.rows[table as keyof typeof content.rows].map((row) => bigints(row)), []];
    return [[], []];
  };
  const query = vi.fn((options: { sql: string }, parameters?: unknown[]) =>
    Promise.resolve(answer(options, parameters)),
  );
  vi.mocked(createConnection).mockImplementation(() => Promise.resolve({ query, destroy, on: vi.fn() } as never));
  return { statements, destroy };
};

describe('Piwigo preparation adapter', () => {
  let directory: string;
  let originalsRoot: string;
  const input = () => ({
    source: {
      kind: 'piwigo' as const,
      version: '16.4.0',
      identity: 'synthetic-piwigo',
      revision: 'b'.repeat(64),
      schemaSha256: 'c'.repeat(64),
    },
    databaseUrl: 'mysql://root:private-fixture-only@127.0.0.1:3306/piwigo',
    originalsRoot,
  });

  beforeEach(async () => {
    vi.mocked(createConnection).mockReset();
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-prepare-piwigo-'));
    originalsRoot = join(directory, 'www');
    for (const original of content.originals) {
      const path = join(originalsRoot, original.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.from(original.originalBase64, 'base64'));
    }
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('inspects a qualified restore: detected prefix, uploader-owned photos and reported missing relations', async () => {
    const { statements, destroy } = restore();
    const result = await inspectPreparationSource(adapter, input());
    expect(result.tested).toBe(true);
    expect(result.testedVersion).toBe(fixture.source.version);
    expect(result.source.schemaSha256).toBe('c'.repeat(64));
    expect(result.summary).toMatchObject({ owners: 4, assets: 4, albums: 3, files: 4 });
    expect(result.owners.find((owner) => owner.sourceId === '1')).toMatchObject({
      name: 'fixture_admin',
      email: 'admin@example.invalid',
      assets: 4,
      restrictions: [],
    });
    expect(result.losses.map((loss) => loss.code)).toContain('PIWIGO_MISSING_IMAGE_RELATIONSHIPS_ARCHIVED');
    expect(result.losses.map((loss) => loss.code)).not.toContain(UNTESTED_VERSION_LOSS);
    expect(statements.some((sql) => sql.includes('`flq_images`'))).toBe(true);
    expect(statements.some((sql) => sql.endsWith(' WAIT 5'))).toBe(true);
    expect(destroy).toHaveBeenCalled();
  });

  it('reads an untested engine best effort without version, visibility or fingerprint pins', async () => {
    const { statements } = restore({ engine: '8.0.36' });
    const result = await inspectPreparationSource(adapter, input());
    expect(result.tested).toBe(false);
    expect(result.summary).toMatchObject({ assets: 4, albums: 3 });
    expect(result.losses).toContainEqual({ code: UNTESTED_VERSION_LOSS, count: 1 });
    const lock = statements.findLast((sql) => sql.startsWith('LOCK TABLES'))!;
    expect(lock).not.toContain(' WAIT ');
    expect(lock).toContain('`flq_lounge` READ');
    expect(lock).not.toContain('flq_sessions');
    expect(statements).toContain('SET SESSION lock_wait_timeout=5');
  });

  it.each([
    ['writable restore', { engine: '8.0.36', readOnly: 0n }],
    ['Galera node', { engine: '8.0.36', wsrep: 'ON' }],
  ])('keeps isolation checks in best effort: %s', async (_name, options) => {
    restore(options);
    await expect(inspectPreparationSource(adapter, input())).rejects.toThrow('PIWIGO_RESTORE_NOT_ISOLATED');
  });

  it('reads each owner password through a fresh locked read and releases it', async () => {
    const { destroy } = restore({ password: '482c811da5d5b4bc6d497ffa98491e38' });
    const source = await adapter.open(input());
    const owner = (await source.owners()).find((candidate) => candidate.sourceId === '1')!;
    const before = destroy.mock.calls.length;
    const credential = await owner.password({
      operationId: '11111111-1111-4111-8111-111111111111',
      sourceUserId: '1',
      destinationUserId: '22222222-2222-4222-8222-222222222222',
    });
    expect(credential).toBeInstanceOf(ImportedPassword);
    expect(await verifyImportedPassword('password123', credential!.forImport())).toBe(true);
    expect(destroy.mock.calls.length).toBe(before + 1);
    await source.close();
  });

  it('honours an explicit table prefix and refuses an ambiguous one', async () => {
    restore();
    await expect(adapter.open({ ...input(), databaseUrl: input().databaseUrl + '?prefix=piwigo_' })).rejects.toThrow(
      'PIWIGO_TABLE_PREFIX_UNKNOWN',
    );
    const { statements } = restore();
    await inspectPreparationSource(adapter, { ...input(), databaseUrl: input().databaseUrl + '?prefix=flq_' });
    expect(statements.some((sql) => sql.includes('`flq_images`'))).toBe(true);
    const query = vi.fn(() =>
      Promise.resolve([
        [
          { name: 'a_user_infos' },
          { name: 'a_images' },
          { name: 'a_categories' },
          { name: 'b_user_infos' },
          { name: 'b_images' },
          { name: 'b_categories' },
        ],
        [],
      ]),
    );
    vi.mocked(createConnection).mockImplementation(() =>
      Promise.resolve({ query, destroy: vi.fn(), on: vi.fn() } as never),
    );
    await expect(adapter.open(input())).rejects.toThrow('PIWIGO_TABLE_PREFIX_AMBIGUOUS');
  });
});

describe('Piwigo restore URL', () => {
  it('parses the loopback restore with encoded credentials', () => {
    expect(parsePiwigoDatabaseUrl('mysql://reader:p%40ss%2Fword@127.0.0.1:3307/my%20db?prefix=piwigo_')).toEqual({
      host: '127.0.0.1',
      port: 3307,
      user: 'reader',
      password: 'p@ss/word',
      database: 'my db',
      prefix: 'piwigo_',
    });
    expect(parsePiwigoDatabaseUrl('mariadb://root:x@[::1]/piwigo')).toMatchObject({ host: '::1', port: 3306 });
  });

  it.each([
    ['mysql://root:x@db.example:3306/piwigo', 'PIWIGO_DATABASE_URL_NOT_LOOPBACK'],
    ['mysql://root:x@localhost:3306/piwigo', 'PIWIGO_DATABASE_URL_NOT_LOOPBACK'],
    ['postgres://root:x@127.0.0.1/piwigo', 'PIWIGO_DATABASE_URL_INVALID'],
    ['mysql://root:x@127.0.0.1:3306/', 'PIWIGO_DATABASE_URL_INVALID'],
    ['mysql://root:x@127.0.0.1/piwigo?prefix=1bad', 'PIWIGO_DATABASE_URL_INVALID'],
    [undefined, 'PIWIGO_DATABASE_URL_INVALID'],
  ])('refuses %s', (url, code) => {
    expect(() => parsePiwigoDatabaseUrl(url)).toThrow(code);
  });
});

describe('Piwigo owner and file review', () => {
  it('prefers the uploader when they may see the photo and falls back to the highest-ranked admissible account', () => {
    const tables = contentTables();
    const images = tables.get('images')!;
    // Alice (normal, level 8) reaches category 3 through her group; Mallory (level 0) cannot see a level-4 photo.
    images.find((row) => row.id === 6n)!.added_by = 3n;
    images.find((row) => row.id === 5n)!.added_by = 5n;
    const review = derivePiwigoReview(tables);
    expect(review.photoOwners).toEqual({ '3': '1', '4': '1', '5': '1', '6': '3' });
    expect(review.albumOwners).toEqual({ '1': '1', '2': '1', '3': '1' });
    expect(review.reviewedMissingImageIds.toSorted()).toEqual(['1', '2']);
    expect(Object.values(review.reviewedCaptureOffsets)).toEqual([0, 0, 0, 0]);
  });

  it('lists originals and format siblings relative to the web root', () => {
    const tables = contentTables();
    tables.set('image_format', [{ format_id: 9n, image_id: 3n, ext: 'cr2', filesize: 1n }]);
    expect(piwigoFiles(tables).filter((file) => file.id.startsWith('image:3:'))).toEqual([
      { id: 'image:3:original', path: 'upload/2026/11/01/20261101215921-efe58f4e.png', role: 'original' },
      { id: 'image:3:format:9', path: 'upload/2026/11/01/pwg_format/20261101215921-efe58f4e.cr2', role: 'original' },
    ]);
  });
});
