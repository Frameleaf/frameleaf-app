import { createHash } from 'node:crypto';
import type { Mock } from 'vitest';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AssetVisibility, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import {
  PreservationItem,
  PreservationPackage,
  PreservationRestore,
  PreservationRestoreItem,
} from 'src/repositories/preservation.repository.js';
import { PreservationWorkerService } from 'src/services/preservation-worker.service.js';
import {
  PRESERVATION_FORMAT,
  PRESERVATION_SCHEMA_VERSION,
  PreservationEntry,
  PreservationPackageError,
  PreservationSidecar,
  preservationJson,
} from 'src/utils/preservation.js';
import { newUuid, newUuidV7 } from 'test/small.factory.js';
import { getMocks } from 'test/utils.js';

type Mocked = Record<string, Mock<(...args: any[]) => any>>;

const sha1 = 'a'.repeat(40);
const sha256 = 'b'.repeat(64);

describe(PreservationWorkerService.name, () => {
  let sut: PreservationWorkerService;
  let repository: Mocked;
  let files: Mocked;
  let operations: Mocked;
  let users: Mocked;
  let assetMedia: Mocked;
  let assets: Mocked;
  let albums: Mocked;
  let stacks: Mocked;
  let tags: Mocked;
  let enrichment: Mocked;
  let albumRepository: Mocked;
  const ownerId = newUuid();

  /** Private steps are exercised directly: they are where the invariants live. */
  const worker = () => sut as unknown as Record<string, (...args: unknown[]) => Promise<unknown>>;

  const packageOf = (overrides: Partial<PreservationPackage> = {}): PreservationPackage =>
    ({
      id: newUuidV7(),
      ownerId,
      origin: 'export',
      name: 'Italy 2024',
      status: 'building',
      format: 'directory',
      path: '/media/exports/owner/preservation/package',
      includeLocked: false,
      includeMetadata: true,
      scope: { description: 'Whole library' },
      manifest: null,
      removedAt: null,
      ...overrides,
    }) as unknown as PreservationPackage;

  const sidecarOf = (sourceAssetId: string, overrides: Partial<PreservationSidecar> = {}): PreservationSidecar => ({
    schemaVersion: PRESERVATION_SCHEMA_VERSION,
    sourceAssetId,
    originalFileName: 'lake.jpg',
    type: 'IMAGE',
    checksum: { sha1, sha256 },
    dates: {
      fileCreatedAt: '2024-06-01T10:00:00.000Z',
      fileModifiedAt: '2024-06-01T10:00:00.000Z',
      localDateTime: null,
      dateTimeOriginal: '2024-06-01T10:00:00.000Z',
      timeZone: null,
    },
    isFavorite: false,
    visibility: 'timeline',
    lock: null,
    location: null,
    description: { text: 'Our first trip', source: 'manual', model: null },
    rating: null,
    camera: null,
    tags: [],
    albums: [],
    faces: [],
    livePhotoVideoId: null,
    stack: null,
    edits: { isEdited: false, recipe: [] },
    documents: [],
    moments: { manual: [], generated: [] },
    provenance: { generatedDescriptions: ['A lake'] },
    ...overrides,
  });

  const restoreItemOf = (overrides: Partial<PreservationRestoreItem> = {}): PreservationRestoreItem => {
    const sourceAssetId = newUuid();
    return {
      id: newUuidV7(),
      restoreId: newUuidV7(),
      sourceAssetId,
      state: 'ready',
      match: 'new',
      assetId: null,
      locked: false,
      entry: {
        sourceAssetId,
        originalFileName: 'lake.jpg',
        type: 'IMAGE',
        locked: false,
        original: { path: `originals/${sourceAssetId}.jpg`, sha1, sha256, bytes: 5 },
        metadata: { path: `metadata/${sourceAssetId}.json`, sha256, bytes: 5 },
      },
      sidecar: sidecarOf(sourceAssetId) as unknown as Record<string, unknown>,
      conflicts: [],
      decisions: null,
      findings: null,
      reasonKey: null,
      error: null,
      attempts: 0,
      creatingAt: null,
      appliedAt: null,
      ...overrides,
    } as unknown as PreservationRestoreItem;
  };

  const contextOf = (overrides: Record<string, unknown> = {}) => ({
    auth: { user: { id: ownerId }, session: { id: newUuid(), hasElevatedPermission: true } },
    ownerId,
    restore: { id: newUuidV7(), ownerId } as unknown as PreservationRestore,
    source: {},
    albums: new Map<string, string>(),
    people: new Map<string, string>(),
    restoreEditRecipes: true,
    conflictDefault: 'keep',
    ...overrides,
  });

  const library = (overrides: Record<string, unknown> = {}) => ({
    dateTimeOriginal: null,
    description: null,
    latitude: null,
    longitude: null,
    rating: null,
    isFavorite: false,
    visibility: 'timeline',
    locked: false,
    editRecipe: [],
    ...overrides,
  });

  beforeEach(() => {
    StorageCore.setMediaLocation('/media');
    repository = {
      beginItemAttempt: vi.fn(),
      finishItem: vi.fn(),
      getExportAsset: vi.fn(),
      findByChecksum: vi.fn().mockResolvedValue([]),
      updateRestoreItem: vi.fn(),
      getLibraryState: vi.fn().mockResolvedValue(library()),
      getEditRecipe: vi.fn().mockResolvedValue([]),
      setLockReason: vi.fn(),
      getFaces: vi.fn().mockResolvedValue([]),
      addFace: vi.fn(),
      nameFace: vi.fn(),
      addDocumentEdit: vi.fn().mockResolvedValue(true),
      addManualMoment: vi.fn().mockResolvedValue(true),
      getOwnedAlbum: vi.fn().mockResolvedValue(undefined),
      albumExists: vi.fn().mockResolvedValue(false),
      findOwnedAlbumsByName: vi.fn().mockResolvedValue([]),
      getOwnedPerson: vi.fn().mockResolvedValue(undefined),
      findPeopleByName: vi.fn().mockResolvedValue([]),
      createPerson: vi.fn(),
      otherClaimedOperation: vi.fn().mockResolvedValue(false),
    };
    files = {
      copyOriginal: vi.fn(),
      removeFile: vi.fn(),
      writeDocument: vi.fn().mockResolvedValue({ sha256, bytes: 5 }),
      extractVerified: vi.fn(),
    };
    operations = {
      requeue: vi.fn().mockResolvedValue(true),
      acknowledgeCancel: vi.fn(),
      fail: vi.fn().mockResolvedValue('retrying'),
    };
    users = { get: vi.fn().mockResolvedValue({ id: ownerId }) };
    assetMedia = { uploadAsset: vi.fn() };
    assets = { update: vi.fn(), editAsset: vi.fn() };
    albums = { addAssets: vi.fn() };
    stacks = { create: vi.fn() };
    tags = { upsertValue: vi.fn(), upsertAssetIds: vi.fn() };
    enrichment = { shouldReadSidecar: vi.fn().mockResolvedValue(false), get: vi.fn() };
    albumRepository = { create: vi.fn() };

    sut = new PreservationWorkerService(
      getMocks().logger as never,
      operations as never,
      repository as never,
      files as never,
      users as never,
      albumRepository as never,
      tags as never,
      enrichment as never,
      assetMedia as never,
      assets as never,
      albums as never,
      stacks as never,
    );
  });

  describe('export', () => {
    const itemOf = (): PreservationItem =>
      ({ id: newUuidV7(), sourceAssetId: newUuid(), state: 'pending', attempts: 0 }) as unknown as PreservationItem;

    it('skips an item that became Locked when the package was asked for without Locked items', async () => {
      const item = itemOf();
      repository.getExportAsset.mockResolvedValue({
        id: item.sourceAssetId,
        ownerId,
        deletedAt: null,
        status: 'active',
        isLocked: true,
      });

      const outcome = await worker().exportItem(packageOf({ includeLocked: false }), item);

      expect(outcome).toBe('skipped');
      expect(files.copyOriginal).not.toHaveBeenCalled();
      expect(repository.finishItem).toHaveBeenCalledWith(item.id, {
        state: 'skipped',
        reasonKey: 'locked_excluded',
        locked: true,
      });
    });

    it('skips an item that is not the owner’s or has left the library', async () => {
      const item = itemOf();
      repository.getExportAsset.mockResolvedValue({ id: item.sourceAssetId, ownerId: newUuid(), status: 'active' });
      expect(await worker().exportItem(packageOf(), item)).toBe('skipped');
      repository.getExportAsset.mockResolvedValue(undefined);
      expect(await worker().exportItem(packageOf(), item)).toBe('skipped');
      expect(files.copyOriginal).not.toHaveBeenCalled();
    });

    it('refuses a copy that does not match the library checksum and removes it', async () => {
      const item = itemOf();
      repository.getExportAsset.mockResolvedValue({
        id: item.sourceAssetId,
        ownerId,
        deletedAt: null,
        status: 'active',
        isLocked: false,
        isOffline: false,
        originalFileName: 'lake.jpg',
        originalPath: '/library/lake.jpg',
        checksum: Buffer.from('c'.repeat(64), 'hex'),
      });
      files.copyOriginal.mockResolvedValue({ sha1, sha256, bytes: 5 });

      const outcome = await worker().exportItem(packageOf(), item);

      expect(outcome).toBe('failed');
      expect(files.removeFile).toHaveBeenCalledWith(expect.stringContaining(`originals/${item.sourceAssetId}.jpg`));
      expect(repository.finishItem).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({ reasonKey: 'checksum_mismatch' }),
      );
    });

    describe('publishing', () => {
      const found = packageOf({ includeMetadata: false });
      const publish = async (counts: { states: Record<string, number>; unavailable: number }) => {
        repository.listedItems = vi.fn().mockResolvedValue([]);
        repository.countItems = vi.fn().mockResolvedValue(new Map([[found.id, { locked: 0, bytes: 0, ...counts }]]));
        repository.updatePackage = vi.fn();
        files.writeLines = vi.fn(async (_path: string, lines: AsyncIterable<string[]>) => {
          for await (const _page of lines) {
            // drained
          }
          return { sha256, bytes: 0 };
        });
        files.openPackage = vi.fn().mockResolvedValue({ listEntries: vi.fn().mockResolvedValue([]), close: vi.fn() });
        await worker().publishPackage(found);
        const manifest = JSON.parse(String(vi.mocked(files.writeDocument).mock.calls.at(-1)![1]));
        return { manifest, update: vi.mocked(repository.updatePackage).mock.calls[0][1] };
      };

      it('does not call a package complete when an original was skipped as unavailable (FL-74)', async () => {
        const { manifest, update } = await publish({ states: { copied: 2, skipped: 1 }, unavailable: 1 });

        expect(manifest).toMatchObject({ complete: false, counts: expect.objectContaining({ skipped: 1, failed: 0 }) });
        expect(update).toMatchObject({ status: 'incomplete', manifest: expect.objectContaining({ complete: false }) });
      });

      it('still calls a package complete when the only skips are Locked items it was asked to leave out', async () => {
        const { manifest, update } = await publish({ states: { copied: 2, skipped: 1 }, unavailable: 0 });

        expect(manifest).toMatchObject({ complete: true });
        expect(update).toMatchObject({ status: 'ready' });
      });
    });

    describe('hidden text evidence (FL-74)', () => {
      const region = (left: number, top: number) => ({
        x1: left,
        y1: top,
        x2: left + 0.2,
        y2: top,
        x3: left + 0.2,
        y3: top + 0.1,
        x4: left,
        y4: top + 0.1,
      });
      const noRegion = { x1: null, y1: null, x2: null, y2: null, x3: null, y3: null, x4: null, y4: null };
      const exportAsset = (overrides: Record<string, unknown> = {}) => ({
        id: newUuid(),
        ownerId,
        type: 'IMAGE',
        originalFileName: 'receipt.jpg',
        fileCreatedAt: new Date('2024-06-01T10:00:00.000Z'),
        fileModifiedAt: new Date('2024-06-01T10:00:00.000Z'),
        localDateTime: new Date('2024-06-01T10:00:00.000Z'),
        dateTimeOriginal: null,
        timeZone: null,
        isFavorite: false,
        visibility: AssetVisibility.Timeline,
        livePhotoVideoId: null,
        stackId: null,
        isEdited: true,
        isLocked: false,
        width: 1000,
        height: 1000,
        exifImageWidth: 1000,
        exifImageHeight: 1000,
        latitude: null,
        longitude: null,
        description: null,
        rating: null,
        ...overrides,
      });
      const documents = [
        { key: 'total', action: 'correct', value: '12.50', ...region(0.1, 0.1) },
        { key: 'address', action: 'correct', value: '1 Cropped Street', ...region(0.7, 0.8) },
        { key: 'kind', action: 'confirm', value: null, ...noRegion },
      ];

      beforeEach(() => {
        Object.assign(repository, {
          getLock: vi.fn(),
          getTagValues: vi.fn().mockResolvedValue([]),
          getOwnedAlbumIds: vi.fn().mockResolvedValue([]),
          getNamedFaces: vi.fn().mockResolvedValue([]),
          // Cropped to the top-left quarter: the address was cut out of the picture.
          getEditRecipe: vi
            .fn()
            .mockResolvedValue([{ action: 'crop', parameters: { x: 0, y: 0, width: 500, height: 500 } }]),
          getDocumentEdits: vi.fn().mockResolvedValue(documents),
          getMoments: vi.fn().mockResolvedValue([]),
          getStackPrimary: vi.fn(),
          getEnrichmentMetadata: vi.fn().mockResolvedValue(undefined),
        });
      });

      it('leaves out a document decision whose text was cropped away, and never copies recognized text', async () => {
        const sidecar = (await worker().buildSidecar(ownerId, exportAsset(), { sha1, sha256 })) as PreservationSidecar;

        expect(sidecar.documents.map((document) => document.key)).toEqual(['total', 'kind']);
        const written = JSON.stringify(sidecar);
        expect(written).not.toContain('Cropped Street');
        // Only the owner's own decisions travel: no recognized-text lines, boxes or scores.
        expect(sidecar).not.toHaveProperty('ocr');
        expect(written).not.toMatch(/"(boxScore|textScore|ocr)"/);
      });

      it('keeps every located decision out when a crop meets unknown image geometry', async () => {
        const asset = exportAsset({ width: null, height: null, exifImageWidth: null, exifImageHeight: null });

        const sidecar = (await worker().buildSidecar(ownerId, asset, { sha1, sha256 })) as PreservationSidecar;

        expect(sidecar.documents.map((document) => document.key)).toEqual(['kind']);
      });
    });

    it('stops the whole job when the disk is full, after recording the item', async () => {
      const item = itemOf();
      repository.getExportAsset.mockResolvedValue({
        id: item.sourceAssetId,
        ownerId,
        deletedAt: null,
        status: 'active',
        isLocked: false,
        isOffline: false,
        originalFileName: 'lake.jpg',
        originalPath: '/library/lake.jpg',
        checksum: Buffer.from(sha256, 'hex'),
      });
      files.copyOriginal.mockRejectedValue(Object.assign(new Error('no space'), { code: 'ENOSPC' }));

      await expect(worker().exportItem(packageOf(), item)).rejects.toThrow('no space');
      expect(repository.finishItem).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({ reasonKey: 'package_no_space' }),
      );
    });
  });

  describe('restore', () => {
    it('matches an original the library already holds and never uploads a second copy', async () => {
      const existing = newUuid();
      repository.findByChecksum.mockResolvedValue([
        { id: existing, deletedAt: null, createdAt: new Date('2020-01-01') },
      ]);
      const item = restoreItemOf();

      const outcome = await worker().restoreItem(contextOf(), item);

      expect(outcome).toBe('matched');
      expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
      expect(files.extractVerified).not.toHaveBeenCalled();
      expect(repository.updateRestoreItem).toHaveBeenCalledWith(item.id, { assetId: existing, match: 'existing' });
    });

    it('refuses an original the library holds in the trash rather than adding it again', async () => {
      repository.findByChecksum.mockResolvedValue([{ id: newUuid(), deletedAt: new Date(), createdAt: new Date() }]);
      const item = restoreItemOf();

      expect(await worker().restoreItem(contextOf(), item)).toBe('failed');
      expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
      expect(repository.updateRestoreItem).toHaveBeenCalledWith(
        item.id,
        expect.objectContaining({ state: 'failed', reasonKey: 'asset_in_trash' }),
      );
    });

    it('adds a new original through the upload path, Locked from the start when the package says so', async () => {
      const created = newUuid();
      assetMedia.uploadAsset.mockResolvedValue({ id: created, status: AssetMediaStatus.CREATED });
      const item = restoreItemOf();
      const sidecar = sidecarOf(item.sourceAssetId, { lock: { reason: 'detected', lockedAt: null } });
      item.sidecar = sidecar as unknown as Record<string, unknown>;
      repository.getLibraryState.mockResolvedValue(library({ locked: true }));

      const outcome = await worker().restoreItem(contextOf(), item);

      expect(outcome).toBe('restored');
      // The intent is recorded before the upload, so a retry after a crash knows the asset is its own.
      const calls = repository.updateRestoreItem.mock.calls.map(([, patch]) => patch);
      expect(calls.findIndex((patch) => patch.state === 'creating')).toBeLessThan(
        calls.findIndex((patch) => patch.assetId === created),
      );
      expect(files.extractVerified).toHaveBeenCalledWith(
        expect.anything(),
        `originals/${item.sourceAssetId}.jpg`,
        expect.any(String),
        { sha1, sha256, bytes: 5 },
      );
      expect(assetMedia.uploadAsset).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({ visibility: AssetVisibility.Locked, filename: 'lake.jpg' }),
        expect.objectContaining({ checksum: Buffer.from(sha256, 'hex'), legacyChecksum: Buffer.from(sha1, 'hex') }),
      );
      expect(repository.setLockReason).toHaveBeenCalledWith(created, 'detected');
      // The owner's description is restored; the generated one stays provenance.
      expect(assets.update).toHaveBeenCalledWith(
        expect.anything(),
        created,
        expect.objectContaining({ description: 'Our first trip', dateTimeOriginal: '2024-06-01T10:00:00.000Z' }),
      );
      expect(repository.updateRestoreItem).toHaveBeenLastCalledWith(
        item.id,
        expect.objectContaining({
          state: 'restored',
          findings: expect.arrayContaining(['generated_description_provenance']),
        }),
      );
    });

    it('recognizes the asset an interrupted attempt added instead of calling it the owner’s', async () => {
      const creatingAt = new Date('2026-09-23T10:00:00.000Z');
      const added = newUuid();
      repository.findByChecksum.mockResolvedValue([
        { id: added, deletedAt: null, createdAt: new Date('2026-09-23T10:00:02.000Z') },
      ]);
      const item = restoreItemOf({ state: 'failed', creatingAt });

      expect(await worker().restoreItem(contextOf(), item)).toBe('restored');
      expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
    });

    it('keeps the library’s values where they differ unless the owner chose the package’s', async () => {
      const existing = newUuid();
      repository.findByChecksum.mockResolvedValue([
        { id: existing, deletedAt: null, createdAt: new Date('2020-01-01') },
      ]);
      repository.getLibraryState.mockResolvedValue(
        library({ description: 'Mine now', dateTimeOriginal: '2024-06-01T10:00:00.000Z' }),
      );

      await worker().restoreItem(contextOf(), restoreItemOf());
      expect(assets.update).not.toHaveBeenCalled();

      await worker().restoreItem(contextOf(), restoreItemOf({ decisions: { description: 'replace' } }));
      expect(assets.update).toHaveBeenCalledWith(expect.anything(), existing, { description: 'Our first trip' });
    });

    it('applies a choice made before a failed attempt when the item is retried (FL-74)', async () => {
      const existing = newUuid();
      repository.findByChecksum.mockResolvedValue([
        { id: existing, deletedAt: null, createdAt: new Date('2020-01-01') },
      ]);
      repository.getLibraryState.mockResolvedValue(library({ description: 'Mine now' }));
      // A failed item handed back by the retry: attempts reset, the owner's choice still on the row.
      const retried = restoreItemOf({
        state: 'failed',
        attempts: 0,
        error: 'The server restarted',
        decisions: { description: 'replace' },
      });

      expect(await worker().restoreItem(contextOf({ conflictDefault: 'keep' }), retried)).toBe('matched');

      expect(assets.update).toHaveBeenCalledWith(
        expect.anything(),
        existing,
        expect.objectContaining({ description: 'Our first trip' }),
      );
      for (const [, patch] of repository.updateRestoreItem.mock.calls) {
        expect(patch).not.toHaveProperty('decisions');
      }
    });

    it('locks a matched original the package says is Locked, and never unlocks one', async () => {
      const existing = newUuid();
      repository.findByChecksum.mockResolvedValue([
        { id: existing, deletedAt: null, createdAt: new Date('2020-01-01') },
      ]);
      const item = restoreItemOf();
      item.sidecar = sidecarOf(item.sourceAssetId, {
        description: null,
        lock: { reason: 'marked', lockedAt: null },
      }) as unknown as Record<string, unknown>;

      await worker().restoreItem(contextOf(), item);
      expect(assets.update).toHaveBeenCalledWith(expect.anything(), existing, { visibility: AssetVisibility.Locked });

      assets.update.mockClear();
      repository.getLibraryState.mockResolvedValue(library({ locked: true }));
      const unlockedInPackage = restoreItemOf();
      const withoutDescription = sidecarOf(unlockedInPackage.sourceAssetId, { description: null });
      unlockedInPackage.sidecar = withoutDescription as unknown as Record<string, unknown>;
      await worker().restoreItem(contextOf(), unlockedInPackage);
      expect(assets.update).not.toHaveBeenCalledWith(
        expect.anything(),
        existing,
        expect.objectContaining({ visibility: expect.anything() }),
      );
    });
  });

  describe('restore relationships', () => {
    it('finds an album from an earlier restore of the same package instead of creating another', async () => {
      const albumId = newUuid();
      repository.getOwnedAlbum.mockImplementation((_owner: string, id: string) =>
        Promise.resolve(id === albumId ? undefined : { id, kind: 'album', parentId: null }),
      );

      const mapped = (await worker().ensureAlbums(ownerId, newUuidV7(), [
        { id: albumId, name: 'Italy', description: '', kind: 'album', parentId: null, icon: null, order: null },
      ])) as Map<string, string>;

      expect(mapped.get(albumId)).toBeDefined();
      expect(mapped.get(albumId)).not.toBe(albumId);
      expect(albumRepository.create).not.toHaveBeenCalled();
    });

    it('creates a missing album once, with an id derived from the package', async () => {
      const albumId = newUuid();
      const identity = newUuidV7();
      const created = new Set<string>();
      albumRepository.create.mockImplementation((album: { id: string }) => {
        created.add(album.id);
        return Promise.resolve(album);
      });
      repository.getOwnedAlbum.mockImplementation((_owner: string, id: string) =>
        Promise.resolve(created.has(id) ? { id, kind: 'album', parentId: null } : undefined),
      );
      const first = (await worker().ensureAlbums(ownerId, identity, [
        { id: albumId, name: 'Italy', description: '', kind: 'album', parentId: null, icon: null, order: null },
      ])) as Map<string, string>;
      const second = (await worker().ensureAlbums(ownerId, identity, [
        { id: albumId, name: 'Italy', description: '', kind: 'album', parentId: null, icon: null, order: null },
      ])) as Map<string, string>;

      expect(first.get(albumId)).toBe(second.get(albumId));
      expect(albumRepository.create).toHaveBeenCalledTimes(1);
      expect(albumRepository.create).toHaveBeenCalledWith(
        expect.objectContaining({ id: first.get(albumId), albumName: 'Italy' }),
        [],
        [{ userId: ownerId, role: 'owner' }],
        ownerId,
      );
    });

    it('never writes to an album id somebody else holds', async () => {
      repository.albumExists.mockResolvedValue(true);
      const albumId = newUuid();
      const mapped = (await worker().ensureAlbums(ownerId, newUuidV7(), [
        { id: albumId, name: 'Italy', description: '', kind: 'album', parentId: null, icon: null, order: null },
      ])) as Map<string, string>;
      expect(mapped.has(albumId)).toBe(false);
      expect(albumRepository.create).not.toHaveBeenCalled();
    });
  });

  describe('run', () => {
    it('waits its turn when another job holds the same package', async () => {
      repository.otherClaimedOperation.mockResolvedValue(true);
      const operation = {
        id: newUuidV7(),
        ownerId,
        kind: MediaOperationKind.PreservationVerify,
        status: MediaOperationStatus.Preparing,
        snapshot: { packageId: newUuidV7() },
        result: null,
      } as unknown as MediaOperation;

      await sut.run({ operation, claimToken: newUuid() });

      expect(operations.requeue).toHaveBeenCalled();
      expect(operations.fail).not.toHaveBeenCalled();
    });

    it('reports a package that is gone through the one automatic retry', async () => {
      repository.getPackageById = vi.fn().mockResolvedValue(undefined);
      const operation = {
        id: newUuidV7(),
        ownerId,
        kind: MediaOperationKind.PreservationExport,
        status: MediaOperationStatus.Preparing,
        snapshot: { packageId: newUuidV7() },
        result: null,
      } as unknown as MediaOperation;

      await sut.run({ operation, claimToken: newUuid() });

      expect(operations.fail).toHaveBeenCalledWith(operation.id, expect.any(String), {
        error: 'The package is gone',
        errorCode: 'package_unavailable',
      });
    });
  });

  /**
   * Reading packages back (FL-74 acceptance: tampered manifests, partial packages, wrong owners).
   * The package lives in memory; everything the worker believes comes from its own checks.
   */
  describe('reading a package', () => {
    const hash = (bytes: Buffer) => ({
      sha1: createHash('sha1').update(bytes).digest('hex'),
      sha256: createHash('sha256').update(bytes).digest('hex'),
      bytes: bytes.length,
    });

    const memorySource = (entries: Map<string, Buffer>) => ({
      format: 'directory' as const,
      listEntries: vi.fn(() => Promise.resolve(entries.keys().toArray())),
      has: vi.fn((name: string) => Promise.resolve(entries.has(name))),
      readDocument: vi.fn((name: string, maxBytes: number) => {
        const bytes = entries.get(name);
        if (!bytes) {
          return Promise.reject(new PreservationPackageError('package_entry_missing', `${name} is not in the package`));
        }
        if (bytes.length > maxBytes) {
          return Promise.reject(new PreservationPackageError('package_too_large', `${name} is too large`));
        }
        return Promise.resolve(bytes);
      }),
      stream: vi.fn((name: string) => {
        const bytes = entries.get(name);
        return bytes
          ? Promise.resolve(hash(bytes))
          : Promise.reject(new PreservationPackageError('package_entry_missing', `${name} is not in the package`));
      }),
      close: vi.fn(),
    });

    /** A well-formed package of `count` originals with their sidecars, index and manifest. */
    const buildPackage = (count: number) => {
      const entries = new Map<string, Buffer>();
      const index: PreservationEntry[] = [];
      for (let i = 0; i < count; i++) {
        const sourceAssetId = newUuid();
        const original = Buffer.from(`original ${i}`);
        const digests = hash(original);
        const sidecar = preservationJson(
          sidecarOf(sourceAssetId, { checksum: { sha1: digests.sha1, sha256: digests.sha256 } }),
        );
        const entry: PreservationEntry = {
          sourceAssetId,
          originalFileName: 'lake.jpg',
          type: 'IMAGE',
          locked: false,
          original: { path: `originals/${sourceAssetId}.jpg`, ...digests },
          metadata: { path: `metadata/${sourceAssetId}.json`, sha256: hash(sidecar).sha256, bytes: sidecar.length },
        };
        entries.set(entry.original.path, original);
        entries.set(entry.metadata!.path, sidecar);
        index.push(entry);
      }
      const indexBytes = Buffer.from(index.map((entry) => `${JSON.stringify(entry)}\n`).join(''));
      entries.set('assets.jsonl', indexBytes);
      const manifest = {
        format: PRESERVATION_FORMAT,
        schemaVersion: PRESERVATION_SCHEMA_VERSION,
        packageId: newUuid(),
        name: 'Italy 2024',
        createdAt: '2026-09-23T10:00:00.000Z',
        producer: { product: 'frameleaf', version: '3.0.0' },
        scope: { description: 'Whole library', includeLocked: false, includeMetadata: true },
        counts: { selected: count, exported: count, failed: 0, skipped: 0, locked: 0, bytes: 1 },
        complete: true,
        files: { 'assets.jsonl': { sha256: hash(indexBytes).sha256, bytes: indexBytes.length } },
        support: {},
      };
      entries.set('manifest.json', preservationJson(manifest));
      return { entries, index, manifest };
    };

    const operationOf = (kind: MediaOperationKind, snapshot: Record<string, unknown>, owner = ownerId) =>
      ({
        id: newUuidV7(),
        ownerId: owner,
        kind,
        status: MediaOperationStatus.Preparing,
        snapshot,
        result: null,
      }) as unknown as MediaOperation;

    let source: ReturnType<typeof memorySource>;

    const useSource = (entries: Map<string, Buffer>) => {
      source = memorySource(entries);
      files.openPackage = vi.fn().mockResolvedValue(source);
    };

    beforeEach(() => {
      files.readLines = vi.fn(
        async (
          from: ReturnType<typeof memorySource>,
          name: string,
          _max: number,
          onLine: (line: string) => Promise<void>,
        ) => {
          const bytes = await from.readDocument(name, Number.MAX_SAFE_INTEGER);
          for (const line of bytes.toString('utf8').split('\n')) {
            await onLine(line);
          }
          return { sha256: hash(bytes).sha256, bytes: bytes.length };
        },
      );
      operations.setBulkResult = vi.fn().mockResolvedValue({
        status: MediaOperationStatus.Rendering,
        cancelRequestedAt: null,
        pauseRequestedAt: null,
      });
      operations.beginValidation = vi.fn().mockResolvedValue(true);
      operations.complete = vi.fn();
      operations.reportProgress = vi.fn();
      Object.assign(repository, {
        getPackageById: vi.fn(),
        updatePackage: vi.fn(),
        resetVerification: vi.fn(),
        upsertListedItems: vi.fn(),
        itemIdsBySource: vi.fn().mockResolvedValue(new Map()),
        countVerified: vi.fn().mockResolvedValue({}),
        verificationWork: vi.fn().mockResolvedValue([]),
        setVerifyState: vi.fn(),
        getRestoreById: vi.fn(),
        updateRestore: vi.fn(),
        addRestoreItems: vi.fn(),
        countRestoreItems: vi.fn().mockResolvedValue({ total: 0, pending: 0 }),
        reviewWork: vi.fn().mockResolvedValue([]),
      });
    });

    describe('verify', () => {
      it('calls a package whose manifest was rewritten after this server wrote it unreadable', async () => {
        const built = buildPackage(1);
        useSource(built.entries);
        // What this server recorded when it published the package: a different index digest.
        const found = packageOf({
          status: 'ready',
          manifest: { files: { 'assets.jsonl': { sha256: 'c'.repeat(64), bytes: 1 } } } as never,
        });
        repository.getPackageById.mockResolvedValue(found);

        const operation = operationOf(MediaOperationKind.PreservationVerify, { packageId: found.id });
        await sut.run({ operation, claimToken: newUuid() });

        expect(repository.updatePackage).toHaveBeenCalledWith(
          found.id,
          expect.objectContaining({
            verification: expect.objectContaining({ status: 'unreadable', reasonKey: 'package_manifest_changed' }),
          }),
        );
        expect(repository.setVerifyState).not.toHaveBeenCalled();
        expect(operations.complete).toHaveBeenCalled();
        expect(operations.fail).not.toHaveBeenCalled();
      });

      it('refuses an index that does not list what the manifest counts', async () => {
        const built = buildPackage(2);
        const manifest = { ...built.manifest, counts: { ...built.manifest.counts, selected: 3, exported: 3 } };
        built.entries.set('manifest.json', preservationJson(manifest));
        useSource(built.entries);
        const found = packageOf({ origin: 'upload', format: 'zip', status: 'building' });
        repository.getPackageById.mockResolvedValue(found);

        await sut.run({
          operation: operationOf(MediaOperationKind.PreservationVerify, { packageId: found.id }),
          claimToken: newUuid(),
        });

        expect(repository.updatePackage).toHaveBeenCalledWith(
          found.id,
          expect.objectContaining({
            status: 'unreadable',
            verification: expect.objectContaining({ status: 'unreadable', reasonKey: 'package_counts_changed' }),
          }),
        );
      });

      it('refuses an index changed after the manifest digested it', async () => {
        const built = buildPackage(1);
        built.entries.set('assets.jsonl', Buffer.concat([built.entries.get('assets.jsonl')!, Buffer.from('\n')]));
        useSource(built.entries);
        const found = packageOf({ origin: 'upload', format: 'zip' });
        repository.getPackageById.mockResolvedValue(found);

        await sut.run({
          operation: operationOf(MediaOperationKind.PreservationVerify, { packageId: found.id }),
          claimToken: newUuid(),
        });

        expect(repository.updatePackage).toHaveBeenCalledWith(
          found.id,
          expect.objectContaining({
            verification: expect.objectContaining({ status: 'unreadable', reasonKey: 'package_index_changed' }),
          }),
        );
      });

      it('reports the missing and changed files of a partial package, item by item', async () => {
        const built = buildPackage(3);
        const [kept, lost, altered] = built.index;
        built.entries.delete(lost.original.path);
        built.entries.set(altered.original.path, Buffer.from('not the original'));
        built.entries.set('stray.txt', Buffer.from('left behind'));
        useSource(built.entries);
        const found = packageOf({ origin: 'upload', format: 'zip' });
        repository.getPackageById.mockResolvedValue(found);
        const rows = built.index.map((entry) => ({
          id: newUuidV7(),
          packageId: found.id,
          sourceAssetId: entry.sourceAssetId,
          state: 'listed',
          entry,
          verifyState: null,
        }));
        repository.verificationWork.mockResolvedValueOnce(rows).mockResolvedValue([]);
        repository.countVerified
          .mockResolvedValueOnce({ unchecked: 3 })
          .mockResolvedValue({ ok: 1, missing: 1, changed: 1 });

        await sut.run({
          operation: operationOf(MediaOperationKind.PreservationVerify, { packageId: found.id }),
          claimToken: newUuid(),
        });

        expect(repository.upsertListedItems).toHaveBeenCalledWith(
          found.id,
          expect.arrayContaining([expect.objectContaining({ sourceAssetId: kept.sourceAssetId })]),
        );
        expect(repository.setVerifyState).toHaveBeenCalledWith(rows[0].id, 'ok', null);
        expect(repository.setVerifyState).toHaveBeenCalledWith(rows[1].id, 'missing', 'package_entry_missing');
        expect(repository.setVerifyState).toHaveBeenCalledWith(rows[2].id, 'changed', 'package_entry_changed');
        expect(repository.updatePackage).toHaveBeenCalledWith(
          found.id,
          expect.objectContaining({
            status: 'ready',
            verification: expect.objectContaining({ status: 'problems', missing: 1, changed: 1, unexpected: 1 }),
          }),
        );
      });

      it('never reads a package for a job of another account', async () => {
        const found = packageOf({ ownerId: newUuid() });
        repository.getPackageById.mockResolvedValue(found);
        files.openPackage = vi.fn();

        const operation = operationOf(MediaOperationKind.PreservationVerify, { packageId: found.id });
        await sut.run({ operation, claimToken: newUuid() });

        expect(files.openPackage).not.toHaveBeenCalled();
        expect(operations.fail).toHaveBeenCalledWith(operation.id, expect.any(String), {
          error: 'The package is gone',
          errorCode: 'package_unavailable',
        });
      });
    });

    describe('review', () => {
      const restoreFor = (found: PreservationPackage, overrides: Partial<PreservationRestore> = {}) =>
        ({
          id: newUuidV7(),
          ownerId,
          packageId: found.id,
          name: 'Italy 2024',
          status: 'reviewing',
          packageIdentity: null,
          options: { restoreEditRecipes: true, conflictDefault: 'keep' },
          summary: null,
          ...overrides,
        }) as unknown as PreservationRestore;

      it('marks a changed original and a sidecar that names other bytes as failed, and matches the rest', async () => {
        const built = buildPackage(3);
        const [good, altered, lying] = built.index;
        built.entries.set(altered.original.path, Buffer.from('not the original'));
        // A sidecar rewritten to name other bytes, with its digest in the index updated to match.
        const forged = preservationJson(sidecarOf(lying.sourceAssetId));
        built.entries.set(lying.metadata!.path, forged);
        lying.metadata = { path: lying.metadata!.path, sha256: hash(forged).sha256, bytes: forged.length };
        useSource(built.entries);

        const found = packageOf({ origin: 'upload', format: 'zip', status: 'ready' });
        const restore = restoreFor(found);
        repository.getRestoreById.mockResolvedValue(restore);
        repository.getPackageById.mockResolvedValue(found);
        const items = built.index.map((entry) =>
          restoreItemOf({
            restoreId: restore.id,
            sourceAssetId: entry.sourceAssetId,
            state: 'pending',
            entry,
          } as never),
        );
        repository.reviewWork.mockResolvedValueOnce(items).mockResolvedValue([]);
        repository.countRestoreItems.mockResolvedValue({ total: 3, pending: 3 });

        await sut.run({
          operation: operationOf(MediaOperationKind.PreservationReview, { packageId: found.id, restoreId: restore.id }),
          claimToken: newUuid(),
        });

        expect(repository.updateRestoreItem).toHaveBeenCalledWith(
          items[0].id,
          expect.objectContaining({ state: 'ready', match: 'new' }),
        );
        expect(repository.updateRestoreItem).toHaveBeenCalledWith(items[1].id, {
          state: 'failed',
          reasonKey: 'original_changed',
        });
        expect(repository.updateRestoreItem).toHaveBeenCalledWith(items[2].id, {
          state: 'failed',
          reasonKey: 'metadata_invalid',
        });
        expect(repository.findByChecksum).toHaveBeenCalledTimes(1);
        expect(repository.findByChecksum).toHaveBeenCalledWith(ownerId, good.original.sha256, good.original.sha1);
        expect(repository.updateRestore).toHaveBeenCalledWith(restore.id, { status: 'ready' });
        expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
      });

      it('calls a restoration of a tampered manifest unreadable and writes nothing to the library', async () => {
        const built = buildPackage(1);
        const manifest = { ...built.manifest, complete: false };
        built.entries.set('manifest.json', preservationJson(manifest));
        useSource(built.entries);
        const found = packageOf({ origin: 'upload', format: 'zip', status: 'ready' });
        const restore = restoreFor(found);
        repository.getRestoreById.mockResolvedValue(restore);
        repository.getPackageById.mockResolvedValue(found);

        await sut.run({
          operation: operationOf(MediaOperationKind.PreservationReview, { packageId: found.id, restoreId: restore.id }),
          claimToken: newUuid(),
        });

        expect(repository.updateRestore).toHaveBeenCalledWith(
          restore.id,
          expect.objectContaining({
            status: 'unreadable',
            summary: expect.objectContaining({ reasonKey: 'package_manifest_invalid' }),
          }),
        );
        expect(repository.addRestoreItems).not.toHaveBeenCalled();
        expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
      });

      it('records the document digests it reviewed on the restoration (FL-74)', async () => {
        const built = buildPackage(1);
        useSource(built.entries);
        const found = packageOf({ origin: 'server-folder', format: 'directory', status: 'ready' });
        const restore = restoreFor(found);
        repository.getRestoreById.mockResolvedValue(restore);
        repository.getPackageById.mockResolvedValue(found);

        await sut.run({
          operation: operationOf(MediaOperationKind.PreservationReview, { packageId: found.id, restoreId: restore.id }),
          claimToken: newUuid(),
        });

        expect(repository.updateRestore).toHaveBeenCalledWith(
          restore.id,
          expect.objectContaining({
            packageIdentity: built.manifest.packageId,
            summary: expect.objectContaining({ reviewedDocuments: built.manifest.files }),
          }),
        );
      });

      describe('applying a reviewed restoration (FL-74)', () => {
        const reviewed = (found: PreservationPackage, files: unknown, identity: string) =>
          restoreFor(found, {
            status: 'ready',
            packageIdentity: identity,
            summary: { albums: 0, people: 0, reviewedDocuments: files } as never,
          });

        const apply = async (restore: PreservationRestore, found: PreservationPackage) => {
          repository.getRestoreById.mockResolvedValue(restore);
          repository.getPackageById.mockResolvedValue(found);
          const operation = operationOf(MediaOperationKind.PreservationRestore, {
            packageId: found.id,
            restoreId: restore.id,
          });
          await sut.run({ operation, claimToken: newUuid() });
          return operation;
        };

        beforeEach(() => {
          Object.assign(repository, {
            countRestoreWork: vi.fn().mockResolvedValue(0),
            restoreWork: vi.fn().mockResolvedValue([]),
          });
        });

        it('refuses a package whose index was rewritten in place after the review', async () => {
          const built = buildPackage(2);
          const found = packageOf({ origin: 'server-folder', format: 'directory', status: 'ready' });
          const restore = reviewed(found, built.manifest.files, built.manifest.packageId);
          // Rewritten between review and apply: one item dropped and the manifest re-digested to match.
          const rewritten = Buffer.from(`${JSON.stringify(built.index[0])}\n`);
          built.entries.set('assets.jsonl', rewritten);
          built.entries.set(
            'manifest.json',
            preservationJson({
              ...built.manifest,
              files: { 'assets.jsonl': { sha256: hash(rewritten).sha256, bytes: rewritten.length } },
            }),
          );
          useSource(built.entries);

          const operation = await apply(restore, found);

          expect(repository.updateRestore).toHaveBeenLastCalledWith(restore.id, {
            status: 'unreadable',
            summary: expect.objectContaining({ reasonKey: 'package_changed_since_review' }),
          });
          expect(repository.restoreWork).not.toHaveBeenCalled();
          expect(albumRepository.create).not.toHaveBeenCalled();
          expect(assetMedia.uploadAsset).not.toHaveBeenCalled();
          expect(operations.fail).not.toHaveBeenCalled();
          expect(operations.complete).toHaveBeenCalledWith(operation.id, expect.any(String), { resultAssetId: null });
        });

        it('refuses album or people lists added after the review', async () => {
          const built = buildPackage(1);
          const found = packageOf({ origin: 'server-folder', format: 'directory', status: 'ready' });
          const restore = reviewed(found, built.manifest.files, built.manifest.packageId);
          const albums = preservationJson([]);
          built.entries.set('albums.json', albums);
          built.entries.set(
            'manifest.json',
            preservationJson({
              ...built.manifest,
              files: { ...built.manifest.files, 'albums.json': { sha256: hash(albums).sha256, bytes: albums.length } },
            }),
          );
          useSource(built.entries);

          await apply(restore, found);

          expect(repository.updateRestore).toHaveBeenLastCalledWith(restore.id, {
            status: 'unreadable',
            summary: expect.objectContaining({ reasonKey: 'package_changed_since_review' }),
          });
          expect(repository.restoreWork).not.toHaveBeenCalled();
        });

        it('carries on a restoration reviewed before digests were recorded', async () => {
          const built = buildPackage(1);
          useSource(built.entries);
          const found = packageOf({ origin: 'server-folder', format: 'directory', status: 'ready' });
          const restore = restoreFor(found, {
            status: 'restoring',
            packageIdentity: built.manifest.packageId,
            summary: { albums: 0, people: 0 } as never,
          });

          await apply(restore, found);

          expect(repository.updateRestore).not.toHaveBeenCalledWith(
            restore.id,
            expect.objectContaining({ status: 'unreadable' }),
          );
          expect(repository.restoreWork).toHaveBeenCalled();
        });

        it('compares a legacy restoration with the digests stored on the package', async () => {
          const built = buildPackage(1);
          useSource(built.entries);
          const found = packageOf({
            origin: 'server-folder',
            format: 'directory',
            status: 'ready',
            manifest: { files: { 'assets.jsonl': { sha256: 'c'.repeat(64), bytes: 1 } } } as never,
          });
          const restore = restoreFor(found, {
            status: 'restoring',
            packageIdentity: built.manifest.packageId,
            summary: { albums: 0, people: 0 } as never,
          });

          await apply(restore, found);

          expect(repository.updateRestore).toHaveBeenLastCalledWith(restore.id, {
            status: 'unreadable',
            summary: expect.objectContaining({ reasonKey: 'package_changed_since_review' }),
          });
          expect(repository.restoreWork).not.toHaveBeenCalled();
        });

        it('applies a legacy restoration whose package still matches its stored digests', async () => {
          const built = buildPackage(1);
          useSource(built.entries);
          const found = packageOf({
            origin: 'server-folder',
            format: 'directory',
            status: 'ready',
            manifest: { files: built.manifest.files } as never,
          });

          await apply(reviewed(found, undefined, built.manifest.packageId), found);

          expect(repository.restoreWork).toHaveBeenCalled();
        });

        it('applies a package that is byte-for-byte what was reviewed', async () => {
          const built = buildPackage(1);
          useSource(built.entries);
          const found = packageOf({ origin: 'server-folder', format: 'directory', status: 'ready' });
          const restore = reviewed(found, built.manifest.files, built.manifest.packageId);

          await apply(restore, found);

          expect(repository.updateRestore).not.toHaveBeenCalledWith(
            restore.id,
            expect.objectContaining({ status: 'unreadable' }),
          );
          expect(repository.restoreWork).toHaveBeenCalled();
        });
      });

      it('never reviews or restores another account’s restoration', async () => {
        const found = packageOf();
        const restore = restoreFor(found, { ownerId: newUuid() });
        repository.getRestoreById.mockResolvedValue(restore);
        repository.getPackageById.mockResolvedValue(found);
        files.openPackage = vi.fn();

        for (const kind of [MediaOperationKind.PreservationReview, MediaOperationKind.PreservationRestore]) {
          const operation = operationOf(kind, { packageId: found.id, restoreId: restore.id });
          await sut.run({ operation, claimToken: newUuid() });
          expect(operations.fail).toHaveBeenCalledWith(operation.id, expect.any(String), {
            error: 'The restoration is gone',
            errorCode: 'restore_unavailable',
          });
        }
        expect(files.openPackage).not.toHaveBeenCalled();
      });
    });
  });

  it('uses a stable error type for package problems', () => {
    expect(new PreservationPackageError('package_index_invalid', 'x').code).toBe('package_index_invalid');
  });
});
