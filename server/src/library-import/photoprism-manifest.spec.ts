import { randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { DatabaseSync, type SQLInputValue } from 'node:sqlite';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import planFixture from 'src/library-import/fixtures/manager-plan-v2.json' with { type: 'json' };
import metadata from 'src/library-import/fixtures/photoprism/261029-metadata.json' with { type: 'json' };
import recordsFixture from 'src/library-import/fixtures/photoprism/261029-records.json' with { type: 'json' };
import schema from 'src/library-import/fixtures/photoprism/261029-sqlite.json' with { type: 'json' };
import { manifestFingerprint } from 'src/library-import/manifest.js';
import {
  type PhotoprismInventoryRecord,
  normalizePhotoprismInventoryRow,
} from 'src/library-import/photoprism-inventory.js';
import { assemblePhotoprismManifest, readPhotoprismSqliteManifest } from 'src/library-import/photoprism-manifest.js';
import { type PhotoprismRow } from 'src/library-import/photoprism.js';

const integerRow = (row: Record<string, unknown>): PhotoprismRow =>
  Object.fromEntries(
    Object.entries(row).map(([key, value]) => [
      key,
      typeof value === 'number' && !['photo_lat', 'photo_lng'].includes(key) ? BigInt(value) : value,
    ]),
  ) as PhotoprismRow;
const setup = (timeZone?: string) => {
  const photo = integerRow({ ...metadata.photo, ...(timeZone === undefined ? {} : { time_zone: timeZone }) }),
    details = integerRow(metadata.details),
    album = integerRow(metadata.album);
  const file = {
    file_uid: 'jpeg',
    photo_uid: photo.photo_uid,
    photo_id: photo.id,
    file_name: 'camera/photo.jpg',
    file_root: '/',
    file_size: 8n,
    file_primary: 1n,
    file_sidecar: 0n,
    file_missing: 0n,
    file_watermark: 0n,
    media_type: 'image',
    original_name: 'DSC123.jpg',
  };
  const rows: PhotoprismInventoryRecord[] = [
    ...normalizePhotoprismInventoryRow('photos', photo, details),
    ...normalizePhotoprismInventoryRow('files', file),
    ...normalizePhotoprismInventoryRow('albums', album),
    ...normalizePhotoprismInventoryRow('photos_albums', integerRow(metadata.memberships[0])),
    ...normalizePhotoprismInventoryRow('users', {
      user_uid: 'alice',
      user_name: 'alice',
      display_name: 'Alice',
      user_role: 'admin',
      auth_provider: 'local',
      can_login: 1n,
    }),
    ...normalizePhotoprismInventoryRow('users', {
      user_uid: 'bob',
      user_name: 'bob',
      display_name: 'Bob',
      user_role: 'user',
      auth_provider: 'local',
      can_login: 1n,
    }),
  ];
  const input = {
    source: {
      kind: 'photoprism' as const,
      version: '261029-963b58c50',
      identity: 'synthetic-source',
      revision: 'snapshot-1',
      schemaSha256: schema.schemaSha256,
    },
    inventory: {
      complete: true as const,
      ownershipComplete: true as const,
      privacyComplete: true as const,
      writersStopped: true as const,
      revisionBefore: 'snapshot-1',
      revisionAfter: 'snapshot-1',
    },
    photoOwners: { [String(photo.photo_uid)]: 'alice' },
    albumOwners: { [String(album.album_uid)]: 'alice' },
    files: [
      {
        id: 'jpeg',
        path: 'camera/photo.jpg',
        bytes: '8',
        sha256: 'b'.repeat(64),
        role: 'original' as const,
        modifiedAt: '2020-06-10T18:31:00Z',
      },
    ],
    materializedAlbums: {} as Record<string, string[]>,
  };
  return { rows, input, photo, details, album, file };
};

describe('PhotoPrism common manifest assembly', () => {
  const label = (id: bigint, name: string, change: Record<string, unknown> = {}) => ({
    id,
    label_name: name,
    label_priority: 0n,
    deleted_at: null,
    ...change,
  });
  const assignment = (photo: bigint, id: bigint, source = 'manual', uncertainty = 0n) => ({
    photo_id: photo,
    label_id: id,
    label_src: source,
    uncertainty,
  });
  const addLabel = (rows: PhotoprismInventoryRecord[], definition: PhotoprismRow, relationship: PhotoprismRow) => {
    rows.push(
      ...normalizePhotoprismInventoryRow('labels', definition),
      ...normalizePhotoprismInventoryRow('photos_labels', relationship),
    );
  };
  it('preserves manual and batch labels alongside keywords without copying generated or rejected labels', () => {
    const { rows, input, photo } = setup();
    addLabel(rows, label(1n, 'Mountain Trail'), assignment(photo.id as bigint, 1n));
    addLabel(rows, label(2n, 'Reviewed batch'), assignment(photo.id as bigint, 2n, 'batch'));
    addLabel(rows, label(3n, 'summer'), assignment(photo.id as bigint, 3n));
    addLabel(rows, label(4n, 'Generated label'), assignment(photo.id as bigint, 4n, 'image'));
    addLabel(rows, label(5n, 'Rejected label'), assignment(photo.id as bigint, 5n, 'manual', 100n));
    addLabel(
      rows,
      label(6n, 'Deleted label', { deleted_at: '2024-01-01T00:00:00Z' }),
      assignment(photo.id as bigint, 6n),
    );
    addLabel(rows, label(7n, 'Hidden label', { label_priority: -1n }), assignment(photo.id as bigint, 7n));
    addLabel(
      rows,
      label(8n, 'Zero timestamp label', { deleted_at: '0001-01-01T00:00:00Z' }),
      assignment(photo.id as bigint, 8n, 'manual', 99n),
    );
    const result = assemblePhotoprismManifest(rows, input);
    expect(result.manifest.assets[0].metadata.tags).toEqual([
      'family',
      'summer',
      'Mountain Trail',
      'Reviewed batch',
      'Zero timestamp label',
    ]);
    expect(rows.find((row) => row.type === 'photo')?.value.metadata.tags).toEqual(['family', 'summer']);
    expect(result.archive.filter((row) => row.table === 'labels')).toHaveLength(8);
    expect(result.archive.filter((row) => row.table === 'photos_labels')).toHaveLength(8);
  });
  it.each(['none', 'generated', 'rejected'])('deduplicates stored keywords with %s labels', (state) => {
    const { rows, input, photo } = setup();
    const logical = rows.find((row) => row.type === 'photo')!;
    logical.value.metadata.tags = ['family', 'family', 'summer'];
    if (state !== 'none')
      addLabel(
        rows,
        label(1n, 'Excluded label'),
        assignment(
          photo.id as bigint,
          1n,
          state === 'generated' ? 'image' : 'manual',
          state === 'rejected' ? 100n : 0n,
        ),
      );
    const result = assemblePhotoprismManifest(rows, input);
    expect(result.manifest.assets[0].metadata.tags).toEqual(['family', 'summer']);
    expect(logical.value.metadata.tags).toEqual(['family', 'family', 'summer']);
  });
  it('archives an unrepresentable manual label and explicitly reports the loss', () => {
    const { rows, input, photo } = setup();
    addLabel(rows, label(1n, 'Family//Travel'), assignment(photo.id as bigint, 1n));
    const result = assemblePhotoprismManifest(rows, input);
    expect(result.manifest.assets[0].metadata.tags).toEqual(['family', 'summer']);
    expect(result.manifest.losses).toContainEqual({
      code: 'PHOTOPRISM_LABEL_TAG_UNREPRESENTABLE',
      entityId: '1',
      acknowledged: false,
    });
    expect(result.archive.find((row) => row.table === 'labels')?.value.label_name).toBe('Family//Travel');
  });
  it.each(['missing label', 'missing photo', 'duplicate label', 'duplicate assignment', 'invalid uncertainty'])(
    'refuses inconsistent manual-label relationships: %s',
    (failure) => {
      const { rows, input, photo } = setup();
      addLabel(rows, label(1n, 'Manual tag'), assignment(photo.id as bigint, 1n));
      switch (failure) {
        case 'missing label': {
          rows.push(...normalizePhotoprismInventoryRow('photos_labels', assignment(photo.id as bigint, 2n)));
          break;
        }
        case 'missing photo': {
          rows.push(...normalizePhotoprismInventoryRow('photos_labels', assignment(999n, 1n)));
          break;
        }
        case 'duplicate label': {
          rows.push(...normalizePhotoprismInventoryRow('labels', label(1n, 'Conflicting label')));
          break;
        }
        case 'duplicate assignment': {
          rows.push(...normalizePhotoprismInventoryRow('photos_labels', assignment(photo.id as bigint, 1n, 'batch')));
          break;
        }
        case 'invalid uncertainty': {
          rows.push(
            ...normalizePhotoprismInventoryRow('labels', label(2n, 'Invalid confidence')),
            ...normalizePhotoprismInventoryRow('photos_labels', assignment(photo.id as bigint, 2n, 'manual', 101n)),
          );
          break;
        }
      }
      expect(() => assemblePhotoprismManifest(rows, input)).toThrow(/PHOTOPRISM_LABEL/u);
    },
  );

  it.each([null, ''])('preserves nullable and empty album description semantics: %j', (description) => {
    const { rows, input, album } = setup();
    const records = rows.filter((row) => row.type !== 'album' && !(row.type === 'archive' && row.table === 'albums'));
    records.push(...normalizePhotoprismInventoryRow('albums', { ...album, album_description: description }));
    const result = assemblePhotoprismManifest(records, input);
    expect(result.manifest.albums[0].description).toBe(description ?? undefined);
    expect(Object.hasOwn(result.manifest.albums[0], 'description')).toBe(description !== null);
    expect(result.archive.find((row) => row.table === 'albums')?.value.album_description).toBe(description);
  });

  it.each(['America/Edmonton', 'Local'])('prepares source zone %s without generated media', (timeZone) => {
    const { rows, input, file } = setup(timeZone);
    rows.push(
      ...normalizePhotoprismInventoryRow('files', {
        ...file,
        file_uid: 'xmp',
        file_name: 'camera/photo.xmp',
        file_primary: 0n,
        file_sidecar: 1n,
      }),
    );
    const { manifest } = assemblePhotoprismManifest(rows, {
      ...input,
      files: [...input.files, { ...input.files[0], id: 'xmp', path: 'camera/photo.xmp', role: 'sidecar' }],
    });
    const asset = manifest.assets[0];
    if (!('type' in asset)) throw new Error('Sealed source asset required');
    const template = planFixture.plan.files[0];
    const plan = parseDestinationImportPlan({
      ...planFixture.plan,
      source: manifest.source,
      owners: manifest.users.map((user, index) => ({
        sourceId: user.id,
        destinationId: planFixture.plan.owners[index].destinationId,
      })),
      files: manifest.files.map((file, index) => ({
        ...template,
        id: 'placement-' + file.id,
        sourceAssetId: asset.id,
        sourceFileId: file.id,
        sourcePath: file.path,
        destinationPath: 'alice/' + file.id,
        bytes: file.bytes,
        sha256: file.sha256,
        sourceIdentity: { ...template.sourceIdentity, inode: String(index + 1), bytes: file.bytes },
      })),
    });
    const writer = new CanonicalAssetWriter(
      { query: vi.fn(), transaction: vi.fn() },
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
    const prepared = writer.prepare({
      sourceAssetId: asset.id,
      type: asset.type,
      fileModifiedAt: asset.fileModifiedAt,
      originalFileNames: asset.originalFileNames,
    });
    expect(prepared.metadata.timeZone).toBe(timeZone === 'Local' ? undefined : timeZone);
    expect('localDateTime' in prepared.asset ? prepared.asset.localDateTime : undefined).toBe(
      timeZone === 'Local' ? '2020-06-10T12:30:00' : undefined,
    );
    expect(prepared.metadata.description).toBe(metadata.expected.Caption);
    expect(prepared.metadata.tags).toEqual(['family', 'summer']);
    expect(prepared.bytes).toBe(8n);
    expect(prepared.files.map((file) => file.role)).toEqual(['original', 'sidecar']);
  });

  it('requires sidecar review before producing a manifest the canonical writer cannot prepare', () => {
    const { rows, input, file } = setup();
    const sidecars = ['xmp', 'json'].map((extension) => ({
      ...input.files[0],
      id: extension,
      path: 'camera/photo.' + extension,
      role: 'sidecar' as const,
    }));
    for (const sidecar of sidecars)
      rows.push(
        ...normalizePhotoprismInventoryRow('files', {
          ...file,
          file_uid: sidecar.id,
          file_name: sidecar.path,
          file_primary: 0n,
          file_sidecar: 1n,
        }),
      );
    expect(() => assemblePhotoprismManifest(rows, { ...input, files: [...input.files, ...sidecars] })).toThrow(
      'PHOTOPRISM_SIDECAR_REVIEW_REQUIRED',
    );
  });

  it('reads a schema-qualified SQLite snapshot directly into the common manifest', async () => {
    const root = await mkdtemp(join(tmpdir(), 'frameleaf-photoprism-manifest-'));
    const path = join(root, 'snapshot.sqlite');
    const db = new DatabaseSync(path);
    try {
      db.exec('BEGIN');
      const insert = (table: string, row: Record<string, SQLInputValue>) => {
        const keys = Object.keys(row);
        const quotedTable = '"' + table.replaceAll('"', '""') + '"';
        const columns = keys.map((key) => '"' + key.replaceAll('"', '""') + '"').join(',');
        const sql = `INSERT INTO ${quotedTable} (${columns}) VALUES (${keys.map(() => '?').join(',')})`;
        // eslint-disable-next-line unicorn/no-unsafe-sqlite-interpolation -- Fixture identifiers only; values are bound.
        db.prepare(sql).run(...Object.values(row));
      };
      for (const type of ['table', 'index', 'trigger', 'view'])
        for (const object of schema.objects)
          if (object.type === type && object.sql && !object.name.startsWith('sqlite_')) db.exec(object.sql);
      for (const migration of schema.migrations)
        insert('migrations', { ...migration, error: '', finished_at: '2026-11-01T00:00:00Z' });
      insert('versions', { version: schema.source.executableVersion, error: '', migrated_at: '2026-11-01T00:00:00Z' });
      for (const [name, rows] of Object.entries(recordsFixture.tables))
        for (const row of rows)
          insert(name === 'users' ? 'auth_users' : name === 'shares' ? 'auth_users_shares' : name, row);
      db.exec('COMMIT');
      db.exec("PRAGMA journal_mode=WAL; UPDATE photos SET time_zone='UTC'");
      const ownerId = recordsFixture.tables.users.find((user) => user.user_name === 'admin')!.user_uid;
      const { input } = setup();
      input.photoOwners = Object.fromEntries(recordsFixture.tables.photos.map((photo) => [photo.photo_uid, ownerId]));
      input.albumOwners = Object.fromEntries(recordsFixture.tables.albums.map((album) => [album.album_uid, ownerId]));
      input.materializedAlbums = Object.fromEntries(
        recordsFixture.tables.albums
          .filter((album) => album.album_type !== 'album')
          .map((album) => [album.album_uid, []]),
      );
      input.files = recordsFixture.tables.files.map((file) => ({
        id: file.file_uid,
        path: file.file_name,
        bytes: String(file.file_size),
        sha256: 'b'.repeat(64),
        role: 'original',
        modifiedAt: new Date(file.mod_time * 1000).toISOString(),
      }));
      db.prepare('INSERT INTO labels(id,label_name,label_priority,deleted_at) VALUES(?,?,?,?)').run(
        900,
        'SQLite manual label',
        0,
        null,
      );
      db.prepare('INSERT INTO photos_labels(photo_id,label_id,label_src,uncertainty) VALUES(?,?,?,?)').run(
        recordsFixture.tables.photos[0].id,
        900,
        'manual',
        0,
      );
      const result = readPhotoprismSqliteManifest(path, input);
      expect(result.manifest.assets.map((asset) => asset.id)).toEqual(
        recordsFixture.tables.photos.map((photo) => photo.photo_uid),
      );
      expect(result.manifest.users).toEqual([{ id: ownerId, name: 'Admin' }]);
      expect(result.manifest.assets[0].metadata.tags).toContain('SQLite manual label');
      expect(result.manifest.assets[1].metadata.tags).not.toContain('SQLite manual label');
      expect(result.manifest.files).toHaveLength(2);
      expect(result.archive.filter((row) => row.table === 'photos_keywords')).toHaveLength(7);
      db.exec('CREATE TABLE unexpected (id INTEGER)');
      expect(() => readPhotoprismSqliteManifest(path, input)).toThrow('PHOTOPRISM_SCHEMA_UNQUALIFIED');
    } finally {
      db.close();
      await rm(root, { recursive: true, force: true });
    }
  });

  it('maps source IDs, explicit owners and edited metadata while retaining the complete protected archive', () => {
    const { rows, input, photo, album } = setup();
    const result = assemblePhotoprismManifest(rows, input);
    expect(result.manifest.version).toBe(3);
    expect(result.manifest.users).toEqual([
      { id: 'alice', name: 'Alice' },
      { id: 'bob', name: 'Bob' },
    ]);
    expect(result.manifest.assets[0]).toMatchObject({
      id: photo.photo_uid,
      ownerId: 'alice',
      fileIds: ['jpeg'],
      primaryFileId: 'jpeg',
      type: 'IMAGE',
      visibility: 'locked',
      originalFileNames: { jpeg: 'DSC123.jpg' },
      metadata: {
        description: metadata.expected.Caption,
        takenAt: '2020-06-10T18:30:00+00:00',
        timeZone: 'America/Edmonton',
        latitude: metadata.expected.Lat,
        longitude: metadata.expected.Lng,
        favorite: true,
        tags: ['family', 'summer'],
      },
    });
    expect(result.manifest.assets[0].metadata).not.toHaveProperty('title');
    expect(result.manifest.albums[0]).toEqual({
      id: album.album_uid,
      ownerId: 'alice',
      name: metadata.album.album_title,
      description: metadata.album.album_description,
      assetIds: [photo.photo_uid],
      members: [],
    });
    expect(result.manifest.losses).toContainEqual({
      code: 'PHOTOPRISM_TITLE_ARCHIVED',
      entityId: photo.photo_uid,
      acknowledged: false,
    });
    expect(result.manifest.losses).toContainEqual({ code: 'PHOTOPRISM_SHARING_RESTRICTED', acknowledged: false });
    expect(result.archive).toEqual(
      rows.filter((row) => row.type === 'archive').map(({ table, value }) => ({ table, value })),
    );
    expect(result.archive.find((row) => row.table === 'photos')?.value.photo_title).toBe(metadata.photo.photo_title);
  });

  it('retains secondary originals and ignores generated previews without trusting their checksums', () => {
    const { rows, input, file } = setup();
    rows.push(
      ...normalizePhotoprismInventoryRow('files', {
        ...file,
        file_uid: 'raw',
        file_name: 'camera/photo.raw',
        file_primary: 0n,
        media_type: 'raw',
      }),
      ...normalizePhotoprismInventoryRow('files', {
        ...file,
        file_uid: 'preview',
        file_name: 'cache/photo.jpg',
        file_root: 'sidecar',
        file_primary: 0n,
      }),
    );
    input.files.push({ ...input.files[0], id: 'raw', path: 'camera/photo.raw', sha256: 'c'.repeat(64) });
    const result = assemblePhotoprismManifest(rows, input);
    expect(result.manifest.files.map((file) => file.id)).toEqual(['jpeg', 'raw']);
    expect(result.manifest.assets[0].fileIds).toEqual(['jpeg', 'raw']);
    expect(result.manifest.assets[0]).toHaveProperty('primaryFileId', 'jpeg');
    expect(result.archive.filter((row) => row.table === 'files')).toHaveLength(3);
  });

  it('uses the sole verified RAW original when the source primary is a generated JPEG', () => {
    const { rows, input, file } = setup();
    const records = rows.filter((row) => row.type !== 'file' && !(row.type === 'archive' && row.table === 'files'));
    records.push(
      ...normalizePhotoprismInventoryRow('files', {
        ...file,
        file_uid: 'raw',
        file_name: 'camera/photo.raw',
        original_name: 'DSC123.RAW',
        media_type: 'raw',
        file_primary: 0n,
      }),
      ...normalizePhotoprismInventoryRow('files', {
        ...file,
        file_uid: 'preview',
        file_name: 'cache/photo.jpg',
        file_root: 'sidecar',
        file_primary: 1n,
      }),
    );
    input.files = [{ ...input.files[0], id: 'raw', path: 'camera/photo.raw' }];
    const result = assemblePhotoprismManifest(records, input);
    expect(result.manifest.assets[0]).toMatchObject({
      primaryFileId: 'raw',
      fileIds: ['raw'],
      type: 'IMAGE',
      originalFileNames: { raw: 'DSC123.RAW' },
    });
    expect(result.manifest.files).toHaveLength(1);
  });

  it.each([
    ['archive', 0n, 'archive'],
    ['trash', 1n, 'trash'],
    // Owner 2026-11-04: an archived private photo stays private, so it imports Locked
    ['archive', 1n, 'locked'],
  ] as const)('preserves source %s (private=%s) without reviving it', (archived, isPrivate, state) => {
    const { rows, input, photo, details } = setup();
    const changed = [
      ...normalizePhotoprismInventoryRow(
        'photos',
        {
          ...photo,
          photo_private: isPrivate,
          deleted_at: '2026-11-01T00:00:00Z',
          photo_quality: archived === 'trash' ? -1n : 5n,
        },
        details,
      ),
    ];
    const result = assemblePhotoprismManifest(
      [
        ...changed,
        ...rows.filter((row) => row.type !== 'photo' && !(row.type === 'archive' && row.table === 'photos')),
      ],
      input,
    );
    expect(result.manifest.assets[0].visibility).toBe(state);
    // Unlocking returns an archived private photo to the Archive
    expect(result.manifest.assets[0].archived).toBe(state === 'locked' ? true : undefined);
    expect(result.manifest.assets[0].metadata.deletedAt).toBe(state === 'trash' ? '2026-11-01T00:00:00Z' : undefined);
  });

  it('keeps hidden and missing historical memberships out of destination albums', () => {
    const { rows, input } = setup();
    for (const row of rows) if (row.type === 'membership') row.value.hidden = true;
    expect(assemblePhotoprismManifest(rows, input).manifest.albums[0].assetIds).toEqual([]);
  });

  it('requires explicit membership snapshots for dynamic albums and identifies the loss', () => {
    const { rows, input, album, photo } = setup();
    for (const row of rows) if (row.type === 'album') row.value.review = ['ALBUM_REQUIRES_MATERIALIZATION'];
    expect(() => assemblePhotoprismManifest(rows, input)).toThrow('PHOTOPRISM_ALBUM_SNAPSHOT_REQUIRED');
    input.materializedAlbums[String(album.album_uid)] = [String(photo.photo_uid)];
    const result = assemblePhotoprismManifest(rows, input);
    expect(result.manifest.albums[0].assetIds).toEqual([photo.photo_uid]);
    expect(result.manifest.losses).toContainEqual({
      code: 'PHOTOPRISM_ALBUM_SNAPSHOT',
      entityId: album.album_uid,
      acknowledged: false,
    });
  });

  it.each([
    'photo-owner',
    'album-owner',
    'missing-file',
    'extra-file',
    'changed-path',
    'changed-size',
    'clock',
    'primary',
    'cross-owner',
  ])('refuses incomplete or conflicting evidence: %s', (failure) => {
    const { rows, input, photo, album, file } = setup();
    switch (failure) {
      case 'photo-owner': {
        delete input.photoOwners[String(photo.photo_uid)];
        break;
      }
      case 'album-owner': {
        delete input.albumOwners[String(album.album_uid)];
        break;
      }
      case 'missing-file': {
        input.files = [];
        break;
      }
      case 'extra-file': {
        input.files.push({ ...input.files[0], id: 'unknown' });
        break;
      }
      case 'changed-path': {
        input.files[0].path = 'another.jpg';
        break;
      }
      case 'changed-size': {
        input.files[0].bytes = '9';
        break;
      }
      case 'clock': {
        for (const row of rows) if (row.type === 'photo') row.value.review = ['LOCAL_TIME_ZONE_UNRESOLVED'];
        break;
      }
      case 'primary': {
        for (const row of rows) if (row.type === 'file') row.value.primary = false;
        rows.push(
          ...normalizePhotoprismInventoryRow('files', {
            ...file,
            file_uid: 'another-original',
            file_name: 'camera/another.jpg',
            file_primary: 0n,
          }),
        );
        input.files.push({ ...input.files[0], id: 'another-original', path: 'camera/another.jpg' });
        break;
      }
      case 'cross-owner': {
        input.albumOwners[String(album.album_uid)] = 'bob';
        break;
      }
    }
    expect(() => assemblePhotoprismManifest(rows, input)).toThrow();
  });
});
