import { RequestMethod } from '@nestjs/common';
import { HEADERS_METADATA, METHOD_METADATA, PATH_METADATA } from '@nestjs/common/constants.js';
import { Reflector } from '@nestjs/core';
import { CloudBackupOwnerController } from 'src/controllers/cloud-backup-owner.controller.js';
import { Permission } from 'src/enum.js';
import { getAuthenticatedOptions } from 'src/middleware/auth.guard.js';
import { authStub } from 'test/fixtures/auth.stub.js';

const reflector = new Reflector();
describe('owner backup route scopes', () => {
  it('requires write permission, keeps non-refreshing elevation, and reauthenticates owner restore with the same permission', async () => {
    expect(
      getAuthenticatedOptions(reflector, CloudBackupOwnerController.prototype.restoreOwnBackupItems),
    ).toMatchObject({ permission: Permission.AssetUpdate, refreshElevation: false });
    const authenticate = vi.fn().mockResolvedValue(authStub.user1);
    const service = {
      startOwnerRestore: vi.fn(async (_auth, _dto, refresh: () => Promise<unknown>) => {
        await refresh();
        return { operationId: 'own', status: 'queued' };
      }),
    };
    const controller = new CloudBackupOwnerController(service as never, { authenticate } as never);
    await expect(
      controller.restoreOwnBackupItems(authStub.user1, { manifestKey: 'm/own', assetIds: ['own'] }, {
        headers: {},
        query: {},
        path: '/users/me/cloud-backup/restore',
      } as never),
    ).resolves.toEqual({ operationId: 'own', status: 'queued' });
    expect(authenticate).toHaveBeenCalledWith(
      expect.objectContaining({
        metadata: expect.objectContaining({
          permission: Permission.AssetUpdate,
          adminRoute: false,
          sharedLinkRoute: false,
          refreshElevation: false,
        }),
      }),
    );
  });

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

describe('owner setup progress route (FL-234)', () => {
  it('is an owner-only (administrator) cloud backup status read that never needs or extends PIN elevation', () => {
    const options = getAuthenticatedOptions(reflector, CloudBackupOwnerController.prototype.getOwnSetupProgress);
    expect(options).toMatchObject({
      permission: Permission.AdminCloudBackupRead,
      admin: true,
      refreshElevation: false,
    });
    expect(options).not.toMatchObject({ sharedLink: true });
  });

  it('serves GET users/me/cloud-backup/setup without caching and passes the caller to the service', async () => {
    const proto = CloudBackupOwnerController.prototype.getOwnSetupProgress;
    expect(reflector.get(PATH_METADATA, proto)).toBe('setup');
    expect(reflector.get(METHOD_METADATA, proto)).toBe(RequestMethod.GET);
    expect(reflector.get(HEADERS_METADATA, proto)).toEqual(
      expect.arrayContaining([{ name: 'Cache-Control', value: 'private, no-store' }]),
    );
    const service = { getOwnerSetup: vi.fn().mockResolvedValue({ target: 'off' }) };
    const controller = new CloudBackupOwnerController(service as never, {} as never);
    await expect(controller.getOwnSetupProgress(authStub.admin)).resolves.toEqual({ target: 'off' });
    expect(service.getOwnerSetup).toHaveBeenCalledWith(authStub.admin);
  });
});
