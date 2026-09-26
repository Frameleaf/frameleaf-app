import {
  BadRequestException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { vitest } from 'vitest';
import { AssetFile } from 'src/database.js';
import { AssetMediaStatus, AssetRejectReason, AssetUploadAction } from 'src/dtos/asset-media-response.dto.js';
import { AssetMediaCreateDto, AssetMediaSize, UploadFieldName } from 'src/dtos/asset-media.dto.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetFileType, AssetLockReason, AssetType, AssetVisibility, CacheControl, JobName } from 'src/enum.js';
import { AuthRequest } from 'src/middleware/auth.guard.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { UploadBody } from 'src/types.js';
import { clearConfigCache } from 'src/utils/config.js';
import { ASSET_CHECKSUM_CONSTRAINT } from 'src/utils/database.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { AssetFileFactory } from 'test/factories/asset-file.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { PartnerFactory } from 'test/factories/partner.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { fileStub } from 'test/fixtures/file.stub.js';
import { userStub } from 'test/fixtures/user.stub.js';
import { getForAsset, getForPartner } from 'test/mappers.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const file1 = Buffer.from('d2947b871a706081be194569951b7db246907957', 'hex');

const uploadFile = {
  nullAuth: {
    auth: null,
    body: {},
    fieldName: UploadFieldName.ASSET_DATA,
    file: {
      uuid: 'random-uuid',
      checksum: Buffer.from('checksum', 'utf8'),
      originalPath: '/data/library/admin/image.jpeg',
      originalName: 'image.jpeg',
      size: 1000,
    },
  },
  filename: (fieldName: UploadFieldName, filename: string, body?: UploadBody) => {
    return {
      auth: authStub.admin,
      body: body || {},
      fieldName,
      file: {
        uuid: 'random-uuid',
        mimeType: 'image/jpeg',
        checksum: Buffer.from('checksum', 'utf8'),
        originalPath: `/data/admin/${filename}`,
        originalName: filename,
        size: 1000,
      },
    };
  },
};

const validImages = [
  '.3fr',
  '.ari',
  '.arw',
  '.avif',
  '.cap',
  '.cin',
  '.cr2',
  '.cr3',
  '.crw',
  '.dcr',
  '.dng',
  '.erf',
  '.fff',
  '.gif',
  '.heic',
  '.heif',
  '.iiq',
  '.jp2',
  '.jpeg',
  '.jpg',
  '.jxl',
  '.k25',
  '.kdc',
  '.mpo',
  '.mrw',
  '.nef',
  '.orf',
  '.ori',
  '.pef',
  '.png',
  '.psd',
  '.raf',
  '.raw',
  '.rwl',
  '.sr2',
  '.srf',
  '.srw',
  '.svg',
  '.tiff',
  '.webp',
  '.x3f',
];

const validVideos = [
  '.3gp',
  '.avi',
  '.flv',
  '.m2t',
  '.m2ts',
  '.mkv',
  '.mov',
  '.mp4',
  '.mpg',
  '.mts',
  '.mxf',
  '.ts',
  '.vob',
  '.webm',
  '.wmv',
];

const uploadTests = [
  {
    label: 'asset images',
    fieldName: UploadFieldName.ASSET_DATA,
    valid: validImages,
    invalid: ['.html', '.xml'],
  },
  {
    label: 'asset videos',
    fieldName: UploadFieldName.ASSET_DATA,
    valid: validVideos,
    invalid: ['.html', '.xml'],
  },
  {
    label: 'sidecar',
    fieldName: UploadFieldName.SIDECAR_DATA,
    valid: ['.xmp'],
    invalid: ['.html', '.jpeg', '.jpg', '.mov', '.mp4', '.xml'],
  },
  {
    label: 'profile',
    fieldName: UploadFieldName.PROFILE_DATA,
    valid: ['.avif', '.dng', '.heic', '.heif', '.jpeg', '.jpg', '.png', '.webp'],
    invalid: ['.arf', '.cr2', '.html', '.mov', '.mp4', '.xml'],
  },
];

const createDto = Object.freeze({
  fileCreatedAt: new Date('2022-06-19T23:41:36.910Z'),
  fileModifiedAt: new Date('2022-06-19T23:41:36.910Z'),
  isFavorite: false,
}) as AssetMediaCreateDto;

const assetEntity: any = Object.freeze({
  id: 'id_1',
  ownerId: 'user_id_1',
  type: AssetType.Video,
  originalPath: 'fake_path/asset_1.jpeg',
  physicalOriginalFileId: null,
  fileModifiedAt: new Date('2022-06-19T23:41:36.910Z'),
  fileCreatedAt: new Date('2022-06-19T23:41:36.910Z'),
  updatedAt: new Date('2022-06-19T23:41:36.910Z'),
  isFavorite: false,
  duration: null,
  files: [] as AssetFile[],
  exifInfo: {
    latitude: 49.533547,
    longitude: 10.703075,
  },
  livePhotoVideoId: null,
});

describe(AssetMediaService.name, () => {
  let sut: AssetMediaService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    clearConfigCache();
    ({ sut, mocks } = newTestService(AssetMediaService));
    mocks.partner.getAll.mockResolvedValue([]);
  });

  describe('getUploadAssetIdByChecksum', () => {
    it('should return if checksum is undefined', async () => {
      await expect(sut.getUploadAssetIdByChecksum(authStub.admin)).resolves.toBe(undefined);
    });

    it('should handle a non-existent asset', async () => {
      await expect(sut.getUploadAssetIdByChecksum(authStub.admin, file1.toString('hex'))).resolves.toBeUndefined();
      expect(mocks.asset.getUploadAssetIdByChecksum).toHaveBeenCalledWith(authStub.admin.user.id, file1);
    });

    it('should find an existing asset', async () => {
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue('asset-id');
      await expect(sut.getUploadAssetIdByChecksum(authStub.admin, file1.toString('hex'))).resolves.toEqual({
        id: 'asset-id',
        status: AssetMediaStatus.DUPLICATE,
      });
      expect(mocks.asset.getUploadAssetIdByChecksum).toHaveBeenCalledWith(authStub.admin.user.id, file1);
    });

    it('should find an existing asset by base64', async () => {
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue('asset-id');
      await expect(sut.getUploadAssetIdByChecksum(authStub.admin, file1.toString('base64'))).resolves.toEqual({
        id: 'asset-id',
        status: AssetMediaStatus.DUPLICATE,
      });
      expect(mocks.asset.getUploadAssetIdByChecksum).toHaveBeenCalledWith(authStub.admin.user.id, file1);
    });

    it('should hide duplicate checksum ids in hidden NSFW mode', async () => {
      const auth = { ...authStub.admin, hideNsfwAssets: true };

      await expect(sut.getUploadAssetIdByChecksum(auth, file1.toString('hex'))).resolves.toBeUndefined();

      expect(mocks.asset.getUploadAssetIdByChecksum).toHaveBeenCalledWith(auth.user.id, file1, { excludeNsfw: true });
    });
  });

  describe('canUpload', () => {
    it('should require an authenticated user', () => {
      expect(() => sut.canUploadFile(uploadFile.nullAuth)).toThrowError(UnauthorizedException);
    });

    for (const { fieldName, valid, invalid } of uploadTests) {
      describe(fieldName, () => {
        for (const filetype of valid) {
          it(`should accept ${filetype}`, () => {
            expect(sut.canUploadFile(uploadFile.filename(fieldName, `asset${filetype}`))).toEqual(true);
          });
        }

        for (const filetype of invalid) {
          it(`should reject ${filetype}`, () => {
            expect(() => sut.canUploadFile(uploadFile.filename(fieldName, `asset${filetype}`))).toThrowError(
              BadRequestException,
            );
          });
        }

        it('should be sorted (valid)', () => {
          expect(valid).toEqual(valid.toSorted());
        });

        it('should be sorted (invalid)', () => {
          expect(invalid).toEqual(invalid.toSorted());
        });
      });
    }

    it('should prefer filename from body over name from path', () => {
      const pathFilename = 'invalid-file-name';
      const body = { filename: 'video.mov' };
      expect(() => sut.canUploadFile(uploadFile.filename(UploadFieldName.ASSET_DATA, pathFilename))).toThrowError(
        BadRequestException,
      );
      expect(sut.canUploadFile(uploadFile.filename(UploadFieldName.ASSET_DATA, pathFilename, body))).toEqual(true);
    });
  });

  describe('getUploadFilename', () => {
    it('should require authentication', () => {
      expect(() => sut.getUploadFilename(uploadFile.nullAuth)).toThrowError(UnauthorizedException);
    });

    it('should be the original extension for asset upload', () => {
      expect(sut.getUploadFilename(uploadFile.filename(UploadFieldName.ASSET_DATA, 'image.jpg'))).toEqual(
        'random-uuid.jpg',
      );
    });

    it('should be the xmp extension for sidecar upload', () => {
      expect(sut.getUploadFilename(uploadFile.filename(UploadFieldName.SIDECAR_DATA, 'image.html'))).toEqual(
        'random-uuid.xmp',
      );
    });

    it('should be the original extension for profile upload', () => {
      expect(sut.getUploadFilename(uploadFile.filename(UploadFieldName.PROFILE_DATA, 'image.jpg'))).toEqual(
        'random-uuid.jpg',
      );
    });

    it('should accept filenames with just an extension', () => {
      expect(sut.getUploadFilename(uploadFile.filename(UploadFieldName.ASSET_DATA, '.jpg'))).toEqual('random-uuid.jpg');
    });
  });

  describe('getUploadFolder', () => {
    it('should require authentication', () => {
      expect(() => sut.getUploadFolder(uploadFile.nullAuth)).toThrowError(UnauthorizedException);
    });

    it('should return profile for profile uploads', () => {
      expect(sut.getUploadFolder(uploadFile.filename(UploadFieldName.PROFILE_DATA, 'image.jpg'))).toEqual(
        expect.stringContaining('/data/profile/admin_id'),
      );
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/profile/admin_id'));
    });

    it('should return upload for everything else', () => {
      expect(sut.getUploadFolder(uploadFile.filename(UploadFieldName.ASSET_DATA, 'image.jpg'))).toEqual(
        expect.stringContaining('/data/upload/admin_id/ra/nd'),
      );
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.stringContaining('/data/upload/admin_id/ra/nd'));
    });
  });

  describe('uploadAsset', () => {
    it('should throw an error if the quota is exceeded', async () => {
      const file = {
        uuid: 'random-uuid',
        originalPath: 'fake_path/asset_1.jpeg',
        mimeType: 'image/jpeg',
        checksum: Buffer.from('file hash', 'utf8'),
        originalName: 'asset_1.jpeg',
        size: 42,
      };

      mocks.asset.create.mockResolvedValue(assetEntity);

      await expect(
        sut.uploadAsset(
          { ...authStub.admin, user: { ...authStub.admin.user, quotaSizeInBytes: 42, quotaUsageInBytes: 1 } },
          createDto,
          file,
        ),
      ).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.asset.remove).not.toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [file.originalPath, undefined] },
      });
      expect(mocks.event.emit).not.toHaveBeenCalled();
      expect(mocks.user.updateUsage).not.toHaveBeenCalledWith(authStub.user1.user.id, file.size);
      expect(mocks.storage.utimes).not.toHaveBeenCalledWith(
        file.originalPath,
        expect.any(Date),
        new Date(createDto.fileModifiedAt),
      );
    });

    it('should lock an upload into the Locked view instead of storing visibility locked (FL-34)', async () => {
      const file = {
        uuid: 'random-uuid',
        originalPath: 'fake_path/asset_1.jpeg',
        mimeType: 'image/jpeg',
        checksum: Buffer.from('file hash', 'utf8'),
        originalName: 'asset_1.jpeg',
        size: 42,
      };

      mocks.asset.create.mockResolvedValue(assetEntity);

      await expect(
        sut.uploadAsset(authStub.user1, { ...createDto, visibility: AssetVisibility.Locked }, file),
      ).resolves.toEqual({ id: 'id_1', status: AssetMediaStatus.CREATED });

      // the lock is written in the asset's own transaction, never as a second step
      expect(mocks.asset.create).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: AssetVisibility.Timeline }),
        { reason: AssetLockReason.Marked, lockedBy: authStub.user1.user.id },
      );
      expect(mocks.asset.lock).not.toHaveBeenCalled();
    });

    it('should handle a file upload', async () => {
      const file = {
        uuid: 'random-uuid',
        originalPath: 'fake_path/asset_1.jpeg',
        mimeType: 'image/jpeg',
        checksum: Buffer.from('file hash', 'utf8'),
        originalName: 'asset_1.jpeg',
        size: 42,
      };

      mocks.asset.create.mockResolvedValue(assetEntity);

      await expect(sut.uploadAsset(authStub.user1, createDto, file)).resolves.toEqual({
        id: 'id_1',
        status: AssetMediaStatus.CREATED,
      });

      expect(mocks.asset.create).toHaveBeenCalled();
      expect(mocks.storage.utimes).toHaveBeenCalledWith(
        file.originalPath,
        expect.any(Date),
        new Date(createDto.fileModifiedAt),
      );
    });

    it('should reuse a master physical original for a cross-user duplicate when enabled', async () => {
      const file = {
        uuid: 'random-uuid',
        originalPath: 'fake_path/duplicate.jpeg',
        mimeType: 'image/jpeg',
        checksum: Buffer.from('file hash', 'utf8'),
        originalName: 'duplicate.jpeg',
        size: 42,
      };
      const asset = {
        ...assetEntity,
        id: 'new-asset',
        ownerId: authStub.user1.user.id,
        originalPath: file.originalPath,
      };
      const physicalFile = { id: 'physical-file-id', path: '/data/library/master.jpeg' };

      mocks.systemMetadata.get.mockResolvedValue({
        physicalDeduplication: { enabled: true, masterUserId: 'master-user-id' },
      });
      mocks.asset.create.mockResolvedValue(asset);
      mocks.physicalFile.getMasterOriginalCandidate.mockResolvedValue({
        id: 'master-asset-id',
        checksum: file.checksum,
        originalFileName: 'master.jpeg',
        type: AssetType.Image,
        originalPath: '/data/library/master.jpeg',
        physicalOriginalFileId: null,
        sizeInBytes: file.size,
        width: null,
        height: null,
        duration: null,
      });
      mocks.physicalFile.ensureOriginalPhysicalFile.mockResolvedValue(physicalFile as never);

      await expect(sut.uploadAsset(authStub.user1, createDto, file)).resolves.toEqual({
        id: 'new-asset',
        status: AssetMediaStatus.CREATED,
      });

      expect(mocks.asset.create).toHaveBeenCalled();
      expect(mocks.physicalFile.getMasterOriginalCandidate).toHaveBeenCalledWith(
        'master-user-id',
        file.checksum,
        file.size,
      );
      expect(mocks.physicalFile.linkAssetToOriginalPhysicalFile).toHaveBeenCalledWith('new-asset', physicalFile);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [file.originalPath] },
      });
    });

    it('should keep normal storage when no master physical original exists', async () => {
      const file = {
        uuid: 'random-uuid',
        originalPath: 'fake_path/asset_1.jpeg',
        mimeType: 'image/jpeg',
        checksum: Buffer.from('file hash', 'utf8'),
        originalName: 'asset_1.jpeg',
        size: 42,
      };

      mocks.systemMetadata.get.mockResolvedValue({
        physicalDeduplication: { enabled: true, masterUserId: 'master-user-id' },
      });
      mocks.asset.create.mockResolvedValue(assetEntity);
      mocks.physicalFile.getMasterOriginalCandidate.mockResolvedValue(null as never);

      await expect(sut.uploadAsset(authStub.user1, createDto, file)).resolves.toEqual({
        id: 'id_1',
        status: AssetMediaStatus.CREATED,
      });

      expect(mocks.physicalFile.linkAssetToOriginalPhysicalFile).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [file.originalPath] },
      });
    });

    it('should handle a duplicate', async () => {
      const file = {
        uuid: 'random-uuid',
        originalPath: 'fake_path/asset_1.jpeg',
        mimeType: 'image/jpeg',
        checksum: Buffer.from('file hash', 'utf8'),
        originalName: 'asset_1.jpeg',
        size: 0,
      };
      const error = new Error('unique key violation');
      (error as any).constraint_name = ASSET_CHECKSUM_CONSTRAINT;

      mocks.asset.create.mockRejectedValue(error);
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(assetEntity.id);

      await expect(sut.uploadAsset(authStub.user1, createDto, file)).resolves.toEqual({
        id: 'id_1',
        status: AssetMediaStatus.DUPLICATE,
      });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['fake_path/asset_1.jpeg', undefined] },
      });
      expect(mocks.user.updateUsage).not.toHaveBeenCalled();
    });

    it('should throw an error if the duplicate could not be found by checksum', async () => {
      const file = {
        uuid: 'random-uuid',
        originalPath: 'fake_path/asset_1.jpeg',
        mimeType: 'image/jpeg',
        checksum: Buffer.from('file hash', 'utf8'),
        originalName: 'asset_1.jpeg',
        size: 0,
      };
      const error = new Error('unique key violation');
      (error as any).constraint_name = ASSET_CHECKSUM_CONSTRAINT;

      mocks.asset.create.mockRejectedValue(error);

      await expect(sut.uploadAsset(authStub.user1, createDto, file)).rejects.toBeInstanceOf(
        InternalServerErrorException,
      );

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['fake_path/asset_1.jpeg', undefined] },
      });
      expect(mocks.user.updateUsage).not.toHaveBeenCalled();
    });

    it('should mark hidden NSFW duplicates without disclosing the duplicate id if upload hits the checksum constraint', async () => {
      const file = {
        uuid: 'random-uuid',
        originalPath: 'fake_path/asset_1.jpeg',
        mimeType: 'image/jpeg',
        checksum: Buffer.from('file hash', 'utf8'),
        originalName: 'asset_1.jpeg',
        size: 0,
      };
      const error = new Error('unique key violation');
      (error as any).constraint_name = ASSET_CHECKSUM_CONSTRAINT;

      mocks.asset.create.mockRejectedValue(error);

      await expect(sut.uploadAsset({ ...authStub.user1, hideNsfwAssets: true }, createDto, file)).resolves.toEqual({
        id: '00000000-0000-0000-0000-000000000000',
        status: AssetMediaStatus.DUPLICATE,
      });

      expect(mocks.asset.getUploadAssetIdByChecksum).toHaveBeenCalledWith(authStub.user1.user.id, file.checksum, {
        excludeNsfw: true,
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['fake_path/asset_1.jpeg', undefined] },
      });
      expect(mocks.user.updateUsage).not.toHaveBeenCalled();
    });

    it('should never name a Locked duplicate to a session that has not unlocked it (FL-34)', async () => {
      const file = {
        uuid: 'random-uuid',
        originalPath: 'fake_path/asset_1.jpeg',
        mimeType: 'image/jpeg',
        checksum: Buffer.from('file hash', 'utf8'),
        originalName: 'asset_1.jpeg',
        size: 0,
      };
      const error = new Error('unique key violation');
      (error as any).constraint_name = ASSET_CHECKSUM_CONSTRAINT;

      mocks.asset.create.mockRejectedValue(error);
      // the named lookup withholds Locked; only the owner-scoped server-side check finds it
      mocks.asset.getUploadAssetIdByChecksum.mockImplementation((_ownerId, _checksum, options) =>
        Promise.resolve(options?.lockedOwnerId ? 'locked-asset-id' : undefined),
      );

      await expect(sut.uploadAsset(authStub.user1, createDto, file)).resolves.toEqual({
        id: '00000000-0000-0000-0000-000000000000',
        status: AssetMediaStatus.DUPLICATE,
      });
      expect(mocks.asset.getUploadAssetIdByChecksum).toHaveBeenNthCalledWith(1, authStub.user1.user.id, file.checksum);
      expect(mocks.sharedLink.addAssets).not.toHaveBeenCalled();
      expect(mocks.album.addAssetIds).not.toHaveBeenCalled();
    });

    it('should handle a live photo', async () => {
      const motionAsset = AssetFactory.from({ type: AssetType.Video, visibility: AssetVisibility.Hidden })
        .owner(authStub.user1.user)
        .build();
      const asset = AssetFactory.create({ livePhotoVideoId: motionAsset.id });
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(motionAsset));
      mocks.asset.create.mockResolvedValueOnce(asset);

      await expect(
        sut.uploadAsset(authStub.user1, { ...createDto, livePhotoVideoId: motionAsset.id }, fileStub.livePhotoStill),
      ).resolves.toEqual({
        status: AssetMediaStatus.CREATED,
        id: asset.id,
      });

      expect(mocks.asset.getById).toHaveBeenCalledWith(motionAsset.id);
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('should hide the linked motion asset', async () => {
      const motionAsset = AssetFactory.from({ type: AssetType.Video }).owner(authStub.user1.user).build();
      const asset = AssetFactory.create();
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(motionAsset));
      mocks.asset.create.mockResolvedValueOnce(asset);

      await expect(
        sut.uploadAsset(authStub.user1, { ...createDto, livePhotoVideoId: motionAsset.id }, fileStub.livePhotoStill),
      ).resolves.toEqual({
        status: AssetMediaStatus.CREATED,
        id: asset.id,
      });

      expect(mocks.asset.getById).toHaveBeenCalledWith(motionAsset.id);
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: motionAsset.id,
        visibility: AssetVisibility.Hidden,
      });
    });

    it('should handle a sidecar file', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Sidecar }).build();
      mocks.asset.getById.mockResolvedValueOnce(getForAsset(asset));
      mocks.asset.create.mockResolvedValueOnce(asset);

      await expect(sut.uploadAsset(authStub.user1, createDto, fileStub.photo, fileStub.photoSidecar)).resolves.toEqual({
        status: AssetMediaStatus.CREATED,
        id: asset.id,
      });

      expect(mocks.storage.utimes).toHaveBeenCalledWith(
        fileStub.photoSidecar.originalPath,
        expect.any(Date),
        new Date(createDto.fileModifiedAt),
      );
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });
  });

  describe('downloadVideoEditVersion', () => {
    it('requires download access before querying a version', async () => {
      await expect(sut.downloadVideoEditVersion(authStub.admin, 'asset-1', 'version-1')).rejects.toBeInstanceOf(
        BadRequestException,
      );
      expect(mocks.assetEdit.getVideoVersion).not.toHaveBeenCalled();
    });

    it.each(['pending', 'failed'])('refuses a %s master', async (status) => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.assetEdit.getVideoVersion.mockResolvedValue({
        ownerId: authStub.admin.user.id,
        status,
        masterPath: '/master.mp4',
      } as any);
      await expect(sut.downloadVideoEditVersion(authStub.admin, 'asset-1', 'version-1')).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });

    it('downloads the retained master, independently of the playback proxy', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set(['asset-1']));
      mocks.assetEdit.getVideoVersion.mockResolvedValue({
        id: 'version-1',
        ownerId: authStub.admin.user.id,
        status: 'ready',
        masterPath: '/master.mp4',
        proxyPath: '/proxy.mp4',
      } as any);
      await expect(sut.downloadVideoEditVersion(authStub.admin, 'asset-1', 'version-1')).resolves.toEqual(
        new ImmichFileResponse({
          path: '/master.mp4',
          fileName: 'asset-1-version-1.mp4',
          contentType: 'video/mp4',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
    });
  });

  describe('downloadOriginal', () => {
    it('should require the asset.download permission', async () => {
      await expect(sut.downloadOriginal(authStub.admin, 'asset-1', {})).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.admin.user.id,
        new Set(['asset-1']),
        undefined,
      );
      expect(mocks.access.asset.checkAlbumAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set(['asset-1']));
      expect(mocks.access.asset.checkPartnerAccess).toHaveBeenCalledWith(authStub.admin.user.id, new Set(['asset-1']));
    });

    it('should download a file', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginal.mockResolvedValue(asset);

      await expect(sut.downloadOriginal(authStub.admin, asset.id, {})).resolves.toEqual(
        new ImmichFileResponse({
          path: asset.originalPath,
          fileName: asset.originalFileName,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
    });

    it('should download edited file by default when edits exist', async () => {
      const editedAsset = AssetFactory.from()
        .edit()
        .files([AssetFileType.FullSize, AssetFileType.Preview, AssetFileType.Thumbnail])
        .file({ type: AssetFileType.FullSize, isEdited: true })
        .build();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([editedAsset.id]));
      mocks.asset.getForOriginal.mockResolvedValue({ ...editedAsset, editedPath: editedAsset.files[3].path });

      await expect(sut.downloadOriginal(AuthFactory.create(), editedAsset.id, {})).resolves.toEqual(
        new ImmichFileResponse({
          path: editedAsset.files[3].path,
          fileName: editedAsset.originalFileName,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
    });

    it('should download edited file when edited=true', async () => {
      const editedAsset = AssetFactory.from()
        .edit()
        .files([AssetFileType.FullSize, AssetFileType.Preview, AssetFileType.Thumbnail])
        .file({ type: AssetFileType.FullSize, isEdited: true })
        .build();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([editedAsset.id]));
      mocks.asset.getForOriginal.mockResolvedValue({ ...editedAsset, editedPath: editedAsset.files[3].path });

      await expect(sut.downloadOriginal(AuthFactory.create(), editedAsset.id, { edited: true })).resolves.toEqual(
        new ImmichFileResponse({
          path: editedAsset.files[3].path,
          fileName: editedAsset.originalFileName,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
    });

    it('should not return the unedited version if requested using a shared link', async () => {
      const fullsizeEdited = AssetFileFactory.create({ type: AssetFileType.FullSize, isEdited: true });
      const editedAsset = AssetFactory.from().edit({ action: AssetEditAction.Crop }).file(fullsizeEdited).build();

      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([editedAsset.id]));
      mocks.asset.getForOriginal.mockResolvedValue({ ...editedAsset, editedPath: fullsizeEdited.path });

      await expect(
        sut.downloadOriginal(AuthFactory.from().sharedLink().build(), editedAsset.id, { edited: false }),
      ).resolves.toEqual(
        new ImmichFileResponse({
          path: fullsizeEdited.path,
          fileName: editedAsset.originalFileName,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
    });

    it('should download original file when edited=false', async () => {
      const editedAsset = AssetFactory.from()
        .edit()
        .files([AssetFileType.FullSize, AssetFileType.Preview, AssetFileType.Thumbnail])
        .file({ type: AssetFileType.FullSize, isEdited: true })
        .build();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([editedAsset.id]));
      mocks.asset.getForOriginal.mockResolvedValue(editedAsset);

      await expect(sut.downloadOriginal(AuthFactory.create(), editedAsset.id, { edited: false })).resolves.toEqual(
        new ImmichFileResponse({
          path: editedAsset.originalPath,
          fileName: editedAsset.originalFileName,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
    });
  });

  describe('downloadOriginal location policy (FL-54)', () => {
    const lease = { path: '/tmp/immich-location-free/copy.jpg', release: vitest.fn() };

    const setup = ({ shareLocation }: { shareLocation: boolean }) => {
      const me = UserFactory.create();
      const owner = UserFactory.create();
      const asset = AssetFactory.create({ ownerId: owner.id, originalPath: '/original/photo.jpg' });
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginal.mockResolvedValue({ ...asset, editedPath: null });
      mocks.partner.getAll.mockResolvedValue([
        getForPartner(PartnerFactory.from({ shareLocation }).sharedBy(owner).sharedWith(me).build()),
      ]);
      mocks.metadata.acquireLocationFreeOriginal.mockResolvedValue(lease);
      return { auth: AuthFactory.create(me), asset };
    };

    it('serves the owner the original bytes without a partner lookup or a copy', async () => {
      const owner = UserFactory.create();
      const asset = AssetFactory.create({ ownerId: owner.id });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginal.mockResolvedValue(asset);

      const response = await sut.downloadOriginal(AuthFactory.create(owner), asset.id, {});

      expect(response.path).toBe(asset.originalPath);
      expect(response.release).toBeUndefined();
      expect(mocks.partner.getAll).not.toHaveBeenCalled();
      expect(mocks.metadata.acquireLocationFreeOriginal).not.toHaveBeenCalled();
    });

    it('serves a partner who may see locations the original bytes', async () => {
      const { auth, asset } = setup({ shareLocation: true });

      const response = await sut.downloadOriginal(auth, asset.id, {});

      expect(response.path).toBe(asset.originalPath);
      expect(mocks.metadata.acquireLocationFreeOriginal).not.toHaveBeenCalled();
    });

    it('serves a location-free copy to a partner the owner hides locations from', async () => {
      const { auth, asset } = setup({ shareLocation: false });

      const response = await sut.downloadOriginal(auth, asset.id, {});

      expect(mocks.metadata.acquireLocationFreeOriginal).toHaveBeenCalledWith('/original/photo.jpg');
      expect(response).toEqual(
        new ImmichFileResponse({
          path: lease.path,
          fileName: asset.originalFileName,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithCache,
          release: lease.release,
        }),
      );
    });

    it('cleans an existing fullsize preview lazily for a viewer who may not see its location', async () => {
      const { auth, asset } = setup({ shareLocation: false });
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({
        ownerId: asset.ownerId,
        originalPath: '/original/photo.cr2',
        originalFileName: 'photo.cr2',
        path: '/thumbs/photo-fullsize.jpeg',
      });

      const response = await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.FULLSIZE });

      expect(mocks.metadata.acquireLocationFreeOriginal).toHaveBeenCalledWith('/thumbs/photo-fullsize.jpeg');
      expect(response).toMatchObject({ path: lease.path, release: lease.release });
    });

    it('never checks thumbnails or previews, which are re-encoded without metadata', async () => {
      const { auth, asset } = setup({ shareLocation: false });
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({
        ownerId: asset.ownerId,
        originalPath: '/original/photo.cr2',
        originalFileName: 'photo.cr2',
        path: '/thumbs/photo-preview.jpeg',
      });

      await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW });

      expect(mocks.metadata.acquireLocationFreeOriginal).not.toHaveBeenCalled();
    });

    it('strips the location of an original reached through a hidden album owner (owner default)', async () => {
      const me = UserFactory.create();
      const owner = UserFactory.create();
      const asset = AssetFactory.create({ ownerId: owner.id, originalPath: '/original/photo.jpg' });
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginal.mockResolvedValue({ ...asset, editedPath: null });
      mocks.partner.getLocationHiddenThroughAlbums.mockResolvedValue(new Set([asset.id]));
      mocks.metadata.acquireLocationFreeOriginal.mockResolvedValue(lease);

      await expect(sut.downloadOriginal(AuthFactory.create(me), asset.id, {})).resolves.toMatchObject({
        path: lease.path,
      });
      expect(mocks.partner.getLocationHiddenThroughAlbums).toHaveBeenCalledWith(me.id, [asset.id]);
    });

    it('refuses rather than leak when the location cannot be removed', async () => {
      const { auth, asset } = setup({ shareLocation: false });
      mocks.metadata.acquireLocationFreeOriginal.mockRejectedValue(new Error('exiftool failed'));

      await expect(sut.downloadOriginal(auth, asset.id, {})).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses a shared link that hides metadata even when its download flag is on', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginal.mockResolvedValue({ ...asset, editedPath: null });
      const auth = AuthFactory.from().sharedLink({ showExif: false, allowDownload: true }).build();

      await expect(sut.downloadOriginal(auth, asset.id, {})).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.metadata.acquireLocationFreeOriginal).not.toHaveBeenCalled();
    });

    it('serves a location-free copy through a link the hidden partner created (review B1)', async () => {
      const me = UserFactory.create();
      const owner = UserFactory.create();
      const asset = AssetFactory.create({ ownerId: owner.id, originalPath: '/original/photo.jpg' });
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginal.mockResolvedValue({ ...asset, editedPath: null });
      mocks.partner.getAll.mockResolvedValue([
        getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(owner).sharedWith(me).build()),
      ]);
      mocks.metadata.acquireLocationFreeOriginal.mockResolvedValue(lease);
      const auth = AuthFactory.from(me).sharedLink({ userId: me.id, showExif: true, allowDownload: true }).build();

      await expect(sut.downloadOriginal(auth, asset.id, {})).resolves.toMatchObject({ path: lease.path });
      expect(mocks.partner.getAll).toHaveBeenCalledWith(me.id);
      expect(mocks.metadata.acquireLocationFreeOriginal).toHaveBeenCalledWith('/original/photo.jpg');
    });

    it('serves a shared link that shows metadata the file untouched', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginal.mockResolvedValue({ ...asset, editedPath: null });
      const auth = AuthFactory.from().sharedLink({ showExif: true, allowDownload: true }).build();

      await expect(sut.downloadOriginal(auth, asset.id, {})).resolves.toMatchObject({ path: asset.originalPath });
      expect(mocks.metadata.acquireLocationFreeOriginal).not.toHaveBeenCalled();
    });
  });

  describe('viewThumbnail', () => {
    it('should require asset.view permissions', async () => {
      await expect(sut.viewThumbnail(authStub.admin, 'id', {})).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(userStub.admin.id, new Set(['id']), undefined);
      expect(mocks.access.asset.checkAlbumAccess).toHaveBeenCalledWith(userStub.admin.id, new Set(['id']));
      expect(mocks.access.asset.checkPartnerAccess).toHaveBeenCalledWith(userStub.admin.id, new Set(['id']));
    });

    it('serves the preview instead of redirecting to the original through the relay (FL-161)', async () => {
      const asset = AssetFactory.from({ originalPath: '/data/library/admin/image.jpeg' }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({ ...asset, path: null });
      mocks.systemMetadata.get.mockResolvedValue(null as never);

      await expect(
        sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.FULLSIZE }, 'relay'),
      ).resolves.toEqual({ targetSize: AssetMediaSize.PREVIEW });
      await expect(
        sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.FULLSIZE }, 'wan'),
      ).resolves.toEqual({
        targetSize: 'original',
      });
      await expect(sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.FULLSIZE })).resolves.toEqual({
        targetSize: 'original',
      });
    });

    it('redirects to the original through the relay once an administrator allowed originals there (FL-161)', async () => {
      const asset = AssetFactory.from({ originalPath: '/data/library/admin/image.jpeg' }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({ ...asset, path: null });
      mocks.systemMetadata.get.mockResolvedValue({
        frameleafCloud: { remoteAccess: { allowOriginalsOverRelay: true, allowPasswordOverRelay: false } },
      } as never);

      await expect(
        sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.FULLSIZE }, 'relay'),
      ).resolves.toEqual({ targetSize: 'original' });
    });

    it('should fall back to preview if the requested thumbnail file does not exist', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({ ...asset, path: asset.files[0].path });

      await expect(sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.THUMBNAIL })).resolves.toEqual(
        new ImmichFileResponse({
          path: asset.files[0].path,
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'image/jpeg',
          fileName: `IMG_${asset.id}_thumbnail.jpg`,
        }),
      );
    });

    it('should get preview file', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({ ...asset, path: asset.files[0].path });
      await expect(sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.PREVIEW })).resolves.toEqual(
        new ImmichFileResponse({
          path: asset.files[0].path,
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'image/jpeg',
          fileName: `IMG_${asset.id}_preview.jpg`,
        }),
      );
    });

    it('should get thumbnail file', async () => {
      const asset = AssetFactory.from()
        .file({ type: AssetFileType.Thumbnail, path: '/uploads/user-id/webp/path.ext' })
        .build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({ ...asset, path: asset.files[0].path });
      await expect(sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.THUMBNAIL })).resolves.toEqual(
        new ImmichFileResponse({
          path: asset.files[0].path,
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'application/octet-stream',
          fileName: `IMG_${asset.id}_thumbnail.ext`,
        }),
      );
      expect(mocks.asset.getForThumbnail).toHaveBeenCalledWith(asset.id, AssetFileType.Thumbnail, false);
    });

    it('should get original thumbnail by default', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Thumbnail }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({ ...asset, path: asset.files[0].path });
      await expect(sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.THUMBNAIL })).resolves.toEqual(
        new ImmichFileResponse({
          path: asset.files[0].path,
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'image/jpeg',
          fileName: `IMG_${asset.id}_thumbnail.jpg`,
        }),
      );
      expect(mocks.asset.getForThumbnail).toHaveBeenCalledWith(asset.id, AssetFileType.Thumbnail, false);
    });

    it('should get edited thumbnail when edited=true', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Thumbnail, isEdited: true }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({ ...asset, path: asset.files[0].path });
      await expect(
        sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.THUMBNAIL, edited: true }),
      ).resolves.toEqual(
        new ImmichFileResponse({
          path: asset.files[0].path,
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'image/jpeg',
          fileName: `IMG_${asset.id}_thumbnail.jpg`,
        }),
      );
      expect(mocks.asset.getForThumbnail).toHaveBeenCalledWith(asset.id, AssetFileType.Thumbnail, true);
    });

    it('should get original thumbnail when edited=false', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Thumbnail }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({ ...asset, path: asset.files[0].path });
      await expect(
        sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.THUMBNAIL, edited: false }),
      ).resolves.toEqual(
        new ImmichFileResponse({
          path: asset.files[0].path,
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'image/jpeg',
          fileName: `IMG_${asset.id}_thumbnail.jpg`,
        }),
      );
      expect(mocks.asset.getForThumbnail).toHaveBeenCalledWith(asset.id, AssetFileType.Thumbnail, false);
    });

    it('should not return the unedited version if requested using a shared link', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Thumbnail }).build();
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({ ...asset, path: asset.files[0].path });
      await expect(
        sut.viewThumbnail(authStub.adminSharedLink, asset.id, {
          size: AssetMediaSize.THUMBNAIL,
          edited: true,
        }),
      ).resolves.toEqual(
        new ImmichFileResponse({
          path: asset.files[0].path,
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'image/jpeg',
          fileName: `IMG_${asset.id}_thumbnail.jpg`,
        }),
      );
      expect(mocks.asset.getForThumbnail).toHaveBeenCalledWith(asset.id, AssetFileType.Thumbnail, true);
    });

    it('should not include original filename if requested using a shared link with showExif false', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).build();

      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({ ...asset, path: asset.files[0].path });

      const auth = AuthFactory.from().sharedLink({ showExif: false }).build();

      await expect(sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW })).resolves.toEqual(
        new ImmichFileResponse({
          path: asset.files[0].path,
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'image/jpeg',
          fileName: `${asset.id}_preview.jpg`,
        }),
      );
    });
  });

  describe('playbackVideo', () => {
    it('plays a location-free copy of the original for a partner the owner hides locations from', async () => {
      const me = UserFactory.create();
      const owner = UserFactory.create();
      const asset = AssetFactory.create({ type: AssetType.Video, ownerId: owner.id, originalPath: '/original/v.mp4' });
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForVideo.mockResolvedValue({
        originalPath: asset.originalPath,
        encodedVideoPath: null,
        editedVideoPath: null,
        ownerId: owner.id,
      });
      mocks.partner.getAll.mockResolvedValue([
        getForPartner(PartnerFactory.from({ shareLocation: false }).sharedBy(owner).sharedWith(me).build()),
      ]);
      const release = vitest.fn();
      mocks.metadata.acquireLocationFreeOriginal.mockResolvedValue({ path: '/tmp/copy.mp4', release });

      await expect(sut.playbackVideo(AuthFactory.create(me), asset.id)).resolves.toEqual(
        new ImmichFileResponse({
          path: '/tmp/copy.mp4',
          contentType: 'video/mp4',
          cacheControl: CacheControl.PrivateWithCache,
          release,
        }),
      );
      expect(mocks.metadata.acquireLocationFreeOriginal).toHaveBeenCalledWith('/original/v.mp4');
    });

    it('should require asset.view permissions', async () => {
      await expect(sut.playbackVideo(authStub.admin, 'id')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(userStub.admin.id, new Set(['id']), undefined);
      expect(mocks.access.asset.checkAlbumAccess).toHaveBeenCalledWith(userStub.admin.id, new Set(['id']));
      expect(mocks.access.asset.checkPartnerAccess).toHaveBeenCalledWith(userStub.admin.id, new Set(['id']));
    });

    it('should throw an error if the video asset could not be found', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));

      await expect(sut.playbackVideo(authStub.admin, asset.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('should return the encoded video path if available', async () => {
      const asset = AssetFactory.from()
        .file({ type: AssetFileType.EncodedVideo, path: '/path/to/encoded/video.mp4' })
        .build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForVideo.mockResolvedValue({
        originalPath: asset.originalPath,
        encodedVideoPath: asset.files[0].path,
        editedVideoPath: null,
        ownerId: authStub.admin.user.id,
      });

      await expect(sut.playbackVideo(authStub.admin, asset.id)).resolves.toEqual(
        new ImmichFileResponse({
          path: '/path/to/encoded/video.mp4',
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'video/mp4',
        }),
      );
    });

    it('should prefer the edited encoded video path if available', async () => {
      const asset = AssetFactory.from()
        .file({ type: AssetFileType.EncodedVideo, path: '/path/to/encoded/video.mp4' })
        .file({ type: AssetFileType.EncodedVideo, path: '/path/to/encoded/video_edited.mp4', isEdited: true })
        .build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForVideo.mockResolvedValue({
        originalPath: asset.originalPath,
        encodedVideoPath: '/path/to/encoded/video.mp4',
        editedVideoPath: '/path/to/encoded/video_edited.mp4',
        ownerId: authStub.admin.user.id,
      });

      await expect(sut.playbackVideo(authStub.admin, asset.id)).resolves.toEqual(
        new ImmichFileResponse({
          path: '/path/to/encoded/video_edited.mp4',
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'video/mp4',
        }),
      );
    });

    it('plays the unedited source for the owner when the quick editor asks (FL-113)', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForVideo.mockResolvedValue({
        originalPath: asset.originalPath,
        encodedVideoPath: '/path/to/encoded/video.mp4',
        editedVideoPath: '/path/to/encoded/video_edited.mp4',
        ownerId: authStub.admin.user.id,
      });

      await expect(sut.playbackVideo(authStub.admin, asset.id, false)).resolves.toEqual(
        new ImmichFileResponse({
          path: '/path/to/encoded/video.mp4',
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'video/mp4',
        }),
      );
    });

    it('never gives anyone but the owner the unedited source', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForVideo.mockResolvedValue({
        originalPath: asset.originalPath,
        encodedVideoPath: '/path/to/encoded/video.mp4',
        editedVideoPath: '/path/to/encoded/video_edited.mp4',
        ownerId: 'someone-else',
      });

      await expect(sut.playbackVideo(authStub.admin, asset.id, false)).resolves.toEqual(
        new ImmichFileResponse({
          path: '/path/to/encoded/video_edited.mp4',
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'video/mp4',
        }),
      );
    });

    it('should fall back to the original path', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video, originalPath: '/original/path.ext' });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForVideo.mockResolvedValue({
        originalPath: asset.originalPath,
        encodedVideoPath: null,
        editedVideoPath: null,
        ownerId: authStub.admin.user.id,
      });

      await expect(sut.playbackVideo(authStub.admin, asset.id)).resolves.toEqual(
        new ImmichFileResponse({
          path: asset.originalPath,
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'application/octet-stream',
        }),
      );
    });
  });

  describe('bulkUploadCheck', () => {
    it('should name Locked duplicates only for the elevated owner (FL-34)', async () => {
      const file1 = Buffer.from('d2947b871a706081be194569951b7db246907957', 'hex');
      mocks.asset.getByChecksums.mockResolvedValue([]);

      await sut.bulkUploadCheck(authStub.admin, { assets: [{ id: '1', checksum: file1.toString('hex') }] });
      expect(mocks.asset.getByChecksums).toHaveBeenLastCalledWith(authStub.admin.user.id, [file1]);

      const elevated = authStub.adminWithElevatedPermission;
      await sut.bulkUploadCheck(elevated, { assets: [{ id: '1', checksum: file1.toString('hex') }] });
      expect(mocks.asset.getByChecksums).toHaveBeenLastCalledWith(elevated.user.id, [file1], {
        lockedOwnerId: elevated.user.id,
      });
    });

    it('should accept hex and base64 checksums', async () => {
      const file1 = Buffer.from('d2947b871a706081be194569951b7db246907957', 'hex');
      const file2 = Buffer.from('53be335e99f18a66ff12e9a901c7a6171dd76573', 'hex');

      mocks.asset.getByChecksums.mockResolvedValue([
        { id: 'asset-1', checksum: file1, deletedAt: null },
        { id: 'asset-2', checksum: file2, deletedAt: null },
      ]);

      await expect(
        sut.bulkUploadCheck(authStub.admin, {
          assets: [
            { id: '1', checksum: file1.toString('hex') },
            { id: '2', checksum: file2.toString('base64') },
          ],
        }),
      ).resolves.toEqual({
        results: [
          {
            id: '1',
            assetId: 'asset-1',
            action: AssetUploadAction.REJECT,
            reason: AssetRejectReason.DUPLICATE,
            isTrashed: false,
          },
          {
            id: '2',
            assetId: 'asset-2',
            action: AssetUploadAction.REJECT,
            reason: AssetRejectReason.DUPLICATE,
            isTrashed: false,
          },
        ],
      });

      expect(mocks.asset.getByChecksums).toHaveBeenCalledWith(authStub.admin.user.id, [file1, file2]);
    });

    it('should detect a duplicate when the client sends sha1 and the asset is stored as sha256', async () => {
      // Clients pre-check with sha1; this fork persists sha256, so without the
      // translation every already-uploaded file is re-sent and only rejected
      // at the unique constraint.
      const sha1 = Buffer.from('d2947b871a706081be194569951b7db246907957', 'hex');
      const sha256 = Buffer.from('9f86d081884c7d659a2feaa0c55ad015a3bf4f1b2b0b822cd15d6c15b0f00a08', 'hex');

      mocks.forkSchema.getChecksumTranslations.mockResolvedValue([{ sha1, checksum: sha256 }]);
      mocks.asset.getByChecksums.mockResolvedValue([{ id: 'asset-1', checksum: sha256, deletedAt: null }]);

      await expect(
        sut.bulkUploadCheck(authStub.admin, { assets: [{ id: '1', checksum: sha1.toString('hex') }] }),
      ).resolves.toEqual({
        results: [
          {
            id: '1',
            assetId: 'asset-1',
            action: AssetUploadAction.REJECT,
            reason: AssetRejectReason.DUPLICATE,
            isTrashed: false,
          },
        ],
      });

      expect(mocks.asset.getByChecksums).toHaveBeenCalledWith(authStub.admin.user.id, [sha1, sha256]);
    });

    it('should return non-duplicates as well', async () => {
      const file1 = Buffer.from('d2947b871a706081be194569951b7db246907957', 'hex');
      const file2 = Buffer.from('53be335e99f18a66ff12e9a901c7a6171dd76573', 'hex');

      mocks.asset.getByChecksums.mockResolvedValue([{ id: 'asset-1', checksum: file1, deletedAt: null }]);

      await expect(
        sut.bulkUploadCheck(authStub.admin, {
          assets: [
            { id: '1', checksum: file1.toString('hex') },
            { id: '2', checksum: file2.toString('base64') },
          ],
        }),
      ).resolves.toEqual({
        results: [
          {
            id: '1',
            assetId: 'asset-1',
            action: AssetUploadAction.REJECT,
            reason: AssetRejectReason.DUPLICATE,
            isTrashed: false,
          },
          {
            id: '2',
            action: AssetUploadAction.ACCEPT,
          },
        ],
      });

      expect(mocks.asset.getByChecksums).toHaveBeenCalledWith(authStub.admin.user.id, [file1, file2]);
    });

    it('should hide duplicate checksum matches in hidden NSFW mode', async () => {
      const file1 = Buffer.from('d2947b871a706081be194569951b7db246907957', 'hex');
      const file2 = Buffer.from('53be335e99f18a66ff12e9a901c7a6171dd76573', 'hex');

      mocks.asset.getByChecksums.mockResolvedValue([{ id: 'asset-1', checksum: file1, deletedAt: null }]);

      await expect(
        sut.bulkUploadCheck(
          { ...authStub.admin, hideNsfwAssets: true },
          {
            assets: [
              { id: '1', checksum: file1.toString('hex') },
              { id: '2', checksum: file2.toString('base64') },
            ],
          },
        ),
      ).resolves.toEqual({
        results: [
          {
            id: '1',
            assetId: 'asset-1',
            action: AssetUploadAction.REJECT,
            reason: AssetRejectReason.DUPLICATE,
            isTrashed: false,
          },
          {
            id: '2',
            action: AssetUploadAction.ACCEPT,
          },
        ],
      });

      expect(mocks.asset.getByChecksums).toHaveBeenCalledWith(authStub.admin.user.id, [file1, file2], {
        excludeNsfw: true,
      });
    });
  });

  describe('onUploadError', () => {
    it('should queue a job to delete the uploaded file', async () => {
      const request = {
        body: {},
        user: authStub.user1,
      } as AuthRequest;

      const file = {
        fieldname: UploadFieldName.ASSET_DATA,
        originalname: 'image.jpg',
        mimetype: 'image/jpeg',
        buffer: Buffer.from(''),
        size: 1000,
        uuid: 'random-uuid',
        checksum: Buffer.from('checksum', 'utf8'),
        originalPath: '/data/upload/user-id/ra/nd/random-uuid.jpg',
      } as unknown as Express.Multer.File;

      await sut.onUploadError(request, file);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [expect.stringContaining('/data/upload/user-id/ra/nd/random-uuid.jpg')] },
      });
    });
  });
});
