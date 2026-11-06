import { mkdir, mkdtemp, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import content from 'src/library-import/fixtures/nextcloud/35-8-10.2-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/nextcloud/35-8-10.2-sqlite.json' with { type: 'json' };
import { adapter } from 'src/library-import/preparation/nextcloud.js';
import { UNTESTED_VERSION_LOSS, inspectPreparationSource } from 'src/library-import/preparation/prepare.js';

const homes = new Map(
  content.rows.oc_storages
    .filter((storage) => storage.id.startsWith('home::'))
    .map((storage) => [storage.numeric_id, storage.id.slice('home::'.length)]),
);
const media = new Set(
  content.rows.oc_mimetypes.filter((row) => /^(image|video)\//u.test(row.mimetype)).map((row) => row.id),
);
const originals = content.rows.oc_filecache.filter((row) => homes.has(row.storage) && media.has(row.mimetype));

describe('Nextcloud preparation adapter', () => {
  let directory: string;
  let snapshotPath: string;
  let originalsRoot: string;
  const input = () => ({
    source: {
      kind: 'nextcloud' as const,
      version: fixture.source.version,
      identity: 'synthetic-nextcloud',
      revision: 'c'.repeat(64),
      schemaSha256: fixture.schemaSha256,
    },
    snapshotPath,
    originalsRoot,
  });
  const edit = (sql: string) => {
    const database = new DatabaseSync(snapshotPath);
    database.exec(sql);
    database.close();
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-prepare-nextcloud-'));
    snapshotPath = join(directory, 'source.sqlite');
    originalsRoot = join(directory, 'data');
    const database = new DatabaseSync(snapshotPath);
    database.exec('PRAGMA foreign_keys=OFF; BEGIN');
    for (const type of ['table', 'index', 'trigger', 'view'])
      for (const object of fixture.structure.objects)
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
    const records = { ...content.rows, oc_appconfig: fixture.appState, oc_migrations: fixture.migrations };
    for (const [table, captured] of Object.entries(records))
      for (const value of captured) {
        const row: Record<string, SQLInputValue> = { ...value };
        if (table === 'oc_users') row.password = 'excluded-user-password-hash';
        else if (table === 'oc_files_metadata') row.sync_token = 'excluded-sync-cursor';
        else if (table === 'oc_photos_albums_collabs' && row.collaborator_type === 3)
          row.collaborator_id = 'excluded-public-link-token';
        const keys = Object.keys(row);
        database
          .prepare(
            // eslint-disable-next-line unicorn/no-unsafe-sqlite-interpolation -- Fixture identifiers only; values are bound.
            `INSERT INTO "${table}" (${keys.map((key) => `"${key}"`).join(',')}) VALUES (${keys.map(() => '?').join(',')})`,
          )
          .run(...Object.values(row));
      }
    database.exec('COMMIT');
    database.close();
    for (const file of originals) {
      const path = join(originalsRoot, homes.get(file.storage)!, file.path);
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.alloc(file.size));
      // The file system keeps sub-second precision that Nextcloud's whole-second file cache does not.
      await utimes(path, file.mtime + 0.25, file.mtime + 0.25);
    }
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('maps home storages under the data directory and reads account facts from the snapshot', async () => {
    edit(`
      INSERT INTO oc_preferences (userid,appid,configkey,configvalue) VALUES
        ('alice','settings','email','alice@example.com'),
        ('mallory','core','enabled','false');
      INSERT INTO oc_twofactor_providers (provider_id,uid,enabled) VALUES ('totp','bob',1);
    `);
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection).toMatchObject({
      tested: true,
      testedVersion: fixture.source.version,
      summary: {
        owners: 4,
        assets: originals.length,
        albums: 4,
        files: originals.length,
        bytes: String(originals.reduce((sum, file) => sum + file.size, 0)),
      },
    });
    expect(inspection.owners).toEqual([
      { sourceId: 'fixture-admin', name: 'fixture-admin', email: null, assets: 10, restrictions: [] },
      { sourceId: 'alice', name: 'alice', email: 'alice@example.com', assets: 4, restrictions: [] },
      { sourceId: 'bob', name: 'bob', email: null, assets: 1, restrictions: ['second-factor-required'] },
      { sourceId: 'mallory', name: 'mallory', email: null, assets: 0, restrictions: ['account-disabled'] },
    ]);
    const codes = inspection.losses.map((loss) => loss.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'NEXTCLOUD_SOURCE_METADATA_ARCHIVED',
        'NEXTCLOUD_SHARING_RESTRICTED',
        'NEXTCLOUD_GLOBAL_PRIVACY_REQUIRES_QUALIFICATION',
      ]),
    );
    expect(codes).not.toContain(UNTESTED_VERSION_LOSS);
  });

  it('treats enforced second factors and unreadable account facts as restrictive', async () => {
    edit(`INSERT INTO oc_appconfig (appid,configkey,configvalue) VALUES ('core','twofactor_enforced','true')`);
    let inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.owners.every((owner) => owner.restrictions.includes('second-factor-required'))).toBe(true);
    edit('DROP TABLE oc_preferences');
    inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.tested).toBe(false);
    expect(inspection.owners.every((owner) => owner.restrictions.includes('account-disabled'))).toBe(true);
  });

  it.each([
    ['an untested schema', 'CREATE TABLE frameleaf_extra (id INTEGER PRIMARY KEY)'],
    [
      'a newer Memories app',
      "UPDATE oc_appconfig SET configvalue='10.3.0' WHERE appid='memories' AND configkey='installed_version'",
    ],
  ])('reads %s best effort and records the untested-version loss', async (_name, sql) => {
    edit(sql);
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.tested).toBe(false);
    expect(inspection.summary).toMatchObject({ owners: 4, assets: originals.length, albums: 4 });
    expect(inspection.losses).toContainEqual({ code: UNTESTED_VERSION_LOSS, count: 1 });
  });

  it('refuses when an original is missing from the mount', async () => {
    await rm(join(originalsRoot, 'alice', 'files/Photos/manual.jpg'));
    await expect(inspectPreparationSource(adapter, input())).rejects.toThrow('IMPORT_SOURCE_ORIGINALS_MISSING');
  });
});
