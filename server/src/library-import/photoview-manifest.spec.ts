import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import planFixture from 'src/library-import/fixtures/manager-plan-v2.json' with { type: 'json' };
import content from 'src/library-import/fixtures/photoview/2.4.0-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/photoview/2.4.0-sqlite.json' with { type: 'json' };
import { type ImportManifest, manifestFingerprint } from 'src/library-import/manifest.js';
import * as photoview from 'src/library-import/photoview.js';
import { type SourceArchiveRecord } from 'src/library-import/source-archive-codec.js';

type Result = { manifest: ImportManifest; archive: SourceArchiveRecord[] };
const proof = (id: string, path: string, size: number, role = 'original') => {
  const bytes = Buffer.alloc(size, Number(id.replaceAll(/\D/g, '')) || 42);
  return {
    id,
    path,
    bytes: String(bytes.length),
    sha256: createHash('sha256').update(bytes).digest('hex'),
    role,
    modifiedAt: '2020-06-11T00:00:00.123456Z',
  };
};
const input = () => ({
  source: {
    kind: 'photoview',
    version: fixture.source.version,
    identity: 'synthetic-library',
    revision: 'snapshot-1',
    schemaSha256: fixture.schemaSha256,
  },
  inventory: {
    complete: true,
    ownershipComplete: true,
    privacyComplete: true,
    writersStopped: true,
    revisionBefore: 'snapshot-1',
    revisionAfter: 'snapshot-1',
  },
  sourceRoot: '/photos',
  photoOwners: { '1': '1', '2': '2', '3': '2', '4': '3' } as Record<string, string>,
  albumOwners: Object.fromEntries(
    content.rows.albums.map((a) => [String(a.id), [1, 5].includes(a.id) ? '1' : [3, 8].includes(a.id) ? '3' : '2']),
  ),
  files: content.rows.media.map((m) =>
    proof(
      `media:${m.id}`,
      m.path.slice('/photos/'.length),
      content.rows.media_urls.find((u) => u.media_id === m.id && u.purpose === 'original')!.file_size,
    ),
  ),
});

describe('Photoview common manifest mapping', () => {
  let directory: string;
  let database: DatabaseSync;
  let path: string;
  const opened: ReturnType<typeof photoview.openPhotoviewSnapshot>[] = [];
  const read = (value = input()): Result => {
    const source = photoview.openPhotoviewSnapshot(path, fixture.source.version);
    opened.push(source);
    const adapter = Reflect.get(photoview, 'readPhotoviewManifest') as
      ((snapshot: typeof source, input: unknown) => Result) | undefined;
    expect(adapter).toBeTypeOf('function');
    if (!adapter) throw new Error('Photoview manifest adapter missing');
    return adapter(source, value);
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-photoview-manifest-'));
    path = join(directory, 'source.sqlite');
    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=OFF');
    for (const type of ['table', 'index', 'trigger', 'view'])
      for (const object of fixture.objects)
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
    for (const [table, captured] of Object.entries(content.rows)) {
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
          default: {
            break;
          }
        }
        const names = Object.keys(row);
        database
          .prepare(
            `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
          )
          .run(...Object.values(row));
      }
    }
  });
  afterEach(async () => {
    for (const source of opened.splice(0)) source.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  it('maps admitted originals, explicit owners, directory albums and the selected owner favourite', () => {
    database
      .prepare('UPDATE media_exif SET description=?,gps_latitude=?,gps_longitude=? WHERE id=2')
      .run('Edited caption', 45.5, -73.6);
    const { manifest, archive } = read();
    expect(manifest.version).toBe(3);
    expect(manifest.assets).toHaveLength(4);
    expect(manifest.files).toHaveLength(4);
    expect(manifest.users).toEqual(content.rows.users.map((u) => ({ id: String(u.id), name: u.username })));
    expect(manifest.assets.find((a) => a.id === '2')).toMatchObject({
      ownerId: '2',
      type: 'IMAGE',
      primaryFileId: 'media:2',
      originalFileNames: { 'media:2': 'photo.png' },
      metadata: {
        description: 'Edited caption',
        latitude: 45.5,
        longitude: -73.6,
        takenAt: '2026-11-01T21:07:49+00:00',
      },
    });
    expect(manifest.assets.find((a) => a.id === '3')?.metadata.favorite).toBe(true);
    expect(manifest.albums.find((a) => a.id === '7')).toMatchObject({
      ownerId: '2',
      name: 'private',
      assetIds: ['3'],
      members: [],
    });
    expect(archive.find((r) => r.table === 'media' && r.value.id === 3n)?.value.path_hash).toBe(
      content.rows.media[2].path_hash,
    );
    expect(archive.find((r) => r.table === 'user_media_data')?.value.favorite).toBe(1n);
    expect(JSON.stringify(archive, (_, v) => (typeof v === 'bigint' ? String(v) : v))).not.toMatch(/excluded-/);
    expect(manifest.losses).toContainEqual({ code: 'PHOTOVIEW_SHARING_RESTRICTED', acknowledged: false });
    expect(manifest.assets.every((a) => a.visibility === 'timeline')).toBe(true);
  });
  it('does not assign another viewer favourite when the shared original maps to Bob', () => {
    const value = input();
    value.photoOwners['3'] = '3';
    const { manifest } = read(value);
    expect(manifest.assets.find((a) => a.id === '3')?.metadata.favorite).toBe(false);
    expect(manifest.albums.find((a) => a.id === '7')).toMatchObject({ ownerId: '2', assetIds: [] });
    expect(manifest.albums.find((a) => a.id === '7:owner:3')).toMatchObject({
      ownerId: '3',
      name: 'private',
      assetIds: ['3'],
      members: [],
    });
    expect(manifest.losses.some((l) => l.code === 'PHOTOVIEW_VIEWER_PREFERENCES_ARCHIVED')).toBe(true);
  });

  it('binds a known native foreign-key permutation to its actual snapshot fingerprint', () => {
    const sql = fixture.objects.find((object) => object.type === 'table' && object.name === 'image_faces')!.sql!;
    const [columns, ...constraints] = sql.slice(0, -1).split(',CONSTRAINT ');
    database.exec('PRAGMA writable_schema=ON');
    database
      .prepare("UPDATE sqlite_schema SET sql=? WHERE name='image_faces'")
      .run([columns, ...constraints.reverse()].join(',CONSTRAINT ') + ')');
    const source = photoview.openPhotoviewSnapshot(path, fixture.source.version);
    opened.push(source);
    expect(source.schemaSha256).not.toBe(fixture.schemaSha256);
    const value = input();
    value.source.schemaSha256 = source.schemaSha256;
    const result = read(value);
    expect(result.manifest.source.schemaSha256).toBe(source.schemaSha256);
  });
  it('retains absent GPS as cleared coordinates and an empty caption rather than stale embedded metadata', () => {
    database.prepare('UPDATE media_exif SET description=? WHERE id=1').run('');
    expect(read().manifest.assets.find((a) => a.id === '1')?.metadata).toMatchObject({
      description: '',
      latitude: null,
      longitude: null,
    });
  });
  it('preserves the source clock without guessing a regional zone or treating EXIF UTC as a verified offset', () => {
    const { manifest } = read();
    expect(manifest.assets[0]).toMatchObject({
      localDateTime: '2026-11-01T21:07:49',
      metadata: { takenAt: '2026-11-01T21:07:49+00:00' },
    });
    expect(manifest.assets[0].metadata.timeZone).toBeUndefined();
    expect(manifest.losses).toContainEqual({
      code: 'PHOTOVIEW_CAPTURE_TIME_ZONE_UNRESOLVED',
      entityId: '1',
      acknowledged: false,
    });
  });
  it('keeps current source dates ahead of stale EXIF and archives nanosecond precision beyond destination storage', () => {
    database.prepare('UPDATE media SET date_shot=? WHERE id=1').run('2022-02-03 04:05:06.123456789-07:00');
    const { manifest, archive } = read();
    expect(manifest.assets[0]).toMatchObject({
      localDateTime: '2022-02-03T04:05:06.123456',
      metadata: { takenAt: '2022-02-03T04:05:06.123456-07:00' },
    });
    expect(archive.find((r) => r.table === 'media' && r.value.id === 1n)?.value.date_shot).toBe(
      '2022-02-03 04:05:06.123456789-07:00',
    );
    expect(manifest.losses.some((l) => l.code === 'PHOTOVIEW_CAPTURE_PRECISION_ARCHIVED')).toBe(true);
  });
  it('keeps a qualified original RAW XMP sidecar and ignores cached renditions', () => {
    database
      .prepare('UPDATE media SET path=?,side_car_path=?,side_car_hash=? WHERE id=1')
      .run('/photos/admin/private/photo.dng', '/photos/admin/private/photo.dng.xmp', 'source-md5-is-not-proof');
    const value = input();
    value.files[0].path = 'admin/private/photo.dng';
    value.files.push(proof('sidecar:1', 'admin/private/photo.dng.xmp', 100, 'sidecar'));
    const { manifest } = read(value);
    expect(manifest.assets[0].fileIds).toEqual(['media:1', 'sidecar:1']);
    expect(manifest.files.find((f) => f.id === 'sidecar:1')?.role).toBe('sidecar');
    expect(manifest.files).toHaveLength(5);
  });
  it('maps video originals without copying transcoded renditions', () => {
    database.prepare('UPDATE media SET type=?,path=? WHERE id=1').run('video', '/photos/admin/private/movie.mp4');
    const value = input();
    value.files[0].path = 'admin/private/movie.mp4';
    expect(read(value).manifest.assets[0]).toMatchObject({
      type: 'VIDEO',
      originalFileNames: { 'media:1': 'movie.mp4' },
    });
  });
  it.each(['photo', 'album'])(
    'refuses a %s owner who cannot read that source directory, including an ungranted administrator',
    (kind) => {
      const value = input();
      if (kind === 'photo') value.photoOwners['2'] = '1';
      else value.albumOwners['6'] = '1';
      expect(() => read(value)).toThrow('PHOTOVIEW_OWNER_MAPPING_REQUIRED');
    },
  );
  it.each([false, true])('reports sharing loss for an empty album with inherited readers (shared: %s)', (shared) => {
    database.exec(
      'DELETE FROM share_tokens; DELETE FROM user_media_data; DELETE FROM image_faces; DELETE FROM media_urls; DELETE FROM media; DELETE FROM user_albums',
    );
    for (const album of content.rows.albums)
      database.prepare('INSERT INTO user_albums(user_id,album_id) VALUES(?,?)').run(1, album.id);
    if (shared) {
      database.prepare('DELETE FROM user_albums WHERE album_id=?').run(5);
      database.prepare('INSERT INTO user_albums(user_id,album_id) VALUES(?,?)').run(2, 5);
    }
    const value = input();
    value.files = [];
    value.photoOwners = {};
    value.albumOwners = Object.fromEntries(content.rows.albums.map((album) => [String(album.id), '1']));
    const { manifest } = read(value);
    expect(manifest.assets).toHaveLength(0);
    expect(manifest.albums.find((album) => album.id === '5')).toMatchObject({
      ownerId: '1',
      members: [],
      assetIds: [],
    });
    expect(manifest.losses.some((loss) => loss.code === 'PHOTOVIEW_SHARING_RESTRICTED')).toBe(shared);
  });
  it('requires every owner decision and refuses unused stale decisions', () => {
    const value = input();
    delete value.photoOwners['1'];
    expect(() => read(value)).toThrow('PHOTOVIEW_OWNER_MAPPING_REQUIRED');
    value.photoOwners['1'] = '1';
    value.albumOwners.stale = '1';
    expect(() => read(value)).toThrow('PHOTOVIEW_MAPPING_CHANGED');
  });
  it.each(['schema', 'revision', 'writers'])('refuses changed %s evidence before reading content', (kind) => {
    const value = input();
    switch (kind) {
      case 'schema': {
        value.source.schemaSha256 = '0'.repeat(64);
        break;
      }
      case 'revision': {
        value.inventory.revisionAfter = 'changed';
        break;
      }
      case 'writers': {
        value.inventory.writersStopped = false;
        break;
      }
    }
    expect(() => read(value)).toThrow(
      kind === 'schema' ? 'PHOTOVIEW_SCHEMA_UNQUALIFIED' : 'PHOTOVIEW_CAPTURE_INCOMPLETE',
    );
  });
  it.each(['missing', 'extra', 'path', 'size', 'role'])(
    'refuses %s original evidence instead of using path hashes or cache entries',
    (kind) => {
      const value = input();
      switch (kind) {
        case 'missing': {
          value.files.pop();
          break;
        }
        case 'extra': {
          value.files.push(proof('cache:1', 'cache/thumbnail.jpg', 5395));
          break;
        }
        case 'path': {
          value.files[0].path = 'cache/thumbnail.jpg';
          break;
        }
        case 'size': {
          value.files[0].bytes = '1';
          break;
        }
        case 'role': {
          value.files[0].role = 'sidecar';
          break;
        }
      }
      expect(() => read(value)).toThrow('PHOTOVIEW_FILE_EVIDENCE_MISMATCH');
    },
  );
  it.each(['/photos/../escape.jpg', '/photos2/escape.jpg', '/photos/admin/./photo.png'])(
    'refuses unsafe original path %s',
    (path) => {
      database.prepare('UPDATE media SET path=? WHERE id=1').run(path);
      expect(() => read()).toThrow('PHOTOVIEW_ORIGINAL_PATH_INVALID');
    },
  );
  it.each([String.raw`/photos\lab`, '/photos\nlab'])(
    'refuses an unsafe source root before stripping its prefix: %s',
    (root) => {
      const value = input();
      value.sourceRoot = root;
      database.prepare("UPDATE media SET path=REPLACE(path,'/photos',?)").run(root);
      expect(() => read(value)).toThrow('PHOTOVIEW_ORIGINAL_PATH_INVALID');
    },
  );
  it('prepares every mapped original with the existing destination writer without database effects', () => {
    const { manifest } = read();
    const template = planFixture.plan.files[0];
    const files = new Map(manifest.files.map((file, index) => [file.id, { ...file, inode: String(index + 1) }]));
    const plan = parseDestinationImportPlan({
      ...planFixture.plan,
      source: manifest.source,
      owners: manifest.users.map((user) => ({ sourceId: user.id, destinationId: randomUUID() })),
      files: manifest.assets.flatMap((asset) =>
        asset.fileIds.map((id) => {
          const file = files.get(id)!;
          return {
            ...template,
            id: `placement:${asset.id}:${id}`,
            sourceAssetId: asset.id,
            sourceFileId: id,
            sourcePath: file.path,
            destinationPath: `${asset.ownerId}/${asset.id}/${file.path}`,
            bytes: file.bytes,
            sha256: file.sha256,
            sourceIdentity: { ...template.sourceIdentity, inode: file.inode, bytes: file.bytes },
          };
        }),
      ),
    });
    const query = vi.fn();
    const writer = new CanonicalAssetWriter(
      { query, transaction: vi.fn() },
      {
        manifest,
        plan,
        destinationId: plan.destinationId,
        binding: {
          operationId: randomUUID(),
          source: manifest.source,
          manifestSha256: manifestFingerprint(manifest),
          planSha256: destinationPlanFingerprint(plan),
        },
      },
    );
    const prepared = manifest.assets.map((asset) => {
      if (!('type' in asset)) throw new Error('Sealed source asset required');
      return writer.prepare({
        sourceAssetId: asset.id,
        type: asset.type,
        fileModifiedAt: asset.fileModifiedAt,
        originalFileNames: asset.originalFileNames,
      });
    });
    expect(prepared).toHaveLength(4);
    expect(prepared.reduce((count, asset) => count + asset.files.length, 0)).toBe(4);
    expect(query).not.toHaveBeenCalled();
  });
  it('refuses half-known GPS coordinates', () => {
    database.prepare('UPDATE media_exif SET gps_latitude=? WHERE id=1').run(45);
    expect(() => read()).toThrow('PHOTOVIEW_METADATA_INVALID');
  });
  it('refuses invalid source dates', () => {
    database.prepare('UPDATE media SET date_shot=? WHERE id=1').run('invalid');
    expect(() => read()).toThrow('PHOTOVIEW_CAPTURE_TIME_INVALID');
  });
});
