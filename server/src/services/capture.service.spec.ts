import { NotFoundException } from '@nestjs/common';
import { randomUUID } from 'node:crypto';
import { CaptureCommitDto, CaptureResponseDto } from 'src/dtos/capture.dto.js';
import { LibraryScope, Permission } from 'src/enum.js';
import { CaptureReceipt, CaptureRepository } from 'src/repositories/capture.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
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
  const service = new CaptureService(captures, uploads, bookmarks, albums, tags, system);
  beforeEach(() => {
    captures.resetAllMocks();
    uploads.resetAllMocks();
    bookmarks.resetAllMocks();
    albums.resetAllMocks();
    tags.resetAllMocks();
    system.resetAllMocks();
    captures.getCompleted.mockResolvedValueOnce(undefined).mockResolvedValue(receipt);
    captures.commitBookmark.mockResolvedValue(receipt);
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
      maxFileBytes: 1024,
      captureSupported: true,
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
