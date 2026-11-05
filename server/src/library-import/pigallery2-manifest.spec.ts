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
import content from 'src/library-import/fixtures/pigallery2/3.5.2-content.json' with { type: 'json' };
import enriched from 'src/library-import/fixtures/pigallery2/3.5.2-metadata.json' with { type: 'json' };
import fixture from 'src/library-import/fixtures/pigallery2/3.5.2-sqlite.json' with { type: 'json' };
import { type ImportManifest, manifestFingerprint } from 'src/library-import/manifest.js';
import * as pigallery2 from 'src/library-import/pigallery2.js';

type Result = { manifest: ImportManifest; archive: SourceArchiveRecord[] };
const rows = { ...content.rows, ...enriched.rows };
const digest = (value: Uint8Array) => createHash('sha256').update(value).digest('hex');
const directoryPath = (id: number) => {
  const row = rows.directory_entity.find((directory) => directory.id === id)!;
  return (row.path === './' ? '' : row.path) + (row.name === '.' ? '' : row.name + '/');
};
const input = () => ({
  source: {
    kind: 'pigallery2' as const,
    version: '3.5.2',
    identity: 'synthetic',
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
  owners: Object.fromEntries(rows.media_entity.map((media) => [String(media.id), '1'])),
  grants: Object.fromEntries(
    rows.user_entity.map((user) => [
      String(user.id),
      user.id === 1 ? rows.media_entity.map((media) => String(media.id)) : ([] as string[]),
    ]),
  ),
  materializedAlbums: { '1': { ownerId: '1', mediaIds: ['1', '4'] } } as Record<
    string,
    { ownerId: string; mediaIds: string[] }
  >,
  files: rows.media_entity.map((media) => {
    const bytes = Buffer.alloc(media.metadataFilesize, media.id);
    return {
      id: 'media_entity:' + media.id,
      path: directoryPath(media.directoryId) + media.name,
      bytes: String(bytes.length),
      sha256: digest(bytes),
      role: 'original' as const,
      modifiedAt: '2020-01-01T00:00:00Z',
    };
  }),
  archivedFiles: enriched.files
    .filter((file) => rows.media_entity.every((media) => directoryPath(media.directoryId) + media.name !== file.path))
    .map((file) => {
      const bytes = Buffer.alloc(Number(file.bytes), 65);
      return { path: file.path, bytes: String(bytes.length), sha256: digest(bytes), content: new Uint8Array(bytes) };
    }),
});

describe('PiGallery2 common manifest mapping', () => {
  let root: string;
  let path: string;
  let database: DatabaseSync;
  const opened: ReturnType<typeof pigallery2.openPigallery2Snapshot>[] = [];
  const read = (value = input()): Result => {
    const snapshot = pigallery2.openPigallery2Snapshot(path, '3.5.2');
    opened.push(snapshot);
    const adapter = Reflect.get(pigallery2, 'readPigallery2Manifest') as
      ((source: typeof snapshot, value: unknown) => Result) | undefined;
    expect(adapter).toBeTypeOf('function');
    if (!adapter) throw new Error('PiGallery2 manifest adapter missing');
    return adapter(snapshot, value);
  };
  beforeEach(async () => {
    root = await mkdtemp(join(tmpdir(), 'frameleaf-pigallery2-manifest-'));
    path = join(root, 'source.sqlite');
    database = new DatabaseSync(path);
    database.exec('PRAGMA foreign_keys=OFF; BEGIN');
    for (const type of ['table', 'index', 'trigger', 'view'])
      for (const object of fixture.structure.objects)
        if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) database.exec(object.sql);
    for (const [table, records] of Object.entries({ ...rows, version_entity: fixture.versions }))
      for (const record of records) {
        const row: Record<string, SQLInputValue> = { ...record };
        if (table === 'user_entity') row.password = 'excluded-password-hash';
        else if (table === 'sharing_entity') {
          row.password = row.has_password === 1 ? 'excluded-share-password-hash' : null;
          row.sharingKey = 'excluded-bearer-token';
          delete row.has_password;
        }
        const keys = Object.keys(row);
        database
          .prepare(
            'INSERT INTO "' +
              table +
              '" (' +
              keys.map((key) => '"' + key + '"').join(',') +
              ') VALUES (' +
              keys.map(() => '?').join(',') +
              ')',
          )
          .run(...Object.values(row));
      }
    database.exec('COMMIT');
  });
  afterEach(async () => {
    for (const snapshot of opened.splice(0)) snapshot.close();
    database.close();
    await rm(root, { recursive: true, force: true });
  });

  it('discloses unqualified global guest access even with one user and no shares', () => {
    database.exec('DELETE FROM sharing_entity; DELETE FROM user_entity WHERE id<>1');
    const value = input();
    value.grants = { '1': value.grants['1'] };
    expect(read(value).manifest.losses).toContainEqual({ code: 'PIGALLERY2_SHARING_RESTRICTED', acknowledged: false });
  });

  it('preserves current native metadata and originals without importing previews or credentials', () => {
    const value = input();
    const { manifest, archive } = read(value);
    expect(manifest.assets).toHaveLength(7);
    expect(manifest.files).toEqual(value.files.map(({ modifiedAt: _modifiedAt, ...file }) => file));
    expect(manifest.assets.find((asset) => asset.id === '6')).toMatchObject({
      ownerId: '1',
      type: 'IMAGE',
      primaryFileId: 'media_entity:6',
      visibility: 'timeline',
      originalFileNames: { 'media_entity:6': 'priority.jpg' },
      metadata: {
        description: 'Edited photo-1 caption',
        rating: 4,
        tags: ['Synthetic tag'],
        latitude: null,
        longitude: null,
      },
    });
    expect(manifest.assets.find((asset) => asset.id === '7')).toMatchObject({
      type: 'VIDEO',
      metadata: { description: 'Edited video-4 caption' },
    });
    expect(archive.some((record) => record.table === 'persons' || record.table === 'person_entry')).toBe(true);
    const serialized = JSON.stringify(archive, (_key, value) => (typeof value === 'bigint' ? String(value) : value));
    expect(serialized).not.toContain('excluded-password');
    expect(serialized).not.toContain('excluded-bearer');
    expect(manifest.losses).toEqual(
      expect.arrayContaining([expect.objectContaining({ code: 'PIGALLERY2_PEOPLE_ARCHIVED', acknowledged: false })]),
    );
  });
  it('retains all case-sensitive XMP, Markdown and GPX bytes in the protected archive', () => {
    const value = input();
    const { archive } = read(value);
    const files = archive.filter((record) => record.table === 'frameleaf_archived_file');
    expect(files).toHaveLength(11);
    for (const file of value.archivedFiles)
      expect(files).toContainEqual({
        table: 'frameleaf_archived_file',
        value: expect.objectContaining({
          path: file.path,
          sha256: file.sha256,
          bytes: file.bytes,
          content: file.content,
        }),
      });
  });
  it('preserves zone-free source clocks without assigning a regional zone', () => {
    const { manifest } = read();
    expect(manifest.assets.find((asset) => asset.id === '6')).toMatchObject({
      localDateTime: '2019-03-17T14:15:16.000',
      metadata: { takenAt: '2019-03-17T14:15:16.000Z' },
    });
    expect(manifest.assets.find((asset) => asset.id === '6')!.metadata).not.toHaveProperty('timeZone');
    expect(manifest.losses).toContainEqual({
      code: 'PIGALLERY2_CAPTURE_OFFSET_UNKNOWN',
      entityId: '6',
      acknowledged: false,
    });
  });
  it('applies the recorded offset to the source instant when retaining its local clock', () => {
    // Native 3.5.2 writes smallint minutes (Utils.getOffsetMinutes), not the "+HH:MM" entity string.
    database.prepare('UPDATE media_entity SET metadataCreationdateoffset=? WHERE id=6').run(-360);
    expect(read().manifest.assets.find((asset) => asset.id === '6')).toMatchObject({
      localDateTime: '2019-03-17T08:15:16.000',
      metadata: { takenAt: '2019-03-17T14:15:16.000Z' },
    });
  });
  it('locks cleared captions, ratings, tags and coordinates against stale embedded metadata', () => {
    database.exec('UPDATE media_entity SET metadataCaption=NULL,metadataRating=NULL,metadataKeywords=NULL WHERE id=6');
    expect(read().manifest.assets.find((asset) => asset.id === '6')!.metadata).toMatchObject({
      description: '',
      rating: 0,
      tags: [],
      latitude: null,
      longitude: null,
    });
  });
  it('preserves direct folder membership as owner-specific path-named albums', () => {
    const value = input();
    value.owners['4'] = '2';
    value.grants['2'] = ['4'];
    const { manifest } = read(value);
    expect(manifest.albums).toContainEqual(
      expect.objectContaining({ ownerId: '1', name: 'enriched', assetIds: ['5', '6', '7'], members: [] }),
    );
    for (const album of manifest.albums)
      for (const id of album.assetIds)
        expect(manifest.assets.find((asset) => asset.id === id)!.ownerId).toBe(album.ownerId);
  });
  it('materializes saved searches only from explicit captured membership and labels the snapshot', () => {
    const { manifest } = read();
    expect(manifest.albums).toContainEqual(
      expect.objectContaining({ name: 'Shared originals snapshot (snapshot)', assetIds: ['1', '4'], members: [] }),
    );
    const value = input();
    delete value.materializedAlbums['1'];
    expect(() => read(value)).toThrow('PIGALLERY2_ALBUM_SNAPSHOT_REQUIRED');
  });
  it.each(['owners', 'grants'] as const)(
    'requires explicit complete %s without inferring ownership from names or roles',
    (field) => {
      const value = input();
      delete value[field]['1'];
      expect(() => read(value)).toThrow('PIGALLERY2_OWNER_REVIEW_REQUIRED');
    },
  );
  it('refuses an owner who cannot download the source original', () => {
    const value = input();
    value.owners['6'] = '2';
    expect(() => read(value)).toThrow('PIGALLERY2_OWNER_REVIEW_REQUIRED');
  });
  it('refuses saved-search members outside the chosen owner access', () => {
    const value = input();
    value.materializedAlbums['1'].ownerId = '2';
    expect(() => read(value)).toThrow('PIGALLERY2_OWNER_REVIEW_REQUIRED');
  });
  it.each(['writersStopped', 'privacyComplete', 'ownershipComplete', 'complete'] as const)(
    'refuses incomplete %s evidence',
    (field) => {
      const value = input();
      value.inventory[field] = false;
      expect(() => read(value)).toThrow('PIGALLERY2_CAPTURE_INCOMPLETE');
    },
  );
  it('refuses changed source inventory', () => {
    const value = input();
    value.inventory.revisionAfter = 'changed';
    expect(() => read(value)).toThrow('PIGALLERY2_CAPTURE_INCOMPLETE');
  });
  it.each(['path', 'bytes', 'missing'] as const)('refuses %s original proof mismatches', (field) => {
    const value = input();
    if (field === 'missing') value.files.pop();
    else value.files[0][field] = field === 'path' ? '../unsafe.jpg' : '1';
    expect(() => read(value)).toThrow('PIGALLERY2_FILE_EVIDENCE_MISMATCH');
  });
  it('refuses corrupted archived bytes and missing metadata files', () => {
    const value = input();
    value.archivedFiles[0].content[0] ^= 1;
    expect(() => read(value)).toThrow('PIGALLERY2_FILE_EVIDENCE_MISMATCH');
    const missing = input();
    missing.archivedFiles = missing.archivedFiles.filter((file) => !file.path.endsWith('.gpx'));
    expect(() => read(missing)).toThrow('PIGALLERY2_FILE_EVIDENCE_MISMATCH');
  });
  it.each([-721, 841, '-06:00', 'invalid', 1.5])('refuses invalid capture offsets (%s)', (offset) => {
    database.prepare('UPDATE media_entity SET metadataCreationdateoffset=? WHERE id=6').run(offset);
    expect(() => read()).toThrow('PIGALLERY2_CAPTURE_TIME_INVALID');
  });
  it.each(['a,,b', 'a,a', 'a,', '/a', 'a//b'])(
    'refuses unrepresentable keyword tags before producing a manifest (%s)',
    (keywords) => {
      database.prepare('UPDATE media_entity SET metadataKeywords=? WHERE id=6').run(keywords);
      expect(database.prepare('SELECT hex(metadataKeywords) AS bytes FROM media_entity WHERE id=6').get()?.bytes).toBe(
        Buffer.from(keywords).toString('hex').toUpperCase(),
      );
      const probe = pigallery2.openPigallery2Snapshot(path, '3.5.2');
      opened.push(probe);
      expect([...probe.rows('media_entity')].flat().find((row) => row.id === 6n)?.metadataKeywords).toBe(keywords);
      expect(() => read()).toThrow('PIGALLERY2_METADATA_INVALID');
    },
  );

  it('refuses complete keyword text containing NUL instead of importing its truncated prefix', () => {
    database.prepare('UPDATE media_entity SET metadataKeywords=? WHERE id=6').run('a\0b');
    expect(database.prepare('SELECT hex(metadataKeywords) AS bytes FROM media_entity WHERE id=6').get()?.bytes).toBe(
      '610062',
    );
    expect(() => read()).toThrow('PIGALLERY2_SNAPSHOT_READ_FAILED');
  });

  it('refuses a directory cycle even when the source lacks a cycle constraint', () => {
    database.exec('UPDATE directory_entity SET parentId=5 WHERE id=5');
    expect(() => read()).toThrow('PIGALLERY2_DIRECTORY_GRAPH_INVALID');
  });
  it('prepares every mapped original with the common canonical writer without database effects', () => {
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
            id: 'placement:' + asset.id + ':' + id,
            sourceAssetId: asset.id,
            sourceFileId: id,
            sourcePath: file.path,
            destinationPath: asset.ownerId + '/' + asset.id + '/' + file.path,
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
    for (const asset of manifest.assets) {
      if (!('type' in asset)) throw new Error('Sealed source asset required');
      expect(
        writer.prepare({
          sourceAssetId: asset.id,
          type: asset.type,
          fileModifiedAt: asset.fileModifiedAt,
          originalFileNames: asset.originalFileNames,
        }),
      ).toBeDefined();
    }
    expect(query).not.toHaveBeenCalled();
  });
});
