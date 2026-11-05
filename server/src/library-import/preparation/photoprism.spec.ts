import { hash } from 'bcrypt';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import records from 'src/library-import/fixtures/photoprism/261029-records.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/photoprism/261029-sqlite.json' with { type: 'json' };
import { verifyImportedPassword } from 'src/library-import/passwords.js';
import { adapter, mysqlSourceConfig, photoprismLogin } from 'src/library-import/preparation/photoprism.js';
import { UNTESTED_VERSION_LOSS, inspectPreparationSource } from 'src/library-import/preparation/prepare.js';

const admin = records.tables.users.find((user) => user.user_name === 'admin')!;
// PhotoPrism numbers the first administrator 1 and its built-in Unknown/Visitor principals -1/-2.
const userIds: Record<string, number> = { [admin.user_uid]: 1, u000000000000001: -1, u000000000000002: -2 };

describe('PhotoPrism preparation adapter', () => {
  let directory: string;
  let snapshotPath: string;
  let originalsRoot: string;
  const input = () => ({
    source: {
      kind: 'photoprism' as const,
      version: fixture.source.version,
      identity: 'synthetic-photoprism',
      revision: 'a'.repeat(64),
      schemaSha256: fixture.schemaSha256,
    },
    snapshotPath,
    originalsRoot,
  });
  const edit = (sql: string, ...values: SQLInputValue[]) => {
    const database = new DatabaseSync(snapshotPath);
    database.prepare(sql).run(...values);
    database.close();
  };
  const insert = (table: string, row: Record<string, SQLInputValue>) => {
    const database = new DatabaseSync(snapshotPath);
    const names = Object.keys(row);
    database
      .prepare(
        // eslint-disable-next-line unicorn/no-unsafe-sqlite-interpolation -- Fixture identifiers only; values are bound.
        `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      )
      .run(...Object.values(row));
    database.close();
  };
  const owners = async () => {
    const source = await adapter.open(input());
    try {
      return await source.owners();
    } finally {
      await source.close();
    }
  };
  const manifest = async () => {
    const source = await adapter.open(input());
    try {
      const files = await source.files();
      return (
        await source.manifest(
          files.map((file) => ({
            ...file,
            bytes: String(records.tables.files.find((row) => row.file_uid === file.id)!.file_size),
            sha256: '0'.repeat(64),
            modifiedAt: '2026-11-01T00:00:00.000Z',
          })),
        )
      ).manifest;
    } finally {
      await source.close();
    }
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-prepare-photoprism-'));
    snapshotPath = join(directory, 'source.sqlite');
    originalsRoot = join(directory, 'originals');
    const database = new DatabaseSync(snapshotPath);
    for (const type of ['table', 'index', 'trigger', 'view'])
      for (const object of fixture.objects)
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
    database.close();
    for (const migration of fixture.migrations)
      insert('migrations', { ...migration, error: '', finished_at: '2026-11-01T00:00:00Z' });
    insert('versions', { version: fixture.source.executableVersion, error: '', migrated_at: '2026-11-01T00:00:00Z' });
    for (const [name, rows] of Object.entries(records.tables))
      for (const row of rows as Record<string, SQLInputValue>[])
        insert(
          name === 'users' ? 'auth_users' : name === 'shares' ? 'auth_users_shares' : name,
          name === 'users' ? { ...row, id: userIds[String(row.user_uid)] } : row,
        );
    for (const file of records.tables.files) {
      const path = join(originalsRoot, file.file_name);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.alloc(file.file_size, 1));
    }
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('inspects the qualified fixture as tested and derives owners from the snapshot', async () => {
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection).toMatchObject({
      format: 'frameleaf-library-import-inspection',
      tested: true,
      testedVersion: fixture.source.version,
      summary: {
        owners: 1,
        assets: 2,
        albums: 3,
        files: 2,
        bytes: String(records.tables.files.reduce((sum, file) => sum + file.file_size, 0)),
      },
      owners: [{ sourceId: admin.user_uid, name: 'Admin', email: null, assets: 2, restrictions: [] }],
    });
    expect(inspection.losses).toEqual([
      { code: 'PHOTOPRISM_ALBUM_SNAPSHOT', count: 2 },
      { code: 'PHOTOPRISM_SHARING_RESTRICTED', count: 1 },
      { code: 'PHOTOPRISM_SOURCE_METADATA_ARCHIVED', count: 1 },
      { code: 'PHOTOPRISM_TITLE_ARCHIVED', count: 2 },
    ]);
  });

  it('materializes generated folder albums from public photos in that folder', async () => {
    const { albums } = await manifest();
    const [publicPhoto, privatePhoto] = records.tables.photos;
    expect(albums.map(({ id, assetIds }) => ({ id, assetIds }))).toEqual([
      { id: records.tables.albums[0].album_uid, assetIds: [publicPhoto.photo_uid] },
      { id: records.tables.albums[1].album_uid, assetIds: [] },
      { id: records.tables.albums[2].album_uid, assetIds: [privatePhoto.photo_uid] },
    ]);
  });

  it('archives dynamic albums it cannot evaluate as a reported loss', async () => {
    insert('albums', {
      ...records.tables.albums[2],
      id: 99,
      album_uid: 'moment-album',
      album_slug: 'moment',
      album_type: 'moment',
      album_filter: 'label:sunset',
    });
    const result = await manifest();
    expect(result.albums.map((album) => album.id)).not.toContain('moment-album');
    expect(result.losses).toContainEqual({
      code: 'PHOTOPRISM_DYNAMIC_ALBUM_ARCHIVED',
      entityId: 'moment-album',
      acknowledged: false,
    });
  });

  it('gives each photo to its creator and keeps other owners out of an album', async () => {
    insert('auth_users', {
      ...admin,
      id: 2,
      user_uid: 'u-second',
      user_name: 'second',
      display_name: 'Second',
      user_email: 'second@example.test',
      super_admin: 0,
      user_role: 'user',
    });
    const privatePhoto = records.tables.photos[1];
    edit('UPDATE photos SET created_by=? WHERE photo_uid=?', 'u-second', privatePhoto.photo_uid);
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.owners).toEqual([
      expect.objectContaining({ sourceId: admin.user_uid, assets: 1, restrictions: [] }),
      expect.objectContaining({
        sourceId: 'u-second',
        email: 'second@example.test',
        assets: 1,
        restrictions: ['restricted-library-access'],
      }),
    ]);
    const result = await manifest();
    const album = records.tables.albums[2].album_uid;
    expect(result.albums.find((entry) => entry.id === album)?.assetIds).toEqual([]);
    expect(result.losses).toContainEqual({
      code: 'PHOTOPRISM_CROSS_OWNER_MEMBERSHIP_ARCHIVED',
      entityId: album,
      acknowledged: false,
    });
  });

  it('preserves only the qualified super-administrator verifier and claims every other account', async () => {
    const encoded = await hash('synthetic owner password', 4);
    insert('auth_users', { ...admin, id: 2, user_uid: 'u-second', user_name: 'second', super_admin: 0 });
    insert('passwords', { uid: admin.user_uid, hash: encoded });
    insert('passwords', { uid: 'u-second', hash: encoded });
    const context = (sourceUserId: string) => ({
      operationId: randomUUID(),
      sourceUserId,
      destinationUserId: randomUUID(),
    });
    const [first, second] = await (async () => {
      const source = await adapter.open(input());
      try {
        const accounts = await source.owners();
        return Promise.all(accounts.map((owner) => owner.password(context(owner.sourceId))));
      } finally {
        await source.close();
      }
    })();
    expect(await verifyImportedPassword('synthetic owner password', first!.forImport())).toBe(true);
    expect(second).toBeUndefined();
    edit('UPDATE auth_users SET auth_method=? WHERE user_uid=?', 'totp', admin.user_uid);
    const [restricted] = await owners();
    expect(restricted.login.secondFactorRequired).toBe(true);
    expect(await restricted.password(context(admin.user_uid))).toBeUndefined();
  });

  it('reads an untested schema best effort and records the untested-version loss', async () => {
    edit('CREATE TABLE frameleaf_extra (id INTEGER PRIMARY KEY)');
    const inspection = await inspectPreparationSource(adapter, {
      ...input(),
      source: { ...input().source, version: 'future' },
    });
    expect(inspection.tested).toBe(false);
    expect(inspection.summary).toMatchObject({ owners: 1, assets: 2, albums: 3, files: 2 });
    expect(inspection.losses).toContainEqual({ code: UNTESTED_VERSION_LOSS, count: 1 });
  });

  it('treats a newer PhotoPrism build as untested', async () => {
    edit('UPDATE versions SET version=?', 'future-build');
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.tested).toBe(false);
  });

  it('still refuses a failed migration', async () => {
    edit('UPDATE migrations SET error=? WHERE rowid=1', 'failed');
    await expect(inspectPreparationSource(adapter, input())).rejects.toThrow('PHOTOPRISM_MIGRATIONS_INCOMPLETE');
  });

  it('refuses when an original is missing from the mount', async () => {
    await rm(join(originalsRoot, records.tables.files[0].file_name));
    await expect(inspectPreparationSource(adapter, input())).rejects.toThrow('IMPORT_SOURCE_ORIGINALS_MISSING');
  });
});

describe('PhotoPrism login facts', () => {
  const base = {
    id: 1n,
    auth_provider: 'local',
    auth_method: '',
    super_admin: 1n,
    can_login: 1n,
    user_role: 'admin',
    user_scope: '*',
    user_attr: '',
    base_path: '',
    expires_at: null,
    deleted_at: null,
  };
  it.each([
    [{}, {}],
    [{ can_login: 0n }, {}],
    [{ super_admin: 0n, can_login: 0n }, { accountEnabled: false }],
    [{ deleted_at: '2000-01-01T00:00:00Z' }, { accountEnabled: false }],
    [{ auth_provider: 'none' }, { accountEnabled: false, passwordLoginEnabled: false, externalIdentityRequired: true }],
    [{ auth_provider: 'ldap' }, { passwordLoginEnabled: false, externalIdentityRequired: true }],
    [{ auth_provider: 'oidc' }, { externalIdentityRequired: true }],
    [{ auth_method: 'totp' }, { secondFactorRequired: true }],
    [{ expires_at: '2000-01-01T00:00:00Z' }, { otherRestrictions: 'present' }],
    [{ base_path: 'family' }, { ownedLibraryAccess: 'restricted' }],
    [{ user_role: 'user' }, { ownedLibraryAccess: 'restricted' }],
  ])('maps %o conservatively', (change, expected) => {
    expect(photoprismLogin({ ...base, ...change })).toEqual({
      accountEnabled: true,
      passwordLoginEnabled: true,
      secondFactorRequired: false,
      externalIdentityRequired: false,
      ownedLibraryAccess: 'full',
      otherRestrictions: 'none',
      ...expected,
    });
  });
});

describe('restored MySQL source URL', () => {
  it('maps the loopback URL to the reader configuration', () => {
    expect(mysqlSourceConfig('mysql://import%5Freader:p%40ss%2Fword@127.0.0.1:3307/photoprism', '1')).toEqual({
      host: '127.0.0.1',
      port: 3307,
      user: 'import_reader',
      password: 'p@ss/word',
      database: 'photoprism',
      version: '1',
    });
    expect(mysqlSourceConfig('mysql://reader:secret@127.0.0.1/photoprism', '1').port).toBe(3306);
  });
  it.each([
    'postgres://reader:secret@127.0.0.1/photoprism',
    'mysql://reader:secret@127.0.0.1/',
    'mysql://reader:secret@127.0.0.1/photoprism/extra',
    'mysql://reader:secret@127.0.0.1/photoprism?ssl=false',
    'not a url',
  ])('refuses %s', (url) => {
    expect(() => mysqlSourceConfig(url, '1')).toThrow('IMPORT_PREPARATION_INPUT_INVALID');
  });
});
