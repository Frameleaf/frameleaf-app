import { BadRequestException, NotFoundException } from '@nestjs/common';
import { LibraryScope } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetSourceRepository } from 'src/repositories/asset-source.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { AssetSourceService } from 'src/services/asset-source.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newAccessRepositoryMock } from 'test/repositories/access.repository.mock.js';
import { automock, getMocks } from 'test/utils.js';

describe('private capture source reads', () => {
  const sources = automock(AssetSourceRepository, { args: [{}] });
  const mocks = getMocks();
  const service = new AssetSourceService(
    sources,
    mocks.asset as unknown as AssetRepository,
    mocks.access as unknown as AccessRepository,
  );
  beforeEach(() => {
    sources.resetAllMocks();
    mocks.asset.getById.mockResolvedValue({ ownerId: authStub.user1.user.id } as never);
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset']));
    mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set());
    mocks.access.asset.checkItemShareAccess.mockResolvedValue(new Set());
  });

  it('never returns private sources to a shared link, even with owner user identity', async () => {
    const auth = { ...authStub.user1, sharedLink: authStub.adminSharedLink.sharedLink };
    await expect(service.getAll(auth, 'asset')).rejects.toThrow(NotFoundException);
    expect(sources.getAll).not.toHaveBeenCalled();
  });

  it('does not expose provenance to another album member who may read the media', async () => {
    await expect(service.getAll(authStub.admin, 'asset')).rejects.toThrow(NotFoundException);
    expect(sources.getAll).not.toHaveBeenCalled();
  });

  it('checks media privacy before returning owner sources', async () => {
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
    await expect(service.getAll(authStub.user1, 'asset')).rejects.toThrow();
    expect(sources.getAll).not.toHaveBeenCalled();
  });

  it('returns the owner’s sources after media access succeeds', async () => {
    sources.getAll.mockResolvedValue([]);
    expect(await service.getAll(authStub.user1, 'asset')).toEqual([]);
    expect(sources.getAll).toHaveBeenCalledWith('asset');
  });
});

const assetId = '6b0bd5a4-2f52-4e2a-9d2c-0d9a7b4c1f10';
const created = new Date('2026-10-20T10:00:00.000Z');
const row = {
  id: 'a2b1f0e4-8c9d-4d3e-9f0a-1b2c3d4e5f60',
  assetId,
  captureId: '0f1e2d3c-4b5a-4968-8776-a5b4c3d2e1f0',
  pageUrl: 'https://example.com/board',
  mediaUrl: null,
  title: '',
  capturedAt: created,
  note: null,
  creator: null,
  licenseUrl: null,
  importedFrom: 'eagle' as const,
  createdAt: created,
};

describe(AssetSourceService.name, () => {
  let sut: AssetSourceService;
  let access: ReturnType<typeof newAccessRepositoryMock>;
  let assets: { getById: ReturnType<typeof vitest.fn> };
  let sources: {
    getAll: ReturnType<typeof vitest.fn>;
    addImported: ReturnType<typeof vitest.fn>;
    moveAddedDateEarlier: ReturnType<typeof vitest.fn>;
  };
  const owned = (overrides: Record<string, unknown> = {}) =>
    assets.getById.mockResolvedValue({
      id: assetId,
      ownerId: authStub.user1.user.id,
      libraryScope: LibraryScope.Design,
      deletedAt: null,
      createdAt: created,
      ...overrides,
    });

  beforeEach(() => {
    access = newAccessRepositoryMock();
    access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
    assets = { getById: vitest.fn() };
    sources = {
      getAll: vitest.fn().mockResolvedValue([{ ...row, importedFrom: null }]),
      addImported: vitest.fn().mockResolvedValue(row),
      moveAddedDateEarlier: vitest.fn().mockResolvedValue(true),
    };
    sut = new AssetSourceService(
      sources as unknown as AssetSourceRepository,
      assets as unknown as AssetRepository,
      access as unknown as AccessRepository,
    );
  });

  describe('getAll', () => {
    it('marks a source the extension saved as not imported', async () => {
      owned();
      await expect(sut.getAll(authStub.user1, assetId)).resolves.toEqual([
        expect.objectContaining({ importedFrom: null, capturedAt: created.toISOString() }),
      ]);
    });
  });

  describe('addImported', () => {
    it('adds an Eagle address to your own item', async () => {
      owned();
      await expect(
        sut.addImported(authStub.user1, assetId, {
          importedFrom: 'eagle',
          pageUrl: 'https://example.com/board',
          title: '  Board  ',
        }),
      ).resolves.toEqual(expect.objectContaining({ importedFrom: 'eagle', pageUrl: 'https://example.com/board' }));
      expect(sources.addImported).toHaveBeenCalledWith({
        assetId,
        importedFrom: 'eagle',
        pageUrl: 'https://example.com/board',
        title: 'Board',
      });
      expect(access.asset.checkOwnerAccess).toHaveBeenCalled();
    });

    it("refuses someone else's item as not found", async () => {
      owned({ ownerId: authStub.admin.user.id });
      await expect(
        sut.addImported(authStub.user1, assetId, { importedFrom: 'eagle', pageUrl: 'https://example.com/' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(sources.addImported).not.toHaveBeenCalled();
    });

    it('refuses a shared link', async () => {
      await expect(
        sut.addImported(authStub.adminSharedLink, assetId, { importedFrom: 'eagle', pageUrl: 'https://example.com/' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(assets.getById).not.toHaveBeenCalled();
    });

    it('refuses an item in the trash', async () => {
      owned({ deletedAt: created });
      await expect(
        sut.addImported(authStub.user1, assetId, { importedFrom: 'eagle', pageUrl: 'https://example.com/' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses when the owner check fails (locked or hidden)', async () => {
      owned();
      access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(
        sut.addImported(authStub.user1, assetId, { importedFrom: 'eagle', pageUrl: 'https://example.com/' }),
      ).rejects.toBeDefined();
      expect(sources.addImported).not.toHaveBeenCalled();
    });
  });

  describe('setAddedDate', () => {
    const earlier = '2024-03-01T12:00:00.000Z';

    it('moves the Added date of your own Boards item earlier', async () => {
      owned();
      await sut.setAddedDate(authStub.user1, assetId, { addedAt: earlier });
      expect(sources.moveAddedDateEarlier).toHaveBeenCalledWith({
        assetId,
        ownerId: authStub.user1.user.id,
        addedAt: new Date(earlier),
      });
    });

    it('refuses a time in the future', async () => {
      owned();
      await expect(
        sut.setAddedDate(authStub.user1, assetId, { addedAt: new Date(Date.now() + 60_000).toISOString() }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(sources.moveAddedDateEarlier).not.toHaveBeenCalled();
    });

    it('refuses a time later than the item was added', async () => {
      owned({ createdAt: new Date('2023-01-01T00:00:00.000Z') });
      await expect(sut.setAddedDate(authStub.user1, assetId, { addedAt: earlier })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(sources.moveAddedDateEarlier).not.toHaveBeenCalled();
    });

    it.each([LibraryScope.Personal, LibraryScope.Both])('refuses an item in %s', async (libraryScope) => {
      owned({ libraryScope });
      await expect(sut.setAddedDate(authStub.user1, assetId, { addedAt: earlier })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(sources.moveAddedDateEarlier).not.toHaveBeenCalled();
    });

    it("refuses someone else's item as not found", async () => {
      owned({ ownerId: authStub.admin.user.id });
      await expect(sut.setAddedDate(authStub.user1, assetId, { addedAt: earlier })).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('reports a change that lost a race', async () => {
      owned();
      sources.moveAddedDateEarlier.mockResolvedValue(false);
      await expect(sut.setAddedDate(authStub.user1, assetId, { addedAt: earlier })).rejects.toBeInstanceOf(
        BadRequestException,
      );
    });
  });
});
