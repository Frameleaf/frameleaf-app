import { BadRequestException, ConflictException, ForbiddenException, NotFoundException } from '@nestjs/common';
import { StorageCore } from 'src/cores/storage.core.js';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { MediaOperation } from 'src/repositories/media-operation.repository.js';
import {
  PreservationItem,
  PreservationPackage,
  PreservationRestore,
  PreservationRestoreItem,
} from 'src/repositories/preservation.repository.js';
import { PreservationService, preservationSupportFor } from 'src/services/preservation.service.js';
import { PRESERVATION_MAX_ITEMS } from 'src/utils/preservation.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newUuid, newUuidV7 } from 'test/small.factory.js';
import { getMocks } from 'test/utils.js';

type Mocked = Record<string, ReturnType<typeof vi.fn>>;

describe(PreservationService.name, () => {
  let sut: PreservationService;
  let repository: Mocked;
  let files: Mocked;
  let operations: Mocked;
  let storage: Mocked;
  let owner: AuthDto;
  let unlocked: AuthDto;

  const packageOf = (overrides: Partial<PreservationPackage> = {}): PreservationPackage =>
    ({
      id: newUuidV7(),
      ownerId: owner.user.id,
      origin: 'export',
      name: 'Italy 2024',
      status: 'ready',
      format: 'directory',
      path: '/media/exports/owner/preservation/package',
      originalFileName: null,
      sizeBytes: null,
      digest: null,
      includeLocked: false,
      includeMetadata: true,
      scope: { description: 'Whole library' },
      manifest: {
        packageId: newUuidV7(),
        createdAt: '2026-09-23T10:00:00.000Z',
        producerVersion: '3.0.0',
        complete: true,
        counts: { selected: 1, exported: 1, failed: 0, skipped: 0, locked: 0, bytes: 10 },
        scope: { description: 'Whole library', includeLocked: false, includeMetadata: true },
        files: { 'assets.jsonl': { sha256: 'a'.repeat(64), bytes: 10 } },
      },
      verification: null,
      verifiedAt: null,
      expiresAt: null,
      removedAt: null,
      createdAt: new Date('2026-09-23T10:00:00.000Z'),
      updatedAt: new Date('2026-09-23T10:00:00.000Z'),
      ...overrides,
    }) as unknown as PreservationPackage;

  const restoreOf = (overrides: Partial<PreservationRestore> = {}): PreservationRestore =>
    ({
      id: newUuidV7(),
      ownerId: owner.user.id,
      packageId: newUuidV7(),
      name: 'Italy 2024',
      status: 'ready',
      packageIdentity: newUuidV7(),
      options: { restoreEditRecipes: true, conflictDefault: 'keep' },
      summary: { albums: 2, people: 1 },
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as unknown as PreservationRestore;

  const operationOf = (overrides: Partial<MediaOperation> = {}): MediaOperation =>
    ({
      id: newUuidV7(),
      ownerId: owner.user.id,
      kind: MediaOperationKind.PreservationExport,
      status: MediaOperationStatus.Queued,
      destination: 'local',
      destinationDetail: null,
      label: 'Italy 2024',
      assetId: null,
      resultAssetId: null,
      retryOfId: null,
      projectId: null,
      revisionId: null,
      snapshot: {},
      settings: {},
      estimate: null,
      result: null,
      progress: 0,
      processedUnits: '0',
      totalUnits: null,
      attempt: 0,
      maxAttempts: 3,
      autoRetries: 0,
      retryAt: null,
      error: null,
      errorCode: null,
      cancelRequestedAt: null,
      pauseRequestedAt: null,
      startedAt: null,
      finishedAt: null,
      createdAt: new Date(),
      updatedAt: new Date(),
      ...overrides,
    }) as unknown as MediaOperation;

  beforeEach(() => {
    StorageCore.setMediaLocation('/media');
    owner = AuthFactory.from().session({ hasElevatedPermission: false }).build();
    unlocked = { ...owner, session: { id: newUuid(), hasElevatedPermission: true } };

    repository = {
      previewSelection: vi.fn().mockResolvedValue({ items: 10, bytes: 1000, lockedItems: 3, lockedBytes: 300 }),
      createExport: vi.fn(),
      updatePackage: vi.fn(),
      getPackage: vi.fn(),
      listPackages: vi.fn().mockResolvedValue([]),
      countItems: vi.fn().mockResolvedValue(new Map()),
      latestOperations: vi.fn().mockResolvedValue(new Map()),
      activeOperation: vi.fn().mockResolvedValue(undefined),
      listItems: vi.fn(),
      lockedItemIds: vi.fn().mockResolvedValue(new Set()),
      hasLockedItems: vi.fn().mockResolvedValue(false),
      listedItems: vi.fn().mockResolvedValue([]),
      resetFailedItems: vi.fn().mockResolvedValue(0),
      createPackage: vi.fn(),
      createRestore: vi.fn(),
      getRestore: vi.fn(),
      listRestores: vi.fn().mockResolvedValue([]),
      updateRestore: vi.fn(),
      countRestoreItems: vi.fn().mockResolvedValue({
        total: 0,
        pending: 0,
        ready: 0,
        failed: 0,
        restored: 0,
        matched: 0,
        skipped: 0,
        new: 0,
        existing: 0,
        trashed: 0,
        locked: 4,
        conflicts: 0,
        findings: 0,
      }),
      listRestoreItems: vi.fn(),
      lockedRestoreItemIds: vi.fn().mockResolvedValue([]),
      setDecisions: vi.fn().mockResolvedValue(1),
      resetFailedRestoreItems: vi.fn().mockResolvedValue(0),
    };
    files = {
      freeBytes: vi.fn().mockResolvedValue(5000),
      ownerFolders: vi
        .fn()
        .mockReturnValue(['/media/exports/owner/preservation', '/media/exports/owner/preservation-uploads']),
      exportFolder: vi.fn((ownerId: string, id: string) => `/media/exports/${ownerId}/preservation/${id}`),
      removeDirectory: vi.fn(),
      removeFile: vi.fn(),
      openPackage: vi.fn(),
      sha256File: vi.fn(),
      resolveServerPackage: vi.fn(),
    };
    operations = {
      create: vi.fn().mockImplementation((row: Record<string, unknown>) => Promise.resolve(operationOf(row as never))),
      getByRequestKey: vi.fn().mockResolvedValue(undefined),
    };
    storage = {
      createZipStream: vi.fn(),
      createReadStream: vi.fn(),
    };

    sut = new PreservationService(
      getMocks().logger as never,
      repository as never,
      files as never,
      operations as never,
      storage as never,
    );
  });

  describe('preview', () => {
    it('never tells an ordinary session how much of its library is Locked', async () => {
      const preview = await sut.preview(owner, { includeLocked: true });
      expect(preview).toMatchObject({
        items: 10,
        lockedItems: 0,
        lockedBytes: '0',
        includedItems: 10,
        lockedAllowed: false,
      });
    });

    it('counts Locked items for an unlocked session that includes them', async () => {
      const preview = await sut.preview(unlocked, { includeLocked: true });
      expect(preview).toMatchObject({ lockedItems: 3, includedItems: 13, includedBytes: '1300', withinLimit: true });
      expect(preview.support.find((item) => item.category === 'generatedDescriptions')?.level).toBe('provenance-only');
    });
  });

  describe('createExport', () => {
    it('refuses Locked items from a session that has not unlocked', async () => {
      await expect(sut.createExport(owner, { name: 'All', includeLocked: true })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(repository.createExport).not.toHaveBeenCalled();
    });

    it('refuses a shared link', async () => {
      const link = AuthFactory.from().sharedLink().build();
      await expect(sut.createExport(link, { name: 'All' })).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('freezes the owner’s selection and queues the durable job', async () => {
      const created = packageOf({ status: 'building', manifest: null });
      repository.createExport.mockResolvedValue({ package: created, items: 12 });

      await sut.createExport(unlocked, {
        name: 'Italy 2024',
        includeLocked: true,
        scope: { filter: { isFavorite: { eq: true } } },
        requestKey: 'export-1',
      });

      const [input, pathFor, selection, includeLocked, maxItems] = repository.createExport.mock.calls[0];
      expect(input).toMatchObject({
        ownerId: owner.user.id,
        origin: 'export',
        includeLocked: true,
        includeMetadata: true,
      });
      expect(pathFor('package-1')).toBe(`/media/exports/${owner.user.id}/preservation/package-1`);
      expect(selection).toEqual({ filter: { isFavorite: { eq: true } } });
      expect(includeLocked).toBe(true);
      expect(maxItems).toBe(PRESERVATION_MAX_ITEMS);
      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.PreservationExport,
          totalUnits: '12',
          snapshot: expect.objectContaining({ packageId: created.id, requestKey: 'export-1', elevated: true }),
        }),
      );
    });

    it('answers a repeated request key with the first package', async () => {
      const first = packageOf();
      operations.getByRequestKey.mockResolvedValue(operationOf({ snapshot: { packageId: first.id } }));
      repository.getPackage.mockResolvedValue(first);

      const result = await sut.createExport(owner, { name: 'Italy 2024', requestKey: 'export-1' });

      expect(result.id).toBe(first.id);
      expect(repository.createExport).not.toHaveBeenCalled();
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('refuses a selection larger than one package, and one that matches nothing', async () => {
      repository.createExport.mockResolvedValue(null);
      await expect(sut.createExport(owner, { name: 'All' })).rejects.toBeInstanceOf(BadRequestException);

      repository.createExport.mockResolvedValue({ package: packageOf(), items: 0 });
      await expect(sut.createExport(owner, { name: 'All' })).rejects.toBeInstanceOf(BadRequestException);
      expect(operations.create).not.toHaveBeenCalled();
    });
  });

  describe('reading packages', () => {
    it('answers somebody else’s package exactly like a missing one', async () => {
      repository.getPackage.mockResolvedValue(undefined);
      await expect(sut.getPackage(owner, newUuidV7())).rejects.toBeInstanceOf(NotFoundException);
      expect(repository.getPackage).toHaveBeenCalledWith(expect.any(String), owner.user.id);
    });

    it('never lists or counts a Locked item for an ordinary session', async () => {
      const found = packageOf();
      repository.getPackage.mockResolvedValue(found);
      const itemOf = (locked: boolean, name: string) =>
        ({
          id: newUuidV7(),
          packageId: found.id,
          sourceAssetId: newUuid(),
          assetId: newUuid(),
          state: 'copied',
          locked,
          entry: { originalFileName: name, original: { bytes: 5, sha256: 'c'.repeat(64) } },
          verifyState: 'ok',
          reasonKey: null,
          error: null,
        }) as unknown as PreservationItem;
      const open = itemOf(false, 'lake.jpg');
      // Locked in the library after the ordinary read was filtered: still withheld.
      const lockedSince = itemOf(false, 'private.jpg');
      repository.listItems.mockResolvedValue({ items: [open, lockedSince], total: 2 });
      repository.lockedItemIds.mockResolvedValue(new Set([lockedSince.id]));

      const report = await sut.getPackageItems(owner, found.id, {});

      expect(repository.listItems).toHaveBeenCalledWith(found.id, expect.objectContaining({ excludeLocked: true }));
      expect(report.items.map((item) => item.name)).toEqual(['lake.jpg']);

      const lockedItem = itemOf(true, 'private.jpg');
      repository.listItems.mockResolvedValue({ items: [open, lockedItem], total: 2 });
      const revealed = await sut.getPackageItems(unlocked, found.id, {});
      expect(repository.listItems).toHaveBeenLastCalledWith(
        found.id,
        expect.objectContaining({ excludeLocked: false }),
      );
      expect(revealed.items.map((item) => [item.name, item.locked])).toEqual([
        ['lake.jpg', false],
        ['private.jpg', true],
      ]);
    });

    it('counts a package’s items without its Locked ones for an ordinary session', async () => {
      const found = packageOf();
      repository.getPackage.mockResolvedValue(found);
      repository.countItems.mockResolvedValue(
        new Map([[found.id, { states: { copied: 3 }, locked: 2, bytes: 30, unavailable: 0 }]]),
      );

      const ordinary = await sut.getPackage(owner, found.id);
      expect(repository.countItems).toHaveBeenLastCalledWith([found.id], { excludeLocked: true });
      expect(ordinary.counts.locked).toBe(0);
      expect(ordinary.lockedContent).toBe(false);

      const revealed = await sut.getPackage(unlocked, found.id);
      expect(repository.countItems).toHaveBeenLastCalledWith([found.id], { excludeLocked: false });
      expect(revealed.counts.locked).toBe(2);
      expect(revealed.lockedContent).toBe(true);
    });

    it('states the restoration support of a package without metadata as originals only', () => {
      const support = preservationSupportFor(false);
      expect(support.find((item) => item.category === 'originals')?.level).toBe('restored');
      const others = support.filter((item) => item.category !== 'originals');
      expect(others.every((item) => item.level === 'not-included')).toBe(true);
    });
  });

  describe('downloadPackage', () => {
    it('refuses a package holding Locked items to a session that has not unlocked', async () => {
      repository.getPackage.mockResolvedValue(packageOf({ includeLocked: true }));
      await expect(sut.downloadPackage(owner, newUuidV7())).rejects.toBeInstanceOf(ForbiddenException);
      expect(storage.createZipStream).not.toHaveBeenCalled();
    });

    it('does not tell a locked session that items were locked after the package was written', async () => {
      repository.getPackage.mockResolvedValue(packageOf());
      repository.hasLockedItems.mockResolvedValue(true);
      const refusal = sut.downloadPackage(owner, newUuidV7());
      await expect(refusal).rejects.toBeInstanceOf(BadRequestException);
      await expect(refusal).rejects.toThrow('This package is not ready to download');
      expect(storage.createZipStream).not.toHaveBeenCalled();
    });

    it('refuses a package that is not written yet or came from elsewhere', async () => {
      repository.getPackage.mockResolvedValue(packageOf({ status: 'building' }));
      await expect(sut.downloadPackage(owner, newUuidV7())).rejects.toBeInstanceOf(BadRequestException);

      repository.getPackage.mockResolvedValue(packageOf({ origin: 'upload' }));
      await expect(sut.downloadPackage(owner, newUuidV7())).rejects.toBeInstanceOf(BadRequestException);
    });

    it('streams the manifest, the documents and exactly the files the index names', async () => {
      const found = packageOf();
      repository.getPackage.mockResolvedValue(found);
      const added: string[] = [];
      storage.createZipStream.mockReturnValue({
        stream: { destroy: vi.fn() },
        addFile: (_path: string, name: string) => {
          added.push(name);
        },
        finalize: () => Promise.resolve(),
      });
      const sourceAssetId = newUuid();
      repository.listedItems
        .mockResolvedValueOnce([
          {
            sourceAssetId,
            entry: {
              original: { path: `originals/${sourceAssetId}.jpg` },
              metadata: { path: `metadata/${sourceAssetId}.json` },
            },
          },
        ])
        .mockResolvedValueOnce([]);

      const download = await sut.downloadPackage(owner, found.id);

      expect(added).toEqual([
        'manifest.json',
        'assets.jsonl',
        `originals/${sourceAssetId}.jpg`,
        `metadata/${sourceAssetId}.json`,
      ]);
      expect(download.disposition).toContain('Italy-2024.frameleaf-preservation.zip');
    });
  });

  describe('removePackage', () => {
    it('deletes an export’s own copy but only forgets a package named on the server', async () => {
      const exported = packageOf();
      repository.getPackage.mockResolvedValue(exported);
      await sut.removePackage(owner, exported.id);
      expect(files.removeDirectory).toHaveBeenCalledWith(exported.path);

      const named = packageOf({ origin: 'server', path: '/backups/italy' });
      repository.getPackage.mockResolvedValue(named);
      files.removeDirectory.mockClear();
      await sut.removePackage(owner, named.id);
      expect(files.removeDirectory).not.toHaveBeenCalled();
      expect(files.removeFile).not.toHaveBeenCalled();
      expect(repository.updatePackage).toHaveBeenCalledWith(named.id, expect.objectContaining({ status: 'removed' }));
    });

    it('refuses while a job is working on the package', async () => {
      repository.getPackage.mockResolvedValue(packageOf());
      repository.activeOperation.mockResolvedValue(operationOf({ status: MediaOperationStatus.Rendering }));
      await expect(sut.removePackage(owner, newUuidV7())).rejects.toBeInstanceOf(ConflictException);
      expect(files.removeDirectory).not.toHaveBeenCalled();
    });
  });

  describe('registerServerPackage', () => {
    it('is for administrators only', async () => {
      await expect(sut.registerServerPackage(owner, { path: '/backups/italy' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(files.resolveServerPackage).not.toHaveBeenCalled();
    });
  });

  describe('restorations', () => {
    it('reviews before it restores', async () => {
      const found = packageOf();
      repository.getPackage.mockResolvedValue(found);
      const restore = restoreOf({ packageId: found.id, status: 'reviewing' });
      repository.createRestore.mockResolvedValue(restore);

      await sut.createRestore(owner, { packageId: found.id });

      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.PreservationReview,
          snapshot: expect.objectContaining({ restoreId: restore.id, packageId: found.id }),
        }),
      );

      repository.getRestore.mockResolvedValue(restore);
      await expect(sut.applyRestore(owner, restore.id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses to restore from an unreadable or removed package', async () => {
      repository.getPackage.mockResolvedValue(packageOf({ status: 'unreadable' }));
      await expect(sut.createRestore(owner, { packageId: newUuidV7() })).rejects.toBeInstanceOf(BadRequestException);
      repository.getPackage.mockResolvedValue(packageOf({ removedAt: new Date() }));
      await expect(sut.createRestore(owner, { packageId: newUuidV7() })).rejects.toBeInstanceOf(BadRequestException);
    });

    it('queues the restore of a reviewed package and gives failed items their retry back', async () => {
      const found = packageOf();
      const restore = restoreOf({ packageId: found.id, status: 'ready' });
      repository.getRestore.mockResolvedValue(restore);
      repository.getPackage.mockResolvedValue(found);

      await sut.applyRestore(owner, restore.id);

      expect(repository.resetFailedRestoreItems).toHaveBeenCalledWith(restore.id);
      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({ kind: MediaOperationKind.PreservationRestore }),
      );
      expect(repository.updateRestore).toHaveBeenCalledWith(restore.id, { status: 'restoring' });
    });

    it('keeps the owner’s choices across a retry of failed items (FL-74)', async () => {
      const found = packageOf();
      const itemId = newUuidV7();
      const restore = restoreOf({
        packageId: found.id,
        status: 'restoring',
        options: { restoreEditRecipes: false, conflictDefault: 'keep' },
      });
      repository.getRestore.mockResolvedValue(restore);
      repository.getPackage.mockResolvedValue(found);

      // The choices made while reviewing, before the first attempt failed part-way.
      await sut.updateDecisions(owner, restore.id, {
        conflictDefault: 'replace',
        items: [{ id: itemId, decisions: { description: 'replace', date: 'keep' } }],
      });
      expect(repository.setDecisions).toHaveBeenCalledWith(restore.id, [
        { id: itemId, decisions: { description: 'replace', date: 'keep' } },
      ]);
      const saved = vi.mocked(repository.updateRestore).mock.calls[0][1] as { options: Record<string, unknown> };
      expect(saved.options).toEqual({ restoreEditRecipes: false, conflictDefault: 'replace' });

      // The retry: what the owner chose is read back, never reset.
      repository.getRestore.mockResolvedValue({ ...restore, options: saved.options });
      repository.setDecisions.mockClear();
      repository.updateRestore.mockClear();
      repository.resetFailedRestoreItems.mockResolvedValue(3);

      await sut.applyRestore(owner, restore.id);

      expect(repository.resetFailedRestoreItems).toHaveBeenCalledWith(restore.id);
      expect(repository.setDecisions).not.toHaveBeenCalled();
      expect(repository.updateRestore).toHaveBeenCalledTimes(1);
      expect(repository.updateRestore).toHaveBeenCalledWith(restore.id, { status: 'restoring' });
      expect(operations.create).toHaveBeenCalledWith(
        expect.objectContaining({
          kind: MediaOperationKind.PreservationRestore,
          settings: { restoreEditRecipes: false, conflictDefault: 'replace' },
        }),
      );
    });

    it('answers a second restore request with the job already running', async () => {
      const restore = restoreOf();
      repository.getRestore.mockResolvedValue(restore);
      const running = operationOf({
        kind: MediaOperationKind.PreservationRestore,
        status: MediaOperationStatus.Rendering,
      });
      repository.activeOperation.mockResolvedValue(running);

      const result = await sut.applyRestore(owner, restore.id);

      expect(result.id).toBe(running.id);
      expect(operations.create).not.toHaveBeenCalled();
    });

    it('lets only an unlocked session decide about Locked items', async () => {
      const restore = restoreOf();
      repository.getRestore.mockResolvedValue(restore);
      const itemId = newUuidV7();
      repository.lockedRestoreItemIds.mockResolvedValue([itemId]);

      await expect(
        sut.updateDecisions(owner, restore.id, { items: [{ id: itemId, decisions: { description: 'replace' } }] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.setDecisions).not.toHaveBeenCalled();

      const items = [{ id: itemId, decisions: { description: 'replace' as const } }];
      await sut.updateDecisions(unlocked, restore.id, { items });
      expect(repository.setDecisions).toHaveBeenCalledWith(restore.id, items);
    });

    it('keeps choices while a restore runs, and accepts them while it is paused', async () => {
      const restore = restoreOf();
      repository.getRestore.mockResolvedValue(restore);
      repository.activeOperation.mockResolvedValue(operationOf({ status: MediaOperationStatus.Rendering }));
      await expect(sut.updateDecisions(owner, restore.id, { conflictDefault: 'replace' })).rejects.toBeInstanceOf(
        ConflictException,
      );

      repository.activeOperation.mockResolvedValue(operationOf({ status: MediaOperationStatus.Paused }));
      await sut.updateDecisions(owner, restore.id, { conflictDefault: 'replace' });
      expect(repository.updateRestore).toHaveBeenCalledWith(restore.id, {
        options: expect.objectContaining({ conflictDefault: 'replace' }),
      });
    });

    it('never lists a Locked restoration item, or its conflicts, to an ordinary session', async () => {
      const restore = restoreOf();
      repository.getRestore.mockResolvedValue(restore);
      const item = {
        id: newUuidV7(),
        restoreId: restore.id,
        sourceAssetId: newUuid(),
        state: 'ready',
        match: 'existing',
        assetId: newUuid(),
        locked: true,
        entry: { originalFileName: 'private.jpg' },
        conflicts: [{ field: 'description', archived: 'a', current: 'b' }],
        decisions: null,
        findings: null,
        reasonKey: null,
        error: null,
        appliedAt: null,
      } as unknown as PreservationRestoreItem;
      repository.listRestoreItems.mockResolvedValue({ items: [item], total: 1 });

      const hidden = await sut.getRestoreItems(owner, restore.id, {});
      expect(repository.listRestoreItems).toHaveBeenLastCalledWith(
        restore.id,
        expect.objectContaining({ excludeLocked: true }),
      );
      expect(hidden.items).toEqual([]);

      const shown = await sut.getRestoreItems(unlocked, restore.id, {});
      expect(repository.listRestoreItems).toHaveBeenLastCalledWith(
        restore.id,
        expect.objectContaining({ excludeLocked: false }),
      );
      expect(shown.items[0]).toMatchObject({
        locked: true,
        name: 'private.jpg',
        conflicts: [{ field: 'description', archived: 'a', current: 'b', decision: null }],
      });
    });

    it('does not tell an ordinary session how many Locked items a restoration holds', async () => {
      const restore = restoreOf();
      repository.getRestore.mockResolvedValue(restore);
      expect((await sut.getRestore(owner, restore.id)).counts.locked).toBe(0);
      expect(repository.countRestoreItems).toHaveBeenLastCalledWith(restore.id, { excludeLocked: true });
      expect((await sut.getRestore(unlocked, restore.id)).counts.locked).toBe(4);
      expect(repository.countRestoreItems).toHaveBeenLastCalledWith(restore.id, { excludeLocked: false });
    });
  });

  describe('onUserDelete', () => {
    it('removes the preservation folders of a deleted account', async () => {
      await sut.onUserDelete({ id: owner.user.id } as never);
      expect(files.removeDirectory).toHaveBeenCalledTimes(2);
    });
  });
});
