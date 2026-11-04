import { createHash, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { describe, expect, it, vi } from 'vitest';
import { CanonicalAssetWriter } from 'src/library-import/asset-writer.js';
import { destinationPlanFingerprint, parseDestinationImportPlan } from 'src/library-import/destination-plan.js';
import * as ente from 'src/library-import/ente-files.js';
import media from 'src/library-import/fixtures/ente/0.4.2-media.json' with { type: 'json' };
import planFixture from 'src/library-import/fixtures/manager-plan-v2.json' with { type: 'json' };
import { type ImportManifest, manifestFingerprint } from 'src/library-import/manifest.js';
import { type SourceArchiveRecord } from 'src/library-import/source-archive-codec.js';

type Result = { manifest: ImportManifest; archive: SourceArchiveRecord[] };
const hash = (bytes: Uint8Array) => createHash('sha256').update(bytes).digest('hex');
const image = readFileSync(new URL('fixtures/ente/media/photo.jpg', import.meta.url));
const video = readFileSync(new URL('fixtures/ente/media/video.mov', import.meta.url));
const contract = {
  format: 'ente-photos-export',
  version: 1,
  exporter: media.provenance.exporter,
  sourceCommit: media.provenance.sourceCommit,
  exporterBinarySha256: media.provenance.exporterBinarySha256,
};
const input = () => {
  const cases = structuredClone(media.cases);
  // The native fixture retains representative sidecars; expand its complete ID sets synthetically.
  for (let index = 1; index < 128; index++)
    for (const account of ['alice', 'bob']) {
      const row = structuredClone(
        media.cases.find((row) => row.account === account && row.inventory.id === '10000128')!,
      );
      const id = String(10_000_000 + index),
        name = 'frame-' + String(index).padStart(3, '0') + '.jpg';
      row.inventory.id = id;
      row.inventory.name = name;
      row.record.ente.fileID = id;
      row.record.title = name;
      Reflect.set(row.record.ente.metadata, 'title', name);
      row.record.ente.components[0].path = name;
      row.expected[0].fileId = id;
      row.expected[0].path = name;
      cases.push(row);
    }
  return {
    source: {
      kind: 'ente' as const,
      version: media.provenance.exporter,
      identity: 'synthetic-museum',
      revision: 'unchanged-1',
      schemaSha256: hash(Buffer.from(JSON.stringify(contract))),
    },
    inventory: {
      complete: true,
      ownershipComplete: true,
      privacyComplete: true,
      writersStopped: true,
      revisionBefore: 'unchanged-1',
      revisionAfter: 'unchanged-1',
    },
    accounts: Object.entries(media.users).map(([name, id]) => {
      const selected = cases.filter((row) => row.account === name);
      return {
        id,
        name,
        directory: name,
        root: { format: 'ente-photos-export', version: 1, userID: id, sourceVerifier: undefined as string | undefined },
        files: new Map(selected.map((row) => [row.inventory.id, row.inventory])).values().toArray(),
        albums: new Map(selected.map((row) => [row.album.ente.albumID, { directory: row.folder, record: row.album }]))
          .values()
          .toArray(),
        placements: selected.map((row) => {
          const expected = row.expected.find((file) => file.role === row.record.ente.component)!;
          const bytes = expected.input === 'photo.jpg' ? image : video;
          expect(hash(bytes)).toBe(expected.sha256);
          expect(createHash('blake2b512').update(bytes).digest('base64')).toBe(expected.sourceHash);
          return {
            albumId: row.album.ente.albumID,
            record: row.record,
            file: {
              path: name + '/' + row.folder + '/' + expected.path,
              bytes: String(bytes.length),
              sha256: hash(bytes),
              sourceHash: createHash('blake2b512').update(bytes).digest('base64'),
              modifiedAt: row.inventory.modifiedAt ?? row.inventory.createdAt,
            },
          };
        }),
      };
    }),
  };
};
const read = (value = input()): Result => {
  const adapter = Reflect.get(ente, 'readEnteManifest') as ((value: unknown) => Result) | undefined;
  expect(adapter).toBeTypeOf('function');
  if (!adapter) throw new Error('Ente manifest adapter missing');
  return adapter(value);
};

describe('Ente common manifest mapping', () => {
  it('reconciles complete 131/132-file account inventories and coalesces repeated physical placements', () => {
    const value = input();
    expect(value.accounts[0].files).toHaveLength(131);
    expect(value.accounts[1].files).toHaveLength(132);
    expect(value.accounts[0].placements).toHaveLength(134);
    expect(value.accounts[1].placements).toHaveLength(133);
    const { manifest, archive } = read(value);
    expect(manifest.assets).toHaveLength(133);
    expect(manifest.files).toHaveLength(133);
    expect(manifest.users.map((user) => user.id).toSorted()).toEqual(Object.values(media.users).toSorted());
    expect(archive.filter((record) => record.table === 'frameleaf_ente_placement')).toHaveLength(267);
  });
  it('preserves owning-account manual edits ahead of stale embedded data and sharee preferences', () => {
    const { manifest } = read();
    if (manifest.version !== 5) throw new Error('Live Photo manifest required');
    const asset = manifest.assets.find((asset) => asset.id === media.ids.first)!;
    expect(asset).toMatchObject({
      ownerId: media.users.alice,
      visibility: 'archive',
      type: 'IMAGE',
      localDateTime: '2025-01-01T05:30:00.000000',
      metadata: {
        takenAt: '2025-01-01T00:00:00.000000Z',
        description: 'Frameleaf synthetic caption',
        latitude: -33.25,
        longitude: 151.2,
        favorite: true,
      },
    });
    expect(Object.values(asset.originalFileNames)).toEqual(['Manual cover.jpg']);
    expect(asset.metadata).not.toHaveProperty('timeZone');
  });
  it('imports a hidden file as Locked', () => {
    const value = input();
    for (const account of value.accounts) {
      for (const file of account.files) if (file.id === media.ids.first) file.visibility = 'hidden';
      for (const placement of account.placements)
        if (placement.record.ente.fileID === media.ids.first)
          placement.record.ente.magicMetadata = { ...placement.record.ente.magicMetadata, visibility: 2 };
    }
    expect(read(value).manifest.assets.find((asset) => asset.id === media.ids.first)!.visibility).toBe('locked');
  });
  it('keeps equal bytes belonging to different source IDs and owners distinct', () => {
    const { manifest } = read();
    const first = manifest.assets.find((asset) => asset.id === media.ids.first)!;
    const other = manifest.assets.find((asset) => asset.id === media.ids.bobFile)!;
    expect(first.ownerId).not.toBe(other.ownerId);
    expect(first.fileIds).not.toEqual(other.fileIds);
    expect(manifest.files.find((file) => file.id === first.fileIds[0])!.sha256).toBe(
      manifest.files.find((file) => file.id === other.fileIds[0])!.sha256,
    );
  });
  it('retains every owner album membership, labels Favorites as a snapshot and keeps shares restricted', () => {
    const { manifest } = read();
    expect(manifest.albums.filter((album) => album.assetIds.includes(media.ids.first))).toHaveLength(3);
    expect(manifest.albums).toContainEqual(
      expect.objectContaining({
        ownerId: media.users.alice,
        name: 'Favorites (snapshot)',
        assetIds: [media.ids.first],
        members: [],
      }),
    );
    for (const album of manifest.albums) {
      expect(album.members).toEqual([]);
      for (const id of album.assetIds)
        expect(manifest.assets.find((asset) => asset.id === id)!.ownerId).toBe(album.ownerId);
    }
  });
  it('maps a native Live Photo to a source-ID-bound image and hidden video original', () => {
    const { manifest } = read();
    expect(manifest.version).toBe(5);
    if (manifest.version !== 5) throw new Error('Live Photo manifest required');
    const pair = manifest.livePhotos.find((pair) => pair.photoAssetId === media.ids.live)!;
    expect(pair).toBeDefined();
    expect(manifest.assets.find((asset) => asset.id === pair.videoAssetId)).toMatchObject({
      ownerId: media.users.alice,
      type: 'VIDEO',
      visibility: 'hidden',
    });
    expect(manifest.assets.find((asset) => asset.id === pair.photoAssetId)).toMatchObject({
      ownerId: media.users.alice,
      type: 'IMAGE',
    });
    expect(manifest.files.every((file) => file.role === 'original')).toBe(true);
  });
  it('never archives root verifiers, recovery keys or account authentication data', () => {
    const value = input();
    const verifier = Buffer.alloc(32, 77).toString('base64');
    value.accounts[0].root.sourceVerifier = verifier;
    const result = read(value);
    const encoded = JSON.stringify(result, (_key, value) => (typeof value === 'bigint' ? String(value) : value));
    expect(encoded).not.toContain(verifier);
    expect(encoded).not.toContain('sourceVerifier');
    expect(encoded).not.toContain('encryptedKey');
  });
  it('uses inventory state rather than interpreting a Trash directory as source trash', () => {
    const value = input(),
      account = value.accounts[1],
      album = account.albums.find((album) => album.record.ente.albumID === media.ids.bobAlbum)!;
    const old = album.directory;
    album.directory = 'Trash';
    for (const placement of account.placements) {
      if (placement.albumId !== media.ids.bobAlbum) continue;
      placement.file.path = placement.file.path.replace('/' + old + '/', '/Trash/');
    }
    expect(read(value).manifest.assets.find((asset) => asset.id === media.ids.bobFile)!.visibility).toBe('timeline');
  });
  it('retains precise source clocks without assigning a regional zone when an offset is unavailable', () => {
    const value = input();
    for (const account of value.accounts) {
      const file = account.files.find((file) => file.id === '10000128')!;
      file.createdAt = '2023-11-14T22:13:20.123456Z';
      for (const placement of account.placements) {
        if (placement.record.ente.fileID !== file.id) continue;
        placement.record.photoTakenTime.timestamp = '1700000000';
        placement.record.creationTime.timestamp = '1700000000';
        Reflect.set(placement.record.ente.metadata, 'creationTime', 1_700_000_000_123_456);
      }
    }
    const { manifest } = read(value);
    expect(manifest.assets.find((asset) => asset.id === '10000128')).toMatchObject({
      localDateTime: '2023-11-14T22:13:20.123456',
      metadata: { takenAt: '2023-11-14T22:13:20.123456Z' },
    });
    expect(manifest.losses).toContainEqual({
      code: 'ENTE_CAPTURE_OFFSET_UNKNOWN',
      entityId: '10000128',
      acknowledged: false,
    });
  });
  it.each(['version', 'schema', 'root', 'account'] as const)('refuses an unqualified %s binding', (kind) => {
    const value = input();
    switch (kind) {
      case 'version': {
        value.source.version = 'ente-cli-unknown';
        break;
      }
      case 'schema': {
        value.source.schemaSha256 = '0'.repeat(64);
        break;
      }
      case 'root': {
        value.accounts[0].root.version = 2;
        break;
      }
      case 'account': {
        value.accounts[0].root.userID = media.users.bob;
        break;
      }
    }
    expect(() => read(value)).toThrow(/ENTE_/);
  });
  it.each(['complete', 'ownershipComplete', 'privacyComplete', 'writersStopped'] as const)(
    'refuses incomplete %s evidence',
    (field) => {
      const value = input();
      value.inventory[field] = false;
      expect(() => read(value)).toThrow('ENTE_CAPTURE_INCOMPLETE');
    },
  );
  it('refuses a changed source revision', () => {
    const value = input();
    value.inventory.revisionAfter = 'changed';
    expect(() => read(value)).toThrow('ENTE_CAPTURE_INCOMPLETE');
  });
  it('refuses an incomplete source-ID inventory even across the exporter page boundary', () => {
    const value = input();
    value.accounts[0].files.pop();
    expect(() => read(value)).toThrow('ENTE_EXPORT_INCOMPLETE');
  });
  it('requires the owning account metadata instead of adopting a sharee view as authoritative', () => {
    const value = input();
    value.accounts.shift();
    expect(() => read(value)).toThrow('ENTE_OWNER_EXPORT_REQUIRED');
  });
  it('refuses missing album membership exports', () => {
    const value = input();
    value.accounts[0].placements = value.accounts[0].placements.filter(
      (placement) => placement.albumId !== media.ids.secondary,
    );
    expect(() => read(value)).toThrow('ENTE_EXPORT_INCOMPLETE');
  });
  it('refuses missing Live Photo components instead of converting them to a still photo', () => {
    const value = input();
    value.accounts[0].placements = value.accounts[0].placements.filter(
      (placement) => !(placement.record.ente.fileID === media.ids.live && placement.record.ente.component === 'video'),
    );
    expect(() => read(value)).toThrow('ENTE_EXPORT_INCOMPLETE');
  });
  it.each(['path', 'bytes', 'sha256', 'sourceHash'] as const)('refuses invalid %s file evidence', (field) => {
    const value = input();
    value.accounts[0].placements[0].file[field] = field === 'path' ? '../outside.jpg' : 'invalid';
    expect(() => read(value)).toThrow('ENTE_FILE_EVIDENCE_MISMATCH');
  });
  it.each([1.25, Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER + 1])(
    'keeps JSON numbers lossless (%s)',
    (number) => {
      const value = input();
      Reflect.set(value.accounts[0].placements[0].record.ente.metadata, 'syntheticNumber', number);
      if (number > Number.MAX_SAFE_INTEGER) expect(() => read(value)).toThrow('ENTE_EXPORT_INVALID');
      else expect(() => read(value)).not.toThrow();
    },
  );
  it.each([false, true])('discloses empty shared albums without requiring shared files (shared: %s)', (shared) => {
    const value = input();
    for (const account of value.accounts) {
      account.files = account.files.filter((file) => file.ownerId === account.id);
      const owned = new Set(account.files.map((file) => file.id));
      account.placements = account.placements.filter((placement) => owned.has(placement.record.ente.fileID));
      account.albums = account.albums.filter((album) => album.record.ente.ownerID === account.id);
    }
    if (shared) {
      const album = structuredClone(value.accounts[0].albums[0]);
      album.record.ente.albumID = '777777';
      album.directory = 'empty-shared';
      for (const account of value.accounts) account.albums.push(structuredClone(album));
    }
    const losses = read(value).manifest.losses.map((loss) => loss.code);
    expect(losses.includes('ENTE_SHARING_RESTRICTED')).toBe(shared);
  });

  it('refuses conflicting public metadata between account inventories', () => {
    const value = input();
    value.accounts[1].files.find((file) => file.id === media.ids.first)!.caption = 'Conflicting caption';
    expect(() => read(value)).toThrow('ENTE_METADATA_CONFLICT');
  });
  it.each(['missing', 'conflicting'] as const)('refuses %s authoritative album ownership', (kind) => {
    const value = input();
    const bob = value.accounts.find((account) => account.id === media.users.bob)!;
    const album = bob.albums.find((album) => album.record.ente.albumID === media.ids.bobAlbum)!;
    album.record.ente.ownerID = media.users.alice;
    if (kind === 'conflicting') {
      const view = structuredClone(album);
      view.record.ente.ownerID = media.users.bob;
      view.directory = 'conflicting-owner-view';
      value.accounts.find((account) => account.id === media.users.alice)!.albums.push(view);
    }
    expect(() => read(value)).toThrow('ENTE_OWNER_EXPORT_REQUIRED');
  });
  it('refuses an unknown current owner rather than assigning the exporting account', () => {
    const value = input();
    for (const account of value.accounts) account.files.find((file) => file.id === media.ids.first)!.ownerId = '999999';
    expect(() => read(value)).toThrow('ENTE_OWNER_EXPORT_REQUIRED');
  });
  it('refuses source trash state without authoritative removal time evidence', () => {
    const value = input();
    Reflect.set(
      value.accounts[0].files.find((file) => file.id === media.ids.first)!,
      'visibility',
      'trashed',
    );
    expect(() => read(value)).toThrow('ENTE_VISIBILITY_REVIEW_REQUIRED');
  });
  it('requires review of same-owner duplicate bytes without discarding their source relationships', () => {
    const { manifest } = read(),
      template = planFixture.plan.files[0];
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
    expect(
      () =>
        new CanonicalAssetWriter(
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
        ),
    ).toThrow('IMPORT_PLAN_DUPLICATE_REVIEW_REQUIRED');
    expect(query).not.toHaveBeenCalled();
  });
});
