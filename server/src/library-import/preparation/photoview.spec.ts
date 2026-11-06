import { mkdir, mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import content from 'src/library-import/fixtures/photoview/2.4.0-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/photoview/2.4.0-sqlite.json' with { type: 'json' };
import { adapter } from 'src/library-import/preparation/photoview.js';
import { UNTESTED_VERSION_LOSS, inspectPreparationSource } from 'src/library-import/preparation/prepare.js';

const originalSize = (mediaId: number) =>
  content.rows.media_urls.find((url) => url.media_id === mediaId && url.purpose === 'original')!.file_size;

describe('Photoview preparation adapter', () => {
  let directory: string;
  let snapshotPath: string;
  let originalsRoot: string;
  const input = () => ({
    source: {
      kind: 'photoview' as const,
      version: fixture.source.version,
      identity: 'synthetic-photoview',
      revision: 'b'.repeat(64),
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
  const writeOriginals = async (root: string, prefix: string) => {
    for (const media of content.rows.media) {
      const path = join(root, media.path.slice(prefix.length));
      await mkdir(dirname(path), { recursive: true });
      await writeFile(path, Buffer.alloc(originalSize(media.id), media.id));
    }
  };

  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-prepare-photoview-'));
    snapshotPath = join(directory, 'source.sqlite');
    originalsRoot = join(directory, 'photos');
    const database = new DatabaseSync(snapshotPath);
    database.exec('PRAGMA foreign_keys=OFF; BEGIN');
    for (const type of ['table', 'index', 'trigger', 'view'])
      for (const object of fixture.objects)
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
    for (const [table, captured] of Object.entries(content.rows))
      for (const value of captured) {
        const row: Record<string, SQLInputValue> = { ...value };
        switch (table) {
          case 'users': {
            row.password = 'excluded-user-password';
            break;
          }
          case 'media_urls': {
            row.media_name = 'excluded-preview-cache-name';
            break;
          }
          case 'share_tokens': {
            row.value = 'excluded-bearer-token';
            row.password = row.has_password === 1 ? 'excluded-share-password' : null;
            delete row.has_password;

            break;
          }
          // No default
        }
        const names = Object.keys(row);
        database
          .prepare(
            // eslint-disable-next-line unicorn/no-unsafe-sqlite-interpolation -- Fixture identifiers only; values are bound.
            `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
          )
          .run(...Object.values(row));
      }
    database.exec('COMMIT');
    database.close();
    await writeOriginals(originalsRoot, '/photos/');
  });
  afterEach(async () => {
    await rm(directory, { recursive: true, force: true });
  });

  it('derives the media root and directory owners from the snapshot', async () => {
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection).toMatchObject({
      tested: true,
      testedVersion: fixture.source.version,
      summary: {
        owners: 4,
        assets: 4,
        albums: 8,
        files: 4,
        bytes: String(content.rows.media.reduce((sum, media) => sum + originalSize(media.id), 0)),
      },
    });
    // The shared directory is readable by alice and bob; alice (lowest id at the same depth) owns its photo.
    expect(inspection.owners).toEqual([
      { sourceId: '1', name: 'fixture_admin', email: null, assets: 1, restrictions: [] },
      { sourceId: '2', name: 'fixture_alice', email: null, assets: 2, restrictions: [] },
      { sourceId: '3', name: 'fixture_bob', email: null, assets: 1, restrictions: [] },
      { sourceId: '4', name: 'fixture_mallory', email: null, assets: 0, restrictions: [] },
    ]);
    const codes = inspection.losses.map((loss) => loss.code);
    expect(codes).toEqual(
      expect.arrayContaining([
        'PHOTOVIEW_SOURCE_METADATA_ARCHIVED',
        'PHOTOVIEW_DIRECTORY_HIERARCHY_ARCHIVED',
        'PHOTOVIEW_SHARING_RESTRICTED',
      ]),
    );
    expect(codes).not.toContain(UNTESTED_VERSION_LOSS);
    expect(codes).not.toContain('PHOTOVIEW_ALBUM_PARTITIONED');
  });

  it('finds the media root when the mount is a parent of the scanned directory', async () => {
    await rm(originalsRoot, { recursive: true });
    originalsRoot = join(directory, 'volume');
    await writeOriginals(originalsRoot, '/');
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.summary).toMatchObject({ assets: 4, files: 4 });
  });

  it('prefers the user whose own scanned path holds a directory over an account reading the whole library', async () => {
    // The administrator now scans the whole library (/photos) and so also reads alice's directories.
    edit(`
      INSERT INTO albums (id,created_at,updated_at,title,parent_album_id,path,path_hash) VALUES
        (9,'2026-11-01 21:15:42+00:00','2026-11-01 21:15:42+00:00','photos',NULL,'/photos','root');
      UPDATE albums SET parent_album_id=9 WHERE id IN (1,2,3,4);
      INSERT INTO user_albums (album_id,user_id) VALUES (9,1),(2,1),(6,1);
    `);
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.tested).toBe(true);
    expect(inspection.owners.find((owner) => owner.sourceId === '2')?.assets).toBe(2);
    expect(inspection.owners.find((owner) => owner.sourceId === '1')?.assets).toBe(1);
  });

  it('reads an untested schema best effort and records the untested-version loss', async () => {
    edit('CREATE TABLE frameleaf_extra (id INTEGER PRIMARY KEY); ALTER TABLE media ADD COLUMN frameleaf_extra TEXT');
    const inspection = await inspectPreparationSource(adapter, input());
    expect(inspection.tested).toBe(false);
    expect(inspection.summary).toMatchObject({ owners: 4, assets: 4, albums: 8, files: 4 });
    expect(inspection.losses).toContainEqual({ code: UNTESTED_VERSION_LOSS, count: 1 });
  });

  it('refuses when an original is missing from the mount', async () => {
    await rm(join(originalsRoot, content.rows.media[0].path.slice('/photos/'.length)));
    await expect(inspectPreparationSource(adapter, input())).rejects.toThrow('IMPORT_SOURCE_ORIGINALS_MISSING');
  });
});
