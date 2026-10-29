import {
  BadRequestException,
  ConflictException,
  ForbiddenException,
  InternalServerErrorException,
  NotFoundException,
  UnauthorizedException,
} from '@nestjs/common';
import { stat } from 'node:fs/promises';
import { dirname } from 'node:path';
import { vitest } from 'vitest';
import { AssetFile } from 'src/database.js';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetMediaStatus, AssetRejectReason, AssetUploadAction } from 'src/dtos/asset-media-response.dto.js';
import { AssetMediaCreateDto, AssetMediaSize, UploadFieldName } from 'src/dtos/asset-media.dto.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  AssetLockReason,
  AssetStatus,
  AssetType,
  AssetVisibility,
  CacheControl,
  JobName,
  LibraryScope,
  UserMetadataKey,
} from 'src/enum.js';
import { AuthRequest } from 'src/middleware/auth.guard.js';
import { SharpResourceLimitError } from 'src/queue/sharp-protocol.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { UploadBody } from 'src/types.js';
import { clearConfigCache } from 'src/utils/config.js';
import { ASSET_CHECKSUM_CONSTRAINT } from 'src/utils/database.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { tryPromise } from 'src/utils/promise.js';
import { AssetFileFactory } from 'test/factories/asset-file.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { UserFactory } from 'test/factories/user.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { fileStub } from 'test/fixtures/file.stub.js';
import { userStub } from 'test/fixtures/user.stub.js';
import { getForAsset } from 'test/mappers.js';
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
    mocks.asset.getByChecksums.mockResolvedValue([]);
    mocks.storage.checkFileExists.mockResolvedValue(true);
    mocks.user.getMetadata.mockResolvedValue([]);
  });

  it.each([LibraryScope.Personal, LibraryScope.Design, LibraryScope.Both, undefined])(
    'prepares %s scope in the first published asset row',
    async (libraryScope) => {
      const prepared = await sut.prepareUploadAsset(
        authStub.user1,
        { ...createDto, libraryScope },
        fileStub.livePhotoStill,
      );
      expect(prepared.asset.libraryScope).toBe(libraryScope ?? LibraryScope.Personal);
    },
  );

  describe('getUploadAssetIdByChecksum', () => {
    it('should return if checksum is undefined', async () => {
      await expect(sut.getUploadAssetIdByChecksum(authStub.admin)).resolves.toBe(undefined);
    });

    it.each([undefined, file1.toString('hex')])(
      'refuses checksum preflight when a link forbids uploads: %s',
      async (checksum) => {
        const auth = AuthFactory.from().sharedLink({ allowUpload: false }).build();
        mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue('private-library-id');
        await expect(sut.getUploadAssetIdByChecksum(auth, checksum)).rejects.toBeInstanceOf(UnauthorizedException);
        expect(mocks.asset.getUploadAssetIdByChecksum).not.toHaveBeenCalled();
      },
    );

    it('lets upload-enabled links continue without exposing owner-wide duplicate ids', async () => {
      const auth = AuthFactory.from().sharedLink({ allowUpload: true }).build();
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue('private-library-id');
      await expect(sut.getUploadAssetIdByChecksum(auth, file1.toString('hex'))).resolves.toBeUndefined();
      expect(mocks.asset.getUploadAssetIdByChecksum).not.toHaveBeenCalled();
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

    it('refuses a photo or video while new uploads are paused, but not a profile picture (FL-538)', () => {
      const paused = { ...authStub.admin, user: { ...authStub.admin.user, uploadsPaused: true } };
      const request = (fieldName: UploadFieldName, name: string) => ({
        ...uploadFile.filename(fieldName, name),
        auth: paused,
      });
      expect(() => sut.canUploadFile(request(UploadFieldName.ASSET_DATA, 'photo.jpg'))).toThrowError(
        ForbiddenException,
      );
      expect(sut.canUploadFile(request(UploadFieldName.PROFILE_DATA, 'me.jpg'))).toEqual(true);
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

  describe('Live Photo upload commit', () => {
    const auth = authStub.user1;
    let committed: boolean;
    beforeEach(() => {
      committed = false;
      mocks.asset.getById.mockResolvedValue(
        getForAsset(AssetFactory.from({ type: AssetType.Video }).owner(auth.user).build()),
      );
      mocks.asset.create.mockResolvedValue(assetEntity);
      Object.assign(mocks.asset, {
        createLivePhotoUpload: vitest.fn(() =>
          tryPromise(() => {
            committed = true;
            return { asset: assetEntity, hiddenId: 'motion', lockedIds: [] };
          }),
        ),
      });
    });

    it('prepares the still without hiding or announcing the motion before publication', async () => {
      await sut.prepareUploadAsset(auth, { ...createDto, livePhotoVideoId: 'motion' }, fileStub.livePhotoStill);
      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
      expect(mocks.asset.create).not.toHaveBeenCalled();
    });

    it('does not hide or announce the motion when asset publication fails', async () => {
      mocks.asset.create.mockRejectedValue(new Error('publication failed'));
      Object.assign(mocks.asset, {
        createLivePhotoUpload: vitest.fn().mockRejectedValue(new Error('publication failed')),
      });
      await expect(
        sut.uploadAsset(auth, { ...createDto, livePhotoVideoId: 'motion' }, fileStub.livePhotoStill),
      ).rejects.toThrow();
      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetHide', expect.anything());
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [fileStub.livePhotoStill.originalPath, undefined] },
      });
    });

    it('emits the motion hide only after the repository commits the still and motion', async () => {
      mocks.event.emit.mockImplementation((...[name]) =>
        tryPromise(() => {
          if (name === 'AssetHide') expect(committed).toBe(true);
        }),
      );
      await sut.uploadAsset(auth, { ...createDto, livePhotoVideoId: 'motion' }, fileStub.livePhotoStill);
      expect(mocks.asset.createLivePhotoUpload).toHaveBeenCalledWith(
        expect.objectContaining({ livePhotoVideoId: 'motion' }),
        undefined,
      );
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetHide', { assetId: 'motion', userId: auth.user.id });
    });

    it('preserves checksum-duplicate responses without hiding the requested motion', async () => {
      const error = Object.assign(new Error('duplicate'), { constraint_name: 'UQ_assets_owner_checksum' });
      mocks.asset.create.mockRejectedValue(error);
      Object.assign(mocks.asset, { createLivePhotoUpload: vitest.fn().mockRejectedValue(error) });
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue('existing');
      await expect(
        sut.uploadAsset(auth, { ...createDto, livePhotoVideoId: 'motion' }, fileStub.livePhotoStill),
      ).resolves.toEqual({ id: 'existing', status: AssetMediaStatus.DUPLICATE });
      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalledWith('AssetHide', expect.anything());
    });

    it('passes the explicit Locked decision through without requiring a PIN and follows up after commit', async () => {
      Object.assign(mocks.asset, {
        createLivePhotoUpload: vitest.fn(() =>
          tryPromise(() => {
            committed = true;
            return { asset: assetEntity, hiddenId: 'motion', lockedIds: ['id_1', 'motion'] };
          }),
        ),
      });
      mocks.person.getMissingThumbnailsForAssets.mockResolvedValue([]);
      mocks.user.getLockedProfileImageSources.mockResolvedValue([]);
      mocks.event.emit.mockImplementation(() =>
        tryPromise(() => {
          expect(committed).toBe(true);
        }),
      );
      await sut.uploadAsset(
        auth,
        { ...createDto, livePhotoVideoId: 'motion', visibility: AssetVisibility.Locked },
        fileStub.livePhotoStill,
      );
      expect(mocks.asset.createLivePhotoUpload).toHaveBeenCalledWith(
        expect.objectContaining({ visibility: AssetVisibility.Timeline }),
        { reason: AssetLockReason.Marked, lockedBy: auth.user.id },
      );
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetLocked', { assetIds: ['id_1', 'motion'] });
    });
  });

  describe('a lost original (media health)', () => {
    const lost = {
      id: 'lost-asset',
      checksum: file1,
      deletedAt: null as Date | null,
      status: AssetStatus.Active,
      originalPath: '/data/upload/user-id/aa/bb/IMG_0420.jpg',
      libraryId: null,
      isExternal: false,
    };
    const upload = {
      uuid: 'random-uuid',
      originalPath: '/data/upload/user-id/cc/dd/random-uuid.jpg',
      mimeType: 'image/jpeg',
      checksum: Buffer.from('sha256-of-the-file'),
      legacyChecksum: file1,
      originalName: 'IMG_0420.jpg',
      size: 42,
    };

    beforeEach(() => {
      mocks.asset.getByChecksums.mockResolvedValue([lost]);
      mocks.storage.checkFileExists.mockResolvedValue(false);
    });

    it('does not answer a checksum preflight with a duplicate', async () => {
      mocks.asset.getUploadAssetIdByChecksum.mockResolvedValue(lost.id);
      await expect(sut.getUploadAssetIdByChecksum(authStub.admin, file1.toString('hex'))).resolves.toBeUndefined();
    });

    it('accepts the file in the bulk upload check', async () => {
      await expect(
        sut.bulkUploadCheck(authStub.admin, { assets: [{ id: '1', checksum: file1.toString('hex') }] }),
      ).resolves.toEqual({ results: [{ id: '1', action: AssetUploadAction.ACCEPT }] });
    });

    it('still rejects the file when another matching photo has its original', async () => {
      mocks.asset.getByChecksums.mockResolvedValue([lost, { ...lost, id: 'kept', originalPath: '/data/kept.jpg' }]);
      mocks.storage.checkFileExists.mockImplementation((path) => Promise.resolve(path === '/data/kept.jpg'));
      await expect(
        sut.bulkUploadCheck(authStub.admin, { assets: [{ id: '1', checksum: file1.toString('hex') }] }),
      ).resolves.toEqual({
        results: [
          {
            id: '1',
            action: AssetUploadAction.REJECT,
            reason: AssetRejectReason.DUPLICATE,
            assetId: 'kept',
            isTrashed: false,
          },
        ],
      });
    });

    it('restores the photo from the upload instead of creating another one', async () => {
      mocks.physicalFile.restoreLostOriginal.mockResolvedValue(true);
      await expect(sut.uploadAsset(authStub.admin, createDto, upload)).resolves.toEqual({
        id: lost.id,
        status: AssetMediaStatus.CREATED,
      });
      expect(mocks.asset.getByChecksums).toHaveBeenCalledWith(authStub.admin.user.id, [upload.checksum, file1]);
      expect(mocks.physicalFile.restoreLostOriginal).toHaveBeenCalledWith({
        assetId: lost.id,
        expectedOriginalPath: lost.originalPath,
        originalPath: upload.originalPath,
        sha1: file1,
        sha256: upload.checksum,
        sizeInBytes: 42,
        reason: 'restored_by_upload',
      });
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.FileDelete }));
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.SidecarCheck, data: { id: lost.id, source: 'upload' } },
        { name: JobName.AssetGenerateThumbnails, data: { id: lost.id, source: 'upload' } },
      ]);
    });

    it('repairs a hidden photo but answers like a hidden duplicate, without its id', async () => {
      // NSFW privacy mode hides the photo from this session.
      const locked = { ...AuthFactory.create(), hideNsfwAssets: true };
      mocks.asset.getByChecksums.mockImplementation((_owner, _checksums, options) =>
        Promise.resolve(options ? [] : [lost]),
      );
      mocks.physicalFile.restoreLostOriginal.mockResolvedValue(true);
      await expect(sut.uploadAsset(locked, createDto, upload)).resolves.toEqual({
        id: '00000000-0000-0000-0000-000000000000',
        status: AssetMediaStatus.DUPLICATE,
      });
      // Looked up without the session's hidden-content filter, so the Locked photo was found and repaired.
      expect(mocks.asset.getByChecksums).toHaveBeenCalledWith(locked.user.id, [upload.checksum, file1]);
      expect(mocks.physicalFile.restoreLostOriginal).toHaveBeenCalledWith(
        expect.objectContaining({ assetId: lost.id, originalPath: upload.originalPath }),
      );
      expect(mocks.asset.create).not.toHaveBeenCalled();
    });

    it('never restores a photo removed as a duplicate (in the Trash)', async () => {
      mocks.asset.getByChecksums.mockResolvedValue([{ ...lost, deletedAt: new Date(), status: AssetStatus.Trashed }]);
      mocks.asset.create.mockResolvedValue(assetEntity);
      await sut.uploadAsset(authStub.admin, createDto, upload);
      expect(mocks.physicalFile.restoreLostOriginal).not.toHaveBeenCalled();
      expect(mocks.asset.create).toHaveBeenCalled();
    });

    describe('while the account lets uploads bring photos back from the Trash (FL-556)', () => {
      const trashed = { ...lost, deletedAt: new Date(), status: AssetStatus.Trashed };
      const open = () =>
        mocks.user.getMetadata.mockResolvedValue([
          {
            key: UserMetadataKey.Preferences,
            value: { trash: { reuploadUntil: new Date(Date.now() + 60_000).toISOString() } },
          },
        ] as never);

      beforeEach(() => {
        mocks.asset.getByChecksums.mockResolvedValue([trashed]);
        mocks.trash.restoreAll.mockResolvedValue([trashed.id]);
      });

      it('brings the photo back and drops the upload when the photo still has its file', async () => {
        open();
        mocks.storage.checkFileExists.mockResolvedValue(true);
        await expect(sut.uploadAsset(authStub.admin, createDto, upload)).resolves.toEqual({
          id: trashed.id,
          status: AssetMediaStatus.CREATED,
        });
        expect(mocks.trash.restoreAll).toHaveBeenCalledWith([trashed.id], authStub.admin, expect.any(Function));
        expect(mocks.event.emit).toHaveBeenCalledWith('AssetRestoreAll', {
          assetIds: [trashed.id],
          userId: authStub.admin.user.id,
        });
        expect(mocks.physicalFile.restoreLostOriginal).not.toHaveBeenCalled();
        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.FileDelete,
          data: { files: [upload.originalPath] },
        });
        expect(mocks.asset.create).not.toHaveBeenCalled();
      });

      it('also puts the upload back as its file when the photo had lost it', async () => {
        open();
        mocks.storage.checkFileExists.mockResolvedValue(false);
        mocks.physicalFile.restoreLostOriginal.mockResolvedValue(true);
        await expect(sut.uploadAsset(authStub.admin, createDto, upload)).resolves.toEqual({
          id: trashed.id,
          status: AssetMediaStatus.CREATED,
        });
        expect(mocks.physicalFile.restoreLostOriginal).toHaveBeenCalledWith(
          expect.objectContaining({ assetId: trashed.id, originalPath: upload.originalPath }),
        );
        expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.FileDelete }));
      });

      it('accepts the file in the bulk upload check', async () => {
        open();
        await expect(
          sut.bulkUploadCheck(authStub.admin, { assets: [{ id: '1', checksum: file1.toString('hex') }] }),
        ).resolves.toEqual({ results: [{ id: '1', action: AssetUploadAction.ACCEPT }] });
      });

      it('leaves the Trash alone once the window has closed', async () => {
        mocks.user.getMetadata.mockResolvedValue([
          {
            key: UserMetadataKey.Preferences,
            value: { trash: { reuploadUntil: new Date(Date.now() - 1).toISOString() } },
          },
        ] as never);
        mocks.storage.checkFileExists.mockResolvedValue(true);
        await expect(
          sut.bulkUploadCheck(authStub.admin, { assets: [{ id: '1', checksum: file1.toString('hex') }] }),
        ).resolves.toEqual({
          results: [
            {
              id: '1',
              action: AssetUploadAction.REJECT,
              reason: AssetRejectReason.DUPLICATE,
              assetId: trashed.id,
              isTrashed: true,
            },
          ],
        });
        expect(mocks.trash.restoreAll).not.toHaveBeenCalled();
      });

      it('never touches photos awaiting removal, or a Trash photo whose bytes a live photo already has', async () => {
        open();
        mocks.asset.getByChecksums.mockResolvedValue([
          { ...trashed, status: AssetStatus.Deleted },
          { ...lost, id: 'live', originalPath: '/data/live.jpg' },
        ]);
        mocks.asset.create.mockResolvedValue(assetEntity);
        await sut.uploadAsset(authStub.admin, createDto, upload);
        expect(mocks.trash.restoreAll).not.toHaveBeenCalled();
      });
    });

    it('uploads normally when the photo changed before it could be restored', async () => {
      mocks.physicalFile.restoreLostOriginal.mockResolvedValue(false);
      mocks.asset.create.mockResolvedValue(assetEntity);
      await expect(sut.uploadAsset(authStub.admin, createDto, upload)).resolves.toMatchObject({
        status: AssetMediaStatus.CREATED,
      });
      expect(mocks.asset.create).toHaveBeenCalled();
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

    describe('universal storage linking', () => {
      const file = {
        uuid: 'random-uuid',
        originalPath: '/data/upload/user1/ra/nd/random-uuid.jpeg',
        mimeType: 'image/jpeg',
        checksum: Buffer.from('file hash', 'utf8'),
        originalName: 'duplicate.jpeg',
        size: 42,
      };

      it('links content another library already holds to its file and answers created, not duplicate', async () => {
        const asset = {
          ...assetEntity,
          id: 'new-asset',
          ownerId: authStub.user1.user.id,
          originalPath: file.originalPath,
        };
        const physicalFile = { id: 'physical-file-id', path: '/data/library/other/shared.jpeg' };
        mocks.asset.create.mockResolvedValue(asset);
        mocks.physicalFile.linkUploadedOriginal.mockResolvedValue({ physicalFile, linked: true } as never);

        await expect(sut.uploadAsset(authStub.user1, createDto, file)).resolves.toEqual({
          id: 'new-asset',
          status: AssetMediaStatus.CREATED,
        });

        expect(mocks.physicalFile.linkUploadedOriginal).toHaveBeenCalledWith(
          'new-asset',
          { checksum: file.checksum, sizeInBytes: file.size },
          expect.objectContaining({ verify: expect.any(Function), identify: expect.any(Function) }),
        );
        // the temporary upload is released through the reference-counted FileDelete
        expect(mocks.job.queue).toHaveBeenCalledWith({
          name: JobName.FileDelete,
          data: { files: [file.originalPath] },
        });
        expect(mocks.event.emit).toHaveBeenCalledWith(
          'AssetCreate',
          expect.objectContaining({
            asset: expect.objectContaining({
              originalPath: physicalFile.path,
              physicalOriginalFileId: physicalFile.id,
            }),
          }),
        );
      });

      it('needs no master account: the link is attempted with the old settings left unset', async () => {
        mocks.systemMetadata.get.mockResolvedValue({ physicalDeduplication: { enabled: false, masterUserId: null } });
        mocks.asset.create.mockResolvedValue(assetEntity);

        await sut.uploadAsset(authStub.user1, createDto, file);

        expect(mocks.physicalFile.linkUploadedOriginal).toHaveBeenCalled();
      });

      it('registers new content as its own primary file and keeps the upload', async () => {
        const physicalFile = { id: 'own-physical-file', path: file.originalPath };
        mocks.asset.create.mockResolvedValue({ ...assetEntity });
        mocks.physicalFile.linkUploadedOriginal.mockResolvedValue({ physicalFile, linked: false } as never);

        await expect(sut.uploadAsset(authStub.user1, createDto, file)).resolves.toEqual({
          id: 'id_1',
          status: AssetMediaStatus.CREATED,
        });

        expect(mocks.job.queue).not.toHaveBeenCalledWith({
          name: JobName.FileDelete,
          data: { files: [file.originalPath] },
        });
        expect(mocks.event.emit).toHaveBeenCalledWith(
          'AssetCreate',
          expect.objectContaining({ asset: expect.objectContaining({ physicalOriginalFileId: physicalFile.id }) }),
        );
      });

      it('takes content in the file trash back out instead of storing it twice (Review Focus 3)', async () => {
        mocks.asset.create.mockResolvedValue({ ...assetEntity });

        await sut.uploadAsset(authStub.user1, createDto, file);

        const options = mocks.physicalFile.linkUploadedOriginal.mock.calls[0][2];
        await options.untrash!('/data/file-trash/id/duplicate.jpeg', '/data/upload/restored.jpeg');
        expect(mocks.storage.rename).toHaveBeenCalledWith(
          '/data/file-trash/id/duplicate.jpeg',
          '/data/upload/restored.jpeg',
        );
      });

      describe('proving the stored file before the upload is let go (FL-412)', () => {
        const shared = '/data/library/other/shared.jpeg';
        const stats = { isFile: () => true, dev: 1, ino: 2, size: file.size, mtimeMs: 3, ctimeMs: 4 };

        const uploadOptions = async () => {
          mocks.asset.create.mockResolvedValue(assetEntity);
          await sut.uploadAsset(authStub.user1, createDto, file);
          return mocks.physicalFile.linkUploadedOriginal.mock.calls[0][2];
        };

        it('proves a stored file with the same bytes, by its own checksum, and names it', async () => {
          const options = await uploadOptions();
          mocks.storage.stat.mockResolvedValue(stats as never);
          mocks.crypto.hashFileMatching.mockResolvedValue(file.checksum);

          const identity = await options.verify(shared);

          expect(identity).toEqual(expect.any(String));
          expect(mocks.crypto.hashFileMatching).toHaveBeenCalledWith(shared, file.checksum);
          await expect(options.identify(shared)).resolves.toBe(identity);
          expect(mocks.logger.warn).not.toHaveBeenCalled();
        });

        it('never trusts a stored file that holds other bytes, and says so', async () => {
          const options = await uploadOptions();
          mocks.storage.stat.mockResolvedValue(stats as never);
          mocks.crypto.hashFileMatching.mockResolvedValue(Buffer.from('rotted'));

          await expect(options.verify(shared)).resolves.toBeNull();
          expect(mocks.logger.warn).toHaveBeenCalledWith(expect.stringContaining(shared));
        });

        it('never trusts a stored file of another size, without reading it', async () => {
          const options = await uploadOptions();
          mocks.storage.stat.mockResolvedValue({ ...stats, size: file.size + 1 } as never);
          mocks.crypto.hashFileMatching.mockClear();

          await expect(options.verify(shared)).resolves.toBeNull();
          expect(mocks.crypto.hashFileMatching).not.toHaveBeenCalled();
        });

        it('never trusts a stored file that changed while it was read', async () => {
          const options = await uploadOptions();
          mocks.storage.stat
            .mockResolvedValueOnce(stats as never)
            .mockResolvedValueOnce({ ...stats, mtimeMs: 99 } as never);
          mocks.crypto.hashFileMatching.mockResolvedValue(file.checksum);

          await expect(options.verify(shared)).resolves.toBeNull();
        });

        it('reports a stored file that is gone as having no identity', async () => {
          const options = await uploadOptions();
          mocks.storage.stat.mockRejectedValue(Object.assign(new Error('gone'), { code: 'ENOENT' }));

          await expect(options.verify(shared)).resolves.toBeNull();
          await expect(options.identify(shared)).resolves.toBeNull();
          expect(mocks.logger.warn).not.toHaveBeenCalled();
        });
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
      mocks.asset.createLivePhotoUpload.mockResolvedValueOnce({ asset, hiddenId: undefined, lockedIds: [] });

      await expect(
        sut.uploadAsset(authStub.user1, { ...createDto, livePhotoVideoId: motionAsset.id }, fileStub.livePhotoStill),
      ).resolves.toEqual({
        status: AssetMediaStatus.CREATED,
        id: asset.id,
      });

      expect(mocks.asset.createLivePhotoUpload).toHaveBeenCalledWith(
        expect.objectContaining({ livePhotoVideoId: motionAsset.id }),
        undefined,
      );
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('should hide the linked motion asset', async () => {
      const motionAsset = AssetFactory.from({ type: AssetType.Video }).owner(authStub.user1.user).build();
      const asset = AssetFactory.create();
      mocks.asset.createLivePhotoUpload.mockResolvedValueOnce({ asset, hiddenId: motionAsset.id, lockedIds: [] });

      await expect(
        sut.uploadAsset(authStub.user1, { ...createDto, livePhotoVideoId: motionAsset.id }, fileStub.livePhotoStill),
      ).resolves.toEqual({
        status: AssetMediaStatus.CREATED,
        id: asset.id,
      });

      expect(mocks.asset.createLivePhotoUpload).toHaveBeenCalledWith(
        expect.objectContaining({ livePhotoVideoId: motionAsset.id }),
        undefined,
      );
      expect(mocks.event.emit).toHaveBeenCalledWith('AssetHide', {
        assetId: motionAsset.id,
        userId: authStub.user1.user.id,
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
        new FileDownloadResponse({
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
    });

    it('should download a file', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginal.mockResolvedValue(asset);

      await expect(sut.downloadOriginal(authStub.admin, asset.id, {})).resolves.toEqual(
        new FileDownloadResponse({
          path: asset.originalPath,
          fileName: asset.originalFileName,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
    });

    it('downloads the original by default even when edits exist', async () => {
      const editedAsset = AssetFactory.from()
        .edit()
        .files([AssetFileType.FullSize, AssetFileType.Preview, AssetFileType.Thumbnail])
        .file({ type: AssetFileType.FullSize, isEdited: true })
        .build();

      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([editedAsset.id]));
      mocks.asset.getForOriginal.mockResolvedValue(editedAsset);

      await expect(sut.downloadOriginal(AuthFactory.create(), editedAsset.id, {})).resolves.toEqual(
        new FileDownloadResponse({
          path: editedAsset.originalPath,
          fileName: editedAsset.originalFileName,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
      expect(mocks.asset.getForOriginal).toHaveBeenCalledWith(editedAsset.id, false);
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
        new FileDownloadResponse({
          path: editedAsset.files[3].path,
          fileName: editedAsset.originalFileName,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
      expect(mocks.asset.getForOriginal).toHaveBeenCalledWith(editedAsset.id, true);
    });

    it('should not return the unedited version if requested using a shared link', async () => {
      const fullsizeEdited = AssetFileFactory.create({ type: AssetFileType.FullSize, isEdited: true });
      const editedAsset = AssetFactory.from().edit({ action: AssetEditAction.Crop }).file(fullsizeEdited).build();

      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([editedAsset.id]));
      mocks.asset.getForOriginal.mockResolvedValue({ ...editedAsset, editedPath: fullsizeEdited.path });

      await expect(
        sut.downloadOriginal(AuthFactory.from().sharedLink().build(), editedAsset.id, { edited: false }),
      ).resolves.toEqual(
        new FileDownloadResponse({
          path: fullsizeEdited.path,
          fileName: editedAsset.originalFileName,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
      expect(mocks.asset.getForOriginal).toHaveBeenCalledWith(editedAsset.id, true);
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
        new FileDownloadResponse({
          path: editedAsset.originalPath,
          fileName: editedAsset.originalFileName,
          contentType: 'image/jpeg',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
    });

    describe('as shown (owner, 2026-10-16)', () => {
      const developed = (ownerId: string, status = AssetDevelopRevisionStatus.Rendered) => ({
        id: 'revision',
        ownerId,
        status,
        masterPath: '/develop/master.webp',
        previewPath: '/develop/preview.webp',
      });

      it('gives the owner their current develop version, the picture their viewer shows, uncached', async () => {
        const asset = AssetFactory.create({ ownerId: authStub.admin.user.id, originalFileName: 'IMG_1.HEIC' });
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
        mocks.asset.getForOriginal.mockResolvedValue({ ...asset, editedPath: null });
        mocks.asset.getCurrentDevelop.mockResolvedValue(developed(asset.ownerId));

        await expect(sut.downloadOriginal(authStub.admin, asset.id, { edited: true })).resolves.toEqual(
          new FileDownloadResponse({
            path: '/develop/master.webp',
            fileName: 'IMG_1.webp',
            contentType: 'image/webp',
            cacheControl: CacheControl.PrivateWithoutCache,
          }),
        );
        expect(mocks.asset.getCurrentDevelop).toHaveBeenCalledWith(asset.id);
      });

      it('gives the original when the original is asked for, or while the current version is not rendered', async () => {
        const asset = AssetFactory.create({ ownerId: authStub.admin.user.id });
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
        mocks.asset.getForOriginal.mockResolvedValue(asset);
        mocks.asset.getCurrentDevelop.mockResolvedValue({
          ...developed(asset.ownerId, AssetDevelopRevisionStatus.Rendering),
          masterPath: null,
        });

        await expect(sut.downloadOriginal(authStub.admin, asset.id, { edited: false })).resolves.toMatchObject({
          path: asset.originalPath,
        });
        expect(mocks.asset.getCurrentDevelop).not.toHaveBeenCalled();
        await expect(sut.downloadOriginal(authStub.admin, asset.id, { edited: true })).resolves.toMatchObject({
          path: asset.originalPath,
          cacheControl: CacheControl.PrivateWithCache,
        });
      });

      it("never gives anyone else the owner's working version", async () => {
        const fullsizeEdited = AssetFileFactory.create({ type: AssetFileType.FullSize, isEdited: true });
        const asset = AssetFactory.from({ ownerId: authStub.user1.user.id }).file(fullsizeEdited).build();
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
        mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
        mocks.asset.getForOriginal.mockResolvedValue({ ...asset, editedPath: fullsizeEdited.path });
        mocks.asset.getCurrentDevelop.mockResolvedValue(developed(asset.ownerId));

        await expect(sut.downloadOriginal(authStub.admin, asset.id, { edited: true })).resolves.toMatchObject({
          path: fullsizeEdited.path,
        });
        await expect(
          sut.downloadOriginal(AuthFactory.from().sharedLink().build(), asset.id, { edited: true }),
        ).resolves.toMatchObject({ path: fullsizeEdited.path });
        expect(mocks.asset.getCurrentDevelop).not.toHaveBeenCalled();
      });
    });
  });

  describe('explicit original still exports', () => {
    afterEach(() => vitest.unstubAllEnvs());
    const source = () => {
      const asset = { ...AssetFactory.create(), livePhotoVideoId: '22222222-2222-4222-8222-222222222222' };
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginal.mockResolvedValue(asset);
      mocks.asset.getById.mockResolvedValue(getForAsset(asset));
      return asset;
    };
    it.each(['sdr-jpeg', 'hdr-jpeg', 'hdr-heic'] as const)(
      'exports %s as a private still and retains motion',
      async (format) => {
        vitest.stubEnv('FRAMELEAF_HDR_IMAGES', 'experimental');
        mocks.media.getHdrCodecCapabilities.mockResolvedValue({
          libheif: 'qualified-build',
          libultrahdr: 'qualified-build',
          heicDecoder: true,
          avifDecoder: true,
          heicPqEncoder: true,
        });
        const asset = source();
        const result = await sut.downloadOriginal(AuthFactory.create(), asset.id, { format });
        try {
          expect(result.contentType).toBe(format === 'hdr-heic' ? 'image/heic' : 'image/jpeg');
          expect(result.cacheControl).toBe(CacheControl.PrivateWithoutCache);
          expect(result.fileName).toContain('_still_');
          expect(mocks.media.exportPhotoStill).toHaveBeenCalledWith(
            asset.originalPath,
            result.path,
            format,
            asset.checksum,
            undefined,
          );
          expect(asset.livePhotoVideoId).toBe('22222222-2222-4222-8222-222222222222');
          expect(mocks.job.queue).not.toHaveBeenCalled();
          expect(mocks.asset.update).not.toHaveBeenCalled();
        } finally {
          await result.release?.();
        }
        await vitest.waitFor(async () => expect(stat(dirname(result.path))).rejects.toMatchObject({ code: 'ENOENT' }));
      },
    );
    it('refuses changed source identity after rendering and removes unpublished output', async () => {
      const asset = source();
      mocks.asset.getById
        .mockResolvedValueOnce(getForAsset(asset))
        .mockResolvedValueOnce(getForAsset({ ...asset, checksum: Buffer.alloc(32) }));
      await expect(sut.downloadOriginal(AuthFactory.create(), asset.id, { format: 'sdr-jpeg' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      const output = mocks.media.exportPhotoStill.mock.calls[0][1];
      await expect(stat(dirname(output))).rejects.toMatchObject({ code: 'ENOENT' });
    });
    it('joins cancellation and removes private files without returning an export', async () => {
      const asset = source();
      const abort = new AbortController();
      mocks.media.exportPhotoStill.mockImplementation(() => {
        abort.abort();
        return Promise.resolve();
      });
      await expect(
        sut.downloadOriginal(AuthFactory.create(), asset.id, { format: 'sdr-jpeg' }, abort.signal),
      ).rejects.toMatchObject({ name: 'AbortError' });
      await expect(stat(dirname(mocks.media.exportPhotoStill.mock.calls[0][1]))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    it('revalidates download access after rendering', async () => {
      const asset = source();
      mocks.access.asset.checkOwnerAccess.mockResolvedValueOnce(new Set([asset.id])).mockResolvedValue(new Set());
      await expect(sut.downloadOriginal(AuthFactory.create(), asset.id, { format: 'sdr-jpeg' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(stat(dirname(mocks.media.exportPhotoStill.mock.calls[0][1]))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    it.each([
      [new Error('HDR_RECONSTRUCTION_UNAVAILABLE'), 'hdr_reconstruction_unavailable'],
      [new SharpResourceLimitError('surfaces'), 'photo_export_resource_limit'],
    ])('reports a classified export refusal and removes private output', async (error, code) => {
      const asset = source();
      mocks.media.exportPhotoStill.mockRejectedValue(error);
      try {
        await sut.downloadOriginal(AuthFactory.create(), asset.id, { format: 'sdr-jpeg' });
        expect.unreachable('Export must be refused');
      } catch (error) {
        expect(error).toBeInstanceOf(BadRequestException);
        expect((error as BadRequestException).getResponse()).toMatchObject({ code });
      }
      await expect(stat(dirname(mocks.media.exportPhotoStill.mock.calls[0][1]))).rejects.toMatchObject({
        code: 'ENOENT',
      });
    });
    it('keeps metadata-hidden shared-link download restrictions before conversion', async () => {
      const asset = source();
      const auth = AuthFactory.from().sharedLink({ showExif: false, allowDownload: true }).build();
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
      await expect(sut.downloadOriginal(auth, asset.id, { format: 'sdr-jpeg' })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(mocks.media.exportPhotoStill).not.toHaveBeenCalled();
    });
    it('refuses motion, substituted edits, and explicit HDR while processing is disabled', async () => {
      const asset = source();
      mocks.asset.getById.mockResolvedValueOnce(getForAsset({ ...asset, type: AssetType.Video }));
      await expect(sut.downloadOriginal(AuthFactory.create(), asset.id, { format: 'sdr-jpeg' })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      mocks.asset.getForOriginal.mockResolvedValueOnce({ ...asset, editedPath: '/private/edited.jpg' });
      await expect(
        sut.downloadOriginal(AuthFactory.create(), asset.id, { format: 'sdr-jpeg', edited: true }),
      ).rejects.toBeInstanceOf(BadRequestException);
      vitest.stubEnv('FRAMELEAF_HDR_IMAGES', '');
      await expect(sut.downloadOriginal(AuthFactory.create(), asset.id, { format: 'hdr-jpeg' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.media.exportPhotoStill).not.toHaveBeenCalled();
    });
  });

  describe('downloadOriginal location policy (FL-54)', () => {
    const lease = { path: '/tmp/immich-location-free/copy.jpg', release: vitest.fn() };

    const setup = () => {
      const me = UserFactory.create();
      const owner = UserFactory.create();
      const asset = AssetFactory.create({ ownerId: owner.id, originalPath: '/original/photo.jpg' });
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginal.mockResolvedValue({ ...asset, editedPath: null });
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

    it('serves anyone who can reach an original its bytes untouched (FL-326: locations are always shared)', async () => {
      const { auth, asset } = setup();

      const response = await sut.downloadOriginal(auth, asset.id, {});

      expect(response.path).toBe(asset.originalPath);
      expect(mocks.metadata.acquireLocationFreeOriginal).not.toHaveBeenCalled();
    });

    it('never checks thumbnails or previews, which are re-encoded without metadata', async () => {
      const { auth, asset } = setup();
      mocks.access.asset.checkAlbumAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ownerId: asset.ownerId,
        isEdited: false,
        originalPath: '/original/photo.cr2',
        originalFileName: 'photo.cr2',
        path: '/thumbs/photo-preview.jpeg',
      });

      await sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW });

      expect(mocks.metadata.acquireLocationFreeOriginal).not.toHaveBeenCalled();
    });

    it('refuses a shared link that hides metadata even when its download flag is on', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForOriginal.mockResolvedValue({ ...asset, editedPath: null });
      const auth = AuthFactory.from().sharedLink({ showExif: false, allowDownload: true }).build();

      await expect(sut.downloadOriginal(auth, asset.id, {})).rejects.toBeInstanceOf(ForbiddenException);
      expect(mocks.metadata.acquireLocationFreeOriginal).not.toHaveBeenCalled();
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
    it('refuses explicit HDR when processing is disabled instead of returning SDR', async () => {
      const asset = AssetFactory.create();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ...asset,
        path: '/data/preview.jpg',
      });
      await expect(
        sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.PREVIEW, dynamicRange: 'hdr' }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('serves an authorized HDR derivative without redirecting to the original', async () => {
      vitest.stubEnv('FRAMELEAF_HDR_IMAGES', 'experimental');
      try {
        const asset = AssetFactory.create();
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
        mocks.asset.getForThumbnail.mockResolvedValueOnce({
          imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
          renditionIdentity: null,
          ...asset,
          path: '/data/preview.jpg',
        });
        mocks.asset.getForThumbnail.mockResolvedValueOnce({
          imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
          renditionIdentity: '1'.repeat(64),
          ...asset,
          path: '/data/hdr-preview.jpg',
        });
        await expect(
          sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.PREVIEW, dynamicRange: 'hdr' }),
        ).resolves.toMatchObject({ path: '/data/hdr-preview.jpg', contentType: 'image/jpeg' });
        expect(mocks.asset.getForThumbnail).toHaveBeenLastCalledWith(asset.id, AssetFileType.HdrPreview, false);
      } finally {
        vitest.unstubAllEnvs();
      }
    });

    it('serves the last accepted HDR edit through regeneration and keeps default delivery SDR', async () => {
      vitest.stubEnv('FRAMELEAF_HDR_IMAGES', 'experimental');
      try {
        const asset = AssetFactory.from({ ownerId: authStub.admin.user.id })
          .file({ type: AssetFileType.Preview })
          .build();
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
        mocks.asset.getForThumbnail.mockResolvedValue({
          ...asset,
          path: asset.files[0].path,
          renditionIdentity: null,
          imageEncoding: { dynamicRange: 'hdr', gainMap: 'ultra-hdr', reconstructionAvailable: true },
        });
        mocks.asset.getCurrentDevelop.mockResolvedValue({
          id: 'revision',
          ownerId: asset.ownerId,
          status: AssetDevelopRevisionStatus.Rendering,
          masterPath: '/old-sdr-master.jpg',
          previewPath: '/old-sdr-preview.jpg',
          hdrMasterPath: '/old-hdr-master.jpg',
          hdrPreviewPath: '/old-hdr-preview.jpg',
          hdrRenditionChecksum: Buffer.alloc(32),
          renderedAt: new Date(),
        });
        for (const [dynamicRange, path] of [
          [undefined, '/old-sdr-preview.jpg'],
          ['sdr', '/old-sdr-preview.jpg'],
          ['auto', '/old-hdr-preview.jpg'],
          ['hdr', '/old-hdr-preview.jpg'],
        ] as const) {
          await expect(
            sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.PREVIEW, edited: true, dynamicRange }),
          ).resolves.toMatchObject({ path, cacheControl: CacheControl.PrivateWithoutCache });
        }
        vitest.stubEnv('FRAMELEAF_HDR_IMAGES', '');
        await expect(
          sut.viewThumbnail(authStub.admin, asset.id, {
            size: AssetMediaSize.PREVIEW,
            edited: true,
            dynamicRange: 'hdr',
          }),
        ).rejects.toBeInstanceOf(NotFoundException);
        await expect(
          sut.viewThumbnail(authStub.admin, asset.id, {
            size: AssetMediaSize.PREVIEW,
            edited: true,
            dynamicRange: 'auto',
          }),
        ).resolves.toMatchObject({ path: '/old-sdr-preview.jpg' });
      } finally {
        vitest.unstubAllEnvs();
      }
    });

    it.each(['auto', 'sdr'] as const)(
      'keeps an unedited SDR source full resolution in %s viewing',
      async (dynamicRange) => {
        const asset = AssetFactory.create({ originalPath: '/data/original.jpg', isEdited: false });
        mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
        mocks.asset.getForThumbnail.mockResolvedValue({
          ...asset,
          path: null,
          renditionIdentity: null,
          imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        });
        await expect(
          sut.viewThumbnail(authStub.admin, asset.id, {
            size: AssetMediaSize.FULLSIZE,
            edited: true,
            dynamicRange,
          }),
        ).resolves.toEqual({ targetSize: 'original' });
      },
    );

    it.each([
      { allowDownload: false, showExif: true },
      { allowDownload: true, showExif: false },
    ])('keeps restricted shared viewers on sanitized SDR pixels (%j)', async (policy) => {
      const asset = AssetFactory.create({ originalPath: '/data/original.jpg', isEdited: false });
      const auth = AuthFactory.from().sharedLink(policy).build();
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({
        ...asset,
        path: null,
        renditionIdentity: null,
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
      });
      await expect(
        sut.viewThumbnail(auth, asset.id, {
          size: AssetMediaSize.FULLSIZE,
          edited: true,
          dynamicRange: 'auto',
        }),
      ).resolves.toEqual({ targetSize: AssetMediaSize.PREVIEW });
    });

    it('does not bypass a legacy edit for full-resolution SDR viewing', async () => {
      const asset = AssetFactory.create({ originalPath: '/data/original.jpg', isEdited: true });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({
        ...asset,
        path: '/data/edited.jpg',
        renditionIdentity: null,
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
      });
      await expect(
        sut.viewThumbnail(authStub.admin, asset.id, {
          size: AssetMediaSize.FULLSIZE,
          edited: true,
          dynamicRange: 'sdr',
        }),
      ).resolves.toMatchObject({ path: '/data/edited.jpg' });
    });

    it('does not redirect an HDR or unknown source to the original for default SDR viewing', async () => {
      const asset = AssetFactory.from({ originalPath: '/data/original.jpg' }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      for (const dynamicRange of ['hdr', 'unknown'] as const) {
        mocks.asset.getForThumbnail.mockResolvedValue({
          renditionIdentity: null,
          ...asset,
          path: null,
          imageEncoding: { dynamicRange, gainMap: 'none', reconstructionAvailable: false },
        });
        await expect(sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.FULLSIZE })).resolves.toEqual({
          targetSize: AssetMediaSize.PREVIEW,
        });
      }
    });

    it('redirects a never-inspected web image to the original while HDR processing is off', async () => {
      const asset = AssetFactory.from({ originalPath: '/data/original.jpg' }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({
        renditionIdentity: null,
        ...asset,
        path: null,
        imageEncoding: null,
      });
      await expect(sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.FULLSIZE })).resolves.toEqual({
        targetSize: 'original',
      });

      vitest.stubEnv('FRAMELEAF_HDR_IMAGES', 'experimental');
      try {
        // with HDR on, the encoding backfill decides first
        await expect(sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.FULLSIZE })).resolves.toEqual({
          targetSize: AssetMediaSize.PREVIEW,
        });
      } finally {
        vitest.unstubAllEnvs();
      }
    });

    it('serves the owner current develop pixels but keeps the face source on ordinary edited pixels', async () => {
      const asset = AssetFactory.from({ ownerId: authStub.admin.user.id })
        .file({ type: AssetFileType.Preview, path: '/data/legacy-preview.jpg' })
        .build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ...asset,
        path: '/data/legacy-preview.jpg',
      });
      mocks.asset.getCurrentDevelop.mockResolvedValue({
        id: 'revision-id',
        ownerId: asset.ownerId,
        status: AssetDevelopRevisionStatus.Rendered,
        previewPath: '/data/develop-preview.jpg',
        masterPath: '/data/develop-master.jpg',
      });

      await expect(
        sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.PREVIEW, edited: true }),
      ).resolves.toMatchObject({ path: '/data/develop-preview.jpg', cacheControl: CacheControl.PrivateWithoutCache });
      mocks.systemMetadata.get.mockResolvedValue(null as never);
      await expect(
        sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.FULLSIZE, edited: true }, 'relay'),
      ).resolves.toMatchObject({ path: '/data/develop-preview.jpg' });
      await expect(
        sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.PREVIEW, edited: true, faceSource: true }),
      ).resolves.toMatchObject({ path: '/data/legacy-preview.jpg' });
      expect(mocks.asset.getCurrentDevelop).toHaveBeenCalledTimes(2);
    });

    it('should require asset.view permissions', async () => {
      await expect(sut.viewThumbnail(authStub.admin, 'id', {})).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(userStub.admin.id, new Set(['id']), undefined);
      expect(mocks.access.asset.checkAlbumAccess).toHaveBeenCalledWith(userStub.admin.id, new Set(['id']));
    });

    it('allows full-size files except through the relay while originals are not allowed there (FL-161)', async () => {
      mocks.systemMetadata.get.mockResolvedValue(null as never);
      await expect(sut.fullSizeAllowed(null)).resolves.toBe(true);
      await expect(sut.fullSizeAllowed('lan')).resolves.toBe(true);
      await expect(sut.fullSizeAllowed('wan')).resolves.toBe(true);
      await expect(sut.fullSizeAllowed('relay')).resolves.toBe(false);
    });

    it('serves the preview instead of redirecting to the original through the relay (FL-161)', async () => {
      const asset = AssetFactory.from({ originalPath: '/data/library/admin/image.jpeg' }).build();
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ...asset,
        path: null,
      });
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
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ...asset,
        path: null,
      });
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
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ...asset,
        path: asset.files[0].path,
      });

      await expect(sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.THUMBNAIL })).resolves.toEqual(
        new FileDownloadResponse({
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
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ...asset,
        path: asset.files[0].path,
      });
      await expect(sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.PREVIEW })).resolves.toEqual(
        new FileDownloadResponse({
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
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ...asset,
        path: asset.files[0].path,
      });
      await expect(sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.THUMBNAIL })).resolves.toEqual(
        new FileDownloadResponse({
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
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ...asset,
        path: asset.files[0].path,
      });
      await expect(sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.THUMBNAIL })).resolves.toEqual(
        new FileDownloadResponse({
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
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ...asset,
        path: asset.files[0].path,
      });
      await expect(
        sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.THUMBNAIL, edited: true }),
      ).resolves.toEqual(
        new FileDownloadResponse({
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
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ...asset,
        path: asset.files[0].path,
      });
      await expect(
        sut.viewThumbnail(authStub.admin, asset.id, { size: AssetMediaSize.THUMBNAIL, edited: false }),
      ).resolves.toEqual(
        new FileDownloadResponse({
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
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ...asset,
        path: asset.files[0].path,
      });
      await expect(
        sut.viewThumbnail(authStub.adminSharedLink, asset.id, {
          size: AssetMediaSize.THUMBNAIL,
          edited: true,
        }),
      ).resolves.toEqual(
        new FileDownloadResponse({
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
      mocks.asset.getForThumbnail.mockResolvedValue({
        imageEncoding: { dynamicRange: 'sdr', gainMap: 'none', reconstructionAvailable: false },
        renditionIdentity: null,
        ...asset,
        path: asset.files[0].path,
      });

      const auth = AuthFactory.from().sharedLink({ showExif: false }).build();

      await expect(sut.viewThumbnail(auth, asset.id, { size: AssetMediaSize.PREVIEW })).resolves.toEqual(
        new FileDownloadResponse({
          path: asset.files[0].path,
          cacheControl: CacheControl.PrivateWithCache,
          contentType: 'image/jpeg',
          fileName: `${asset.id}_preview.jpg`,
        }),
      );
    });
  });

  describe('playbackStudioHdrVideo (FL-97)', () => {
    const video = { originalPath: '/original/v.mov', encodedVideoPath: null, editedVideoPath: null };

    it('serves the current Studio HDR intermediate under playback access and location rules', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForVideo.mockResolvedValue({ ...video, ownerId: authStub.admin.user.id });
      mocks.asset.getCurrentStudioHdrIntermediates.mockResolvedValue(
        new Map([[asset.id, '/encoded/v-studio-hdr.mp4']]),
      );

      await expect(sut.playbackStudioHdrVideo(authStub.admin, asset.id)).resolves.toEqual(
        new FileDownloadResponse({
          path: '/encoded/v-studio-hdr.mp4',
          contentType: 'video/mp4',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
      expect(mocks.asset.getCurrentStudioHdrIntermediates).toHaveBeenCalledWith([asset.id]);
    });

    it('is not found without a current intermediate (none yet, a replaced original or a published edit)', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getForVideo.mockResolvedValue({ ...video, ownerId: authStub.admin.user.id });

      await expect(sut.playbackStudioHdrVideo(authStub.admin, asset.id)).rejects.toBeInstanceOf(NotFoundException);
    });

    it('requires asset.view access, as playback does', async () => {
      await expect(sut.playbackStudioHdrVideo(authStub.admin, 'id')).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.asset.getCurrentStudioHdrIntermediates).not.toHaveBeenCalled();
    });

    it('never serves a shared link, even one that may view the asset', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([asset.id]));
      mocks.asset.getCurrentStudioHdrIntermediates.mockResolvedValue(
        new Map([[asset.id, '/encoded/v-studio-hdr.mp4']]),
      );

      await expect(sut.playbackStudioHdrVideo(authStub.adminSharedLink, asset.id)).rejects.toBeInstanceOf(
        NotFoundException,
      );
      expect(mocks.asset.getCurrentStudioHdrIntermediates).not.toHaveBeenCalled();
    });
  });

  describe('playbackVideo', () => {
    it('should require asset.view permissions', async () => {
      await expect(sut.playbackVideo(authStub.admin, 'id')).rejects.toBeInstanceOf(BadRequestException);

      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(userStub.admin.id, new Set(['id']), undefined);
      expect(mocks.access.asset.checkAlbumAccess).toHaveBeenCalledWith(userStub.admin.id, new Set(['id']));
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
        new FileDownloadResponse({
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
        new FileDownloadResponse({
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
        new FileDownloadResponse({
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
        new FileDownloadResponse({
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
        new FileDownloadResponse({
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
        {
          id: 'asset-1',
          checksum: file1,
          deletedAt: null,
          status: AssetStatus.Active,
          originalPath: '/data/upload/asset-1',
          libraryId: null,
          isExternal: false,
        },
        {
          id: 'asset-2',
          checksum: file2,
          deletedAt: null,
          status: AssetStatus.Active,
          originalPath: '/data/upload/asset-2',
          libraryId: null,
          isExternal: false,
        },
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
      mocks.asset.getByChecksums.mockResolvedValue([
        {
          id: 'asset-1',
          checksum: sha256,
          deletedAt: null,
          status: AssetStatus.Active,
          originalPath: '/data/upload/asset-1',
          libraryId: null,
          isExternal: false,
        },
      ]);

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

      mocks.asset.getByChecksums.mockResolvedValue([
        {
          id: 'asset-1',
          checksum: file1,
          deletedAt: null,
          status: AssetStatus.Active,
          originalPath: '/data/upload/asset-1',
          libraryId: null,
          isExternal: false,
        },
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
            action: AssetUploadAction.ACCEPT,
          },
        ],
      });

      expect(mocks.asset.getByChecksums).toHaveBeenCalledWith(authStub.admin.user.id, [file1, file2]);
    });

    it('should hide duplicate checksum matches in hidden NSFW mode', async () => {
      const file1 = Buffer.from('d2947b871a706081be194569951b7db246907957', 'hex');
      const file2 = Buffer.from('53be335e99f18a66ff12e9a901c7a6171dd76573', 'hex');

      mocks.asset.getByChecksums.mockResolvedValue([
        {
          id: 'asset-1',
          checksum: file1,
          deletedAt: null,
          status: AssetStatus.Active,
          originalPath: '/data/upload/asset-1',
          libraryId: null,
          isExternal: false,
        },
      ]);

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
