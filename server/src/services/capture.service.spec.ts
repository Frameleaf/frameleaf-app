import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CaptureCancelResponseDto, CaptureCommitDto, CaptureResponseDto } from 'src/dtos/capture.dto.js';
import { LibraryScope, Permission } from 'src/enum.js';
import { CaptureReceipt, CaptureRepository } from 'src/repositories/capture.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { TrashRepository } from 'src/repositories/trash.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetUploadResourceService } from 'src/services/asset-upload-resource.service.js';
import { BookmarkService } from 'src/services/bookmark.service.js';
import { CaptureService } from 'src/services/capture.service.js';
import { captureRequestHash } from 'src/utils/capture.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { automock, mockBaseService } from 'test/utils.js';

const auth = {
  ...authStub.user1,
  user: { ...authStub.user1.user, id: randomUUID() },
  apiKey: { id: randomUUID(), permissions: [Permission.CaptureCreate, Permission.CaptureCatalogRead] },
};
const dto = CaptureCommitDto.schema.parse({
  captureId: randomUUID(),
  albumId: randomUUID(),
  note: 'Initial note',
  bookmark: { url: 'https://example.org', title: 'Reference' },
  source: { pageUrl: 'https://example.org', title: 'Page title', capturedAt: new Date().toISOString() },
});
const receipt: CaptureReceipt = {
  ownerId: auth.user.id,
  actorId: `key:${auth.apiKey.id}`,
  captureId: dto.captureId,
  requestHash: captureRequestHash(dto),
  kind: 'bookmark',
  itemId: randomUUID(),
  status: 'created',
  createdAt: new Date(),
};

describe('capture application boundary', () => {
  const captures = automock(CaptureRepository, { args: [{}] });
  const uploads = automock(AssetUploadResourceService);
  const bookmarks = automock(BookmarkService);
  const albums = mockBaseService(AlbumService);
  const tags = automock(TagRepository, { args: [{}, { setContext: () => {} }] });
  const system = automock(SystemMetadataRepository, { args: [{}] });
  const trash = automock(TrashRepository);
  const events = automock(EventRepository, { args: [undefined, undefined, { setContext: () => {} }], strict: false });
  const service = new CaptureService(captures, uploads, bookmarks, albums, tags, system, trash, events);
  beforeEach(() => {
    captures.resetAllMocks();
    uploads.resetAllMocks();
    bookmarks.resetAllMocks();
    albums.resetAllMocks();
    tags.resetAllMocks();
    system.resetAllMocks();
    trash.resetAllMocks();
    events.resetAllMocks();
    captures.getCompleted.mockResolvedValueOnce(undefined).mockResolvedValue(receipt);
    captures.commitBookmark.mockResolvedValue(receipt);
    captures.getTrashedCapture.mockResolvedValue(undefined);
    uploads.captureResource.mockResolvedValue({} as never);
    uploads.result.mockResolvedValue({ resource: { state: 'published', verifiedChecksum: null } } as never);
    bookmarks.get.mockResolvedValue({
      id: receipt.itemId,
      ownerId: auth.user.id,
      url: 'https://changed.example.org',
      title: 'Later title',
      note: 'Later private note',
      libraryScope: LibraryScope.Design,
      isArchived: false,
      isLocked: false,
      previewAssetId: null,
      deletedAt: null,
      createdAt: new Date().toISOString(),
      updatedAt: new Date().toISOString(),
      updateId: randomUUID(),
    });
  });

  it('acknowledges a bookmark cancellation without creating or exposing an item', async () => {
    captures.cancel.mockResolvedValue({ ...receipt, status: 'cancelled', itemId: dto.captureId });
    const result = await service.cancel(auth, dto);
    expect(result).toEqual({ captureId: dto.captureId, status: 'cancelled' });
    expect(CaptureCancelResponseDto.schema.safeParse(result).success).toBe(true);
    expect(captures.commitBookmark).not.toHaveBeenCalled();
    expect(bookmarks.get).not.toHaveBeenCalled();
    expect(uploads.cancel).not.toHaveBeenCalled();
    expect(
      CaptureCancelResponseDto.schema.safeParse({ ...result, receipt: { captureId: dto.captureId } }).success,
    ).toBe(false);
    expect(
      CaptureCancelResponseDto.schema.safeParse({ captureId: dto.captureId, status: 'already-published' }).success,
    ).toBe(false);
  });
  it('returns an already published receipt without cancelling its media', async () => {
    captures.cancel.mockResolvedValue(receipt);
    const result = await service.cancel(auth, dto);
    expect(result).toMatchObject({
      captureId: dto.captureId,
      status: 'already-published',
      receipt: {
        captureId: dto.captureId,
        status: 'created',
        item: { kind: 'bookmark', bookmark: { title: 'Reference', url: 'https://example.org' } },
      },
    });
    expect(CaptureCancelResponseDto.schema.safeParse(result).success).toBe(true);
    expect(uploads.cancel).not.toHaveBeenCalled();
    expect(captures.commitBookmark).not.toHaveBeenCalled();
  });
  it('cleans an unpublished resource after its tombstone, accepts absent resources and retains cleanup failures', async () => {
    const file = { ...dto, bookmark: undefined, uploadResourceId: dto.captureId, sha256: 'a'.repeat(64) };
    uploads.cancel.mockResolvedValue(undefined);
    captures.cancel.mockResolvedValue({ ...receipt, kind: 'asset', status: 'cancelled', itemId: dto.captureId });
    expect(await service.cancel(auth, file)).toEqual({ captureId: dto.captureId, status: 'cancelled' });
    expect(uploads.cancel).toHaveBeenCalledWith(auth, dto.captureId);
    uploads.cancel.mockRejectedValueOnce(new NotFoundException());
    expect((await service.cancel(auth, file)).status).toBe('cancelled');
    uploads.cancel.mockRejectedValueOnce(new Error('cleanup failed'));
    await expect(service.cancel(auth, file)).rejects.toThrow('cleanup failed');
  });
  it('never interprets a cancellation tombstone as a normal saved receipt', async () => {
    captures.getCompleted.mockReset().mockResolvedValue({ ...receipt, status: 'cancelled', itemId: dto.captureId });
    await expect(service.commit(auth, dto)).rejects.toThrow('cancelled');
    expect(bookmarks.get).not.toHaveBeenCalled();
    expect(captures.commitBookmark).not.toHaveBeenCalled();
  });

  it('acknowledges a durable bookmark receipt using its submitted fields, without exposing later private edits', async () => {
    const result = await service.commit(auth, dto);
    expect(CaptureResponseDto.schema.safeParse(result).success).toBe(true);
    expect(result.item).toEqual({
      kind: 'bookmark',
      bookmark: expect.objectContaining({ title: 'Reference', url: 'https://example.org', note: 'Initial note' }),
    });
    expect(uploads.commitCapture).not.toHaveBeenCalled();
  });

  it('replays an existing receipt without allocating or publishing again', async () => {
    captures.getCompleted.mockReset().mockResolvedValue(receipt);
    await service.commit(auth, dto);
    expect(captures.commitBookmark).not.toHaveBeenCalled();
    expect(uploads.commitCapture).not.toHaveBeenCalled();
  });

  it('never acknowledges a source failure or performs a second untracked attachment step', async () => {
    const file = { ...dto, bookmark: undefined, uploadResourceId: dto.captureId, sha256: 'a'.repeat(64) };
    uploads.commitCapture.mockImplementation(async (_auth, _id, _sha256, apply) => apply({} as never, vi.fn()));
    captures.commitFile.mockRejectedValue(new Error('source write failed'));
    await expect(service.commit(auth, file)).rejects.toThrow('source write failed');
    expect(captures.getCompleted).toHaveBeenCalledTimes(1);
    expect(captures.commitBookmark).not.toHaveBeenCalled();
  });

  it('brings a trashed Boards copy of the same bytes back before publication reuses it', async () => {
    const file = { ...dto, bookmark: undefined, uploadResourceId: dto.captureId, sha256: 'a'.repeat(64) };
    const asset = AssetFactory.create({ ownerId: auth.user.id, libraryScope: LibraryScope.Design });
    captures.getCompleted
      .mockReset()
      .mockResolvedValueOnce(undefined)
      .mockResolvedValue({
        ...receipt,
        kind: 'asset',
        itemId: asset.id,
        status: 'duplicate',
      });
    captures.getTrashedCapture.mockResolvedValue(asset.id);
    uploads.captureResource.mockResolvedValue({} as never);
    uploads.result.mockResolvedValue({
      resource: { state: 'verified', verifiedChecksum: Buffer.from('a'.repeat(64), 'hex') },
    } as never);
    trash.restoreAll.mockResolvedValue([asset.id]);
    uploads.commitCapture.mockResolvedValue(undefined as never);
    captures.getCapturedAsset.mockResolvedValue(asset);
    const result = await service.commit(auth, file);
    expect(captures.getTrashedCapture).toHaveBeenCalledWith(auth, 'a'.repeat(64));
    expect(trash.restoreAll).toHaveBeenCalledWith([asset.id], auth, expect.any(Function));
    expect(events.emit).toHaveBeenCalledWith('AssetRestoreAll', { assetIds: [asset.id], userId: auth.user.id });
    expect(trash.restoreAll.mock.invocationCallOrder[0]).toBeLessThan(
      uploads.commitCapture.mock.invocationCallOrder[0],
    );
    expect(result.status).toBe('duplicate');
  });

  it('leaves the Trash alone until the capture upload holds the verified bytes', async () => {
    const file = { ...dto, bookmark: undefined, uploadResourceId: dto.captureId, sha256: 'a'.repeat(64) };
    captures.getTrashedCapture.mockResolvedValue(randomUUID());
    uploads.commitCapture.mockRejectedValue(new NotFoundException('Capture unavailable'));
    uploads.captureResource.mockRejectedValueOnce(new NotFoundException('Capture unavailable'));
    await expect(service.commit(auth, file)).rejects.toThrow(NotFoundException);
    for (const resource of [
      { state: 'uploading', verifiedChecksum: null },
      { state: 'verified', verifiedChecksum: Buffer.from('b'.repeat(64), 'hex') },
    ]) {
      captures.getCompleted.mockReset().mockResolvedValue(undefined);
      uploads.captureResource.mockResolvedValue({} as never);
      uploads.result.mockResolvedValue({ resource } as never);
      await expect(service.commit(auth, file)).rejects.toThrow(NotFoundException);
    }
    expect(captures.getTrashedCapture).not.toHaveBeenCalled();
    expect(trash.restoreAll).not.toHaveBeenCalled();
  });

  it('does not return an asset receipt whose media became protected', async () => {
    const file = { ...dto, bookmark: undefined, uploadResourceId: dto.captureId, sha256: 'a'.repeat(64) };
    captures.getCompleted.mockReset().mockResolvedValue({ ...receipt, kind: 'asset' });
    captures.getCapturedAsset.mockResolvedValue(undefined);
    await expect(service.commit(auth, file)).rejects.toThrow(NotFoundException);
  });

  it('returns media without unrelated owner metadata or filesystem paths', async () => {
    const file = { ...dto, bookmark: undefined, uploadResourceId: dto.captureId, sha256: 'a'.repeat(64) };
    const asset = AssetFactory.create({ ownerId: auth.user.id, libraryScope: LibraryScope.Design });
    captures.getCompleted.mockReset().mockResolvedValue({ ...receipt, kind: 'asset', itemId: asset.id });
    captures.getCapturedAsset.mockResolvedValue(asset);
    const result = await service.commit(auth, file);
    expect(CaptureResponseDto.schema.safeParse(result).success).toBe(true);
    expect(result.item.kind).toBe('asset');
    expect(result.item).not.toHaveProperty('asset.originalPath');
    expect(result.item).not.toHaveProperty('asset.exifInfo');
  });

  it('uses the local server/account identity without a paid entitlement dependency', async () => {
    captures.assertActor.mockResolvedValue(`key:${auth.apiKey.id}`);
    system.get.mockResolvedValue({ id: 'local-server', createdAt: new Date().toISOString() } as never);
    uploads.limits.mockResolvedValue({ maxSize: 1024, maxAppendSize: 1024, maxAge: 86_400, maxActive: 4 });
    expect(await service.capabilities(auth)).toEqual({
      version: 1,
      serverId: 'local-server',
      userId: auth.user.id,
      userName: auth.user.name,
      maxFileBytes: 1024,
      captureSupported: true,
      cancellationSupported: true,
    });
  });

  it('creates an ordinary design album through the existing album service', async () => {
    captures.assertActor.mockResolvedValue(`key:${auth.apiKey.id}`);
    captures.assertParent.mockResolvedValue(undefined);
    albums.create.mockResolvedValue({ id: randomUUID() } as never);
    await service.createAlbum(auth, { name: 'References', parentId: dto.albumId, libraryScope: LibraryScope.Design });
    expect(albums.create).toHaveBeenCalledWith(auth, {
      albumName: 'References',
      parentId: dto.albumId,
      libraryScope: LibraryScope.Design,
    });
  });
});
