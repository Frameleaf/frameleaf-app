import { NotFoundException } from '@nestjs/common';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetSourceRepository } from 'src/repositories/asset-source.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { AssetSourceService } from 'src/services/asset-source.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
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
