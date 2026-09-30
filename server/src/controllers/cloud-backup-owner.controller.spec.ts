import { Reflector } from '@nestjs/core';
import { CloudBackupOwnerController } from 'src/controllers/cloud-backup-owner.controller.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const reflector = new Reflector();
describe('owner backup route scopes', () => {
  it('uses media-view permission for binary thumbnails, not metadata-only read', () => {
    expect(
      getAuthenticatedOptions(reflector, CloudBackupOwnerController.prototype.getOwnBackupThumbnail),
    ).toMatchObject({ permission: Permission.AssetView, refreshElevation: false });
  });
  it('reauthenticates binary reads with the same media permission after remote work', async () => {
    const authenticate = vi.fn().mockResolvedValue(authStub.user1);
    const service = {
      readOwnerThumbnail: vi.fn(async (_auth, _id, _key, refresh: () => Promise<unknown>) => {
        await refresh();
        return Buffer.from('preview');
      }),
    };
    const controller = new CloudBackupOwnerController(service as never, { authenticate } as never);
    await controller.getOwnBackupThumbnail(
      authStub.user1,
      { id: 'item' },
      { manifestKey: 'm/run.json.gz', offset: 0, limit: 1 },
      { headers: {}, query: {}, path: '/users/me/cloud-backup/history/item/thumbnail' } as never,
    );
    expect(authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          permission: Permission.AssetView,
          sharedLinkRoute: false,
          adminRoute: false,
          refreshElevation: false,
        }),
      }),
    );
  });
  it.each(['listOwnKeptBackups', 'getOwnBackupHistory'] as const)(
    '%s requires ordinary asset.read without admin/shared grants',
    (method) => {
      const options = getAuthenticatedOptions(reflector, CloudBackupOwnerController.prototype[method]);
      expect(options).toMatchObject({ permission: Permission.AssetRead, refreshElevation: false });
      expect(options).not.toMatchObject({ admin: true });
      expect(options).not.toMatchObject({ sharedLink: true });
    },
  );
});
