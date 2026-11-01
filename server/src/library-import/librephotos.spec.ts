import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it } from 'vitest';
import content from 'src/library-import/fixtures/librephotos/1.5.1-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/librephotos/1.5.1-sqlite.json' with { type: 'json' };
import { LibrephotosTable, openLibrephotosSnapshot } from 'src/library-import/librephotos.js';

describe('LibrePhotos pinned SQLite extraction', () => {
  let root: string;
  let path: string;
  let database: DatabaseSync;
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-librephotos-'));
    path = join(root, 'source.sqlite');
    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=OFF');
    for (const type of ['table', 'index', 'trigger', 'view']) {
      for (const object of fixture.objects) {
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
      }
    }
    for (const migration of fixture.migrations) {
      database
        .prepare('INSERT INTO django_migrations(app,name,applied) VALUES(?,?,?)')
        .run(migration.app, migration.name, '2026-11-01 00:00:00');
    }
    // Omitted required fields are synthetic inert values, never captured credentials or model vectors.
    for (const [table, rows] of Object.entries(content.rows)) {
      const columns = database.prepare(`PRAGMA table_info("${table}")`).all();
      for (const captured of rows) {
        const row: Record<string, SQLInputValue> = { ...captured };
        if (table === 'api_user')
          Object.assign(row, {
            llm_settings: '{}',
            burst_detection_rules: '[]',
            default_timeline_filter: '{}',
            excluded_folders: '[]',
          });
        for (const column of columns) {
          const name = String(column.name);
          if (column.notnull && !Object.hasOwn(row, name)) {
            row[name] = String(column.type).includes('BLOB')
              ? new Uint8Array()
              : /int|bool|real/i.test(String(column.type))
                ? 0
                : '';
          }
        }
        const names = Object.keys(row);
        database
          .prepare(
            `INSERT INTO "${table}" (${names.map((name) => `"${name}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
          )
          .run(...Object.values(row));
      }
    }
  });
  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  const rows = (table: LibrephotosTable) => {
    const source = openLibrephotosSnapshot(path, fixture.source.version);
    try {
      return [...source.rows(table)].flat();
    } finally {
      source.close();
    }
  };
  const id = (name: keyof typeof content.expected.photos) => content.expected.photos[name].replaceAll('-', '');

  it('retains distinct UUID owners, shared physical files, variants and duplicate paths', () => {
    const photos = rows('api_photo');
    const alice = photos.find((photo) => photo.id === id('alice'))!;
    const bob = photos.find((photo) => photo.id === id('bob'))!;
    expect(alice.owner_id).toBe(BigInt(content.expected.actors.alice));
    expect(bob.owner_id).toBe(BigInt(content.expected.actors.bob));
    expect(alice.main_file_id).toBe(bob.main_file_id);
    expect(alice.image_hash).not.toBe(bob.image_hash);
    expect(rows('api_photo_files').filter((row) => row.photo_id === alice.id)).toHaveLength(2);
    expect(rows('api_filecopy')[0].file_id).toBe(alice.main_file_id);
    expect(rows('api_file')).toHaveLength(5);
  });

  it('retains manual edits ahead of embedded values and independently verified source API expectations', () => {
    const metadata = rows('api_photometadata').find((row) => row.photo_id === id('alice'))!;
    expect(metadata.title).toBe(content.expected.sourceApi.ownerTitle);
    expect(JSON.parse(String(metadata.edited_keywords))).toEqual(content.expected.sourceApi.manualKeywords);
    expect(JSON.parse(String(metadata.keywords))).toEqual(content.expected.sourceApi.scannedKeywords);
    const caption = rows('api_photo_caption').find((row) => row.photo_id === id('alice'))!;
    expect(JSON.parse(String(caption.captions_json)).user_caption).toBe(content.expected.sourceApi.ownerCaption);
    expect(rows('api_photo').find((row) => row.id === id('alice'))!.rating).toBe(4n);
    expect(rows('api_metadataedit').length).toBeGreaterThanOrEqual(5);
    const bob = rows('api_photo').find((row) => row.id === id('bob'))!;
    expect(String(bob.exif_timestamp).replace(' ', 'T') + 'Z').toBe(content.expected.sourceApi.manualCaptureTime);
    expect(bob.exif_timestamp_source).not.toBe(1n);
    expect(bob.timestamp).toBe(bob.exif_timestamp);
  });

  it('preserves independent hidden/archive/trash state and same-owner stack relationships', () => {
    const photos = rows('api_photo');
    expect(photos.find((row) => row.id === id('hidden'))!.hidden).toBe(1n);
    expect(photos.find((row) => row.id === id('archived'))!.archived).toBe(1n);
    expect(photos.find((row) => row.id === id('trash'))!.in_trashcan).toBe(1n);
    expect(rows('api_photostack')[0].owner_id).toBe(BigInt(content.expected.actors.alice));
    expect(rows('api_photo_stacks')).toHaveLength(2);
  });

  it('retains both album permission ceilings and individual roles without conflating locks with privacy', () => {
    expect(rows('api_albumuser')[0]).toMatchObject({
      locked: 1n,
      members_share_location: 0n,
      members_share_faces: 0n,
      members_share_originals: 0n,
      members_share_captions: 0n,
    });
    expect(rows('api_albumuser_shared_to')).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          user_id: BigInt(content.expected.actors.bob),
          role: 'contributor',
          share_originals: 0n,
        }),
        expect.objectContaining({ user_id: BigInt(content.expected.actors.clara), role: 'viewer', share_faces: 0n }),
      ]),
    );
    expect(
      rows('api_albumuser_photos')
        .map((row) => String(row.photo_id))
        .sort((a, b) => a.localeCompare(b)),
    ).toEqual([id('alice'), id('bob')].sort());
    expect(content.expected.sourceApi.viewerLatitude).toBeNull();
    expect(content.expected.sourceApi.strangerPhotoStatus).toBe(404);
    expect(content.expected.sourceApi.strangerAlbumStatus).toBe(404);
  });

  it('preserves raw face coordinates for later geometry qualification without exporting embeddings', () => {
    const geometry = content.expected.faceGeometry;
    database.exec(
      "UPDATE api_face SET encoding='private-face-vector'; UPDATE api_photo SET clip_embeddings='[123]', clip_embeddings_model='private-model'",
    );
    expect(rows('api_face')[0]).toMatchObject({
      location_left: BigInt(geometry.left),
      location_right: BigInt(geometry.right),
      location_top: BigInt(geometry.top),
      location_bottom: BigInt(geometry.bottom),
    });
    expect(rows('api_person')[0].name).toBe('Fixture Person');
    expect(rows('api_face')[0]).not.toHaveProperty('encoding');
    expect(rows('api_photo')[0]).not.toHaveProperty('clip_embeddings');
    expect(rows('api_photo')[0]).not.toHaveProperty('clip_embeddings_model');
  });

  it('excludes credentials, encrypted provider passwords, public bearer links and model vectors', () => {
    database.exec(
      "UPDATE api_user SET password='private-password-hash', nextcloud_app_password=X'736563726574', llm_settings='{\"apiKey\":\"private-key\"}'",
    );
    const user = rows('api_user')[0];
    expect(user.username).toBe('fixture_alice');
    for (const field of ['password', 'nextcloud_app_password', 'llm_settings', 'is_superuser', 'is_staff'])
      expect(user).not.toHaveProperty(field);
    database
      .prepare('INSERT INTO api_photoshare(id,enabled,slug,created_at,photo_id) VALUES(1,1,?,?,?)')
      .run('private-bearer-link', '2026-11-01', id('alice'));
    database
      .prepare('INSERT INTO api_albumusershare(id,enabled,slug,album_id) VALUES(1,1,?,?)')
      .run('private-bearer-link', content.expected.albumId);
    for (const table of ['api_photoshare', 'api_albumusershare'] as const) {
      database.exec(`UPDATE ${table} SET slug='private-bearer-link'`);
      const shares = rows(table);
      expect(shares).toHaveLength(1);
      expect(shares[0].enabled).toBe(1n);
      expect(shares[0]).not.toHaveProperty('slug');
    }
    for (const table of [
      'django_session',
      'socialaccount_socialtoken',
      'api_emailconfig',
      'constance_constance',
      'api_cluster',
      '__proto__',
      'api_user; DROP TABLE api_user',
    ]) {
      expect(() => rows(table as LibrephotosTable)).toThrow('LIBREPHOTOS_TABLE_NOT_ALLOWED');
    }
  });

  it('refuses unknown source versions and changed schemas', () => {
    expect(() => openLibrephotosSnapshot(path, '1.5.2')).toThrow('LIBREPHOTOS_VERSION_UNQUALIFIED');
    database.exec('ALTER TABLE api_albumuser ADD COLUMN new_privacy_rule TEXT');
    expect(() => openLibrephotosSnapshot(path, fixture.source.version)).toThrow('LIBREPHOTOS_SCHEMA_UNQUALIFIED');
  });

  it('returns stable redacted errors for unavailable and closed snapshots', () => {
    expect(() => openLibrephotosSnapshot(join(root, 'private-missing-source.sqlite'), fixture.source.version)).toThrow(
      'LIBREPHOTOS_SNAPSHOT_UNAVAILABLE',
    );
    const source = openLibrephotosSnapshot(path, fixture.source.version);
    source.close();
    expect(() => [...source.rows('api_user')]).toThrow('LIBREPHOTOS_SNAPSHOT_READ_FAILED');
  });

  it.each(['missing', 'unexpected', 'duplicate', 'unfinished'])(
    'refuses %s migration inventory before returning content',
    (kind) => {
      const mutations: Record<string, string> = {
        missing: 'DELETE FROM django_migrations WHERE id=(SELECT min(id) FROM django_migrations)',
        unexpected:
          "INSERT INTO django_migrations(app,name,applied) VALUES ('api','unqualified','2026-11-01 00:00:00')",
        duplicate:
          'INSERT INTO django_migrations(app,name,applied) SELECT app,name,applied FROM django_migrations LIMIT 1',
        unfinished: "UPDATE django_migrations SET applied='not-a-date' WHERE id=1",
      };
      database.exec(mutations[kind]);
      expect(() => openLibrephotosSnapshot(path, fixture.source.version)).toThrow('LIBREPHOTOS_MIGRATIONS_INCOMPLETE');
      database.exec('BEGIN EXCLUSIVE; ROLLBACK');
    },
  );

  it('refuses broken foreign-key relationships before returning content', () => {
    database.exec('UPDATE api_photo SET owner_id=999999');
    expect(() => openLibrephotosSnapshot(path, fixture.source.version)).toThrow('LIBREPHOTOS_RELATIONSHIPS_INVALID');
  });

  it('keeps one read snapshot, bounds batches and preserves large and negative identities', () => {
    database.exec("PRAGMA journal_mode=WAL; UPDATE api_user SET id=9007199254740993 WHERE username='fixture_mallory'");
    const source = openLibrephotosSnapshot(path, fixture.source.version);
    try {
      database.exec(
        "WITH RECURSIVE seq(n) AS (SELECT 1 UNION ALL SELECT n+1 FROM seq WHERE n<2100) INSERT INTO api_filecopy(path,file_id) SELECT '/originals/copy-'||n,(SELECT hash FROM api_file LIMIT 1) FROM seq",
      );
      expect([...source.rows('api_filecopy')].flat()).toHaveLength(1);
      expect([...source.rows('api_user')].flat().at(-1)!.id).toBe(9_007_199_254_740_993n);
    } finally {
      source.close();
    }
    database.exec(
      "INSERT INTO api_filecopy(id,path,file_id) SELECT -1,'/originals/negative',hash FROM api_file LIMIT 1",
    );
    const current = openLibrephotosSnapshot(path, fixture.source.version);
    try {
      const batches = [...current.rows('api_filecopy')];
      expect(batches.map((batch) => batch.length)).toEqual([1000, 1000, 102]);
      expect(batches[0][0].id).toBe(-1n);
    } finally {
      current.close();
    }
  });
});
