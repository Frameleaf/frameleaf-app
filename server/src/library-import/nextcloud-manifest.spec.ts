import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest';
import type { SourceArchiveRecord } from 'src/library-import/source-archive-codec.js';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import planFixture from 'src/library-import/fixtures/manager-plan-v2.json' with { type: 'json' };
import content from 'src/library-import/fixtures/nextcloud/35-8-10.2-content.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/nextcloud/35-8-10.2-sqlite.json' with { type: 'json' };
import { type ImportManifest, manifestFingerprint, parseImportManifest } from 'src/library-import/manifest.js';
import * as nextcloud from 'src/library-import/nextcloud.js';

type Result = { manifest: ImportManifest; archive: SourceArchiveRecord[] };
const originals = [9, 12, 66, 67, 68, 69, 71, 72, 73, 74, 95, 96, 97, 98, 100];
const input = () => ({
  source: {
    kind: 'nextcloud' as const,
    version: fixture.source.version,
    identity: 'synthetic-nextcloud',
    revision: 'frozen-1',
    schemaSha256: fixture.schemaSha256,
  },
  inventory: {
    complete: true,
    ownershipComplete: true,
    privacyComplete: true,
    writersStopped: true,
    revisionBefore: 'frozen-1',
    revisionAfter: 'frozen-1',
  },
  metadataView: 'memories' as 'photos' | 'memories',
  storageRoots: { '2': 'storage-2', '3': 'storage-3', '4': 'storage-4', '5': 'storage-5' },
  files: content.rows.oc_filecache
    .filter((row) => originals.includes(row.fileid))
    .map((row) => {
      const native = content.native.files.find((file) => file.id === String(row.fileid));
      return {
        id: 'file:' + row.fileid,
        path: 'storage-' + row.storage + '/' + row.path,
        bytes: String(row.size),
        // Stock-file receipts are synthetic; only the five generated originals have native byte proofs.
        sha256:
          native?.sha256 ??
          createHash('sha256')
            .update('synthetic-stock:' + row.fileid)
            .digest('hex'),
        role: 'original' as const,
        modifiedAt: new Date(row.mtime * 1000).toISOString(),
      };
    }),
});

describe('Nextcloud Photos / Memories common manifest mapping', () => {
  let root: string;
  let path: string;
  let database: DatabaseSync;
  const read = (value = input()): Result => {
    const snapshot = nextcloud.openNextcloudSnapshot(path, fixture.source.version);
    try {
      const adapter = Reflect.get(nextcloud, 'readNextcloudManifest') as
        ((source: typeof snapshot, value: unknown) => Result) | undefined;
      expect(adapter).toBeTypeOf('function');
      if (!adapter) throw new Error('Nextcloud manifest adapter missing');
      return adapter(snapshot, value);
    } finally {
      snapshot.close();
    }
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-nextcloud-manifest-'));
    path = join(root, 'source.sqlite');
    database = new DatabaseSync(path);
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
        const columns = Object.keys(row);
        database
          .prepare(
            'INSERT INTO "' +
              table +
              '" (' +
              columns.map((column) => '"' + column + '"').join(',') +
              ') VALUES (' +
              columns.map(() => '?').join(',') +
              ')',
          )
          .run(...Object.values(row));
      }
    database.exec('COMMIT');
  });
  afterEach(async () => {
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it('requires all 15 home originals and keeps storage owners separate from file-cache host paths', () => {
    const value = input();
    const { manifest, archive } = read(value);
    expect(manifest.assets.map((asset) => asset.id).sort()).toEqual(originals.map(String).sort());
    expect(manifest.files).toEqual(value.files.map(({ modifiedAt: _modifiedAt, ...file }) => file));
    expect(manifest.users.map((user) => user.id)).toEqual(['fixture-admin', 'alice', 'bob', 'mallory']);
    for (const native of content.native.files)
      expect(manifest.assets.find((asset) => asset.id === native.id)).toMatchObject({
        ownerId: native.owner,
        fileIds: ['file:' + native.id],
      });
    expect(archive.length).toBeGreaterThan(100);
    const encoded = JSON.stringify(archive, (_key, value) => (typeof value === 'bigint' ? String(value) : value));
    for (const secret of ['excluded-user-password-hash', 'excluded-sync-cursor', 'excluded-public-link-token'])
      expect(encoded).not.toContain(secret);
  });

  it('selects the owner home mount when the same storage also has a shared mount', () => {
    database.exec(
      String.raw`INSERT INTO oc_mounts(id,storage_id,root_id,user_id,mount_point,mount_id,mount_provider_class,mount_point_hash) VALUES(99,3,94,'bob','/bob/files/Shared/',1,'OC\Files\Mount\SharedMountProvider','synthetic-shared-mount')`,
    );
    expect(read().manifest.assets.find((asset) => asset.id === '95')).toMatchObject({ ownerId: 'alice' });
  });

  it('does not treat the five native hash receipts as complete coverage of the stock library', () => {
    const value = input();
    value.files = value.files.filter((file) => content.native.files.some((native) => file.id === 'file:' + native.id));
    expect(() => read(value)).toThrow('NEXTCLOUD_FILE_EVIDENCE_MISMATCH');
  });

  it.each([
    ['photos', '95'],
    ['memories', '95'],
    ['memories', '9'],
  ] as const)(
    'prepares an individual %s-view asset %s through the canonical writer, including unknown-clock fallbacks',
    (view, id) => {
      const value = input();
      value.metadataView = view;
      const mapped = read(value).manifest;
      if (mapped.version !== 5) throw new Error('Live Photo manifest required');
      const asset = mapped.assets.find((asset) => asset.id === id)!;
      // Isolate preparation from the separate whole-library duplicate-byte review required by the native fixture.
      const manifest = parseImportManifest({
        ...mapped,
        assets: [asset],
        files: mapped.files.filter((file) => asset.fileIds.includes(file.id)),
        albums: [],
      });
      const template = planFixture.plan.files[0];
      const plan = parseDestinationImportPlan({
        ...planFixture.plan,
        source: manifest.source,
        owners: manifest.users.map((user) => ({ sourceId: user.id, destinationId: randomUUID() })),
        files: manifest.files.map((file) => ({
          ...template,
          id: 'placement:' + id,
          sourceAssetId: id,
          sourceFileId: file.id,
          sourcePath: file.path,
          destinationPath: asset.ownerId + '/' + id + '/' + file.path,
          bytes: file.bytes,
          sha256: file.sha256,
          sourceIdentity: { ...template.sourceIdentity, bytes: file.bytes },
        })),
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
      expect(
        writer.prepare({
          sourceAssetId: id,
          type: asset.type,
          fileModifiedAt: asset.fileModifiedAt,
          originalFileNames: asset.originalFileNames,
        }),
      ).toBeDefined();
      expect(query).not.toHaveBeenCalled();
    },
  );

  it.each(['path', 'bytes', 'modifiedAt'] as const)('refuses mismatched original %s evidence', (field) => {
    const value = input();
    value.files[0][field] = field === 'path' ? 'storage-3/files/Nextcloud.png' : field === 'bytes' ? '1' : 'invalid';
    expect(() => read(value)).toThrow('NEXTCLOUD_FILE_EVIDENCE_MISMATCH');
  });

  it.each([
    'UPDATE oc_filecache SET encrypted=1 WHERE fileid=95',
    "UPDATE oc_storages SET id='object::remote' WHERE numeric_id=3",
    "UPDATE oc_mounts SET user_id='bob' WHERE storage_id=3",
    "UPDATE oc_filecache SET path='files/../outside.jpg' WHERE fileid=95",
  ])('requires a qualified decrypted/storage export for unsafe original resolution: %s', (statement) => {
    database.exec(statement);
    expect(() => read()).toThrow('NEXTCLOUD_ORIGINAL_INVALID');
  });

  it('preserves manual Memories metadata, exact local clocks and capture instants', () => {
    const exif = { Description: 'Edited caption', Rating: 4, GPSLatitude: 42.5, GPSLongitude: -73.5 };
    database
      .prepare('UPDATE oc_memories SET epoch=?,datetaken=?,lat=?,lon=?,exif=? WHERE fileid=95')
      .run(1_591_813_800, '2020-06-10 12:30:00', 42.5, -73.5, JSON.stringify(exif));
    const asset = read().manifest.assets.find((asset) => asset.id === '95');
    expect(asset).toMatchObject({
      localDateTime: '2020-06-10T12:30:00',
      metadata: {
        takenAt: '2020-06-10T18:30:00.000Z',
        description: 'Edited caption',
        rating: 4,
        latitude: 42.5,
        longitude: -73.5,
      },
    });
    expect(asset!.metadata.timeZone).toBeUndefined();
  });

  it('preserves the selected Photos edit and cleared GPS ahead of stale embedded or Memories values', () => {
    const value = input();
    value.metadataView = 'photos';
    database.prepare('UPDATE oc_files_metadata SET json=? WHERE file_id=95').run(
      JSON.stringify({
        'photos-original_date_time': { value: 1_591_792_200, type: 'int', editPermission: 0 },
      }),
    );
    database.exec('UPDATE oc_memories SET lat=42.5,lon=-73.5 WHERE fileid=95');
    expect(read(value).manifest.assets.find((asset) => asset.id === '95')).toMatchObject({
      metadata: { takenAt: '2020-06-10T12:30:00.000Z', latitude: null, longitude: null },
    });
  });

  it('refuses stale selected Memories metadata rather than applying it over a newer original', () => {
    database.exec('UPDATE oc_memories SET mtime=mtime-1 WHERE fileid=95');
    expect(() => read()).toThrow('NEXTCLOUD_METADATA_STALE');
  });

  it('maps owner-private legacy tags and favourites without importing another reader’s preferences', () => {
    database.exec(
      "INSERT INTO oc_vcategory(id,uid,type,category) VALUES(1,'alice','files','_$!<Favorite>!$_'),(2,'bob','files','Bob private label'),(3,'alice','files','Family')",
    );
    database.exec(
      "INSERT INTO oc_vcategory_to_object(objid,categoryid,type) VALUES(95,1,'files'),(95,2,'files'),(95,3,'files')",
    );
    const { manifest } = read();
    expect(manifest.assets.find((asset) => asset.id === '95')!.metadata).toMatchObject({
      favorite: true,
      tags: ['Family'],
    });
    expect(manifest.assets.find((asset) => asset.id === '100')!.metadata.favorite).toBe(false);
    expect(JSON.stringify(manifest)).not.toContain('Bob private label');
  });

  it('requires smart-album materialization instead of treating its stored rows as complete membership', () => {
    database.prepare('UPDATE oc_photos_albums SET filters=? WHERE album_id=1').run(JSON.stringify({ favorite: true }));
    expect(() => read()).toThrow('NEXTCLOUD_SMART_ALBUM_REVIEW_REQUIRED');
  });

  it('refuses unsupported application evidence', () => {
    const value = input();
    value.source.version = 'unknown';
    expect(() => read(value)).toThrow('NEXTCLOUD_VERSION_UNQUALIFIED');
  });

  it('keeps albums private and never guesses Live Photo identities from matching names', () => {
    const { manifest } = read();
    expect(
      manifest.albums.map((album) => ({
        name: album.name,
        owner: album.ownerId,
        ids: album.assetIds,
        members: album.members,
      })),
    ).toEqual(
      ['Private', 'Family', 'Direct', 'Public'].map((name) => ({ name, owner: 'alice', ids: ['95'], members: [] })),
    );
    expect(manifest.losses).toContainEqual({ code: 'NEXTCLOUD_SHARING_RESTRICTED', acknowledged: false });
    expect(manifest).toMatchObject({ version: 5, livePhotos: [], stacks: [] });
  });

  it.each(['privacyComplete', 'ownershipComplete', 'writersStopped'] as const)(
    'refuses incomplete %s evidence',
    (field) => {
      const value = input();
      value.inventory[field] = false;
      expect(() => read(value)).toThrow('NEXTCLOUD_CAPTURE_INCOMPLETE');
    },
  );

  it('refuses changed capture revisions', () => {
    const value = input();
    value.inventory.revisionAfter = 'changed';
    expect(() => read(value)).toThrow('NEXTCLOUD_CAPTURE_INCOMPLETE');
  });
});
