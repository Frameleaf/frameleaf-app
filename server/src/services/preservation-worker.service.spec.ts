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
import { PRESERVATION_SCHEMA_VERSION, PreservationPackageError, PreservationSidecar } from 'src/utils/preservation.js';
import { newUuid, newUuidV7 } from 'test/small.factory.js';
import { getMocks } from 'test/utils.js';

type Mocked = Record<string, ReturnType<typeof vi.fn>>;

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

  it('uses a stable error type for package problems', () => {
    expect(new PreservationPackageError('package_index_invalid', 'x').code).toBe('package_index_invalid');
  });
});
