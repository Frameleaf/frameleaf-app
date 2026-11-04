import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import content from 'src/library-import/fixtures/lychee/7.12.0-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/lychee/7.12.0-sqlite.json' with { type: 'json' };
import planFixture from 'src/library-import/fixtures/manager-plan-v2.json' with { type: 'json' };
import * as lychee from 'src/library-import/lychee.js';
import { type ImportManifest, manifestFingerprint } from 'src/library-import/manifest.js';
import { type SourceArchiveRecord } from 'src/library-import/source-archive-codec.js';

type Result = { manifest: ImportManifest; archive: SourceArchiveRecord[] };
const photo = content.rows.photos[0];
const original = (id: string) => content.rows.size_variants.find((v) => v.photo_id === id && v.type === 1)!;
const proof = (
  id: string,
  path: string,
  bytes: Buffer,
  role: ImportManifest['files'][number]['role'] = 'original',
  contentId?: string,
) => ({
  id,
  path,
  bytes: String(bytes.length),
  sha256: createHash('sha256').update(bytes).digest('hex'),
  role,
  modifiedAt: '2020-06-11T00:00:00.123456Z',
  contentId,
});
const input = () => ({
  source: {
    kind: 'lychee',
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
  materializedAlbums: {} as Record<string, string[]>,
  files: content.originals.map((entry) => {
    const bytes = Buffer.from(entry.originalBase64, 'base64');
    expect(String(bytes.length)).toBe(entry.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.sha256);
    return proof(`variant:${original(entry.photoId).id}`, entry.path.slice('/uploads/'.length), bytes);
  }),
});

describe('Lychee common manifest mapping', () => {
  let directory: string;
  let path: string;
  let database: DatabaseSync;
  const opened: ReturnType<typeof lychee.openLycheeSnapshot>[] = [];
  const read = (value = input()): Result => {
    const snapshot = lychee.openLycheeSnapshot(path, fixture.source.version);
    opened.push(snapshot);
    const adapter = Reflect.get(lychee, 'readLycheeManifest') as
      ((source: typeof snapshot, value: unknown) => Result) | undefined;
    expect(adapter).toBeTypeOf('function');
    if (!adapter) throw new Error('Lychee manifest adapter missing');
    return adapter(snapshot, value);
  };
  const insert = (table: string, row: Record<string, SQLInputValue>) => {
    const names = Object.keys(row);
    database
      .prepare(
        `INSERT INTO "${table}" (${names.map((n) => `"${n}"`).join(',')}) VALUES (${names.map(() => '?').join(',')})`,
      )
      .run(...Object.values(row));
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-lychee-manifest-'));
    path = join(directory, 'source.sqlite');
    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=OFF; BEGIN');
    for (const type of ['table', 'index', 'trigger', 'view'])
      for (const object of fixture.objects)
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
    for (const migration of fixture.migrations) insert('migrations', migration);
    for (const [table, records] of Object.entries(content.rows))
      for (const value of records) {
        const row: Record<string, SQLInputValue> = { ...value };
        if (table === 'users')
          Object.assign(row, {
            password: 'excluded-password',
            token: `excluded-api-token-${row.id}`,
            remember_token: 'excluded-session-token',
          });
        else if (table === 'access_permissions') {
          row.password = row.has_password === 1 ? 'excluded-share-password' : null;
          delete row.has_password;
        }
        insert(table, row);
      }
    database.exec('ANALYZE; COMMIT');
  });
  afterEach(async () => {
    for (const snapshot of opened.splice(0)) snapshot.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });
  it('maps the native independently hashed originals, owners, captions and private albums without credentials', () => {
    const { manifest, archive } = read();
    expect(manifest.version).toBe(5);
    expect(manifest.assets).toHaveLength(4);
    expect(manifest.files).toHaveLength(4);
    expect(manifest.users).toHaveLength(4);
    for (const entry of content.originals) {
      const source = content.rows.photos.find((p) => p.id === entry.photoId)!;
      expect(manifest.assets.find((p) => p.id === source.id)).toMatchObject({
        ownerId: String(source.owner_id),
        type: 'IMAGE',
        metadata: {
          description: source.description,
          latitude: null,
          longitude: null,
          favorite: false,
          takenAt: input().files[0].modifiedAt,
        },
      });
      expect(manifest.files.find((f) => f.id === `variant:${original(source.id).id}`)).toMatchObject({
        sha256: entry.sha256,
        bytes: entry.bytes,
        path: entry.path.slice('/uploads/'.length),
        role: 'original',
      });
    }
    expect(manifest.albums).toHaveLength(3);
    expect(manifest.albums.every((a) => a.members.length === 0)).toBe(true);
    expect(archive).toContainEqual({
      table: 'albums_tags',
      value: { id: 1n, tag_id: 1n, album_id: content.rows.albums_tags[0].album_id },
    });
    expect(JSON.stringify(archive, (_, value) => (typeof value === 'bigint' ? String(value) : value))).not.toContain(
      'excluded-',
    );
    expect(manifest.users.every((u) => !Object.hasOwn(u, 'email') && !Object.hasOwn(u, 'admin'))).toBe(true);
    expect(manifest.losses.some((l) => l.code === 'LYCHEE_SHARING_RESTRICTED')).toBe(true);
    expect(manifest).toMatchObject({ stacks: [], livePhotos: [] });
  });
  it('preserves a cleared nullable caption as an empty locked description', () => {
    database.prepare('UPDATE photos SET description=NULL WHERE id=?').run(photo.id);
    expect(read().manifest.assets.find((p) => p.id === photo.id)?.metadata.description).toBe('');
  });
  it('uses current manual UTC dates and their named source zone ahead of initial values', () => {
    database
      .prepare(
        'UPDATE photos SET taken_at=?,taken_at_orig_tz=?,initial_taken_at=?,initial_taken_at_orig_tz=?,is_highlighted=1 WHERE id=?',
      )
      .run('2020-06-10 18:30:00.123456', 'America/Edmonton', '1999-01-01 00:00:00.000000', 'UTC', photo.id);
    const asset = read().manifest.assets.find((p) => p.id === photo.id)!;
    expect(asset.metadata).toMatchObject({
      takenAt: '2020-06-10T18:30:00.123456Z',
      timeZone: 'America/Edmonton',
      favorite: true,
    });
    expect(asset).not.toHaveProperty('localDateTime');
  });
  it('preserves a fixed half-hour offset as an exact wall clock without guessing a region', () => {
    database
      .prepare('UPDATE photos SET taken_at=?,taken_at_orig_tz=? WHERE id=?')
      .run('2020-06-10 18:30:00.123456', '+05:30', photo.id);
    expect(read().manifest.assets.find((p) => p.id === photo.id)).toMatchObject({
      localDateTime: '2020-06-11T00:00:00.123456',
      metadata: { takenAt: '2020-06-10T18:30:00.123456Z' },
    });
    expect(read().manifest.assets.find((p) => p.id === photo.id)?.metadata.timeZone).toBeUndefined();
  });
  it('uses verified file time with a disclosed fallback only when the source capture date is absent', () => {
    const { manifest } = read();
    expect(manifest.losses).toContainEqual({
      code: 'LYCHEE_CAPTURE_TIME_FALLBACK',
      entityId: photo.id,
      acknowledged: false,
    });
    expect(manifest.assets.find((p) => p.id === photo.id)?.metadata).toMatchObject({
      takenAt: input().files[0].modifiedAt,
      timeZone: 'UTC',
    });
  });
  it('maps owner ratings and photo tags rather than another viewer rating or a computed average', () => {
    insert('photo_ratings', { photo_id: photo.id, user_id: 2, rating: 4 });
    insert('photo_ratings', { photo_id: photo.id, user_id: 3, rating: 1 });
    insert('photos_tags', { photo_id: photo.id, tag_id: 1 });
    database
      .prepare('UPDATE photos SET rating_avg=?,latitude=?,longitude=?,description=? WHERE id=?')
      .run('2.5000', 45.5, -73.6, '', photo.id);
    const { manifest } = read();
    expect(manifest.assets.find((p) => p.id === photo.id)?.metadata).toMatchObject({
      rating: 4,
      tags: ['Fixture regular album tag'],
      latitude: 45.5,
      longitude: -73.6,
      description: '',
    });
    expect(manifest.losses.some((l) => l.code === 'LYCHEE_VIEWER_RATINGS_ARCHIVED')).toBe(true);
  });
  it('maps a video original through its recorded media type and independent file evidence', () => {
    const variant = original(photo.id);
    const value = input();
    const bytes = Buffer.from('synthetic video mapping fixture');
    database.prepare('UPDATE photos SET type=? WHERE id=?').run('video/mp4', photo.id);
    database
      .prepare('UPDATE size_variants SET short_path=?,filesize=? WHERE id=?')
      .run('original/video.mp4', bytes.length, variant.id);
    value.files[value.files.findIndex((f) => f.id === `variant:${variant.id}`)] = proof(
      `variant:${variant.id}`,
      'original/video.mp4',
      bytes,
    );
    expect(read(value).manifest.assets.find((p) => p.id === photo.id)).toMatchObject({
      type: 'VIDEO',
      originalFileNames: { [`variant:${variant.id}`]: 'video.mp4' },
    });
  });
  it('preserves both RAW and original variants while excluding generated and watermarked paths', () => {
    const variant = original(photo.id);
    const value = input();
    const bytes = Buffer.from('synthetic raw mapping fixture');
    insert('size_variants', {
      ...variant,
      id: 1000,
      type: 0,
      short_path: 'raw/photo.dng',
      filesize: bytes.length,
      short_path_watermarked: 'raw/watermarked.dng',
    });
    value.files.push(proof('variant:1000', 'raw/photo.dng', bytes));
    database
      .prepare('UPDATE size_variants SET short_path_watermarked=? WHERE id=?')
      .run('original/watermarked.png', variant.id);
    const asset = read(value).manifest.assets.find((p) => p.id === photo.id)!;
    expect(asset.fileIds).toEqual(expect.arrayContaining([`variant:${variant.id}`, 'variant:1000']));
    expect(asset).toHaveProperty('primaryFileId', `variant:${variant.id}`);
    expect(read(value).manifest.files.some((f) => f.path.includes('watermarked'))).toBe(false);
  });
  it('imports unvalidated photos as Locked for the owner to review', () => {
    database.prepare('UPDATE photos SET is_validated=0 WHERE id=?').run(photo.id);
    expect(read().manifest.assets.find((p) => p.id === photo.id)?.visibility).toBe('locked');
  });
  it('preserves empty album descriptions and archives cross-owner membership without exposing another album title', () => {
    const bob = content.rows.photos.find((p) => p.owner_id === 3)!;
    const album = content.rows.base_albums[0];
    database
      .prepare('UPDATE base_albums SET title=?,description=? WHERE id=?')
      .run('Private medical notes', '', album.id);
    insert('photo_album', { album_id: album.id, photo_id: bob.id, bucket_key: null });
    const { manifest, archive } = read();
    expect(manifest.albums.find((a) => a.id === album.id)).toMatchObject({
      ownerId: '2',
      name: 'Private medical notes',
      description: '',
      assetIds: [photo.id],
    });
    expect(manifest.albums.filter((a) => a.ownerId === '3').some((a) => a.name === 'Private medical notes')).toBe(
      false,
    );
    expect(
      archive.some((r) => r.table === 'photo_album' && r.value.photo_id === bob.id && r.value.album_id === album.id),
    ).toBe(true);
    expect(manifest.losses).toContainEqual({
      code: 'LYCHEE_CROSS_OWNER_MEMBERSHIP_ARCHIVED',
      entityId: album.id,
      acknowledged: false,
    });
  });
  const livePhoto = () => {
    const contentId = 'synthetic-live-photo-id';
    const value = input();
    database
      .prepare('UPDATE photos SET live_photo_short_path=?,live_photo_content_id=?,live_photo_checksum=? WHERE id=?')
      .run('original/pair.mov', contentId, 'source-sha1-is-not-independent-proof', photo.id);
    value.files.find((f) => f.id === `variant:${original(photo.id).id}`)!.contentId = contentId;
    value.files.push(
      proof(
        `companion:${photo.id}`,
        'original/pair.mov',
        Buffer.from('synthetic motion mapping fixture'),
        'companion',
        contentId,
      ),
    );
    return value;
  };
  it('reconstructs an explicitly identified Live Photo with an independently verified hidden video original', () => {
    const value = livePhoto();
    const { manifest, archive } = read(value);
    expect(manifest.assets).toHaveLength(5);
    expect(manifest).toHaveProperty('livePhotos', [{ photoAssetId: photo.id, videoAssetId: `motion:${photo.id}` }]);
    expect(manifest.assets.find((a) => a.id === `motion:${photo.id}`)).toMatchObject({
      ownerId: '2',
      type: 'VIDEO',
      visibility: 'hidden',
      primaryFileId: `companion:${photo.id}`,
      fileIds: [`companion:${photo.id}`],
    });
    expect(manifest.files.find((f) => f.id === `companion:${photo.id}`)?.role).toBe('original');
    expect(manifest.albums.every((a) => !a.assetIds.includes(`motion:${photo.id}`))).toBe(true);
    expect(
      archive.some(
        (r) => r.table === 'frameleaf_live_photo_verification' && r.value.content_id === 'synthetic-live-photo-id',
      ),
    ).toBe(true);
  });
  it.each(['source', 'original', 'companion'])(
    'refuses missing or mismatched %s content identity for a Live Photo',
    (field) => {
      const value = livePhoto();
      if (field === 'source') database.prepare('UPDATE photos SET live_photo_content_id=NULL WHERE id=?').run(photo.id);
      else
        value.files.find(
          (f) => f.id === (field === 'original' ? `variant:${original(photo.id).id}` : `companion:${photo.id}`),
        )!.contentId = 'different-id';
      expect(() => read(value)).toThrow('LYCHEE_LIVE_PHOTO_IDENTITY_REQUIRED');
    },
  );
  it('requires explicit membership snapshots for dynamic albums and labels the resulting owner-only snapshot', () => {
    const dynamic = 'synthetic-tag-album';
    insert('base_albums', { ...content.rows.base_albums[0], id: dynamic, title: 'Summer' });
    insert('tag_albums', { id: dynamic, is_and: 1, cover_id: null });
    expect(() => read()).toThrow('LYCHEE_ALBUM_SNAPSHOT_REQUIRED');
    const value = input();
    value.materializedAlbums[dynamic] = [photo.id];
    expect(read(value).manifest.albums.find((a) => a.id === dynamic)).toMatchObject({
      name: 'Summer (snapshot)',
      assetIds: [photo.id],
      members: [],
    });
  });
  it('refuses contradictory tag/person album types instead of choosing one silently', () => {
    const id = 'ConflictingDynamicAlbum01';
    insert('base_albums', { ...content.rows.base_albums[0], id });
    insert('tag_albums', { id, is_and: 1, cover_id: null });
    insert('person_albums', { id, is_and: 0 });
    const value = input();
    value.materializedAlbums[id] = [photo.id];
    expect(() => read(value)).toThrow('LYCHEE_ALBUM_TYPE_UNQUALIFIED');
  });
  it('prepares every mapped original and companion with the existing canonical writer', () => {
    const { manifest } = read(livePhoto());
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
    expect(prepared).toHaveLength(5);
    expect(prepared.reduce((count, asset) => count + asset.files.length, 0)).toBe(5);
    expect(query).not.toHaveBeenCalled();
  });
  it.each(['missing', 'extra', 'path', 'size', 'hash', 'remote', 'no-original'])(
    'refuses %s original evidence',
    (kind) => {
      const value = input();
      switch (kind) {
        case 'missing': {
          value.files.pop();
          break;
        }
        case 'no-original': {
          database.prepare('DELETE FROM size_variants WHERE id=?').run(original(photo.id).id);
          break;
        }
        case 'extra': {
          value.files.push({ ...value.files[0], id: 'preview:1', path: 'preview/image.jpg' });
          break;
        }
        case 'path': {
          value.files[0].path = 'preview/image.jpg';
          break;
        }
        case 'size': {
          value.files[0].bytes = '1';
          break;
        }
        case 'hash': {
          value.files[0].sha256 = 'source-checksum';
          break;
        }
        case 'remote': {
          database
            .prepare('UPDATE size_variants SET storage_disk=? WHERE id=?')
            .run('s3', original(content.originals[0].photoId).id);
          break;
        }
      }
      expect(() => read(value)).toThrow(/LYCHEE_/);
    },
  );
  it.each([
    'schema',
    'revision',
    'writers',
    'owner',
    'timezone',
    'timezone-invalid',
    'date',
    'gps',
    'album-cycle',
    'stale-snapshot',
  ])('refuses unqualified %s state before destination effects', (kind) => {
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
      case 'owner': {
        database.prepare('UPDATE photos SET owner_id=999 WHERE id=?').run(photo.id);
        break;
      }
      case 'album-cycle': {
        database.prepare('UPDATE albums SET parent_id=id WHERE id=?').run(content.rows.albums[0].id);
        break;
      }
      case 'stale-snapshot': {
        value.materializedAlbums.unknown = [photo.id];
        break;
      }
      case 'timezone-invalid': {
        database
          .prepare('UPDATE photos SET taken_at=?,taken_at_orig_tz=? WHERE id=?')
          .run('2020-06-10 18:30:00.000000', 'Mars/Olympus', photo.id);
        break;
      }
      case 'timezone': {
        database
          .prepare('UPDATE photos SET taken_at=?,taken_at_orig_tz=NULL WHERE id=?')
          .run('2020-06-10 18:30:00.000000', photo.id);
        break;
      }
      case 'date': {
        database.prepare('UPDATE photos SET taken_at=?,taken_at_orig_tz=? WHERE id=?').run('invalid', 'UTC', photo.id);
        break;
      }
      case 'gps': {
        database.prepare('UPDATE photos SET latitude=45,longitude=NULL WHERE id=?').run(photo.id);
        break;
      }
    }
    expect(() => read(value)).toThrow(/LYCHEE_/);
  });
});
