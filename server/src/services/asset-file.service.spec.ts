import { AssetFileType, JobName } from 'src/enum.js';
import { AssetFileService } from 'src/services/asset-file.service.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

/**
 * FL-34 (ported from PR131 02db47e12c): a derivative file is as private as its source asset, so the
 * caller's hidden-content filter reaches the file-id access check for read, download and delete.
 */
describe(AssetFileService.name, () => {
  let sut: AssetFileService;
  let mocks: ServiceMocks;

  const fileId = newUuid();
  const file = { id: fileId, assetId: newUuid(), path: '/synthetic/preview.jpeg', type: AssetFileType.Preview };
  const methods = ['get', 'download', 'delete'] as const;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(AssetFileService));
    mocks.assetFile.get.mockResolvedValue(file as never);
    mocks.assetFile.delete.mockResolvedValue(undefined as never);
    mocks.job.queue.mockResolvedValue();
  });

  it.each(methods)('passes the hidden-content filter to the derivative access check (%s)', async (method) => {
    const hiddenContent = {
      userId: 'owner',
      includeNsfw: false,
      tagIds: ['tag'],
      personIds: [],
      petIds: [],
      scope: 'owned',
    };
    const auth = { ...AuthFactory.create({ id: 'owner' }), hiddenContent } as never;
    mocks.access.assetFile.checkOwnerAccess.mockResolvedValue(new Set([fileId]));

    await sut[method](auth, fileId);

    expect(mocks.access.assetFile.checkOwnerAccess).toHaveBeenCalledWith(
      'owner',
      new Set([fileId]),
      undefined,
      hiddenContent,
    );
  });

  it.each(methods)('passes the sensitive-only filter of a locked session (%s)', async (method) => {
    const auth = { ...AuthFactory.create({ id: 'owner' }), hideNsfwAssets: true };
    mocks.access.assetFile.checkOwnerAccess.mockResolvedValue(new Set([fileId]));

    await sut[method](auth, fileId);

    expect(mocks.access.assetFile.checkOwnerAccess).toHaveBeenCalledWith('owner', new Set([fileId]), undefined, true);
  });

  it.each(methods)('refuses %s of a derivative whose source the filter hides, deleting nothing', async (method) => {
    const auth = { ...AuthFactory.create({ id: 'owner' }), hideNsfwAssets: true };
    mocks.access.assetFile.checkOwnerAccess.mockResolvedValue(new Set());

    await expect(sut[method](auth, fileId)).rejects.toThrow();

    expect(mocks.assetFile.get).not.toHaveBeenCalled();
    expect(mocks.assetFile.delete).not.toHaveBeenCalled();
    expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.FileDelete }));
  });

  it('keeps the unfiltered owner check when nothing is hidden', async () => {
    const auth = AuthFactory.from({ id: 'owner' }).session({ hasElevatedPermission: true }).build();
    mocks.access.assetFile.checkOwnerAccess.mockResolvedValue(new Set([fileId]));

    await sut.download(auth, fileId);

    expect(mocks.access.assetFile.checkOwnerAccess).toHaveBeenCalledWith('owner', new Set([fileId]), true);
  });
});
