import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { Readable } from 'node:stream';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceArchiveRecord } from 'src/library-import/source-archive-codec.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import content from 'src/library-import/fixtures/librephotos/1.5.1-content.json' with { type: 'json' };
import originals from 'src/library-import/fixtures/librephotos/1.5.1-files.json' with { type: 'json' };
import pgContent from 'src/library-import/fixtures/librephotos/1.5.1-postgres-content.json' with { type: 'json' };
import pgSchema from 'src/library-import/fixtures/librephotos/1.5.1-postgres18.json' with { type: 'json' };
import sqliteSchema from 'src/library-import/fixtures/librephotos/1.5.1-sqlite.json' with { type: 'json' };
import planFixture from 'src/library-import/fixtures/manager-plan-v2.json' with { type: 'json' };
import { createLibrephotosPostgresDecoder } from 'src/library-import/librephotos-postgres.js';
import * as librephotos from 'src/library-import/librephotos.js';
import { type ImportManifest, manifestFingerprint } from 'src/library-import/manifest.js';

const photoId = (name: keyof typeof content.expected.photos) => content.expected.photos[name].replaceAll('-', '');
type Snapshot = {
  version: string;
  schemaSha256: string;
  rows: (
    table: librephotos.LibrephotosTable,
  ) => Iterable<librephotos.LibrephotosRow[]> | AsyncIterable<librephotos.LibrephotosRow[]>;
};
type Result = { manifest: ImportManifest; archive: SourceArchiveRecord[] };
const read = async (snapshot: Snapshot, input: unknown): Promise<Result> => {
  const adapter = Reflect.get(librephotos, 'readLibrephotosManifest') as
    ((snapshot: Snapshot, input: unknown) => Promise<Result>) | undefined;
  expect(adapter).toBeTypeOf('function');
  if (!adapter) throw new Error('LibrePhotos manifest adapter missing');
  return adapter(snapshot, input);
};
const input = () => ({
  source: {
    kind: 'librephotos',
    version: sqliteSchema.source.version,
    identity: 'synthetic-library',
    revision: 'snapshot-1',
    schemaSha256: sqliteSchema.schemaSha256,
  },
  inventory: {
    complete: true,
    ownershipComplete: true,
    privacyComplete: true,
    writersStopped: true,
    revisionBefore: 'snapshot-1',
    revisionAfter: 'snapshot-1',
  },
  sourceRoot: '/originals',
  reviewedCaptureOffsets: { [photoId('bob')]: -420 } as Record<string, number>,
  files: [
    ...originals.files.map((entry) => ({ id: `file:${entry.source.hash}`, entry })),
    ...originals.copies.map((entry) => ({ id: `copy:${entry.source.id}`, entry })),
  ].map(({ id, entry }) => {
    const bytes = Buffer.from(entry.originalBase64, 'base64');
    expect(String(bytes.length)).toBe(entry.expected.bytes);
    expect(createHash('sha256').update(bytes).digest('hex')).toBe(entry.expected.sha256);
    return {
      id,
      ...entry.expected,
      role: 'original',
      modifiedAt: '2020-06-11T00:00:00.123456Z',
    };
  }),
});

describe('LibrePhotos common manifest mapping', () => {
  let directory: string;
  let path: string;
  let database: DatabaseSync;
  const opened: ReturnType<typeof librephotos.openLibrephotosSnapshot>[] = [];
  const snapshot = () => {
    const source = librephotos.openLibrephotosSnapshot(path, sqliteSchema.source.version);
    opened.push(source);
    return source;
  };
  beforeEach(async () => {
    directory = await mkdtemp(join(tmpdir(), 'frameleaf-librephotos-manifest-'));
    path = join(directory, 'source.sqlite');
    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=OFF');
    for (const type of ['table', 'index', 'trigger', 'view']) {
      for (const object of sqliteSchema.objects) {
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
      }
    }
    for (const migration of sqliteSchema.migrations)
      database
        .prepare('INSERT INTO django_migrations(app,name,applied) VALUES(?,?,?)')
        .run(migration.app, migration.name, '2026-11-01 00:00:00');
    for (const [table, captured] of Object.entries(content.rows)) {
      const columns = database.prepare(`PRAGMA table_info("${table}")`).all();
      for (const value of captured) {
        const row: Record<string, SQLInputValue> = { ...value };
        if (table === 'api_user')
          Object.assign(row, {
            llm_settings: '{}',
            burst_detection_rules: '[]',
            default_timeline_filter: '{}',
            excluded_folders: '[]',
          });
        for (const column of columns) {
          const name = String(column.name);
          if (column.notnull && !Object.hasOwn(row, name))
            row[name] = String(column.type).includes('BLOB')
              ? new Uint8Array()
              : /int|bool|real/i.test(String(column.type))
                ? 0
                : '';
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
    for (const source of opened.splice(0)) source.close();
    database.close();
    await rm(directory, { recursive: true, force: true });
  });

  it('maps independently captured owners, originals, aliases and edited metadata through the admitted reader', async () => {
    const { manifest, archive } = await read(snapshot(), input());
    expect(manifest.version).toBe(4);
    expect(manifest.users).toHaveLength(4);
    expect(manifest.assets).toHaveLength(5);
    expect(manifest.files).toHaveLength(5);
    const alice = manifest.assets.find((photo) => photo.id === photoId('alice'))!;
    const bob = manifest.assets.find((photo) => photo.id === photoId('bob'))!;
    expect(alice.ownerId).toBe('1');
    expect(bob.ownerId).toBe('2');
    expect(alice.fileIds).toHaveLength(2);
    expect(bob.fileIds).toHaveLength(1);
    expect(alice.fileIds).toEqual(expect.arrayContaining(bob.fileIds));
    expect(alice.metadata).toMatchObject({
      description: content.expected.sourceApi.ownerCaption,
      rating: 4,
      tags: ['family', 'summer'],
      takenAt: '2020-06-10T18:30:00Z',
    });
    expect(alice.metadata).not.toHaveProperty('title');
    expect(alice).toMatchObject({ localDateTime: '2020-06-10T12:30:00', fileModifiedAt: input().files[0].modifiedAt });
    expect(bob).toMatchObject({ localDateTime: '2021-02-04T08:09:10', metadata: { takenAt: '2021-02-04T15:09:10Z' } });
    expect(bob.metadata.timeZone).toBeUndefined();
    expect(archive).toContainEqual(
      expect.objectContaining({
        table: 'api_photometadata',
        value: expect.objectContaining({ title: content.expected.sourceApi.ownerTitle }),
      }),
    );
    expect(archive).toContainEqual({
      table: 'frameleaf_capture_offset_review',
      value: { photo_id: photoId('bob'), offset_minutes: -420n },
    });
    expect(archive.some((record) => Object.hasOwn(record.value, 'password'))).toBe(false);
  });

  it('keeps restricted collaboration owner-only without dropping the source album memberships', async () => {
    const { manifest, archive } = await read(snapshot(), input());
    expect(manifest.albums).toEqual([
      {
        id: 'album:1',
        ownerId: '1',
        name: content.rows.api_albumuser[0].title,
        assetIds: [photoId('alice')],
        members: [],
      },
      {
        id: 'album:1:owner:2',
        ownerId: '2',
        name: content.rows.api_albumuser[0].title,
        assetIds: [photoId('bob')],
        members: [],
      },
    ]);
    for (const album of manifest.albums) {
      expect(album.members).toEqual([]);
      expect(
        album.assetIds.every((id) => manifest.assets.find((photo) => photo.id === id)?.ownerId === album.ownerId),
      ).toBe(true);
    }
    expect(archive.filter((record) => record.table === 'api_albumuser_photos')).toHaveLength(2);
    expect(manifest.losses).toEqual(
      expect.arrayContaining([
        { code: 'LIBREPHOTOS_SHARING_RESTRICTED', acknowledged: false },
        { code: 'LIBREPHOTOS_ALBUM_PARTITIONED', entityId: '1', acknowledged: false },
      ]),
    );
  });

  it('keeps duplicate-path scan bookkeeping private instead of creating new visible originals', async () => {
    const { manifest, archive } = await read(snapshot(), input());
    expect(manifest.files).toHaveLength(5);
    expect(manifest.assets.find((asset) => asset.id === photoId('alice'))?.fileIds).toHaveLength(2);
    expect(manifest.assets.find((asset) => asset.id === photoId('bob'))?.fileIds).toHaveLength(1);
    expect(manifest.files.some((file) => file.id.startsWith('copy:'))).toBe(false);
    expect(archive.filter((record) => record.table === 'api_filecopy')).toHaveLength(1);
    expect(archive).toContainEqual({
      table: 'frameleaf_file_copy_verification',
      value: {
        copy_id: 1n,
        file_id: originals.copies[0].source.file_id,
        path: originals.copies[0].expected.path,
        sha256: originals.copies[0].expected.sha256,
        bytes: originals.copies[0].expected.bytes,
        modified_at: input().files[0].modifiedAt,
      },
    });
    expect(manifest.losses).toContainEqual({ code: 'LIBREPHOTOS_DUPLICATE_PATHS_ARCHIVED', acknowledged: false });
  });

  it('does not disclose a private album title to another photo owner who is not a member', async () => {
    database.prepare('DELETE FROM api_albumuser_shared_to WHERE user_id=2').run();
    database.prepare("UPDATE api_albumuser SET title='Private medical notes'").run();
    const { manifest, archive } = await read(snapshot(), input());
    expect(manifest.albums.filter((album) => album.ownerId === '2')).toEqual([]);
    expect(manifest.albums[0]).toMatchObject({ ownerId: '1', name: 'Private medical notes' });
    expect(archive.filter((record) => record.table === 'api_albumuser_photos')).toHaveLength(2);
    expect(manifest.losses).toContainEqual({
      code: 'LIBREPHOTOS_PRIVATE_ALBUM_MEMBERSHIP_ARCHIVED',
      entityId: '1',
      acknowledged: false,
    });
  });

  it('prepares every mapped owner and original through the canonical importer without destination effects', async () => {
    const { manifest } = await read(snapshot(), input());
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
    expect(prepared.reduce((count, asset) => count + asset.files.length, 0)).toBe(6);
    expect(query).not.toHaveBeenCalled();
  });

  it('imports hidden as Locked and preserves archive, trash and explicitly removed location state', async () => {
    database.prepare('UPDATE api_photo SET exif_gps_lat=NULL,exif_gps_lon=NULL WHERE id=?').run(photoId('alice'));
    const { manifest } = await read(snapshot(), input());
    for (const [name, visibility] of [
      ['hidden', 'locked'],
      ['archived', 'archive'],
      ['trash', 'trash'],
    ] as const)
      expect(manifest.assets.find((photo) => photo.id === photoId(name))?.visibility).toBe(visibility);
    expect(manifest.assets.find((photo) => photo.id === photoId('alice'))?.metadata).toMatchObject({
      latitude: null,
      longitude: null,
    });
    expect(manifest.assets.find((photo) => photo.id === photoId('trash'))?.metadata.deletedAt).toBe(
      '2026-11-01T19:20:53.620027Z',
    );
    expect(manifest.assets.find((photo) => photo.id === photoId('trash'))?.locked).toBeUndefined();
  });

  it('imports a hidden photo in Trash both trashed and Locked (FL-1230)', async () => {
    database.prepare('UPDATE api_photo SET hidden=1 WHERE id=?').run(photoId('trash'));
    const { manifest } = await read(snapshot(), input());
    expect(manifest.assets.find((photo) => photo.id === photoId('trash'))).toMatchObject({
      visibility: 'trash',
      locked: true,
      metadata: { deletedAt: '2026-11-01T19:20:53.620027Z' },
    });
  });

  it('preserves safe stack membership and archives incompatible visibility without changing it', async () => {
    const initial = await read(snapshot(), input());
    expect(initial.manifest).toHaveProperty('stacks', []);
    expect(initial.manifest.losses).toContainEqual({
      code: 'LIBREPHOTOS_STACK_ARCHIVED',
      entityId: content.rows.api_photostack[0].id,
      acknowledged: false,
    });
    for (const source of opened.splice(0)) source.close();
    database.prepare('UPDATE api_photo SET archived=0 WHERE id=?').run(photoId('archived'));
    const result = await read(snapshot(), input());
    expect(result.manifest).toHaveProperty('stacks', [
      {
        id: content.rows.api_photostack[0].id,
        ownerId: '1',
        primaryAssetId: photoId('alice'),
        assetIds: [photoId('alice'), photoId('archived')],
      },
    ]);
  });

  it('maps the actual PostgreSQL text fixture through the qualified decoder and async pages', async () => {
    const decoder = createLibrephotosPostgresDecoder(
      pgSchema.structure,
      pgSchema.source.version,
      pgSchema.source.database.version,
    );
    const rows = new Map(
      Object.entries(pgContent.rows).map(([table, values]) => [
        table,
        values.map((value) =>
          decoder.decode(table as librephotos.LibrephotosTable, value as Record<string, string | null>),
        ),
      ]),
    );
    const source: Snapshot = {
      version: pgSchema.source.version,
      schemaSha256: pgSchema.schemaSha256,
      rows: (table) => Readable.from([rows.get(table) ?? []]),
    };
    const options = input();
    options.source.schemaSha256 = pgSchema.schemaSha256;
    const result = await read(source, options);
    expect(result.manifest.assets).toHaveLength(5);
    expect(result.manifest.assets.find((photo) => photo.id === photoId('alice'))?.metadata.description).toBe(
      content.expected.sourceApi.ownerCaption,
    );
    expect(result.manifest.assets.find((photo) => photo.id === photoId('bob'))).toHaveProperty(
      'localDateTime',
      '2021-02-04T08:09:10',
    );
  });

  it('reports source-absent dates using verified file time without overriding a manual date', async () => {
    database
      .prepare('UPDATE api_photo SET timestamp=NULL,exif_timestamp=NULL,exif_timestamp_offset=NULL WHERE id=?')
      .run(photoId('alice'));
    const { manifest } = await read(snapshot(), input());
    expect(manifest.assets.find((photo) => photo.id === photoId('alice'))?.metadata).toMatchObject({
      takenAt: input().files[0].modifiedAt,
      timeZone: 'UTC',
    });
    expect(manifest.losses).toContainEqual({
      code: 'LIBREPHOTOS_CAPTURE_TIME_FALLBACK',
      entityId: photoId('alice'),
      acknowledged: false,
    });
    expect(manifest.assets.find((photo) => photo.id === photoId('bob'))).toHaveProperty(
      'localDateTime',
      '2021-02-04T08:09:10',
    );
  });

  it.each([
    'offset-missing',
    'offset-extra',
    'offset-invalid',
    'missing-proof',
    'extra-proof',
    'wrong-path',
    'wrong-alias-bytes',
    'orphan-file',
    'missing-primary',
    'companion',
    'changed-schema',
    'unknown-member-role',
  ])('refuses incomplete or conflicting capture evidence: %s', async (failure) => {
    const options = input();
    switch (failure) {
      case 'offset-missing': {
        options.reviewedCaptureOffsets = {};
        break;
      }
      case 'offset-extra': {
        options.reviewedCaptureOffsets[photoId('alice')] = -360;
        break;
      }
      case 'offset-invalid': {
        options.reviewedCaptureOffsets[photoId('bob')] = 841;
        break;
      }
      case 'missing-proof': {
        options.files.pop();
        break;
      }
      case 'extra-proof': {
        options.files.push({ ...options.files[0], id: 'extra' });
        break;
      }
      case 'wrong-path': {
        options.files[0].path = 'wrong.png';
        break;
      }
      case 'wrong-alias-bytes': {
        options.files.find((file) => file.id === 'copy:1')!.sha256 = 'a'.repeat(64);
        break;
      }
      case 'orphan-file': {
        database.prepare('DELETE FROM api_photo_files WHERE file_id=?').run(originals.files[1].source.hash);
        break;
      }
      case 'missing-primary': {
        database.prepare('UPDATE api_photo SET main_file_id=NULL WHERE id=?').run(photoId('alice'));
        break;
      }
      case 'companion': {
        database
          .prepare('INSERT INTO api_file_embedded_media(from_file_id,to_file_id) VALUES(?,?)')
          .run(originals.files[0].source.hash, originals.files[1].source.hash);
        break;
      }
      case 'changed-schema': {
        options.source.schemaSha256 = 'a'.repeat(64);
        break;
      }
      case 'unknown-member-role': {
        database.prepare("UPDATE api_albumuser_shared_to SET role='unknown'").run();
        break;
      }
    }
    await expect(read(snapshot(), options)).rejects.toThrow(/LIBREPHOTOS_/);
  });
});
