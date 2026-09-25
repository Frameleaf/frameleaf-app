import { ShallowDehydrateObject } from 'kysely';
import { OutputInfo } from 'sharp';
import { Exif } from 'src/database.js';
import { type SystemConfig, defaults } from 'src/dtos/config.dto.js';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import {
  AssetFileType,
  AssetPathType,
  AssetStatus,
  AssetType,
  AssetVisibility,
  AudioCodec,
  Colorspace,
  DvProfile,
  ExifOrientation,
  ImageFormat,
  JobName,
  JobStatus,
  RawExtractedFormat,
  ToneMapping,
  TranscodeHardwareAcceleration,
  TranscodePolicy,
  VideoCodec,
} from 'src/enum.js';
import { MediaService } from 'src/services/media.service.js';
import { AudioStreamInfo, JobCounts, RawImageInfo, VideoFormat, VideoStreamInfo } from 'src/types.js';
import { EDITED_MASTER_MAX_CRF, FRAMELEAF_RENDERER, resolveEditedMasterColorPolicy } from 'src/utils/media-policy.js';
import { renderRawWithLibRaw } from 'src/utils/raw-renderer.js';
import { AssetFaceFactory } from 'test/factories/asset-face.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { PersonFactory } from 'test/factories/person.factory.js';
import { probeStub, videoInfoStub } from 'test/fixtures/media.stub.js';
import { personThumbnailStub } from 'test/fixtures/person.stub.js';
import { systemConfigStub } from 'test/fixtures/system-config.stub.js';
import { getForGenerateThumbnail } from 'test/mappers.js';
import { factory, newUuid } from 'test/small.factory.js';
import { ServiceMocks, makeStream, newTestService } from 'test/utils.js';

const fullsizeBuffer = Buffer.from('embedded image data');
const rawBuffer = Buffer.from('raw image data');
const extractedBuffer = Buffer.from('embedded image file');
const renderedRawBuffer = Buffer.from('rendered raw image');
const getFilterOption = (outputOptions: string[], option = '-vf') => outputOptions[outputOptions.indexOf(option) + 1];

vi.mock('src/utils/raw-renderer.js', () => ({
  renderRawWithLibRaw: vi.fn(),
}));

describe(MediaService.name, () => {
  let sut: MediaService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MediaService));
    // FL-39: without retained video history the handler keeps its single-master path.
    mocks.assetEdit.getRequestedVideoVersion.mockResolvedValue(undefined);
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  // TODO these should all become medium tests of either the service or the repository.
  // The entire logic of what to queue lives in the SQL query now
  describe('handleQueueGenerateThumbnails', () => {
    it('should queue all assets', async () => {
      const asset = AssetFactory.create();
      const person = PersonFactory.create({ faceAssetId: newUuid() });
      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([asset]));

      mocks.person.getAll.mockReturnValue(makeStream([person]));

      await sut.handleQueueGenerateThumbnails({ force: true });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: true, fullsizeEnabled: false });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetGenerateThumbnails,
          data: { id: asset.id },
        },
      ]);

      expect(mocks.person.getAll).toHaveBeenCalledWith(undefined);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PersonGenerateThumbnail,
          data: { ownerId: person.ownerId, personGroupId: person.personGroupId },
        },
      ]);
    });

    it('should queue trashed assets when force is true', async () => {
      const asset = AssetFactory.create({ status: AssetStatus.Trashed, deletedAt: new Date() });
      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAll.mockReturnValue(makeStream());

      await sut.handleQueueGenerateThumbnails({ force: true });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: true, fullsizeEnabled: false });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetGenerateThumbnails,
          data: { id: asset.id },
        },
      ]);
    });

    it('should queue archived assets when force is true', async () => {
      const asset = AssetFactory.create({ visibility: AssetVisibility.Archive });
      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAll.mockReturnValue(makeStream());

      await sut.handleQueueGenerateThumbnails({ force: true });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: true, fullsizeEnabled: false });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetGenerateThumbnails,
          data: { id: asset.id },
        },
      ]);
    });

    it('should queue all people with missing thumbnail path', async () => {
      const [person1, person2] = [
        PersonFactory.create({ thumbnailPath: undefined }),
        PersonFactory.create({ thumbnailPath: undefined }),
      ];

      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([AssetFactory.create()]));
      mocks.person.getAll.mockReturnValue(makeStream([person1, person2]));
      mocks.person.getRandomFace.mockResolvedValueOnce(AssetFaceFactory.create());

      await sut.handleQueueGenerateThumbnails({ force: false });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: false, fullsizeEnabled: false });
      expect(mocks.person.getAll).toHaveBeenCalledWith({ thumbnailPath: '' });
      expect(mocks.person.getRandomFace).toHaveBeenCalled();
      expect(mocks.person.update).toHaveBeenCalledTimes(1);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PersonGenerateThumbnail,
          data: {
            ownerId: person1.ownerId,
            personGroupId: person1.personGroupId,
          },
        },
      ]);
    });

    it('should queue all assets with missing resize path', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAll.mockReturnValue(makeStream());
      await sut.handleQueueGenerateThumbnails({ force: false });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: false, fullsizeEnabled: false });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetGenerateThumbnails,
          data: { id: asset.id },
        },
      ]);

      expect(mocks.person.getAll).toHaveBeenCalledWith({ thumbnailPath: '' });
    });

    it('should queue all assets with missing preview', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAll.mockReturnValue(makeStream());
      await sut.handleQueueGenerateThumbnails({ force: false });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: false, fullsizeEnabled: false });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetGenerateThumbnails, data: { id: asset.id } },
      ]);
      expect(mocks.person.getAll).toHaveBeenCalledWith({ thumbnailPath: '' });
    });

    it('should queue all assets with missing thumbhash', async () => {
      const asset = AssetFactory.from({ thumbhash: null })
        .files([AssetFileType.Thumbnail, AssetFileType.Preview])
        .build();
      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAll.mockReturnValue(makeStream());
      await sut.handleQueueGenerateThumbnails({ force: false });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: false, fullsizeEnabled: false });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetGenerateThumbnails, data: { id: asset.id } },
      ]);

      expect(mocks.person.getAll).toHaveBeenCalledWith({ thumbnailPath: '' });
    });

    it('should queue all assets with missing fullsize when feature is enabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ image: { fullsize: { enabled: true } } });
      const asset = { id: factory.uuid(), isEdited: false };
      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAll.mockReturnValue(makeStream());
      await sut.handleQueueGenerateThumbnails({ force: false });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: false, fullsizeEnabled: true });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetGenerateThumbnails,
          data: { id: asset.id },
        },
      ]);

      expect(mocks.person.getAll).toHaveBeenCalledWith({ thumbnailPath: '' });
    });

    it('should not queue assets with missing fullsize when feature is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ image: { fullsize: { enabled: false } } });
      const asset = { id: factory.uuid(), isEdited: false };
      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAll.mockReturnValue(makeStream());
      await sut.handleQueueGenerateThumbnails({ force: false });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: false, fullsizeEnabled: false });
      expect(mocks.job.queueAll).toHaveBeenCalledTimes(1);
      expect(mocks.person.getAll).toHaveBeenCalledWith({ thumbnailPath: '' });
    });

    it('should queue assets with edits but missing edited thumbnails', async () => {
      const asset = AssetFactory.from().edit().build();
      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAll.mockReturnValue(makeStream());
      await sut.handleQueueGenerateThumbnails({ force: false });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: false, fullsizeEnabled: false });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetEditThumbnailGeneration,
          data: { id: asset.id },
        },
      ]);

      expect(mocks.person.getAll).toHaveBeenCalledWith({ thumbnailPath: '' });
    });

    it('should not queue assets with missing edited fullsize when feature is disabled', async () => {
      const asset = AssetFactory.from().edit().build();
      mocks.systemMetadata.get.mockResolvedValue({ image: { fullsize: { enabled: false } } });
      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAll.mockReturnValue(makeStream());
      await sut.handleQueueGenerateThumbnails({ force: false });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: false, fullsizeEnabled: false });
      expect(mocks.job.queueAll).toHaveBeenCalledTimes(1);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.AssetEditThumbnailGeneration, data: { id: asset.id } },
      ]);

      expect(mocks.person.getAll).toHaveBeenCalledWith({ thumbnailPath: '' });
    });

    it('should queue assets with missing fullsize when force is true, regardless of setting', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ image: { fullsize: { enabled: false } } });
      const asset = { id: factory.uuid(), isEdited: false };
      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAll.mockReturnValue(makeStream());
      await sut.handleQueueGenerateThumbnails({ force: true });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: true, fullsizeEnabled: false });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetGenerateThumbnails,
          data: { id: asset.id },
        },
      ]);

      expect(mocks.person.getAll).toHaveBeenCalled();
    });

    it('should queue both regular and edited thumbnails for assets with edits when force is true', async () => {
      const asset = AssetFactory.from().edit().build();
      mocks.assetJob.streamForThumbnailJob.mockReturnValue(makeStream([asset]));
      mocks.person.getAll.mockReturnValue(makeStream());
      await sut.handleQueueGenerateThumbnails({ force: true });

      expect(mocks.assetJob.streamForThumbnailJob).toHaveBeenCalledWith({ force: true, fullsizeEnabled: false });
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetGenerateThumbnails,
          data: { id: asset.id },
        },
        {
          name: JobName.AssetEditThumbnailGeneration,
          data: { id: asset.id },
        },
      ]);

      expect(mocks.person.getAll).toHaveBeenCalledWith(undefined);
    });
  });

  describe('handleQueueMigration', () => {
    it('should remove empty directories and queue jobs', async () => {
      const asset = AssetFactory.create();
      const person = PersonFactory.create();

      mocks.assetJob.streamForMigrationJob.mockReturnValue(makeStream([asset]));
      mocks.job.getJobCounts.mockResolvedValue({ active: 1, waiting: 0 } as JobCounts);
      mocks.person.getAll.mockReturnValue(makeStream([person]));

      await expect(sut.handleQueueMigration()).resolves.toBe(JobStatus.Success);

      expect(mocks.storage.removeEmptyDirs).toHaveBeenCalledTimes(2);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([{ name: JobName.AssetFileMigration, data: { id: asset.id } }]);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PersonFileMigration,
          data: { ownerId: person.ownerId, personGroupId: person.personGroupId },
        },
      ]);
    });
  });

  describe('handleAssetMigration', () => {
    it('should fail if asset does not exist', async () => {
      mocks.assetJob.getForMigrationJob.mockResolvedValue(void 0);
      await expect(sut.handleAssetMigration({ id: 'non-existent' })).resolves.toBe(JobStatus.Failed);

      expect(mocks.move.getByEntity).not.toHaveBeenCalled();
    });

    it('should move asset files', async () => {
      const asset = AssetFactory.from()
        .files([AssetFileType.FullSize, AssetFileType.Preview, AssetFileType.Thumbnail])
        .build();
      mocks.assetJob.getForMigrationJob.mockResolvedValue(asset);
      mocks.move.create.mockResolvedValue({
        entityId: asset.id,
        id: 'move-id',
        newPath: '/new/path',
        oldPath: '/old/path',
        pathType: AssetPathType.Original,
      });

      await expect(sut.handleAssetMigration({ id: asset.id })).resolves.toBe(JobStatus.Success);
      expect(mocks.move.create).toHaveBeenCalledWith({
        entityId: asset.id,
        pathType: AssetFileType.FullSize,
        oldPath: asset.files[0].path,
        newPath: `/data/thumbs/${asset.ownerId}/${asset.id.slice(0, 2)}/${asset.id.slice(2, 4)}/${asset.id}_fullsize.jpeg`,
      });
      expect(mocks.move.create).toHaveBeenCalledWith({
        entityId: asset.id,
        pathType: AssetFileType.Preview,
        oldPath: asset.files[1].path,
        newPath: `/data/thumbs/${asset.ownerId}/${asset.id.slice(0, 2)}/${asset.id.slice(2, 4)}/${asset.id}_preview.jpeg`,
      });
      expect(mocks.move.create).toHaveBeenCalledWith({
        entityId: asset.id,
        pathType: AssetFileType.Thumbnail,
        oldPath: asset.files[2].path,
        newPath: `/data/thumbs/${asset.ownerId}/${asset.id.slice(0, 2)}/${asset.id.slice(2, 4)}/${asset.id}_thumbnail.webp`,
      });
      expect(mocks.move.create).toHaveBeenCalledTimes(3);
    });
  });

  describe('handleGenerateThumbnails', () => {
    let rawInfo: RawImageInfo;

    beforeEach(() => {
      rawInfo = { width: 100, height: 100, channels: 3 };
      mocks.person.getFaces.mockResolvedValue([]);
      mocks.ocr.getByAssetId.mockResolvedValue([]);
      mocks.media.decodeImage.mockImplementation((input) =>
        Promise.resolve(
          typeof input === 'string'
            ? { data: rawBuffer, info: rawInfo as OutputInfo } // string implies original file
            : { data: fullsizeBuffer, info: rawInfo as OutputInfo }, // buffer implies embedded image extracted
        ),
      );
      mocks.media.getImageMetadata.mockResolvedValue({ width: 100, height: 100, isTransparent: false });
      vi.mocked(renderRawWithLibRaw).mockReset();
      vi.mocked(renderRawWithLibRaw).mockRejectedValue(new Error('dcraw_emu unavailable'));
    });

    it('should skip thumbnail generation if asset not found', async () => {
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(void 0);
      await sut.handleGenerateThumbnails({ id: 'non-existent' });

      expect(mocks.media.generateThumbnail).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalledWith();
    });

    it('should skip thumbnail generation if asset type is unknown', async () => {
      const asset = AssetFactory.from({ type: 'foo' as AssetType })
        .exif()
        .build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await expect(sut.handleGenerateThumbnails({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.media.generateThumbnail).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalledWith();
    });

    it('should skip video thumbnail generation if no video stream', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.noVideoStreams,
      });
      await expect(sut.handleGenerateThumbnails({ id: asset.id })).rejects.toThrowError();
      expect(mocks.media.generateThumbnail).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalledWith();
    });

    it('should skip invisible assets', async () => {
      const asset = AssetFactory.from({ visibility: AssetVisibility.Hidden }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      expect(await sut.handleGenerateThumbnails({ id: asset.id })).toEqual(JobStatus.Skipped);

      expect(mocks.media.generateThumbnail).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalledWith();
    });

    it('should delete previous preview if different path', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();
      mocks.systemMetadata.get.mockResolvedValue({ image: { thumbnail: { format: ImageFormat.Webp } } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: {
          files: expect.arrayContaining([asset.files[0].path]),
        },
      });
    });

    it('should generate P3 thumbnails for a wide gamut image', async () => {
      const asset = AssetFactory.from()
        .exif({ profileDescription: 'Adobe RGB', bitsPerSample: 14 })
        .files([AssetFileType.Preview, AssetFileType.Thumbnail])
        .build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
      const thumbhashBuffer = Buffer.from('a thumbhash', 'utf8');
      mocks.media.generateThumbhash.mockResolvedValue(thumbhashBuffer);

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.any(String));

      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
        size: 1440,
      });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(2);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          size: 1440,
          quality: 80,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        expect.any(String),
      );
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Webp,
          size: 250,
          quality: 80,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        expect.any(String),
      );

      expect(mocks.media.generateThumbhash).toHaveBeenCalledOnce();
      expect(mocks.media.generateThumbhash).toHaveBeenCalledWith(rawBuffer, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
        raw: rawInfo,
        edits: [],
      });

      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
        {
          assetId: asset.id,
          type: AssetFileType.Preview,
          path: expect.any(String),
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
        {
          assetId: asset.id,
          type: AssetFileType.Thumbnail,
          path: expect.any(String),
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);
      expect(mocks.asset.update).toHaveBeenCalledWith({ id: asset.id, thumbhash: thumbhashBuffer });
    });

    it('should generate a thumbnail for a video', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.videoStream2160p,
      });
      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.any(String));
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        4,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: ['-skip_frame', 'nointra', '-sws_flags', 'accurate_rnd+full_chroma_int'],
          outputOptions: expect.arrayContaining([
            '-fps_mode',
            'vfr',
            '-frames:v',
            '1',
            '-update',
            '1',
            '-v',
            'verbose',
            '-vf',
            String.raw`fps=12:start_time=0.333:eof_action=pass:round=down,thumbnail=12,select=gt(scene\,0.1)-eq(prev_selected_n\,n)+isnan(prev_selected_n)+gt(n\,20),trim=end_frame=2,reverse,scale=-2:1440:flags=lanczos+accurate_rnd+full_chroma_int:out_range=pc`,
          ]),
          twoPass: false,
        }),
      );
      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
        {
          assetId: asset.id,
          type: AssetFileType.Preview,
          path: expect.any(String),
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
        {
          assetId: asset.id,
          type: AssetFileType.Thumbnail,
          path: expect.any(String),
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);
    });

    it('should probe video metadata when persisted video metadata is missing', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        videoStream: null,
        format: null,
      });
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.media.probe.mockResolvedValue(videoInfoStub.videoStream2160p);

      await expect(sut.handleGenerateThumbnails({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.media.probe).toHaveBeenCalledWith('/original/path.ext');
      expect(mocks.media.transcode).toHaveBeenCalledWith('/original/path.ext', expect.any(String), expect.any(Object));
      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
        {
          assetId: asset.id,
          type: AssetFileType.Preview,
          path: expect.any(String),
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
        {
          assetId: asset.id,
          type: AssetFileType.Thumbnail,
          path: expect.any(String),
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);
    });

    it('should throw "Missing video metadata" when probe returns no video streams', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        videoStream: null,
        format: null,
      });
      mocks.storage.checkFileExists.mockResolvedValue(true);
      mocks.media.probe.mockResolvedValue({ videoStreams: [], audioStreams: [], format: {} } as any);

      await expect(sut.handleGenerateThumbnails({ id: asset.id })).rejects.toThrow(
        `Missing video metadata for asset ${asset.id}`,
      );
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should wrap probe failures with a descriptive error preserving the cause', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        videoStream: null,
        format: null,
      });
      mocks.storage.checkFileExists.mockResolvedValue(true);
      const probeError = new Error('ffprobe exited with code 1');
      mocks.media.probe.mockRejectedValue(probeError);

      const promise = sut.handleGenerateThumbnails({ id: asset.id });
      await expect(promise).rejects.toThrow(
        `Failed to probe video metadata for asset ${asset.id}: ffprobe exited with code 1`,
      );
      await expect(promise).rejects.toMatchObject({ cause: probeError });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should throw an "original file missing" error before probing when the file does not exist', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        videoStream: null,
        format: null,
      });
      mocks.storage.checkFileExists.mockResolvedValue(false);

      await expect(sut.handleGenerateThumbnails({ id: asset.id })).rejects.toThrow(
        `Cannot probe video metadata for asset ${asset.id}: original file missing at /original/path.ext`,
      );
      expect(mocks.media.probe).not.toHaveBeenCalled();
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should score multiple video thumbnail candidates and render the best timestamp', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.videoStream2160p,
        format: { ...probeStub.videoStream2160p.format, duration: 120 },
      });
      mocks.media.scoreThumbnailCandidate
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(80)
        .mockResolvedValueOnce(30)
        .mockResolvedValueOnce(20);

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.scoreThumbnailCandidate).toHaveBeenCalledTimes(4);
      expect(mocks.media.transcode).toHaveBeenCalledTimes(6);
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        2,
        '/original/path.ext',
        expect.stringContaining('_candidate_1'),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=42')]),
        }),
      );
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        5,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=42')]),
        }),
      );
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        6,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=42')]),
        }),
      );
    });

    it('should ignore obviously mismatched duration units when picking video thumbnail candidates', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.videoStream2160p,
        videoStream: { ...probeStub.videoStream2160p.videoStream!, frameCount: 64_800, frameRate: 60 },
        format: { ...probeStub.videoStream2160p.format, duration: 1_080_000_000 },
      });
      mocks.media.scoreThumbnailCandidate
        .mockResolvedValueOnce(10)
        .mockResolvedValueOnce(80)
        .mockResolvedValueOnce(30)
        .mockResolvedValueOnce(20);

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        2,
        '/original/path.ext',
        expect.stringContaining('_candidate_1'),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=378')]),
        }),
      );
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        5,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=378')]),
        }),
      );
    });

    it('should use proportional candidate timestamps for short videos', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.videoStream2160p,
        format: { ...probeStub.videoStream2160p.format, duration: 10 },
      });
      mocks.media.scoreThumbnailCandidate.mockResolvedValueOnce(10).mockResolvedValueOnce(80).mockResolvedValueOnce(30);

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.scoreThumbnailCandidate).toHaveBeenCalledTimes(3);
      expect(mocks.media.transcode).toHaveBeenCalledTimes(5);
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        1,
        '/original/path.ext',
        expect.stringContaining('_candidate_0'),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=2')]),
        }),
      );
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        2,
        '/original/path.ext',
        expect.stringContaining('_candidate_1'),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=5')]),
        }),
      );
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        3,
        '/original/path.ext',
        expect.stringContaining('_candidate_2'),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=8')]),
        }),
      );
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        4,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=5')]),
        }),
      );
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        5,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=5')]),
        }),
      );
    });

    it('should spread candidate timestamps for clips just over 30s instead of collapsing onto the end', async () => {
      // Regression: durations of ~30-43s used to map every candidate through
      // Math.max(30, timestamp), collapsing them all onto ~30s. For a clip
      // barely over 30s that single value then clamped into the final 0.5s of
      // the runtime, where the fps/thumbnail filter chain (decoding only
      // keyframes via -skip_frame nointra) emits no frame, so ffmpeg aborted
      // the whole transcode with "Nothing was written into output file" --
      // breaking thumbnail and edited-video generation (e.g. rotating a video).
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.videoStream2160p,
        format: { ...probeStub.videoStream2160p.format, duration: 30.3 },
      });
      mocks.media.scoreThumbnailCandidate.mockResolvedValueOnce(10).mockResolvedValueOnce(80).mockResolvedValueOnce(30);

      await sut.handleGenerateThumbnails({ id: asset.id });

      // Three distinct candidates, all clear of the end-of-clip dead zone.
      expect(mocks.media.scoreThumbnailCandidate).toHaveBeenCalledTimes(3);
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        1,
        '/original/path.ext',
        expect.stringContaining('_candidate_0'),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=10.605')]),
        }),
      );
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        2,
        '/original/path.ext',
        expect.stringContaining('_candidate_1'),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=16.665')]),
        }),
      );
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        3,
        '/original/path.ext',
        expect.stringContaining('_candidate_2'),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=22.725')]),
        }),
      );
      // Best-scoring candidate (index 1) is rendered for preview + thumbnail.
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        4,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=16.665')]),
        }),
      );
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        5,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=16.665')]),
        }),
      );
    });

    it('should fall back to the first frame when thumbnail candidates cannot be scored', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.videoStream2160p,
        format: { ...probeStub.videoStream2160p.format, duration: 10 },
      });
      mocks.media.scoreThumbnailCandidate.mockRejectedValue(new Error('could not read candidate'));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.scoreThumbnailCandidate).toHaveBeenCalledTimes(3);
      expect(mocks.media.transcode).toHaveBeenCalledTimes(5);
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        4,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=0')]),
        }),
      );
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        5,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          outputOptions: expect.arrayContaining([expect.stringContaining('start_time=0')]),
        }),
      );
    });

    it('should tonemap thumbnail for hdr video', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.videoStreamHDR,
      });
      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.any(String));
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        5,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: ['-skip_frame', 'nointra', '-sws_flags', 'accurate_rnd+full_chroma_int'],
          outputOptions: expect.arrayContaining([
            '-fps_mode',
            'vfr',
            '-frames:v',
            '1',
            '-update',
            '1',
            '-v',
            'verbose',
            '-vf',
            String.raw`fps=12:start_time=0.333:eof_action=pass:round=down,thumbnail=12,select=gt(scene\,0.1)-eq(prev_selected_n\,n)+isnan(prev_selected_n)+gt(n\,20),trim=end_frame=2,reverse,scale=-2:250:flags=lanczos+accurate_rnd+full_chroma_int:out_range=pc,tonemapx=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=yuv420p`,
          ]),
          twoPass: false,
        }),
      );
      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
        {
          assetId: asset.id,
          type: AssetFileType.Preview,
          path: expect.any(String),
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
        {
          assetId: asset.id,
          type: AssetFileType.Thumbnail,
          path: expect.any(String),
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);
    });

    it('should always generate video thumbnail in one pass', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { twoPass: true, maxBitrate: '5000k' },
      });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.videoStreamHDR,
      });
      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        5,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: ['-skip_frame', 'nointra', '-sws_flags', 'accurate_rnd+full_chroma_int'],
          outputOptions: expect.arrayContaining([
            '-fps_mode',
            'vfr',
            '-frames:v',
            '1',
            '-update',
            '1',
            '-v',
            'verbose',
            '-vf',
            String.raw`fps=12:start_time=0.333:eof_action=pass:round=down,thumbnail=12,select=gt(scene\,0.1)-eq(prev_selected_n\,n)+isnan(prev_selected_n)+gt(n\,20),trim=end_frame=2,reverse,scale=-2:250:flags=lanczos+accurate_rnd+full_chroma_int:out_range=pc,tonemapx=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=yuv420p`,
          ]),
          twoPass: false,
        }),
      );
    });

    it('should not skip intra frames for MTS file', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.videoStreamMTS,
      });
      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: ['-sws_flags', 'accurate_rnd+full_chroma_int'],
          outputOptions: expect.any(Array),
          progress: expect.any(Object),
          twoPass: false,
        }),
      );
    });

    it('should override reserved color metadata', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.videoStreamReserved,
      });
      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-bsf:0',
            'hevc_metadata=colour_primaries=1:matrix_coefficients=1:transfer_characteristics=1',
          ]),
          outputOptions: expect.any(Array),
          progress: expect.any(Object),
          twoPass: false,
        }),
      );
    });

    it('should use scaling divisible by 2 even when using quick sync', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { accel: TranscodeHardwareAcceleration.Qsv } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.videoStream2160p,
      });
      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([expect.stringContaining('scale=-2:1440')]),
          twoPass: false,
        }),
      );
    });

    it.each(Object.values(ImageFormat))('should generate an image preview in %s format', async (format) => {
      const asset = AssetFactory.from().exif().build();
      mocks.systemMetadata.get.mockResolvedValue({ image: { preview: { format } } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
      const thumbhashBuffer = Buffer.from('a thumbhash', 'utf8');
      mocks.media.generateThumbhash.mockResolvedValue(thumbhashBuffer);
      const previewPath = `/data/thumbs/${asset.ownerId}/${asset.id.slice(0, 2)}/${asset.id.slice(2, 4)}/${asset.id}_preview.${format}`;
      const thumbnailPath = `/data/thumbs/${asset.ownerId}/${asset.id.slice(0, 2)}/${asset.id.slice(2, 4)}/${asset.id}_thumbnail.webp`;

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.any(String));
      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, {
        colorspace: Colorspace.Srgb,
        processInvalidImages: false,
        size: 1440,
      });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(2);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        {
          colorspace: Colorspace.Srgb,
          format,
          size: 1440,
          quality: 80,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        previewPath,
      );
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        {
          colorspace: Colorspace.Srgb,
          format: ImageFormat.Webp,
          size: 250,
          quality: 80,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        thumbnailPath,
      );
    });

    it.each(Object.values(ImageFormat))('should generate an image thumbnail in %s format', async (format) => {
      const asset = AssetFactory.from().exif().build();
      mocks.systemMetadata.get.mockResolvedValue({ image: { thumbnail: { format } } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
      const thumbhashBuffer = Buffer.from('a thumbhash', 'utf8');
      mocks.media.generateThumbhash.mockResolvedValue(thumbhashBuffer);
      const previewPath = `/data/thumbs/${asset.ownerId}/${asset.id.slice(0, 2)}/${asset.id.slice(2, 4)}/${asset.id}_preview.jpeg`;
      const thumbnailPath = `/data/thumbs/${asset.ownerId}/${asset.id.slice(0, 2)}/${asset.id.slice(2, 4)}/${asset.id}_thumbnail.${format}`;

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.any(String));
      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, {
        colorspace: Colorspace.Srgb,
        processInvalidImages: false,
        size: 1440,
      });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(2);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        {
          colorspace: Colorspace.Srgb,
          format: ImageFormat.Jpeg,
          size: 1440,
          quality: 80,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        previewPath,
      );
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        {
          colorspace: Colorspace.Srgb,
          format,
          size: 250,
          quality: 80,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        thumbnailPath,
      );
    });

    it('should generate progressive JPEG for preview when enabled', async () => {
      const asset = AssetFactory.from().exif().build();
      mocks.systemMetadata.get.mockResolvedValue({
        image: { preview: { progressive: true }, thumbnail: { progressive: false } },
      });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        expect.objectContaining({
          format: ImageFormat.Jpeg,
          progressive: true,
        }),
        expect.stringContaining('preview.jpeg'),
      );
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        expect.objectContaining({
          format: ImageFormat.Webp,
          progressive: false,
        }),
        expect.stringContaining('thumbnail.webp'),
      );
      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
        expect.objectContaining({
          type: AssetFileType.Preview,
          isProgressive: true,
          isTransparent: false,
        }),
        expect.objectContaining({
          type: AssetFileType.Thumbnail,
          isProgressive: false,
          isTransparent: false,
        }),
      ]);
    });

    it('should generate progressive JPEG for thumbnail when enabled', async () => {
      const asset = AssetFactory.from().exif().build();
      mocks.systemMetadata.get.mockResolvedValue({
        image: { preview: { progressive: false }, thumbnail: { format: ImageFormat.Jpeg, progressive: true } },
      });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        expect.objectContaining({
          format: ImageFormat.Jpeg,
          progressive: false,
        }),
        expect.stringContaining('preview.jpeg'),
      );
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        expect.objectContaining({
          format: ImageFormat.Jpeg,
          progressive: true,
        }),
        expect.stringContaining('thumbnail.jpeg'),
      );
      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
        expect.objectContaining({
          type: AssetFileType.Preview,
          isProgressive: false,
          isTransparent: false,
        }),
        expect.objectContaining({
          type: AssetFileType.Thumbnail,
          isProgressive: true,
          isTransparent: false,
        }),
      ]);
    });

    it('should never set isProgressive for videos', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video, originalPath: '/original/path.ext' }).exif().build();
      mocks.systemMetadata.get.mockResolvedValue({
        image: { preview: { progressive: true }, thumbnail: { progressive: true } },
      });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({
        ...getForGenerateThumbnail(asset),
        ...probeStub.videoStreamHDR,
      });

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
        expect.objectContaining({
          type: AssetFileType.Preview,
          isProgressive: false,
          isTransparent: false,
        }),
        expect.objectContaining({
          type: AssetFileType.Thumbnail,
          isProgressive: false,
          isTransparent: false,
        }),
      ]);
    });

    it('should delete previous thumbnail if different path', async () => {
      const asset = AssetFactory.from().exif().file({ type: AssetFileType.Preview }).build();
      mocks.systemMetadata.get.mockResolvedValue({ image: { thumbnail: { format: ImageFormat.Webp } } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: {
          files: expect.arrayContaining([asset.files[0].path]),
        },
      });
    });

    it('should extract embedded image if enabled and available', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.dng' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();
      mocks.media.extract.mockResolvedValue({ buffer: extractedBuffer, format: RawExtractedFormat.Jpeg });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 3840, height: 2160, isTransparent: false });
      mocks.systemMetadata.get.mockResolvedValue({ image: { extractEmbedded: true } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(extractedBuffer, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
        size: 1440,
      });
    });

    it('should not check transparency metadata for raw files without extracted images', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.dng' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();
      mocks.systemMetadata.get.mockResolvedValue({ image: { extractEmbedded: false } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.getImageMetadata).not.toHaveBeenCalled();
    });

    it('should not check transparency metadata for raw files with extracted images', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.dng' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();
      mocks.media.extract.mockResolvedValue({ buffer: extractedBuffer, format: RawExtractedFormat.Jpeg });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 3840, height: 2160, isTransparent: false });
      mocks.systemMetadata.get.mockResolvedValue({ image: { extractEmbedded: true } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.getImageMetadata).toHaveBeenCalledOnce();
      expect(mocks.media.getImageMetadata).toHaveBeenCalledWith(extractedBuffer);
    });

    it('should resize original image if embedded image is too small', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.dng' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();
      mocks.media.extract.mockResolvedValue({ buffer: extractedBuffer, format: RawExtractedFormat.Jpeg });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 1000, height: 1000, isTransparent: false });
      mocks.systemMetadata.get.mockResolvedValue({ image: { extractEmbedded: true } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
        size: 1440,
      });
    });

    it('should resize original image if embedded image not found', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.dng' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();
      mocks.systemMetadata.get.mockResolvedValue({ image: { extractEmbedded: true } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
        size: 1440,
      });
    });

    it('should resize original image if embedded image extraction is not enabled', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.dng' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();
      mocks.systemMetadata.get.mockResolvedValue({ image: { extractEmbedded: false } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.extract).not.toHaveBeenCalled();
      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
        size: 1440,
      });
    });

    it('should skip unsupported or corrupt raw files', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.cr2' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();
      mocks.systemMetadata.get.mockResolvedValue({ image: { extractEmbedded: true } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
      mocks.media.decodeImage.mockRejectedValue(
        new Error(
          `Input file has corrupt header: magickload: Magick: Unsupported file format or not RAW file '${asset.originalPath}'`,
        ),
      );

      await expect(sut.handleGenerateThumbnails({ id: asset.id })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.media.generateThumbnail).not.toHaveBeenCalled();
    });

    it('should render RAW with LibRaw when Sharp cannot decode the source and enhanced RAW rendering is enabled', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.cr2' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();
      mocks.systemMetadata.get.mockResolvedValue({ image: { extractEmbedded: false, enhancedRaw: { enabled: true } } });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
      vi.mocked(renderRawWithLibRaw).mockResolvedValue(renderedRawBuffer);
      mocks.media.getImageMetadata.mockResolvedValue({ width: 2000, height: 2000, isTransparent: false });
      mocks.media.decodeImage.mockImplementation((input) => {
        if (input === asset.originalPath) {
          throw new Error(`Input file has corrupt header: unsupported RAW file '${asset.originalPath}'`);
        }
        return Promise.resolve({ data: fullsizeBuffer, info: rawInfo as OutputInfo });
      });

      await expect(sut.handleGenerateThumbnails({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(renderRawWithLibRaw).toHaveBeenCalledWith(asset.originalPath);
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(renderedRawBuffer, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
        size: 1440,
      });
      expect(mocks.media.generateThumbnail).toHaveBeenCalled();
    });

    it('should not render RAW with LibRaw when enhanced RAW rendering is disabled', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.cr2' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();
      mocks.systemMetadata.get.mockResolvedValue({
        image: { extractEmbedded: false, enhancedRaw: { enabled: false } },
      });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
      mocks.media.decodeImage.mockRejectedValue(
        new Error(`Input file has corrupt header: unsupported RAW file '${asset.originalPath}'`),
      );

      await expect(sut.handleGenerateThumbnails({ id: asset.id })).resolves.toBe(JobStatus.Skipped);

      expect(renderRawWithLibRaw).not.toHaveBeenCalled();
      expect(mocks.media.generateThumbnail).not.toHaveBeenCalled();
    });

    it('should process invalid images if enabled', async () => {
      vi.stubEnv('IMMICH_PROCESS_INVALID_IMAGES', 'true');
      const asset = AssetFactory.from({ originalFileName: 'file.dng' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();

      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(
        asset.originalPath,
        expect.objectContaining({ processInvalidImages: true }),
      );

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(2);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        expect.objectContaining({ processInvalidImages: false }),
        expect.any(String),
      );
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        expect.objectContaining({ processInvalidImages: false }),
        expect.any(String),
      );

      expect(mocks.media.generateThumbhash).toHaveBeenCalledOnce();
      expect(mocks.media.generateThumbhash).toHaveBeenCalledWith(
        rawBuffer,
        expect.objectContaining({ processInvalidImages: false }),
      );

      vi.unstubAllEnvs();
    });

    it('should extract full-size JPEG preview from RAW', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.dng' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();

      mocks.systemMetadata.get.mockResolvedValue({
        image: { fullsize: { enabled: true, format: ImageFormat.Webp }, extractEmbedded: true },
      });
      mocks.media.extract.mockResolvedValue({ buffer: extractedBuffer, format: RawExtractedFormat.Jpeg });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 3840, height: 2160, isTransparent: false });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(extractedBuffer, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
        size: 1440, // capped to preview size as fullsize conversion is skipped
      });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(2);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        fullsizeBuffer,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          size: 1440,
          quality: 80,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        expect.any(String),
      );
    });

    describe('extracted RAW preview location (FL-54)', () => {
      const setupExtracted = () => {
        const asset = AssetFactory.from({ originalFileName: 'file.dng' })
          .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
          .build();
        mocks.systemMetadata.get.mockResolvedValue({
          image: { fullsize: { enabled: true, format: ImageFormat.Webp }, extractEmbedded: true },
        });
        mocks.media.extract.mockResolvedValue({ buffer: extractedBuffer, format: RawExtractedFormat.Jpeg });
        mocks.media.getImageMetadata.mockResolvedValue({ width: 3840, height: 2160, isTransparent: false });
        mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
        return asset;
      };

      it('removes the camera location from the extracted fullsize file for every viewer', async () => {
        const asset = setupExtracted();

        await sut.handleGenerateThumbnails({ id: asset.id });

        const [fullsizePath, buffer] = mocks.storage.createOrOverwriteFile.mock.calls[0];
        expect(buffer).toBe(extractedBuffer);
        expect(mocks.media.removeLocation).toHaveBeenCalledWith(fullsizePath);
        expect(mocks.media.removeLocation.mock.invocationCallOrder[0]).toBeGreaterThan(
          mocks.media.writeExif.mock.invocationCallOrder[0],
        );
        expect(mocks.asset.upsertFiles).toHaveBeenCalledWith(
          expect.arrayContaining([expect.objectContaining({ type: AssetFileType.FullSize, path: fullsizePath })]),
        );
      });

      it('drops the fullsize file rather than keep a location it cannot remove', async () => {
        const asset = setupExtracted();
        mocks.media.removeLocation.mockResolvedValue(false);

        await sut.handleGenerateThumbnails({ id: asset.id });

        const [fullsizePath] = mocks.storage.createOrOverwriteFile.mock.calls[0];
        expect(mocks.storage.unlink).toHaveBeenCalledWith(fullsizePath);
        expect(mocks.asset.upsertFiles).not.toHaveBeenCalledWith(
          expect.arrayContaining([expect.objectContaining({ path: fullsizePath })]),
        );
      });
    });

    it('should convert full-size WEBP preview from JXL preview of RAW', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.dng' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();

      mocks.systemMetadata.get.mockResolvedValue({
        image: { fullsize: { enabled: true, format: ImageFormat.Webp }, extractEmbedded: true },
      });
      mocks.media.extract.mockResolvedValue({ buffer: extractedBuffer, format: RawExtractedFormat.Jxl });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 3840, height: 2160, isTransparent: false });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(extractedBuffer, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
      });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(3);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        fullsizeBuffer,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Webp,
          quality: 80,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        expect.any(String),
      );
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        fullsizeBuffer,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          size: 1440,
          quality: 80,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        expect.any(String),
      );
    });

    it('should generate full-size preview directly from RAW images when extractEmbedded is false', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.dng' })
        .exif({ fileSizeInByte: 5000, profileDescription: 'Adobe RGB', bitsPerSample: 14, orientation: undefined })
        .build();

      mocks.systemMetadata.get.mockResolvedValue({ image: { fullsize: { enabled: true }, extractEmbedded: false } });
      mocks.media.extract.mockResolvedValue({ buffer: extractedBuffer, format: RawExtractedFormat.Jpeg });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 3840, height: 2160, isTransparent: false });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
      });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(3);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          quality: 80,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        expect.any(String),
      );
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          quality: 80,
          progressive: false,
          size: 1440,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        expect.any(String),
      );
    });

    it('should generate full-size preview from non-web-friendly images', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ image: { fullsize: { enabled: true } } });
      mocks.media.extract.mockResolvedValue({ buffer: extractedBuffer, format: RawExtractedFormat.Jpeg });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 3840, height: 2160, isTransparent: false });
      // HEIF/HIF image taken by cameras are not web-friendly, only has limited support on Safari.
      const asset = AssetFactory.from({ originalFileName: 'image.hif' })
        .exif({
          fileSizeInByte: 5000,
          profileDescription: 'Adobe RGB',
          bitsPerSample: 14,
        })
        .build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
      });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(3);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          quality: 80,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        expect.any(String),
      );
    });

    it('should skip generating full-size preview for web-friendly images', async () => {
      const asset = AssetFactory.from().exif().build();
      mocks.systemMetadata.get.mockResolvedValue({ image: { fullsize: { enabled: true } } });
      mocks.media.extract.mockResolvedValue({ buffer: extractedBuffer, format: RawExtractedFormat.Jpeg });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 3840, height: 2160, isTransparent: false });
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, {
        colorspace: Colorspace.Srgb,
        processInvalidImages: false,
        size: 1440,
      });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(2);
      expect(mocks.media.generateThumbnail).not.toHaveBeenCalledWith(
        expect.anything(),
        expect.anything(),
        expect.stringContaining('fullsize.jpeg'),
      );
    });

    it('should always generate full-size preview from non-web-friendly panoramas', async () => {
      mocks.systemMetadata.get.mockResolvedValue({ image: { fullsize: { enabled: false } } });
      mocks.media.extract.mockResolvedValue({ buffer: extractedBuffer, format: RawExtractedFormat.Jpeg });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 3840, height: 2160, isTransparent: false });
      mocks.media.copyTagGroup.mockResolvedValue(true);

      const asset = AssetFactory.from({ originalFileName: 'panorama.tif' })
        .exif({
          fileSizeInByte: 5000,
          projectionType: 'EQUIRECTANGULAR',
        })
        .build();

      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, {
        colorspace: Colorspace.Srgb,
        orientation: undefined,
        processInvalidImages: false,
        size: undefined,
      });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(3);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        {
          colorspace: Colorspace.Srgb,
          format: ImageFormat.Jpeg,
          quality: 80,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        expect.any(String),
      );

      expect(mocks.media.copyTagGroup).toHaveBeenCalledTimes(2);
      expect(mocks.media.copyTagGroup).toHaveBeenCalledWith('XMP-GPano', asset.originalPath, expect.any(String));
    });

    it('should respect encoding options when generating full-size preview', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        image: { fullsize: { enabled: true, format: ImageFormat.Webp, quality: 90 } },
      });
      mocks.media.extract.mockResolvedValue({ buffer: extractedBuffer, format: RawExtractedFormat.Jpeg });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 3840, height: 2160, isTransparent: false });
      // HEIF/HIF image taken by cameras are not web-friendly, only has limited support on Safari.
      const asset = AssetFactory.from({ originalFileName: 'image.hif' })
        .exif({
          fileSizeInByte: 5000,
          profileDescription: 'Adobe RGB',
          bitsPerSample: 14,
        })
        .build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.decodeImage).toHaveBeenCalledOnce();
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(asset.originalPath, {
        colorspace: Colorspace.P3,
        processInvalidImages: false,
      });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(3);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Webp,
          quality: 90,
          progressive: false,
          processInvalidImages: false,
          raw: rawInfo,
          edits: [],
        },
        expect.any(String),
      );
    });

    it('should generate progressive JPEG for fullsize when enabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue({
        image: { fullsize: { enabled: true, format: ImageFormat.Jpeg, progressive: true } },
      });
      mocks.media.extract.mockResolvedValue({ buffer: extractedBuffer, format: RawExtractedFormat.Jpeg });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 3840, height: 2160, isTransparent: false });
      const asset = AssetFactory.from({ originalFileName: 'image.hif' })
        .exif({
          fileSizeInByte: 5000,
          profileDescription: 'Adobe RGB',
          bitsPerSample: 14,
        })
        .build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await sut.handleGenerateThumbnails({ id: asset.id });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(3);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        expect.objectContaining({
          format: ImageFormat.Jpeg,
          progressive: true,
        }),
        expect.stringContaining('fullsize.jpeg'),
      );
    });
  });

  describe('handleAssetEditThumbnailGeneration', () => {
    let rawInfo: RawImageInfo;

    beforeEach(() => {
      rawInfo = { width: 100, height: 100, channels: 3 };
      mocks.person.getFaces.mockResolvedValue([]);
      mocks.ocr.getByAssetId.mockResolvedValue([]);
      mocks.media.decodeImage.mockImplementation((input) =>
        Promise.resolve(
          typeof input === 'string'
            ? { data: rawBuffer, info: rawInfo as OutputInfo } // string implies original file
            : { data: fullsizeBuffer, info: rawInfo as OutputInfo }, // buffer implies embedded image extracted
        ),
      );
      mocks.media.getImageMetadata.mockResolvedValue({ width: 100, height: 100, isTransparent: false });
    });

    it('should skip videos', async () => {
      const asset = AssetFactory.from({ type: AssetType.Video }).exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      await expect(sut.handleAssetEditThumbnailGeneration({ id: asset.id })).resolves.toBe(JobStatus.Success);
      expect(mocks.media.generateThumbnail).not.toHaveBeenCalled();
    });

    it('should upsert 3 edited files for edit jobs', async () => {
      const asset = AssetFactory.from()
        .exif()
        .edit({ action: AssetEditAction.Crop })
        .files([
          { type: AssetFileType.FullSize, isEdited: true },
          { type: AssetFileType.Preview, isEdited: true },
          { type: AssetFileType.Thumbnail, isEdited: true },
        ])
        .build();

      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
      const thumbhashBuffer = Buffer.from('a thumbhash', 'utf8');
      mocks.media.generateThumbhash.mockResolvedValue(thumbhashBuffer);
      mocks.person.getFaces.mockResolvedValue([]);
      mocks.ocr.getByAssetId.mockResolvedValue([]);

      await sut.handleAssetEditThumbnailGeneration({ id: asset.id });

      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith(
        expect.arrayContaining([
          expect.objectContaining({ type: AssetFileType.FullSize, isEdited: true }),
          expect.objectContaining({ type: AssetFileType.Preview, isEdited: true }),
          expect.objectContaining({ type: AssetFileType.Thumbnail, isEdited: true }),
        ]),
      );
    });

    it('should apply edits when generating thumbnails', async () => {
      const asset = AssetFactory.from()
        .exif()
        .edit({ action: AssetEditAction.Crop, parameters: { height: 1152, width: 1512, x: 216, y: 1512 } })
        .build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
      mocks.person.getFaces.mockResolvedValue([]);
      mocks.ocr.getByAssetId.mockResolvedValue([]);

      await sut.handleAssetEditThumbnailGeneration({ id: asset.id });
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        expect.objectContaining({
          edits: [
            expect.objectContaining({
              action: 'crop',
              parameters: { height: 1152, width: 1512, x: 216, y: 1512 },
            }),
          ],
        }),
        expect.any(String),
      );
    });

    it('should clean up edited files if an asset has no edits', async () => {
      const asset = AssetFactory.from({ thumbhash: factory.buffer() })
        .exif()
        .files([
          { type: AssetFileType.Preview, path: 'edited1.jpg', isEdited: true },
          { type: AssetFileType.Thumbnail, path: 'edited2.jpg', isEdited: true },
          { type: AssetFileType.FullSize, path: 'edited3.jpg', isEdited: true },
        ])
        .build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));

      const status = await sut.handleAssetEditThumbnailGeneration({ id: asset.id });

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: {
          files: expect.arrayContaining(['edited1.jpg', 'edited2.jpg', 'edited3.jpg']),
        },
      });

      expect(status).toBe(JobStatus.Success);
      expect(mocks.media.generateThumbnail).not.toHaveBeenCalled();
      expect(mocks.asset.upsertFiles).not.toHaveBeenCalled();
    });

    it('should generate all 3 edited files if an asset has edits', async () => {
      const asset = AssetFactory.from().exif().edit().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
      mocks.person.getFaces.mockResolvedValue([]);
      mocks.ocr.getByAssetId.mockResolvedValue([]);

      await sut.handleAssetEditThumbnailGeneration({ id: asset.id });

      expect(mocks.media.generateThumbnail).toHaveBeenCalledTimes(3);
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        expect.anything(),
        expect.stringContaining('preview_edited.jpeg'),
      );
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        expect.anything(),
        expect.stringContaining('thumbnail_edited.webp'),
      );
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        rawBuffer,
        expect.anything(),
        expect.stringContaining('fullsize_edited.jpeg'),
      );
    });

    it('should generate the original thumbhash if no edits exist', async () => {
      const asset = AssetFactory.from().exif().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
      mocks.media.generateThumbhash.mockResolvedValue(factory.buffer());

      await sut.handleAssetEditThumbnailGeneration({ id: asset.id, source: 'upload' });

      expect(mocks.media.generateThumbhash).toHaveBeenCalled();
    });

    it('should apply thumbhash if job source is edit and edits exist', async () => {
      const asset = AssetFactory.from().exif().edit().build();
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(getForGenerateThumbnail(asset));
      const thumbhashBuffer = factory.buffer();
      mocks.media.generateThumbhash.mockResolvedValue(thumbhashBuffer);
      mocks.person.getFaces.mockResolvedValue([]);
      mocks.ocr.getByAssetId.mockResolvedValue([]);

      await sut.handleAssetEditThumbnailGeneration({ id: asset.id });

      expect(mocks.asset.update).toHaveBeenCalledWith(expect.objectContaining({ thumbhash: thumbhashBuffer }));
    });
  });

  describe('handleGeneratePersonThumbnail', () => {
    it('should generate a thumbnail even if machine learning is disabled', async () => {
      mocks.systemMetadata.get.mockResolvedValue(systemConfigStub.machineLearningDisabled);
      mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(personThumbnailStub.newThumbnailMiddle);
      mocks.media.generateThumbnail.mockResolvedValue();
      mocks.media.decodeImage.mockResolvedValue({
        data: Buffer.from(''),
        info: { width: 1000, height: 1000 } as OutputInfo,
      });

      await expect(
        sut.handleGeneratePersonThumbnail({ ownerId: 'owner-1', personGroupId: 'person-group-1' }),
      ).resolves.toBe(JobStatus.Success);
      expect(mocks.media.generateThumbnail).toHaveBeenCalled();
    });

    it('should skip a person not found', async () => {
      await sut.handleGeneratePersonThumbnail({ ownerId: 'owner-1', personGroupId: 'person-group-1' });
      expect(mocks.media.generateThumbnail).not.toHaveBeenCalled();
    });

    it('should skip a person without a face asset id', async () => {
      const person = PersonFactory.create({ faceAssetId: null });
      await sut.handleGeneratePersonThumbnail({ ownerId: person.ownerId, personGroupId: person.personGroupId });
      expect(mocks.media.generateThumbnail).not.toHaveBeenCalled();
    });

    it('should skip a person with face not found', async () => {
      await sut.handleGeneratePersonThumbnail({ ownerId: 'owner-1', personGroupId: 'person-group-1' });
      expect(mocks.media.generateThumbnail).not.toHaveBeenCalled();
    });

    it('should generate a thumbnail', async () => {
      const person = PersonFactory.create();

      mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(personThumbnailStub.newThumbnailMiddle);
      mocks.media.generateThumbnail.mockResolvedValue();
      const data = Buffer.from('');
      const info = { width: 1000, height: 1000 } as OutputInfo;
      mocks.media.decodeImage.mockResolvedValue({ data, info });

      await expect(
        sut.handleGeneratePersonThumbnail({ ownerId: person.ownerId, personGroupId: person.personGroupId }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.person.getDataForThumbnailGenerationJob).toHaveBeenCalledWith({
        ownerId: person.ownerId,
        personGroupId: person.personGroupId,
      });
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.any(String));
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(personThumbnailStub.newThumbnailMiddle.originalPath, {
        colorspace: Colorspace.P3,
        orientation: undefined,
        processInvalidImages: false,
      });
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        data,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          quality: 80,
          progressive: false,
          edits: [
            {
              action: 'crop',
              parameters: {
                height: 274,
                width: 274,
                x: 238,
                y: 163,
              },
            },
          ],
          raw: info,
          processInvalidImages: false,
          size: 250,
        },
        expect.any(String),
      );
      expect(mocks.person.update).toHaveBeenCalledWith({
        ownerId: person.ownerId,
        personGroupId: person.personGroupId,
        thumbnailPath: expect.any(String),
      });
    });

    it('should use preview path if video', async () => {
      const person = PersonFactory.create();

      mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(personThumbnailStub.videoThumbnail);
      mocks.media.generateThumbnail.mockResolvedValue();
      const data = Buffer.from('');
      const info = { width: 1000, height: 1000 } as OutputInfo;
      mocks.media.decodeImage.mockResolvedValue({ data, info });

      await expect(
        sut.handleGeneratePersonThumbnail({ ownerId: person.ownerId, personGroupId: person.personGroupId }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.person.getDataForThumbnailGenerationJob).toHaveBeenCalledWith({
        ownerId: person.ownerId,
        personGroupId: person.personGroupId,
      });
      expect(mocks.storage.mkdirSync).toHaveBeenCalledWith(expect.any(String));
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(expect.any(String), {
        colorspace: Colorspace.P3,
        orientation: undefined,
        processInvalidImages: false,
      });
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        data,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          quality: 80,
          progressive: false,
          edits: [
            {
              action: 'crop',
              parameters: {
                height: 274,
                width: 274,
                x: 238,
                y: 163,
              },
            },
          ],
          raw: info,
          processInvalidImages: false,
          size: 250,
        },
        expect.any(String),
      );
      expect(mocks.person.update).toHaveBeenCalledWith({
        ownerId: person.ownerId,
        personGroupId: person.personGroupId,
        thumbnailPath: expect.any(String),
      });
    });

    it('should generate a thumbnail without going negative', async () => {
      const person = PersonFactory.create();

      mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(personThumbnailStub.newThumbnailStart);
      mocks.media.generateThumbnail.mockResolvedValue();
      const data = Buffer.from('');
      const info = { width: 2160, height: 3840 } as OutputInfo;
      mocks.media.decodeImage.mockResolvedValue({ data, info });

      await expect(
        sut.handleGeneratePersonThumbnail({ ownerId: person.ownerId, personGroupId: person.personGroupId }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.media.decodeImage).toHaveBeenCalledWith(personThumbnailStub.newThumbnailStart.originalPath, {
        colorspace: Colorspace.P3,
        orientation: undefined,
        processInvalidImages: false,
      });
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        data,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          quality: 80,
          progressive: false,
          edits: [
            {
              action: 'crop',
              parameters: {
                height: 510,
                width: 510,
                x: 0,
                y: 85,
              },
            },
          ],
          raw: info,
          processInvalidImages: false,
          size: 250,
        },
        expect.any(String),
      );
    });

    it('should generate a thumbnail without overflowing', async () => {
      const person = PersonFactory.create();

      mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(personThumbnailStub.newThumbnailEnd);
      mocks.person.update.mockResolvedValue(person);
      mocks.media.generateThumbnail.mockResolvedValue();
      const data = Buffer.from('');
      const info = { width: 1000, height: 1000 } as OutputInfo;
      mocks.media.decodeImage.mockResolvedValue({ data, info });

      await expect(
        sut.handleGeneratePersonThumbnail({ ownerId: person.ownerId, personGroupId: person.personGroupId }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.media.decodeImage).toHaveBeenCalledWith(personThumbnailStub.newThumbnailEnd.originalPath, {
        colorspace: Colorspace.P3,
        orientation: undefined,
        processInvalidImages: false,
      });
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        data,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          quality: 80,
          progressive: false,
          edits: [
            {
              action: 'crop',
              parameters: {
                height: 408,
                width: 408,
                x: 591,
                y: 591,
              },
            },
          ],
          raw: info,
          processInvalidImages: false,
          size: 250,
        },
        expect.any(String),
      );
    });

    it('should handle negative coordinates', async () => {
      const person = PersonFactory.create();

      mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(personThumbnailStub.negativeCoordinate);
      mocks.person.update.mockResolvedValue(person);
      mocks.media.generateThumbnail.mockResolvedValue();
      const data = Buffer.from('');
      const info = { width: 4624, height: 3080 } as OutputInfo;
      mocks.media.decodeImage.mockResolvedValue({ data, info });

      await expect(
        sut.handleGeneratePersonThumbnail({ ownerId: person.ownerId, personGroupId: person.personGroupId }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.media.decodeImage).toHaveBeenCalledWith(personThumbnailStub.negativeCoordinate.originalPath, {
        colorspace: Colorspace.P3,
        orientation: undefined,
        processInvalidImages: false,
      });
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        data,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          quality: 80,
          progressive: false,
          edits: [
            {
              action: 'crop',
              parameters: {
                height: 412,
                width: 412,
                x: 0,
                y: 62,
              },
            },
          ],
          raw: info,
          processInvalidImages: false,
          size: 250,
        },
        expect.any(String),
      );
    });

    it('should handle overflowing coordinate', async () => {
      const person = PersonFactory.create();

      mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(personThumbnailStub.overflowingCoordinate);
      mocks.person.update.mockResolvedValue(person);
      mocks.media.generateThumbnail.mockResolvedValue();
      const data = Buffer.from('');
      const info = { width: 4624, height: 3080 } as OutputInfo;
      mocks.media.decodeImage.mockResolvedValue({ data, info });

      await expect(
        sut.handleGeneratePersonThumbnail({ ownerId: person.ownerId, personGroupId: person.personGroupId }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.media.decodeImage).toHaveBeenCalledWith(personThumbnailStub.overflowingCoordinate.originalPath, {
        colorspace: Colorspace.P3,
        orientation: undefined,
        processInvalidImages: false,
      });
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        data,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          quality: 80,
          progressive: false,
          edits: [
            {
              action: 'crop',
              parameters: {
                height: 138,
                width: 138,
                x: 4485,
                y: 94,
              },
            },
          ],
          raw: info,
          processInvalidImages: false,
          size: 250,
        },
        expect.any(String),
      );
    });

    it('should use embedded preview if enabled and raw image', async () => {
      const person = PersonFactory.create();

      mocks.systemMetadata.get.mockResolvedValue({ image: { extractEmbedded: true } });
      mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(personThumbnailStub.rawEmbeddedThumbnail);
      mocks.person.update.mockResolvedValue(person);
      mocks.media.generateThumbnail.mockResolvedValue();
      const extracted = Buffer.from('');
      const data = Buffer.from('');
      const info = { width: 2160, height: 3840 } as OutputInfo;
      mocks.media.extract.mockResolvedValue({ buffer: extracted, format: RawExtractedFormat.Jpeg });
      mocks.media.decodeImage.mockResolvedValue({ data, info });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 2160, height: 3840, isTransparent: false });

      await expect(
        sut.handleGeneratePersonThumbnail({ ownerId: person.ownerId, personGroupId: person.personGroupId }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.media.extract).toHaveBeenCalledWith(personThumbnailStub.rawEmbeddedThumbnail.originalPath);
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(extracted, {
        colorspace: Colorspace.P3,
        orientation: ExifOrientation.Horizontal,
        processInvalidImages: false,
      });
      expect(mocks.media.generateThumbnail).toHaveBeenCalledWith(
        data,
        {
          colorspace: Colorspace.P3,
          format: ImageFormat.Jpeg,
          quality: 80,
          progressive: false,
          edits: [
            {
              action: 'crop',
              parameters: {
                height: 844,
                width: 844,
                x: 388,
                y: 730,
              },
            },
          ],
          raw: info,
          processInvalidImages: false,
          size: 250,
        },
        expect.any(String),
      );
    });

    it('should not use embedded preview if enabled and not raw image', async () => {
      const person = PersonFactory.create();

      mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(personThumbnailStub.newThumbnailMiddle);
      mocks.media.generateThumbnail.mockResolvedValue();
      const data = Buffer.from('');
      const info = { width: 2160, height: 3840 } as OutputInfo;
      mocks.media.decodeImage.mockResolvedValue({ data, info });

      await expect(
        sut.handleGeneratePersonThumbnail({ ownerId: person.ownerId, personGroupId: person.personGroupId }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.media.extract).not.toHaveBeenCalled();
      expect(mocks.media.generateThumbnail).toHaveBeenCalled();
    });

    it('should not use embedded preview if enabled and raw image if not exists', async () => {
      const person = PersonFactory.create();

      mocks.systemMetadata.get.mockResolvedValue({ image: { extractEmbedded: true } });
      mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(personThumbnailStub.rawEmbeddedThumbnail);
      mocks.media.generateThumbnail.mockResolvedValue();
      const data = Buffer.from('');
      const info = { width: 2160, height: 3840 } as OutputInfo;
      mocks.media.decodeImage.mockResolvedValue({ data, info });

      await expect(
        sut.handleGeneratePersonThumbnail({ ownerId: person.ownerId, personGroupId: person.personGroupId }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.media.extract).toHaveBeenCalledWith(personThumbnailStub.rawEmbeddedThumbnail.originalPath);
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(personThumbnailStub.rawEmbeddedThumbnail.originalPath, {
        colorspace: Colorspace.P3,
        orientation: undefined,
        processInvalidImages: false,
      });
      expect(mocks.media.generateThumbnail).toHaveBeenCalled();
    });

    it('should not use embedded preview if enabled and raw image if low resolution', async () => {
      const person = PersonFactory.create();

      mocks.systemMetadata.get.mockResolvedValue({ image: { extractEmbedded: true } });
      mocks.person.getDataForThumbnailGenerationJob.mockResolvedValue(personThumbnailStub.rawEmbeddedThumbnail);
      mocks.media.generateThumbnail.mockResolvedValue();
      const extracted = Buffer.from('');
      const data = Buffer.from('');
      const info = { width: 1000, height: 1000 } as OutputInfo;
      mocks.media.decodeImage.mockResolvedValue({ data, info });
      mocks.media.extract.mockResolvedValue({ buffer: extracted, format: RawExtractedFormat.Jpeg });
      mocks.media.getImageMetadata.mockResolvedValue({ width: 1000, height: 1000, isTransparent: false });

      await expect(
        sut.handleGeneratePersonThumbnail({ ownerId: person.ownerId, personGroupId: person.personGroupId }),
      ).resolves.toBe(JobStatus.Success);

      expect(mocks.media.extract).toHaveBeenCalledWith(personThumbnailStub.rawEmbeddedThumbnail.originalPath);
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(personThumbnailStub.rawEmbeddedThumbnail.originalPath, {
        colorspace: Colorspace.P3,
        orientation: undefined,
        processInvalidImages: false,
      });
      expect(mocks.media.generateThumbnail).toHaveBeenCalled();
    });
  });

  describe('handleQueueVideoConversion', () => {
    it('should queue all video assets', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.streamForVideoConversion.mockReturnValue(makeStream([asset]));
      mocks.person.getAll.mockReturnValue(makeStream());

      await sut.handleQueueVideoConversion({ force: true });

      expect(mocks.assetJob.streamForVideoConversion).toHaveBeenCalledWith(true);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetEncodeVideo,
          data: { id: asset.id },
        },
      ]);
    });

    it('should queue all video assets without encoded videos', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.streamForVideoConversion.mockReturnValue(makeStream([asset]));

      await sut.handleQueueVideoConversion({});

      expect(mocks.assetJob.streamForVideoConversion).toHaveBeenCalledWith(void 0);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetEncodeVideo,
          data: { id: asset.id },
        },
      ]);
    });
  });

  describe('handleQueueVideoConversion', () => {
    it('should queue hidden assets when force is not set', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video, visibility: AssetVisibility.Hidden });
      mocks.assetJob.streamForVideoConversion.mockReturnValue(makeStream([asset]));

      await sut.handleQueueVideoConversion({});
      expect(mocks.assetJob.streamForVideoConversion).toHaveBeenCalledWith(void 0);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.AssetEncodeVideo,
          data: { id: asset.id },
        },
      ]);
    });
  });

  describe('generated physical files', () => {
    it('links a generated preview to its canonical file and deletes only the redundant output', async () => {
      const file = {
        assetId: 'asset-id',
        type: AssetFileType.Preview,
        path: '/generated/preview.jpg',
        isEdited: false,
        isProgressive: false,
        isTransparent: false,
      };
      const canonical = { id: 'physical-id', path: '/canonical/preview.jpg' };
      mocks.systemMetadata.get.mockResolvedValue({ physicalDeduplication: { enabled: true } });
      mocks.physicalFile.getCanonicalGeneratedFile.mockResolvedValue(canonical as never);
      mocks.asset.upsertFiles.mockResolvedValue();
      mocks.job.queue.mockResolvedValue();

      await (sut as any).syncFiles([], [file]);

      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
        { ...file, path: canonical.path, physicalFileId: canonical.id },
      ]);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: [file.path] },
      });
    });

    it('keeps edited outputs independent from shared generated files', async () => {
      const file = {
        assetId: 'asset-id',
        type: AssetFileType.Preview,
        path: '/edited/preview.jpg',
        isEdited: true,
        isProgressive: false,
        isTransparent: false,
      };
      mocks.asset.upsertFiles.mockResolvedValue();

      await (sut as any).syncFiles([], [file]);

      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([file]);
      expect(mocks.physicalFile.getCanonicalGeneratedFile).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });

  describe('getVideoEditCommand', () => {
    const videoStream = probeStub.audioStreamAac.videoStream;
    const audioStream = probeStub.audioStreamAac.audioStream ?? undefined;
    const format = { ...probeStub.audioStreamAac.format, duration: 5 };

    // FL-17/FL-39: every edited master is rendered under the color decision made for its source
    const editCommand = (config: any, edits: any[], stream: any, audio: any, fmt: any) =>
      (sut as any).getVideoEditCommand(
        config,
        edits,
        stream,
        audio,
        fmt,
        resolveEditedMasterColorPolicy(stream, config),
      );
    const editPlan = (config: any, edits: any[], stream: any, audio: any, fmt: any) =>
      (sut as any).getVideoEditCommandPlan(
        config,
        edits,
        stream,
        audio,
        fmt,
        resolveEditedMasterColorPolicy(stream, config),
      );
    const getPlan = (ffmpeg: Partial<SystemConfig['ffmpeg']>, edits: any[]) =>
      editPlan({ ...defaults.ffmpeg, ...ffmpeg }, edits, videoStream, audioStream, format);

    it('should preserve edited dimensions independently of playback resolution', () => {
      const source = { ...videoStream, width: 3840, height: 2160, rotation: 0 };
      const edits = [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }];
      const commands = ['480', '720', '1080', 'original'].map((targetResolution) =>
        editCommand({ ...defaults.ffmpeg, targetResolution }, edits, source, audioStream, format),
      );

      for (const command of commands) {
        // FL-39: a right-angle turn alone is written to the display matrix; every packet is kept
        expect(command.inputOptions).toEqual(expect.arrayContaining(['-display_rotation']));
        expect(command.outputOptions).toEqual(expect.arrayContaining(['-c', 'copy']));
        expect(command).toEqual(commands[0]);
      }
      expect((sut as any).getVideoEditDimensions(edits, source)).toEqual({ width: 2160, height: 3840 });
    });

    it('should report the dimensions actually rendered for portrait sources and chroma-aligned crops', () => {
      const portrait = { ...videoStream, width: 3840, height: 2160, rotation: -90 };
      expect((sut as any).getVideoEditDimensions([], portrait)).toEqual({ width: 2160, height: 3840 });
      const edits = [
        { action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 1001, height: 501 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ];
      expect((sut as any).getVideoEditDimensions(edits, portrait)).toEqual({ width: 500, height: 1000 });
      const command = editCommand(defaults.ffmpeg, edits, portrait, audioStream, format);
      expect(getFilterOption(command.outputOptions)).toBe('crop=1000:500:0:0,transpose=1');
    });

    it('should build a complex filter graph for speed segments with audio', () => {
      const command = editCommand(
        defaults.ffmpeg,
        [
          { action: AssetEditAction.Speed, parameters: { rate: 0.5, startMs: 1000, endMs: 3000 } },
          { action: AssetEditAction.Audio, parameters: { volume: 0.75 } },
        ],
        videoStream,
        audioStream,
        format,
      );

      const filterComplexIndex = command.outputOptions.indexOf('-filter_complex');
      const filterGraph = command.outputOptions[filterComplexIndex + 1];

      expect(filterComplexIndex).toBeGreaterThan(-1);
      expect(command.outputOptions).toEqual(expect.arrayContaining(['-map', '[vout]', '-map', '[aout]']));
      expect(command.outputOptions).not.toContain('-vf');
      expect(command.outputOptions).not.toContain('-filter:a');
      expect(filterGraph).toContain('[0:0]trim=start=0:end=1,setpts=1*(PTS-STARTPTS)[v0]');
      expect(filterGraph).toContain('[0:0]trim=start=1:end=3,setpts=2*(PTS-STARTPTS)[v1]');
      expect(filterGraph).toContain('[0:1]atrim=start=1:end=3,asetpts=PTS-STARTPTS,atempo=0.5[a1]');
      expect(filterGraph).toContain('concat=n=3:v=1:a=1[vout][aconcat]');
      expect(filterGraph).not.toContain('scale=');
      expect(filterGraph).toContain('[aconcat]volume=0.75[aout]');
    });

    it('plays the whole-clip speed in the gaps between speed ranges (FL-113)', () => {
      const edits = [
        { action: AssetEditAction.Speed, parameters: { rate: 2 } },
        { action: AssetEditAction.Speed, parameters: { rate: 0.5, startMs: 1000, endMs: 3000 } },
      ];
      const command = editCommand(defaults.ffmpeg, edits, videoStream, audioStream, format);
      const filterGraph = command.outputOptions[command.outputOptions.indexOf('-filter_complex') + 1];

      expect(filterGraph).toContain('[0:0]trim=start=0:end=1,setpts=0.5*(PTS-STARTPTS)[v0]');
      expect(filterGraph).toContain('[0:0]trim=start=1:end=3,setpts=2*(PTS-STARTPTS)[v1]');
      expect(filterGraph).toContain('[0:0]trim=start=3:end=5,setpts=0.5*(PTS-STARTPTS)[v2]');
      // The whole-clip rate is not applied a second time on top of the ranges.
      expect(filterGraph).not.toContain('setpts=0.5*PTS');
      expect((sut as any).getVideoEditDurationMs(edits, format)).toBe(500 + 4000 + 1000);
    });

    it('scales a straightened picture to cover its frame instead of leaving black corners (FL-113)', () => {
      const command = editCommand(
        defaults.ffmpeg,
        [{ action: AssetEditAction.Straighten, parameters: { angle: 5 } }],
        videoStream,
        audioStream,
        format,
      );
      const filters = getFilterOption(command.outputOptions);
      expect(filters).toContain('rotate=5*PI/180:fillcolor=black');
      expect(filters).toMatch(
        /rotate=5\*PI\/180:fillcolor=black,scale=trunc\(iw\*1\.\d+\/2\)\*2:trunc\(ih\*1\.\d+\/2\)\*2,crop=1920:1080/,
      );
    });

    it("renders the develop model of the quick editor with the still renderer's tone curve (FL-113)", () => {
      const command = editCommand(
        defaults.ffmpeg,
        [
          {
            action: AssetEditAction.Adjust,
            parameters: { model: 'develop', exposure: 0.5, contrast: 20, saturation: -10, preset: 'Mono' },
          },
        ],
        videoStream,
        audioStream,
        format,
      );
      const filters = getFilterOption(command.outputOptions);
      expect(filters).toMatch(/curves=r='0\/0 [^']+':g='[^']+':b='[^']+'/);
      expect(filters).toContain('eq=saturation=0.9');
      expect(filters).toContain('colorchannelmixer=rr=0.2126:rg=0.7152:rb=0.0722');
      // The earlier adjustment model is not applied to develop values.
      expect(filters).not.toContain('eq=contrast=');
    });

    it('keeps the earlier adjustment model for recipes without the develop marker', () => {
      const command = editCommand(
        defaults.ffmpeg,
        [{ action: AssetEditAction.Adjust, parameters: { contrast: 20 } }],
        videoStream,
        audioStream,
        format,
      );
      expect(getFilterOption(command.outputOptions)).toContain('eq=contrast=1.2');
    });

    it('anchors text on the prototype grid with a shadow (FL-113)', () => {
      const command = editCommand(
        defaults.ffmpeg,
        [
          {
            action: AssetEditAction.TextOverlay,
            parameters: {
              text: 'Title',
              x: 0.5,
              y: 1,
              position: 'bottom',
              shadow: true,
              size: 0.05,
              color: '#ffffff',
            },
          },
        ],
        videoStream,
        audioStream,
        format,
      );
      const filters = getFilterOption(command.outputOptions);
      expect(filters).toContain("drawtext=text='Title':x=(w-text_w)/2:y=h-text_h-w*0.04:fontsize=h*0.05");
      expect(filters).toContain(':shadowcolor=black@0.7:shadowx=0:shadowy=3');
    });

    it('crops the stabilized edges and limits gain above 100% (FL-113)', () => {
      const command = editCommand(
        defaults.ffmpeg,
        [
          { action: AssetEditAction.Stabilize, parameters: { enabled: true } },
          { action: AssetEditAction.Audio, parameters: { volume: 1.4 } },
        ],
        videoStream,
        audioStream,
        format,
      );
      expect(getFilterOption(command.outputOptions)).toContain(
        'deshake,crop=trunc(iw*0.96/2)*2:trunc(ih*0.96/2)*2,scale=1920:1080',
      );
      expect(getFilterOption(command.outputOptions, '-filter:a')).toBe('volume=1.4,alimiter=limit=0.98');
    });

    it('copies the packets for a lone fast trim instead of re-encoding (FL-113)', () => {
      const command = editCommand(
        defaults.ffmpeg,
        [{ action: AssetEditAction.Trim, parameters: { startMs: 1000, endMs: 4000, mode: 'fast' } }],
        videoStream,
        audioStream,
        format,
      );
      expect(command.inputOptions).toEqual(['-ss', '1']);
      expect(command.outputOptions).toEqual(expect.arrayContaining(['-t', '3', '-c', 'copy']));
      expect(command.outputOptions).not.toContain('-vf');
    });

    it('renders a fast trim frame-accurately when another edit needs a re-encode', () => {
      const command = editCommand(
        defaults.ffmpeg,
        [
          { action: AssetEditAction.Trim, parameters: { startMs: 1000, endMs: 4000, mode: 'fast' } },
          { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        ],
        videoStream,
        audioStream,
        format,
      );
      expect(command.outputOptions).not.toEqual(expect.arrayContaining(['-c', 'copy']));
      expect(getFilterOption(command.outputOptions)).toContain('transpose=1');
    });

    it('should offset text overlay timing after trimming video', () => {
      const command = editCommand(
        defaults.ffmpeg,
        [
          { action: AssetEditAction.Trim, parameters: { startMs: 1000, endMs: 5000 } },
          {
            action: AssetEditAction.TextOverlay,
            parameters: { text: 'Hello', x: 0.5, y: 0.5, startMs: 3000, endMs: 4000, size: 0.06, color: '#ffffff' },
          },
        ],
        videoStream,
        audioStream,
        format,
      );

      expect(getFilterOption(command.outputOptions)).toContain(String.raw`:enable='between(t\,2\,3)'`);
    });

    it('should map text overlay timing and duration through trimmed speed segments', () => {
      const edits = [
        { action: AssetEditAction.Trim, parameters: { startMs: 1000, endMs: 5000 } },
        { action: AssetEditAction.Speed, parameters: { rate: 0.5, startMs: 1000, endMs: 3000 } },
        {
          action: AssetEditAction.TextOverlay,
          parameters: { text: 'Hello', x: 0.5, y: 0.5, startMs: 3000, endMs: 4000, size: 0.06, color: '#ffffff' },
        },
      ];
      const command = editCommand(defaults.ffmpeg, edits, videoStream, audioStream, format);
      const filterComplexIndex = command.outputOptions.indexOf('-filter_complex');
      const filterGraph = command.outputOptions[filterComplexIndex + 1];

      expect(filterGraph).toContain(String.raw`:enable='between(t\,4\,5)'`);
      expect((sut as any).getVideoEditDurationMs(edits, format)).toBe(6000);
    });

    it('should keep software command shape when hardware acceleration is disabled', () => {
      const plan = getPlan({ accel: TranscodeHardwareAcceleration.Disabled }, [
        { action: AssetEditAction.Crop, parameters: { x: 2, y: 4, width: 300, height: 201 } },
      ]);

      expect(plan.mode).toBe('Software');
      expect(plan.command.inputOptions).not.toEqual(expect.arrayContaining(['-hwaccel']));
      expect(plan.command.inputOptions).not.toEqual(expect.arrayContaining(['-init_hw_device']));
      expect(plan.command.outputOptions).toEqual(
        // FL-39: the edited master is never encoded below the master quality cap, whatever the playback crf
        expect.arrayContaining(['-c:v', 'h264', '-preset', 'ultrafast', '-crf', String(EDITED_MASTER_MAX_CRF)]),
      );
      expect(getFilterOption(plan.command.outputOptions)).toBe('crop=300:200:2:4');
    });

    it.each([
      [TranscodeHardwareAcceleration.Nvenc, 'cuda', 'h264_nvenc'],
      [TranscodeHardwareAcceleration.Qsv, 'qsv', 'h264_qsv'],
      [TranscodeHardwareAcceleration.Vaapi, 'vaapi', 'h264_vaapi'],
      [TranscodeHardwareAcceleration.Rkmpp, 'rkmpp', 'h264_rkmpp'],
    ])('should keep hardware decode and encode for trim-only edits with %s', (accel, hwaccel, codec) => {
      sut.videoInterfaces = { dri: ['renderD128'], mali: true };

      const plan = getPlan({ accel, accelDecode: true }, [
        { action: AssetEditAction.Trim, parameters: { startMs: 1000, endMs: 3000 } },
      ]);

      expect(plan.mode).toBe('HardwareNative');
      expect(plan.command.inputOptions).toEqual(expect.arrayContaining(['-hwaccel', hwaccel]));
      expect(plan.command.outputOptions).toEqual(expect.arrayContaining(['-c:v', codec]));
    });

    it('should retain source autorotation when hardware encoding a portrait trim', () => {
      const plan = editPlan(
        { ...defaults.ffmpeg, accel: TranscodeHardwareAcceleration.Nvenc, accelDecode: true },
        [{ action: AssetEditAction.Trim, parameters: { startMs: 1000, endMs: 3000 } }],
        { ...videoStream, rotation: 90 },
        audioStream,
        format,
      );
      expect(plan.mode).toBe('HybridHardwareEncode');
      expect(plan.command.inputOptions).not.toContain('-noautorotate');
      expect(plan.command.inputOptions).not.toContain('-hwaccel');
      expect(plan.command.outputOptions).toContain('h264_nvenc');
    });

    it.each([
      [TranscodeHardwareAcceleration.Nvenc, 'h264_nvenc', 'hwupload_cuda'],
      [TranscodeHardwareAcceleration.Qsv, 'h264_qsv', 'hwupload=extra_hw_frames=64'],
      [TranscodeHardwareAcceleration.Vaapi, 'h264_vaapi', 'hwupload=extra_hw_frames=64'],
      [TranscodeHardwareAcceleration.Rkmpp, 'h264_rkmpp', null],
    ])(
      'should disable hardware decode and keep hardware encode for CPU edit filters with %s',
      (accel, codec, upload) => {
        sut.videoInterfaces = { dri: ['renderD128'], mali: true };

        const plan = getPlan({ accel, accelDecode: true }, [
          { action: AssetEditAction.Crop, parameters: { x: 2, y: 4, width: 300, height: 200 } },
          { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        ]);
        const filter = getFilterOption(plan.command.outputOptions);

        expect(plan.mode).toBe('HybridHardwareEncode');
        expect(plan.command.inputOptions).not.toEqual(expect.arrayContaining(['-hwaccel']));
        expect(plan.command.outputOptions).toEqual(expect.arrayContaining(['-c:v', codec]));
        expect(filter).toContain('crop=300:200:2:4');
        expect(filter).toContain('transpose=1');
        if (upload) {
          expect(filter).toContain(upload);
        }
        expect(filter).not.toContain('scale=');
      },
    );

    it('should append preset and thread options but never the playback bitrate cap to an edited master', () => {
      const plan = getPlan({ maxBitrate: '10000k', threads: 2 }, [
        { action: AssetEditAction.Trim, parameters: { startMs: 1000, endMs: 3000 } },
      ]);

      expect(plan.command.outputOptions).toEqual(
        expect.arrayContaining(['-preset', 'ultrafast', '-threads', '2', '-crf', String(EDITED_MASTER_MAX_CRF)]),
      );
      // FL-39: the playback transcode settings describe a proxy; they never cap the edited master
      expect(plan.command.outputOptions).not.toContain('-maxrate');
      expect(plan.command.outputOptions).not.toContain('-bufsize');
    });
  });

  describe('handleAssetVideoEditGeneration', () => {
    it('should retry edited video rendering with software acceleration when hardware rendering fails', async () => {
      const asset = {
        ...AssetFactory.create({ id: 'video-id', type: AssetType.Video, originalPath: '/original/path.ext' }),
        videoStream: probeStub.videoStreamH264.videoStream,
        audioStream: probeStub.audioStreamAac.audioStream,
        format: { ...probeStub.videoStreamH264.format, duration: 5 },
        files: [],
      };
      mocks.assetJob.getForVideoConversion.mockResolvedValue(asset);
      mocks.assetEdit.getRequestedVideoVersion.mockResolvedValue(undefined);
      mocks.assetEdit.getAll.mockResolvedValue([
        { id: 'edit-id', action: AssetEditAction.Crop, parameters: { x: 2, y: 4, width: 300, height: 200 } },
      ]);
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Nvenc, accelDecode: true },
      });
      mocks.media.transcode.mockRejectedValueOnce(new Error('gpu failed')).mockResolvedValueOnce(void 0);
      sut.videoInterfaces = { dri: ['renderD128'], mali: true };
      (sut as any).generateVideoThumbnails = () =>
        Promise.resolve({
          files: [],
          thumbhash: Buffer.from('thumbhash'),
          fullsizeDimensions: { width: 300, height: 200 },
        });

      await expect(sut.handleAssetVideoEditGeneration({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.media.transcode).toHaveBeenCalledTimes(2);
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        1,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining(['-init_hw_device', 'cuda=cuda:0', '-filter_hw_device', 'cuda']),
          outputOptions: expect.arrayContaining(['-c:v', 'h264_nvenc']),
        }),
      );
      expect(mocks.media.transcode).toHaveBeenNthCalledWith(
        2,
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.not.arrayContaining(['-hwaccel', '-init_hw_device']),
          outputOptions: expect.arrayContaining(['-c:v', 'h264']),
        }),
      );
      expect(mocks.asset.upsertFile).toHaveBeenCalledWith(
        expect.objectContaining({
          assetId: asset.id,
          type: AssetFileType.EncodedVideo,
          isEdited: true,
        }),
      );
    });

    describe('edited-master policy (FL-39, FL-16)', () => {
      const editedAsset = (overrides: Record<string, unknown> = {}) => ({
        ...AssetFactory.create({ id: 'video-id', type: AssetType.Video, originalPath: '/original/path.ext' }),
        checksum: Buffer.from('checksum'),
        videoStream: probeStub.videoStreamH264.videoStream,
        audioStream: probeStub.audioStreamAac.audioStream,
        format: { ...probeStub.videoStreamH264.format, duration: 5 },
        files: [],
        ...overrides,
      });

      const stubThumbnails = () => {
        (sut as any).generateVideoThumbnails = () =>
          Promise.resolve({
            files: [],
            thumbhash: Buffer.from('thumbhash'),
            fullsizeDimensions: { width: 300, height: 200 },
          });
      };

      const lastTranscodeOptions = () => {
        const calls = mocks.media.transcode.mock.calls;
        return calls.at(-1)![2].outputOptions as string[];
      };

      beforeEach(() => {
        sut.videoInterfaces = { dri: ['renderD128'], mali: true };
        stubThumbnails();
        mocks.assetEdit.getAll.mockResolvedValue([
          { id: 'edit-id', action: AssetEditAction.Crop, parameters: { x: 2, y: 4, width: 300, height: 200 } },
        ]);
      });

      it('does not let the playback resolution, CRF or bitrate ceiling cap the edited master', async () => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue(editedAsset());
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: {
            accel: TranscodeHardwareAcceleration.Disabled,
            crf: 30,
            targetResolution: '720',
            maxBitrate: '3000k',
          },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const outputOptions = lastTranscodeOptions();
        // The master quality target is clamped to at least CRF 18, never the playback CRF.
        expect(outputOptions[outputOptions.indexOf('-crf') + 1]).toBe('18');
        // The playback bitrate ceiling must not truncate the master.
        expect(outputOptions).not.toContain('-maxrate');
        expect(outputOptions).not.toContain('-bufsize');
        // 1920x1080 source, cropped to 300x200 by the recipe alone — no playback downscale.
        expect(getFilterOption(outputOptions)).not.toContain('scale=');
      });

      it('preserves rational timing and any variable-frame-rate mapping', async () => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue(editedAsset());
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const outputOptions = lastTranscodeOptions();
        expect(outputOptions[outputOptions.indexOf('-fps_mode') + 1]).toBe('passthrough');
        expect(outputOptions[outputOptions.indexOf('-video_track_timescale') + 1]).toBe('600');
      });

      it('does not downmix the master to stereo, and stream-copies an untouched track', async () => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue(editedAsset());
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const outputOptions = lastTranscodeOptions();
        expect(outputOptions).not.toContain('-ac');
        expect(outputOptions[outputOptions.indexOf('-c:a') + 1]).toBe('copy');
      });

      it('re-encodes audio without forcing stereo when the recipe changes the audio', async () => {
        mocks.assetEdit.getAll.mockResolvedValue([
          { id: 'edit-id', action: AssetEditAction.Audio, parameters: { volume: 0.5 } },
        ]);
        mocks.assetJob.getForVideoConversion.mockResolvedValue(editedAsset());
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const outputOptions = lastTranscodeOptions();
        expect(outputOptions).not.toContain('-ac');
        expect(outputOptions[outputOptions.indexOf('-c:a') + 1]).not.toBe('copy');
      });

      it('tags the master with the source colour volume and keeps its bit depth', async () => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue(
          editedAsset({ videoStream: probeStub.videoStreamHDR.videoStream }),
        );
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled, tonemap: ToneMapping.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const outputOptions = lastTranscodeOptions();
        expect(outputOptions[outputOptions.indexOf('-color_trc') + 1]).toBe('smpte2084');
        expect(outputOptions[outputOptions.indexOf('-color_primaries') + 1]).toBe('bt2020');
        // A 10-bit source keeps 10 bits: the H.264 playback codec is promoted rather than flattening it.
        expect(outputOptions[outputOptions.indexOf('-c:v') + 1]).toBe(VideoCodec.Hevc);
        expect(getFilterOption(outputOptions)).toContain('format=yuv420p10le');
      });

      it('keeps a full-range source in full range instead of hard-coding limited range (FL-102)', async () => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue(
          editedAsset({ videoStream: { ...probeStub.videoStreamHDR.videoStream, colorRange: 'pc' } }),
        );
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled, tonemap: ToneMapping.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const outputOptions = lastTranscodeOptions();
        expect(getFilterOption(outputOptions)).toContain('out_range=pc');
        expect(getFilterOption(outputOptions)).not.toContain('out_range=tv');
        expect(outputOptions[outputOptions.indexOf('-color_range') + 1]).toBe('pc');
      });

      it('does not tag a range the plain 8-bit chain never converted to (FL-102)', async () => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue(
          editedAsset({ videoStream: { ...probeStub.videoStreamH264.videoStream, colorRange: 'pc' } }),
        );
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled, tonemap: ToneMapping.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const outputOptions = lastTranscodeOptions();
        expect(getFilterOption(outputOptions) ?? '').not.toContain('out_range=');
        expect(outputOptions).not.toContain('-color_range');
      });

      it('delivers limited range when the source does not state its range (FL-102)', async () => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue(
          editedAsset({ videoStream: probeStub.videoStreamHDR.videoStream }),
        );
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled, tonemap: ToneMapping.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const outputOptions = lastTranscodeOptions();
        expect(getFilterOption(outputOptions)).toContain('out_range=tv');
        expect(outputOptions[outputOptions.indexOf('-color_range') + 1]).toBe('tv');
      });

      it('tags a tone-mapped master as Rec. 709 rather than copying the source HDR tags', async () => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue(
          editedAsset({ videoStream: probeStub.videoStreamHDR.videoStream }),
        );
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled, tonemap: ToneMapping.Hable },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const outputOptions = lastTranscodeOptions();
        expect(outputOptions[outputOptions.indexOf('-color_trc') + 1]).toBe('bt709');
      });

      it('fails before touching an existing master when the source cannot be preserved', async () => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue(
          editedAsset({
            videoStream: { ...probeStub.videoStreamDolbyVision.videoStream, dvProfile: DvProfile.Dvhe05 },
          }),
        );
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Failed);

        expect(mocks.media.transcode).not.toHaveBeenCalled();
        expect(mocks.asset.upsertFile).not.toHaveBeenCalled();
      });

      it('never renders over the original', async () => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue(editedAsset());
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const [input, output] = mocks.media.transcode.mock.calls.at(-1)!;
        expect(input).toBe('/original/path.ext');
        expect(output).not.toBe('/original/path.ext');
        expect(output).toMatch(/_edited\.mp4$/);
      });

      it('preserves every packet for a lone right-angle rotation instead of re-encoding', async () => {
        mocks.assetEdit.getAll.mockResolvedValue([
          { id: 'edit-id', action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        ]);
        mocks.assetJob.getForVideoConversion.mockResolvedValue(editedAsset());
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const command = mocks.media.transcode.mock.calls.at(-1)![2];
        expect(command.inputOptions).toEqual(['-display_rotation', '-90']);
        expect(command.outputOptions).toEqual(expect.arrayContaining(['-c', 'copy']));
        expect(command.outputOptions).not.toContain('-vf');
        expect(command.outputOptions).not.toContain('-crf');
      });

      it('re-encodes a rotation that is combined with another edit', async () => {
        mocks.assetEdit.getAll.mockResolvedValue([
          { id: 'edit-1', action: AssetEditAction.Rotate, parameters: { angle: 90 } },
          { id: 'edit-2', action: AssetEditAction.Crop, parameters: { x: 2, y: 4, width: 300, height: 200 } },
        ]);
        mocks.assetJob.getForVideoConversion.mockResolvedValue(editedAsset());
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const command = mocks.media.transcode.mock.calls.at(-1)![2];
        expect(command.inputOptions).not.toContain('-display_rotation');
        expect(getFilterOption(command.outputOptions)).toContain('transpose=1');
      });

      it('records the edited master lineage beside the master', async () => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue(editedAsset());
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        const [lineagePath, buffer] = mocks.storage.createOrOverwriteFile.mock.calls.at(-1)!;
        expect(lineagePath).toMatch(/_edited\.mp4\.lineage\.json$/);

        const lineage = JSON.parse((buffer as Buffer).toString('utf8'));
        expect(lineage).toEqual(
          expect.objectContaining({
            sourceAssetId: 'video-id',
            sourceOriginalPath: '/original/path.ext',
            sourceChecksum: Buffer.from('checksum').toString('base64'),
            renderer: FRAMELEAF_RENDERER,
            recipeActions: [AssetEditAction.Crop],
          }),
        );
        expect(lineage.recipeRevision).toEqual(expect.any(String));
        expect(lineage.rendererVersion).toEqual(expect.any(String));
      });

      it('writes the lineage before the edited master is published as an asset file', async () => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue(editedAsset());
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled },
        } as never as SystemConfig);

        await expect(sut.handleAssetVideoEditGeneration({ id: 'video-id' })).resolves.toBe(JobStatus.Success);

        expect(mocks.storage.createOrOverwriteFile.mock.invocationCallOrder[0]).toBeLessThan(
          mocks.asset.upsertFile.mock.invocationCallOrder[0],
        );
      });
    });
  });

  describe('version-owned video publication', () => {
    const versionFor = (
      asset: { id: string; ownerId: string; originalPath: string; checksum: Buffer },
      purpose: 'save' | 'export' | 'revert',
    ) => ({
      id: newUuid(),
      assetId: asset.id,
      ownerId: asset.ownerId,
      sourcePath: asset.originalPath,
      sourceChecksum: asset.checksum,
      recipe: [{ action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 200, height: 100 } }],
      purpose,
      status: 'pending' as const,
      masterPath: null,
      proxyPath: null,
      files: [],
      createdAt: new Date(),
    });

    it('refuses an unqualified original before rendering and fails only that version', async () => {
      const videoStream = { ...probeStub.videoStreamDolbyVision.videoStream, dvProfile: DvProfile.Dvhe05 };
      const asset = {
        ...AssetFactory.create({ type: AssetType.Video }),
        videoStream: probeStub.videoStreamH264.videoStream,
        audioStream: null,
        format: probeStub.videoStreamH264.format,
        files: [],
      };
      const version = versionFor(asset, 'save');
      mocks.assetJob.getForVideoConversion.mockResolvedValue(asset);
      mocks.assetEdit.getRequestedVideoVersion.mockResolvedValue(version as any);
      mocks.assetEdit.failVideoVersion.mockResolvedValue(undefined);
      // The version's own original is probed; the asset row's (edited) metadata is not trusted.
      mocks.media.probe.mockResolvedValue({ videoStreams: [videoStream], audioStreams: [], format: asset.format });

      await expect(sut.handleAssetVideoEditGeneration({ id: asset.id })).resolves.toBe(JobStatus.Failed);

      expect(mocks.media.probe).toHaveBeenCalledExactlyOnceWith(asset.originalPath);
      expect(mocks.media.transcode).not.toHaveBeenCalled();
      expect(mocks.assetEdit.failVideoVersion).toHaveBeenCalledExactlyOnceWith(asset.id, version.id);
      expect(mocks.assetEdit.publishVideoVersion).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it('queues the edited files a first versioned revert released from a pre-history edit', async () => {
      const asset = {
        ...AssetFactory.create({ type: AssetType.Video }),
        videoStream: probeStub.videoStreamH264.videoStream,
        audioStream: null,
        format: probeStub.videoStreamH264.format,
        files: [],
      };
      const version = { ...versionFor(asset, 'revert'), recipe: [] };
      mocks.assetJob.getForVideoConversion.mockResolvedValue(asset);
      mocks.assetEdit.getRequestedVideoVersion.mockResolvedValue(version as any);
      mocks.assetEdit.publishVideoVersion.mockResolvedValue({
        published: true,
        releasedPaths: ['/legacy_edited.mp4', '/legacy_edited.mp4.lineage.json'],
      });
      mocks.media.probe.mockResolvedValue({
        videoStreams: [probeStub.videoStreamH264.videoStream],
        audioStreams: [],
        format: asset.format,
      });

      await expect(sut.handleAssetVideoEditGeneration({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/legacy_edited.mp4', '/legacy_edited.mp4.lineage.json'] },
      });
    });

    it('publishes an export master and proxy without replacing the current thumbnails', async () => {
      const videoStream = { ...probeStub.videoStreamH264.videoStream, width: 300, height: 200, rotation: 0 };
      const asset = {
        ...AssetFactory.create({ type: AssetType.Video }),
        videoStream,
        audioStream: null,
        format: probeStub.videoStreamH264.format,
        files: [],
      };
      const version = versionFor(asset, 'export');
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { accel: TranscodeHardwareAcceleration.Disabled } });
      mocks.assetJob.getForVideoConversion.mockResolvedValue(asset);
      mocks.assetEdit.getVideoVersion.mockResolvedValue(version as any);
      mocks.assetEdit.publishVideoVersion.mockResolvedValue({ published: true, releasedPaths: [] });
      mocks.media.transcode.mockResolvedValue(undefined);
      mocks.media.probe.mockResolvedValue({
        videoStreams: [{ ...videoStream, width: 200, height: 100 }],
        audioStreams: [],
        format: { ...asset.format, duration: 30 },
      });
      const thumbnails = vi.fn();
      (sut as any).generateVideoThumbnails = thumbnails;

      await expect(sut.handleAssetVideoEditGeneration({ id: asset.id, versionId: version.id })).resolves.toBe(
        JobStatus.Success,
      );

      expect(mocks.assetEdit.getVideoVersion).toHaveBeenCalledWith(asset.id, version.id);
      expect(thumbnails).not.toHaveBeenCalled();
      const [master, proxy] = [mocks.media.transcode.mock.calls[0][1], mocks.media.transcode.mock.calls[1][1]];
      expect(master).toMatch(new RegExp(String.raw`${version.id}_.+\.master\.mp4$`));
      expect(proxy).toMatch(new RegExp(String.raw`${version.id}_.+\.proxy\.mp4$`));
      expect(mocks.storage.createOrOverwriteFile).toHaveBeenCalledWith(`${master}.lineage.json`, expect.any(Buffer));
      expect(mocks.assetEdit.publishVideoVersion).toHaveBeenCalledExactlyOnceWith(
        version,
        expect.objectContaining({
          masterPath: master,
          files: [expect.objectContaining({ type: AssetFileType.EncodedVideo, path: proxy, isEdited: true })],
        }),
      );
      expect(mocks.storage.unlink).not.toHaveBeenCalled();
    });

    it.each(['save', 'export', 'revert'] as const)(
      'preserves multi-audio originals through the %s path',
      async (purpose) => {
        const videoStream = probeStub.videoStreamH264.videoStream;
        const asset = {
          ...AssetFactory.create({ type: AssetType.Video }),
          videoStream,
          audioStream: probeStub.audioStreamAac.audioStream,
          format: probeStub.videoStreamH264.format,
          files: [],
        };
        const version = {
          id: newUuid(),
          assetId: asset.id,
          ownerId: asset.ownerId,
          sourcePath: asset.originalPath,
          sourceChecksum: asset.checksum,
          recipe: purpose === 'revert' ? [] : [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }],
          purpose,
          status: 'pending',
          masterPath: null,
          proxyPath: null,
          files: [],
          createdAt: new Date(),
        };
        mocks.assetJob.getForVideoConversion.mockResolvedValue(asset);
        mocks.assetEdit.getRequestedVideoVersion.mockResolvedValue(version as any);
        mocks.assetEdit.getVideoVersion.mockResolvedValue(version as any);
        mocks.assetEdit.failVideoVersion.mockResolvedValue(undefined);
        mocks.assetEdit.publishVideoVersion.mockResolvedValue({ published: true, releasedPaths: [] });
        mocks.media.probe.mockResolvedValue({
          videoStreams: [videoStream],
          audioStreams: [
            { ...probeStub.audioStreamAac.audioStream!, index: 1 },
            { ...probeStub.audioStreamAac.audioStream!, index: 2 },
          ],
          format: asset.format,
        });
        await expect(
          sut.handleAssetVideoEditGeneration({
            id: asset.id,
            ...(purpose === 'export' && { versionId: version.id }),
          }),
        ).resolves.toBe(purpose === 'revert' ? JobStatus.Success : JobStatus.Failed);
        expect(mocks.media.probe).toHaveBeenCalledExactlyOnceWith(asset.originalPath);
        expect(mocks.media.transcode).not.toHaveBeenCalled();
        if (purpose === 'revert') {
          expect(mocks.assetEdit.failVideoVersion).not.toHaveBeenCalled();
          expect(mocks.assetEdit.publishVideoVersion).toHaveBeenCalledExactlyOnceWith(
            version,
            expect.objectContaining({ files: [], masterPath: null }),
          );
        } else {
          expect(mocks.assetEdit.failVideoVersion).toHaveBeenCalledExactlyOnceWith(asset.id, version.id);
          expect(mocks.assetEdit.publishVideoVersion).not.toHaveBeenCalled();
        }
        expect(mocks.asset.upsertFile).not.toHaveBeenCalled();
        expect(mocks.storage.unlink).not.toHaveBeenCalled();
      },
    );

    it.each(
      [true, false, 'invalid-master'].flatMap((accepted) =>
        [false, true].flatMap((copy) =>
          [
            [TranscodeHardwareAcceleration.Disabled, 'h264'],
            [TranscodeHardwareAcceleration.Nvenc, 'h264_nvenc'],
            [TranscodeHardwareAcceleration.Qsv, 'h264_qsv'],
            [TranscodeHardwareAcceleration.Vaapi, 'h264_vaapi'],
            [TranscodeHardwareAcceleration.Rkmpp, 'h264_rkmpp'],
          ].map(([accel, codec]) => ({ accepted, copy, accel: accel as TranscodeHardwareAcceleration, codec })),
        ),
      ),
    )(
      'publishes a proxy independently from the master ($accepted, copy=$copy, accel=$accel)',
      async ({ accepted, copy, accel, codec }) => {
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: { accel, accelDecode: true, targetVideoCodec: VideoCodec.H264, targetResolution: '480' },
        });
        sut.videoInterfaces = { dri: ['renderD128'], mali: true };
        const videoStream = { ...probeStub.videoStreamH264.videoStream, width: 300, height: 200, rotation: 0 };
        const asset = {
          ...AssetFactory.create({ type: AssetType.Video }),
          videoStream,
          audioStream: null,
          format: probeStub.videoStreamH264.format,
          files: [],
        };
        const version = {
          id: newUuid(),
          assetId: asset.id,
          ownerId: asset.ownerId,
          sourcePath: asset.originalPath,
          sourceChecksum: asset.checksum,
          recipe: [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }],
          purpose: 'save' as const,
          status: 'pending' as const,
          masterPath: null,
          proxyPath: null,
          files: [],
          createdAt: new Date(),
        };
        mocks.assetJob.getForVideoConversion.mockResolvedValue(asset);
        mocks.assetEdit.getRequestedVideoVersion.mockResolvedValue(version as any);
        mocks.assetEdit.publishVideoVersion.mockResolvedValue({ published: accepted === true, releasedPaths: [] });
        mocks.assetEdit.failVideoVersion.mockResolvedValue(undefined);
        mocks.media.transcode.mockResolvedValue(undefined);
        mocks.media.probe.mockResolvedValue({
          videoStreams: [
            {
              ...videoStream,
              rotation: copy ? -90 : 0,
              width: accepted === 'invalid-master' ? 301 : copy ? 300 : 200,
              height: copy ? 200 : 300,
            },
          ],
          audioStreams: [],
          format: asset.format,
        });
        mocks.media.probe.mockResolvedValueOnce({
          videoStreams: [videoStream],
          audioStreams: [],
          // A remuxable container admits the packet-preserving rotation; another one is baked.
          format: { ...asset.format, duration: 30, formatName: copy ? 'mov,mp4,m4a,3gp,3g2,mj2' : 'matroska,webm' },
        });
        mocks.storage.unlink.mockResolvedValue(undefined);
        (sut as any).generateVideoThumbnails = () =>
          Promise.resolve({
            files: [],
            thumbhash: Buffer.from('hash'),
            fullsizeDimensions: { width: 300, height: 200 },
          });
        await expect(sut.handleAssetVideoEditGeneration({ id: asset.id })).resolves.toBe(
          accepted === 'invalid-master' ? JobStatus.Failed : accepted ? JobStatus.Success : JobStatus.Skipped,
        );
        if (accepted === 'invalid-master') {
          expect(mocks.assetEdit.publishVideoVersion).not.toHaveBeenCalled();
          expect(mocks.assetEdit.failVideoVersion).toHaveBeenCalledWith(asset.id, version.id);
          expect(mocks.media.transcode).toHaveBeenCalledOnce();
          // master, its lineage sidecar and the proxy path are all released
          expect(mocks.storage.unlink).toHaveBeenCalledTimes(3);
          return;
        }
        if (copy) {
          expect(mocks.media.transcode.mock.calls[0][2].outputOptions).toContain('copy');
          const proxyCommand = mocks.media.transcode.mock.calls[1][2];
          expect(proxyCommand.outputOptions).toContain(codec);
          expect(proxyCommand.outputOptions).not.toContain('copy');
          expect(proxyCommand.inputOptions).not.toContain('-noautorotate');
          expect(proxyCommand.inputOptions).not.toContain('-hwaccel');
        }
        const master = mocks.media.transcode.mock.calls[0][1];
        const proxy = mocks.media.transcode.mock.calls[1][1];
        expect(mocks.media.transcode.mock.calls[0][0]).toBe(asset.originalPath);
        expect(mocks.media.transcode.mock.calls[1][0]).toBe(master);
        expect(master).not.toBe(proxy);
        expect(mocks.assetEdit.publishVideoVersion).toHaveBeenCalledWith(
          version,
          expect.objectContaining({
            masterPath: master,
            duration: 30_000,
            width: 200,
            height: 300,
            files: [expect.objectContaining({ type: AssetFileType.EncodedVideo, path: proxy })],
          }),
        );
        expect(mocks.storage.unlink).toHaveBeenCalledTimes(accepted ? 0 : 3);
        expect(mocks.asset.upsertFile).not.toHaveBeenCalled();
      },
    );
  });

  describe('handleVideoConversion', () => {
    let asset: ReturnType<typeof AssetFactory.create> & {
      videoStream: VideoStreamInfo & { timeBase: number };
      audioStream: AudioStreamInfo | null;
      format: VideoFormat;
    };
    beforeEach(() => {
      asset = {
        ...AssetFactory.create({ id: 'video-id', type: AssetType.Video, originalPath: '/original/path.ext' }),
        videoStream: probeStub.videoStreamH264.videoStream,
        audioStream: null,
        format: probeStub.videoStreamH264.format,
      };
      mocks.assetJob.getForVideoConversion.mockResolvedValue(asset);
      sut.videoInterfaces = { dri: ['renderD128'], mali: true };
    });

    it('should skip transcoding if asset not found', async () => {
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should transcode the highest bitrate video stream', async () => {
      mocks.logger.isLevelEnabled.mockReturnValue(false);
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.multipleVideoStreams });

      await sut.handleVideoConversion({ id: 'video-id' });

      expect(mocks.systemMetadata.get).toHaveBeenCalled();
      expect(mocks.storage.mkdirSync).toHaveBeenCalled();
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-map', '0:1', '-map', '0:3']),
          twoPass: false,
        }),
      );
    });

    it('should transcode the highest bitrate audio stream', async () => {
      mocks.logger.isLevelEnabled.mockReturnValue(false);
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.multipleAudioStreams });

      await sut.handleVideoConversion({ id: 'video-id' });

      expect(mocks.systemMetadata.get).toHaveBeenCalled();
      expect(mocks.storage.mkdirSync).toHaveBeenCalled();
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-map', '0:0', '-map', '0:2']),
          twoPass: false,
        }),
      );
    });

    it('should skip a video without any streams', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.noVideoStreams });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should skip a video without any height', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.noHeight });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should throw an error if an unknown transcode policy is configured', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.noAudioStreams });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: 'foo' } } as never as SystemConfig);

      await expect(sut.handleVideoConversion({ id: 'video-id' })).rejects.toThrowError();
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should throw an error if transcoding fails and hw acceleration is disabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.multipleVideoStreams });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { transcode: TranscodePolicy.All, accel: TranscodeHardwareAcceleration.Disabled },
      });
      mocks.media.transcode.mockRejectedValue(new Error('Error transcoding video'));

      await expect(sut.handleVideoConversion({ id: 'video-id' })).resolves.toBe(JobStatus.Failed);
      expect(mocks.media.transcode).toHaveBeenCalledTimes(1);
    });

    it('should transcode when set to all', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.multipleVideoStreams });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.All } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.any(Array),
          twoPass: false,
        }),
      );
    });

    it('should transcode when optimal and too big', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream2160p });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Optimal } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.any(Array),
          twoPass: false,
        }),
      );
    });

    it('should not transcode when policy bitrate and bitrate lower than max bitrate', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream40Mbps });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Bitrate, maxBitrate: '50M' } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should transcode when policy bitrate and bitrate higher than max bitrate', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream40Mbps });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Bitrate, maxBitrate: '30M' } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.any(Array),
          twoPass: false,
        }),
      );
    });

    it('should not transcode when max bitrate is not a number', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream40Mbps });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Bitrate, maxBitrate: 'foo' } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should not transcode when max bitrate is 0', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream40Mbps });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Bitrate, maxBitrate: '0' } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should not scale resolution if no target resolution', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream2160p });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { transcode: TranscodePolicy.All, targetResolution: 'original' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.not.arrayContaining([expect.stringContaining('scale')]),
          twoPass: false,
        }),
      );
    });

    it('should scale horizontally when video is horizontal', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream2160p });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Optimal } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([expect.stringMatching(/scale(_.+)?=-2:720/)]),
          twoPass: false,
        }),
      );
    });

    it('should scale vertically when video is vertical', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamVertical2160p });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Optimal } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([expect.stringMatching(/scale(_.+)?=720:-2/)]),
          twoPass: false,
        }),
      );
    });

    it('should always scale video if height is uneven', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamOddHeight });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { transcode: TranscodePolicy.All, targetResolution: 'original' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([expect.stringMatching(/scale(_.+)?=-2:354/)]),
          twoPass: false,
        }),
      );
    });

    it('should always scale video if width is uneven', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamOddWidth });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { transcode: TranscodePolicy.All, targetResolution: 'original' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([expect.stringMatching(/scale(_.+)?=354:-2/)]),
          twoPass: false,
        }),
      );
    });

    it('should copy video stream when video matches target', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { targetVideoCodec: VideoCodec.Hevc, acceptedAudioCodecs: [AudioCodec.Aac] },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:v', 'copy', '-c:a', 'aac']),
          twoPass: false,
        }),
      );
    });

    it('should not include hevc tag when target is hevc and video stream is copied from a different codec', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamH264 });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: {
          targetVideoCodec: VideoCodec.Hevc,
          acceptedVideoCodecs: [VideoCodec.H264, VideoCodec.Hevc],
          acceptedAudioCodecs: [AudioCodec.Aac],
        },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.not.arrayContaining(['-tag:v', 'hvc1']),
          twoPass: false,
        }),
      );
    });

    it('should include hevc tag when target is hevc and copying hevc video stream', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: {
          targetVideoCodec: VideoCodec.Hevc,
          acceptedVideoCodecs: [VideoCodec.H264, VideoCodec.Hevc],
          acceptedAudioCodecs: [AudioCodec.Aac],
        },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:v', 'copy', '-tag:v', 'hvc1']),
          twoPass: false,
        }),
      );
    });

    it('should include hevc tag when target is hevc and using hwa', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamHDR10 });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: {
          targetVideoCodec: VideoCodec.Hevc,
          accel: TranscodeHardwareAcceleration.Nvenc,
        },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:v', 'hevc_nvenc', '-tag:v', 'hvc1']),
          twoPass: false,
        }),
      );
    });

    it('should copy audio stream when audio matches target', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.audioStreamAac });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Optimal } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:v', 'h264', '-c:a', 'copy']),
          twoPass: false,
        }),
      );
    });

    it('should remux when input is not an accepted container', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamAvi });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:v', 'copy', '-c:a', 'copy']),
          twoPass: false,
        }),
      );
    });

    it('should throw an exception if transcode value is invalid', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream2160p });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: 'invalid' as any } });

      await expect(sut.handleVideoConversion({ id: 'video-id' })).rejects.toThrowError();
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should not transcode if transcoding is disabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream2160p });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Disabled } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should not remux when input is not an accepted container and transcoding is disabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Disabled } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should not transcode if target codec is invalid', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream2160p });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { targetVideoCodec: 'invalid' as any } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should delete existing transcode if current policy does not require transcoding', async () => {
      const localAsset = AssetFactory.from({ type: AssetType.Video })
        .file({ type: AssetFileType.EncodedVideo, path: '/encoded/video/path.mp4' })
        .build();
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Disabled } });
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...localAsset, ...probeStub.videoStream2160p });

      await sut.handleVideoConversion({ id: localAsset.id });

      expect(mocks.media.transcode).not.toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/encoded/video/path.mp4'] },
      });
    });

    it('should set max bitrate if above 0', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { maxBitrate: '4500k' } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:v', 'h264', '-maxrate', '4500k', '-bufsize', '9000k']),
          twoPass: false,
        }),
      );
    });

    it('should default max bitrate to kbps if no unit is provided', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { maxBitrate: '4500' } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:v', 'h264', '-maxrate', '4500k', '-bufsize', '9000k']),
          twoPass: false,
        }),
      );
    });

    it('should transcode in two passes for h264/h265 when enabled and max bitrate is above 0', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { twoPass: true, maxBitrate: '4500k' } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([
            '-c:v',
            'h264',
            '-b:v',
            '3104k',
            '-minrate',
            '1552k',
            '-maxrate',
            '4500k',
          ]),
          twoPass: true,
        }),
      );
    });

    it('should fallback to one pass for h264/h265 if two-pass is enabled but no max bitrate is set', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { twoPass: true } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:v', 'h264', '-c:a', 'copy']),
          twoPass: false,
        }),
      );
    });

    it('should transcode by bitrate in two passes for vp9 when two pass mode and max bitrate are enabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: {
          maxBitrate: '4500k',
          twoPass: true,
          targetVideoCodec: VideoCodec.Vp9,
        },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-b:v', '3104k', '-minrate', '1552k', '-maxrate', '4500k']),
          twoPass: true,
        }),
      );
    });

    it('should transcode by crf in two passes for vp9 when two pass mode is enabled and max bitrate is disabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: {
          maxBitrate: '0',
          twoPass: true,
          targetVideoCodec: VideoCodec.Vp9,
        },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.not.arrayContaining([expect.stringContaining('-maxrate')]),
          twoPass: true,
        }),
      );
    });

    it('should configure preset for vp9', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { targetVideoCodec: VideoCodec.Vp9, preset: 'slow' } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-cpu-used', '2']),
          twoPass: false,
        }),
      );
    });

    it('should not configure preset for vp9 if invalid', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { preset: 'invalid', targetVideoCodec: VideoCodec.Vp9 } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.not.arrayContaining([expect.stringContaining('-cpu-used')]),
          twoPass: false,
        }),
      );
    });

    it('should configure threads if above 0', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { targetVideoCodec: VideoCodec.Vp9, threads: 2 } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-threads', '2']),
          twoPass: false,
        }),
      );
    });

    it('should disable thread pooling for h264 if thread limit is 1', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { threads: 1 } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-threads', '1', '-x264-params', 'frame-threads=1:pools=none']),
          twoPass: false,
        }),
      );
    });

    it('should omit thread flags for h264 if thread limit is at or below 0', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { threads: 0 } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.not.arrayContaining([expect.stringContaining('-threads')]),
          twoPass: false,
        }),
      );
    });

    it('should disable thread pooling for hevc if thread limit is 1', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamVp9 });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { threads: 1, targetVideoCodec: VideoCodec.Hevc } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([
            '-c:v',
            'hevc',
            '-threads',
            '1',
            '-x265-params',
            'frame-threads=1:pools=none',
          ]),
          twoPass: false,
        }),
      );
    });

    it('should omit thread flags for hevc if thread limit is at or below 0', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamVp9 });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { threads: 0, targetVideoCodec: VideoCodec.Hevc } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.not.arrayContaining([expect.stringContaining('-threads')]),
          twoPass: false,
        }),
      );
    });

    it('should use av1 if specified', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamVp9 });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { targetVideoCodec: VideoCodec.Av1 } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([
            '-c:v',
            'libsvtav1',
            '-movflags',
            'faststart',
            '-fps_mode',
            'passthrough',
            '-map',
            '0:0',
            '-map',
            '0:3',
            '-v',
            'verbose',
            '-vf',
            'scale=-2:720',
            '-preset',
            '12',
            '-crf',
            '23',
          ]),
          twoPass: false,
        }),
      );
    });

    it('should map `veryslow` preset to 4 for av1', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamVp9 });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { targetVideoCodec: VideoCodec.Av1, preset: 'veryslow' } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-preset', '4']),
          twoPass: false,
        }),
      );
    });

    it('should set max bitrate for av1 if specified', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamVp9 });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { targetVideoCodec: VideoCodec.Av1, maxBitrate: '2M' } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-svtav1-params', 'mbr=2M']),
          twoPass: false,
        }),
      );
    });

    it('should set threads for av1 if specified', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamVp9 });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { targetVideoCodec: VideoCodec.Av1, threads: 4 } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-svtav1-params', 'lp=4']),
          twoPass: false,
        }),
      );
    });

    it('should set both bitrate and threads for av1 if specified', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamVp9 });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { targetVideoCodec: VideoCodec.Av1, threads: 4, maxBitrate: '2M' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-svtav1-params', 'lp=4:mbr=2M']),
          twoPass: false,
        }),
      );
    });

    it('should skip transcoding for audioless videos with optimal policy if video codec is correct', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.noAudioStreams });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: {
          targetVideoCodec: VideoCodec.Hevc,
          transcode: TranscodePolicy.Optimal,
          targetResolution: '1080p',
        },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    describe('should skip transcoding for accepted audio codecs with optimal policy if video is fine', () => {
      const acceptedCodecs = [
        { codec: 'aac', probeStub: probeStub.audioStreamAac },
        { codec: 'mp3', probeStub: probeStub.audioStreamMp3 },
        { codec: 'opus', probeStub: probeStub.audioStreamOpus },
      ];

      beforeEach(() => {
        mocks.systemMetadata.get.mockResolvedValue({
          ffmpeg: {
            targetVideoCodec: VideoCodec.Hevc,
            transcode: TranscodePolicy.Optimal,
            targetResolution: '1080p',
          },
        });
      });

      it.each(acceptedCodecs)('should skip $codec', async ({ probeStub: stub }) => {
        mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...stub });
        await sut.handleVideoConversion({ id: 'video-id' });
        expect(mocks.media.transcode).not.toHaveBeenCalled();
      });
    });

    it('should use libopus audio encoder when target audio is opus', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.audioStreamAac });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: {
          targetAudioCodec: AudioCodec.Opus,
          transcode: TranscodePolicy.All,
        },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:a', 'libopus']),
          twoPass: false,
        }),
      );
    });

    it('should fail if hwaccel is enabled for an unsupported codec', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Nvenc, targetVideoCodec: VideoCodec.Vp9 },
      });
      await expect(sut.handleVideoConversion({ id: 'video-id' })).rejects.toThrowError();
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should fail if hwaccel option is invalid', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { accel: 'invalid' as any } });
      await expect(sut.handleVideoConversion({ id: 'video-id' })).rejects.toThrowError();
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should set options for nvenc sw decode', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Nvenc, accelDecode: false },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining(['-init_hw_device', 'cuda=cuda:0', '-filter_hw_device', 'cuda']),
          outputOptions: expect.arrayContaining([
            '-tune',
            'hq',
            '-qmin',
            '0',
            '-rc-lookahead',
            '20',
            '-i_qfactor',
            '0.75',
            '-c:v',
            'h264_nvenc',
            '-c:a',
            'copy',
            '-movflags',
            'faststart',
            '-fps_mode',
            'passthrough',
            '-map',
            '0:0',
            '-map',
            '0:3',
            '-g',
            '256',
            '-v',
            'verbose',
            '-vf',
            'hwupload_cuda,scale_cuda=-2:720:format=nv12',
            '-preset',
            'p1',
            '-cq:v',
            '23',
          ]),
          twoPass: false,
        }),
      );
    });

    it('should set two pass options for nvenc when enabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: {
          accel: TranscodeHardwareAcceleration.Nvenc,
          maxBitrate: '10000k',
          twoPass: true,
        },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([expect.stringContaining('-multipass')]),
          twoPass: false,
        }),
      );
    });

    it('should set vbr options for nvenc when max bitrate is enabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Nvenc, maxBitrate: '10000k' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-cq:v', '23', '-maxrate', '10000k', '-bufsize', '6897k']),
          twoPass: false,
        }),
      );
    });

    it('should set cq options for nvenc when max bitrate is disabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Nvenc, maxBitrate: '10000k' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.not.stringContaining('-maxrate'),
          twoPass: false,
        }),
      );
    });

    it('should omit preset for nvenc if invalid', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Nvenc, preset: 'invalid' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.not.arrayContaining([expect.stringContaining('-preset')]),
          twoPass: false,
        }),
      );
    });

    it('should ignore two pass for nvenc if max bitrate is disabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { accel: TranscodeHardwareAcceleration.Nvenc } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.not.arrayContaining([expect.stringContaining('-multipass')]),
          twoPass: false,
        }),
      );
    });

    it('should use hardware decoding for nvenc if enabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Nvenc, accelDecode: true },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-hwaccel',
            'cuda',
            '-hwaccel_output_format',
            'cuda',
            '-noautorotate',
            '-threads',
            '1',
          ]),
          outputOptions: expect.arrayContaining([expect.stringContaining('scale_cuda=-2:720:format=nv12')]),
          twoPass: false,
        }),
      );
    });

    it('should use hardware tone-mapping for nvenc if hardware decoding is enabled and should tone map', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamHDR });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Nvenc, accelDecode: true },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining(['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']),
          outputOptions: expect.arrayContaining([
            expect.stringContaining(
              'tonemap_cuda=desat=0:matrix=bt709:primaries=bt709:range=pc:tonemap=hable:tonemap_mode=lum:transfer=bt709:peak=100:format=nv12',
            ),
          ]),
          twoPass: false,
        }),
      );
    });

    it('should set format to nv12 for nvenc if input is not yuv420p', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream10Bit });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Nvenc, accelDecode: true },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining(['-hwaccel', 'cuda', '-hwaccel_output_format', 'cuda']),
          outputOptions: expect.arrayContaining([expect.stringContaining('scale_cuda=-2:720:format=nv12')]),
          twoPass: false,
        }),
      );
    });

    it('should set options for qsv with sw decode', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Qsv, maxBitrate: '10000k', accelDecode: false },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-init_hw_device',
            'qsv=hw,child_device=/dev/dri/renderD128',
            '-filter_hw_device',
            'hw',
          ]),
          outputOptions: expect.arrayContaining([
            '-c:v',
            'h264_qsv',
            '-c:a',
            'copy',
            '-movflags',
            'faststart',
            '-fps_mode',
            'passthrough',
            '-map',
            '0:0',
            '-map',
            '0:3',
            '-bf',
            '7',
            '-refs',
            '5',
            '-g',
            '256',
            '-v',
            'verbose',
            '-vf',
            'hwupload=extra_hw_frames=64,scale_qsv=-1:720:mode=hq:format=nv12',
            '-preset',
            '7',
            '-global_quality:v',
            '23',
            '-b:v',
            '6897k',
            '-maxrate',
            '10000k',
            '-bufsize',
            '20000k',
          ]),
          twoPass: false,
        }),
      );
    });

    it('should set options for qsv with custom dri node with sw decode', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: {
          accel: TranscodeHardwareAcceleration.Qsv,
          maxBitrate: '10000k',
          preferredHwDevice: '/dev/dri/renderD128',
          accelDecode: false,
        },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-init_hw_device',
            'qsv=hw,child_device=/dev/dri/renderD128',
            '-filter_hw_device',
            'hw',
          ]),
          outputOptions: expect.any(Array),
          twoPass: false,
        }),
      );
    });

    it('should omit preset for qsv if invalid', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Qsv, preset: 'invalid' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.not.arrayContaining([expect.stringContaining('-preset')]),
          twoPass: false,
        }),
      );
    });

    it('should set low power mode for qsv if target video codec is vp9', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Qsv, targetVideoCodec: VideoCodec.Vp9 },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-low_power', '1']),
          twoPass: false,
        }),
      );
    });

    it('should fail for qsv if no hw devices', async () => {
      sut.videoInterfaces = { dri: [], mali: false };
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { accel: TranscodeHardwareAcceleration.Qsv } });

      await expect(sut.handleVideoConversion({ id: 'video-id' })).rejects.toThrowError();

      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should prefer higher index renderD* device for qsv', async () => {
      sut.videoInterfaces = { dri: ['card1', 'renderD129', 'card0', 'renderD128'], mali: false };
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { accel: TranscodeHardwareAcceleration.Qsv } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining(['-qsv_device', '/dev/dri/renderD129']),
          outputOptions: expect.arrayContaining(['-c:v', 'h264_qsv']),
          twoPass: false,
        }),
      );
    });

    it('should use hardware decoding for qsv if enabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Qsv, accelDecode: true },
      });

      await sut.handleVideoConversion({ id: 'video-id' });

      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-hwaccel',
            'qsv',
            '-hwaccel_output_format',
            'qsv',
            '-async_depth',
            '4',
            '-noautorotate',
            '-threads',
            '1',
            '-qsv_device',
            '/dev/dri/renderD128',
          ]),
          outputOptions: expect.arrayContaining([expect.stringContaining('scale_qsv=-1:720:async_depth=4:mode=hq')]),
          twoPass: false,
        }),
      );
    });

    it('should use hardware tone-mapping for qsv if hardware decoding is enabled and should tone map', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamHDR });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Qsv, accelDecode: true },
      });

      await sut.handleVideoConversion({ id: 'video-id' });

      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-hwaccel',
            'qsv',
            '-hwaccel_output_format',
            'qsv',
            '-async_depth',
            '4',
            '-threads',
            '1',
          ]),
          outputOptions: expect.arrayContaining([
            expect.stringContaining(
              'hwmap=derive_device=opencl,tonemap_opencl=desat=0:format=nv12:matrix=bt709:primaries=bt709:transfer=bt709:range=pc:tonemap=hable:tonemap_mode=lum:peak=100,hwmap=derive_device=qsv:reverse=1,format=qsv',
            ),
          ]),
          twoPass: false,
        }),
      );
    });

    it('should use preferred device for qsv when hardware decoding', async () => {
      sut.videoInterfaces = { dri: ['renderD128', 'renderD129', 'renderD130'], mali: false };
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Qsv, accelDecode: true, preferredHwDevice: 'renderD129' },
      });

      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining(['-hwaccel', 'qsv', '-qsv_device', '/dev/dri/renderD129']),
          outputOptions: expect.any(Array),
          twoPass: false,
        }),
      );
    });

    it('should set format to nv12 for qsv if input is not yuv420p', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream10Bit });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Qsv, accelDecode: true },
      });

      await sut.handleVideoConversion({ id: 'video-id' });

      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-hwaccel',
            'qsv',
            '-hwaccel_output_format',
            'qsv',
            '-async_depth',
            '4',
            '-threads',
            '1',
          ]),
          outputOptions: expect.arrayContaining([expect.stringContaining('format=nv12')]),
          twoPass: false,
        }),
      );
    });

    it('should set options for sw decode vaapi', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi, accelDecode: false },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-init_hw_device',
            'vaapi=accel:/dev/dri/renderD128',
            '-filter_hw_device',
            'accel',
          ]),
          outputOptions: expect.arrayContaining([
            '-c:v',
            'h264_vaapi',
            '-c:a',
            'copy',
            '-movflags',
            'faststart',
            '-fps_mode',
            'passthrough',
            '-map',
            '0:0',
            '-map',
            '0:3',
            '-g',
            '256',
            '-v',
            'verbose',
            '-vf',
            'hwupload=extra_hw_frames=64,scale_vaapi=-2:720:mode=hq:out_range=pc:format=nv12',
            '-compression_level',
            '7',
            '-rc_mode',
            '1',
          ]),
          twoPass: false,
        }),
      );
    });

    it('should set vbr options for vaapi when max bitrate is enabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi, maxBitrate: '10000k' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([
            '-c:v',
            'h264_vaapi',
            '-b:v',
            '6897k',
            '-maxrate',
            '10000k',
            '-minrate',
            '3448.5k',
            '-rc_mode',
            '3',
          ]),
          twoPass: false,
        }),
      );
    });

    it('should set cq options for vaapi when max bitrate is disabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([
            '-c:v',
            'h264_vaapi',
            '-c:a',
            'copy',
            '-qp:v',
            '23',
            '-global_quality:v',
            '23',
            '-rc_mode',
            '1',
          ]),
          twoPass: false,
        }),
      );
    });

    it('should omit preset for vaapi if invalid', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi, preset: 'invalid' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.not.arrayContaining([expect.stringContaining('-compression_level')]),
          twoPass: false,
        }),
      );
    });

    it('should prefer higher index renderD* device for vaapi', async () => {
      sut.videoInterfaces = { dri: ['card1', 'renderD129', 'card0', 'renderD128'], mali: false };
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining(['-hwaccel_device', '/dev/dri/renderD129']),
          outputOptions: expect.arrayContaining(['-c:v', 'h264_vaapi']),
          twoPass: false,
        }),
      );
    });

    it('should select specific gpu node if selected', async () => {
      sut.videoInterfaces = { dri: ['renderD129', 'card1', 'card0', 'renderD128'], mali: false };
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi, preferredHwDevice: '/dev/dri/renderD128' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining(['-hwaccel_device', '/dev/dri/renderD128']),
          outputOptions: expect.arrayContaining(['-c:v', 'h264_vaapi']),
          twoPass: false,
        }),
      );
    });

    it('should use hardware decoding for vaapi if enabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi, accelDecode: true },
      });

      await sut.handleVideoConversion({ id: 'video-id' });

      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-hwaccel',
            'vaapi',
            '-hwaccel_output_format',
            'vaapi',
            '-noautorotate',
            '-threads',
            '1',
            '-hwaccel_device',
            '/dev/dri/renderD128',
          ]),
          outputOptions: expect.arrayContaining([expect.stringContaining('scale_vaapi=-2:720:mode=hq:out_range=pc')]),
          twoPass: false,
        }),
      );
    });

    it('should use hardware tone-mapping for vaapi if hardware decoding is enabled and should tone map', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamHDR });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi, accelDecode: true },
      });

      await sut.handleVideoConversion({ id: 'video-id' });

      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-hwaccel',
            'vaapi',
            '-hwaccel_output_format',
            'vaapi',
            '-threads',
            '1',
          ]),
          outputOptions: expect.arrayContaining([
            expect.stringContaining(
              'hwmap=derive_device=opencl,tonemap_opencl=desat=0:format=nv12:matrix=bt709:primaries=bt709:transfer=bt709:range=pc:tonemap=hable:tonemap_mode=lum:peak=100,hwmap=derive_device=vaapi:reverse=1,format=vaapi',
            ),
          ]),
          twoPass: false,
        }),
      );
    });

    it('should set format to nv12 for vaapi if input is not yuv420p', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream10Bit });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi, accelDecode: true },
      });

      await sut.handleVideoConversion({ id: 'video-id' });

      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-hwaccel',
            'vaapi',
            '-hwaccel_output_format',
            'vaapi',
            '-threads',
            '1',
          ]),
          outputOptions: expect.arrayContaining([expect.stringContaining('format=nv12')]),
          twoPass: false,
        }),
      );
    });

    it('should use preferred device for vaapi when hardware decoding', async () => {
      sut.videoInterfaces = { dri: ['renderD128', 'renderD129', 'renderD130'], mali: false };
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi, accelDecode: true, preferredHwDevice: 'renderD129' },
      });

      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining(['-hwaccel', 'vaapi', '-hwaccel_device', '/dev/dri/renderD129']),
          outputOptions: expect.any(Array),
          twoPass: false,
        }),
      );
    });

    it('should fallback to hw encoding and sw decoding if hw transcoding fails and hw decoding is enabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi, accelDecode: true },
      });
      mocks.media.transcode.mockRejectedValueOnce(new Error('error'));
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledTimes(2);
      expect(mocks.media.transcode).toHaveBeenLastCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-init_hw_device',
            'vaapi=accel:/dev/dri/renderD128',
            '-filter_hw_device',
            'accel',
          ]),
          outputOptions: expect.arrayContaining(['-c:v', 'h264_vaapi']),
          twoPass: false,
        }),
      );
    });

    it('should fallback to sw decoding if fallback to sw decoding + hw encoding fails', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi, accelDecode: true },
      });
      mocks.media.transcode.mockRejectedValueOnce(new Error('error'));
      mocks.media.transcode.mockRejectedValueOnce(new Error('error'));
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledTimes(3);
      expect(mocks.media.transcode).toHaveBeenLastCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:v', 'h264']),
          twoPass: false,
        }),
      );
    });

    it('should fallback to sw transcoding if hw transcoding fails and hw decoding is disabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi, accelDecode: false },
      });
      mocks.media.transcode.mockRejectedValueOnce(new Error('error'));
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledTimes(2);
      expect(mocks.media.transcode).toHaveBeenLastCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:v', 'h264']),
          twoPass: false,
        }),
      );
    });

    it('should fail for vaapi if no hw devices', async () => {
      sut.videoInterfaces = { dri: [], mali: true };
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { accel: TranscodeHardwareAcceleration.Vaapi } });
      await expect(sut.handleVideoConversion({ id: 'video-id' })).rejects.toThrowError();
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('should set options for rkmpp', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Rkmpp, accelDecode: true },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-hwaccel',
            'rkmpp',
            '-hwaccel_output_format',
            'drm_prime',
            '-afbc',
            'rga',
            '-noautorotate',
          ]),
          outputOptions: expect.arrayContaining([
            '-c:v',
            'h264_rkmpp',
            '-c:a',
            'copy',
            '-movflags',
            'faststart',
            '-fps_mode',
            'passthrough',
            '-map',
            '0:0',
            '-map',
            '0:3',
            '-g',
            '256',
            '-v',
            'verbose',
            '-vf',
            'scale_rkrga=-2:720:format=nv12:afbc=1:async_depth=4',
            '-level',
            '51',
            '-rc_mode',
            'CQP',
            '-qp_init',
            '23',
          ]),
          twoPass: false,
        }),
      );
    });

    it('should set vbr options for rkmpp when max bitrate is enabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamVp9 });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: {
          accel: TranscodeHardwareAcceleration.Rkmpp,
          accelDecode: true,
          maxBitrate: '10000k',
          targetVideoCodec: VideoCodec.Hevc,
        },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-hwaccel',
            'rkmpp',
            '-hwaccel_output_format',
            'drm_prime',
            '-afbc',
            'rga',
          ]),
          outputOptions: expect.arrayContaining([
            '-c:v',
            'hevc_rkmpp',
            '-level',
            '153',
            '-rc_mode',
            'AVBR',
            '-b:v',
            '10000k',
          ]),
          twoPass: false,
        }),
      );
    });

    it('should set cqp options for rkmpp when max bitrate is disabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Rkmpp, accelDecode: true, crf: 30, maxBitrate: '0' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-hwaccel',
            'rkmpp',
            '-hwaccel_output_format',
            'drm_prime',
            '-afbc',
            'rga',
          ]),
          outputOptions: expect.arrayContaining([
            '-c:v',
            'h264_rkmpp',
            '-level',
            '51',
            '-rc_mode',
            'CQP',
            '-qp_init',
            '30',
          ]),
          twoPass: false,
        }),
      );
    });

    it('should set OpenCL tonemapping options for rkmpp when OpenCL is available', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamHDR });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Rkmpp, accelDecode: true, crf: 30, maxBitrate: '0' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-hwaccel',
            'rkmpp',
            '-hwaccel_output_format',
            'drm_prime',
            '-afbc',
            'rga',
          ]),
          outputOptions: expect.arrayContaining([
            expect.stringContaining(
              'scale_rkrga=-2:720:format=p010:afbc=1:async_depth=4,hwmap=derive_device=opencl:mode=read,tonemap_opencl=format=nv12:r=pc:p=bt709:t=bt709:m=bt709:tonemap=hable:desat=0:tonemap_mode=lum:peak=100,hwmap=derive_device=rkmpp:mode=write:reverse=1,format=drm_prime',
            ),
          ]),
          twoPass: false,
        }),
      );
    });

    it('should set hardware decoding options for rkmpp when hardware decoding is enabled with no OpenCL on non-HDR file', async () => {
      sut.videoInterfaces = { dri: ['renderD128'], mali: false };
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.noAudioStreams });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Rkmpp, accelDecode: true, crf: 30, maxBitrate: '0' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.arrayContaining([
            '-hwaccel',
            'rkmpp',
            '-hwaccel_output_format',
            'drm_prime',
            '-afbc',
            'rga',
          ]),
          outputOptions: expect.arrayContaining([
            expect.stringContaining('scale_rkrga=-2:720:format=nv12:afbc=1:async_depth=4'),
          ]),
          twoPass: false,
        }),
      );
    });

    it('should use software decoding and tone-mapping if hardware decoding is disabled', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamHDR });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Rkmpp, accelDecode: false, crf: 30, maxBitrate: '0' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: [],
          outputOptions: expect.arrayContaining([
            expect.stringContaining(
              'tonemapx=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=yuv420p',
            ),
          ]),
          twoPass: false,
        }),
      );
    });

    it('should use software tone-mapping if opencl is not available', async () => {
      sut.videoInterfaces = { dri: ['renderD128'], mali: false };
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamHDR });
      mocks.systemMetadata.get.mockResolvedValue({
        ffmpeg: { accel: TranscodeHardwareAcceleration.Rkmpp, accelDecode: true, crf: 30, maxBitrate: '0' },
      });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([
            expect.stringContaining(
              'tonemapx=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=yuv420p',
            ),
          ]),
          twoPass: false,
        }),
      );
    });

    it('should tonemap when policy is required and video is hdr', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamHDR });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Required } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([
            '-c:v',
            'h264',
            '-c:a',
            'copy',
            '-vf',
            'tonemapx=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=yuv420p',
          ]),
          twoPass: false,
        }),
      );
    });

    it('should tonemap when policy is optimal and video is hdr', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStreamHDR });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Optimal } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining([
            '-c:v',
            'h264',
            '-c:a',
            'copy',
            '-vf',
            'tonemapx=tonemap=hable:desat=0:p=bt709:t=bt709:m=bt709:r=pc:peak=100:format=yuv420p',
          ]),
          twoPass: false,
        }),
      );
    });

    it('should transcode when policy is required and video is not yuv420p', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream10Bit });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Required } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:v', 'h264', '-c:a', 'copy', '-vf', 'format=yuv420p']),
          twoPass: false,
        }),
      );
    });

    it('should convert to yuv420p when scaling without tone-mapping', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream4K10Bit });
      mocks.systemMetadata.get.mockResolvedValue({ ffmpeg: { transcode: TranscodePolicy.Required } });
      await sut.handleVideoConversion({ id: 'video-id' });
      expect(mocks.media.transcode).toHaveBeenCalledWith(
        '/original/path.ext',
        expect.any(String),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:v', 'h264', '-c:a', 'copy', '-vf', 'scale=-2:720,format=yuv420p']),
          twoPass: false,
        }),
      );
    });

    it('should count frames for progress when log level is debug', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.matroskaContainer });
      mocks.logger.isLevelEnabled.mockReturnValue(true);

      await sut.handleVideoConversion({ id: 'video-id' });

      expect(mocks.media.transcode).toHaveBeenCalledWith('/original/path.ext', expect.any(String), {
        inputOptions: expect.any(Array),
        outputOptions: expect.any(Array),
        twoPass: false,
        progress: {
          frameCount: probeStub.videoStream2160p.videoStream!.frameCount,
          percentInterval: expect.any(Number),
        },
      });
    });

    it('should not count frames for progress when log level is not debug', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.videoStream2160p });
      mocks.logger.isLevelEnabled.mockReturnValue(false);
      await sut.handleVideoConversion({ id: 'video-id' });
    });

    it('should process unknown audio stream', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({ ...asset, ...probeStub.audioStreamUnknown });
      await sut.handleVideoConversion({ id: asset.id });

      expect(mocks.media.transcode).toHaveBeenCalledWith(
        asset.originalPath,
        expect.stringContaining('video-id.mp4'),
        expect.objectContaining({
          inputOptions: expect.any(Array),
          outputOptions: expect.arrayContaining(['-c:a', 'copy']),
          twoPass: false,
        }),
      );
    });
  });

  describe('isSRGB', () => {
    it('should return true for srgb colorspace', () => {
      expect(sut.isSRGB({ colorspace: 'sRGB' } as ShallowDehydrateObject<Exif>)).toEqual(true);
    });

    it('should return true for srgb profile description', () => {
      expect(sut.isSRGB({ profileDescription: 'sRGB v1.31' } as ShallowDehydrateObject<Exif>)).toEqual(true);
    });

    it('should return true for 8-bit image with no colorspace metadata', () => {
      expect(sut.isSRGB({ bitsPerSample: 8 } as ShallowDehydrateObject<Exif>)).toEqual(true);
    });

    it('should return true for image with no colorspace or bit depth metadata', () => {
      expect(sut.isSRGB({} as Exif)).toEqual(true);
    });

    it('should return false for non-srgb colorspace', () => {
      expect(sut.isSRGB({ colorspace: 'Adobe RGB' } as ShallowDehydrateObject<Exif>)).toEqual(false);
    });

    it('should return false for non-srgb profile description', () => {
      expect(sut.isSRGB({ profileDescription: 'sP3C' } as ShallowDehydrateObject<Exif>)).toEqual(false);
    });

    it('should return false for 16-bit image with no colorspace metadata', () => {
      expect(sut.isSRGB({ bitsPerSample: 16 } as ShallowDehydrateObject<Exif>)).toEqual(false);
    });

    it('should return true for 16-bit image with sRGB colorspace', () => {
      expect(sut.isSRGB({ colorspace: 'sRGB', bitsPerSample: 16 } as ShallowDehydrateObject<Exif>)).toEqual(true);
    });

    it('should return true for 16-bit image with sRGB profile', () => {
      expect(sut.isSRGB({ profileDescription: 'sRGB', bitsPerSample: 16 } as ShallowDehydrateObject<Exif>)).toEqual(
        true,
      );
    });
  });

  describe('syncFiles', () => {
    it('should upsert new files when they do not exist', async () => {
      const asset = {
        id: 'asset-id',
        files: [],
      };

      await sut['syncFiles'](asset.files, [
        {
          assetId: asset.id,
          type: AssetFileType.Preview,
          path: '/new/preview.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
        {
          assetId: asset.id,
          type: AssetFileType.Thumbnail,
          path: '/new/thumbnail.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);

      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
        {
          assetId: 'asset-id',
          path: '/new/preview.jpg',
          type: AssetFileType.Preview,
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
        {
          assetId: 'asset-id',
          path: '/new/thumbnail.jpg',
          type: AssetFileType.Thumbnail,
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);
      expect(mocks.asset.deleteFiles).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should replace existing files with new paths', async () => {
      const asset = {
        id: 'asset-id',
        files: [
          {
            id: 'file-1',
            assetId: 'asset-id',
            type: AssetFileType.Preview,
            path: '/old/preview.jpg',
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
          },
          {
            id: 'file-2',
            assetId: 'asset-id',
            type: AssetFileType.Thumbnail,
            path: '/old/thumbnail.jpg',
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
          },
        ],
      };

      await sut['syncFiles'](asset.files, [
        {
          assetId: asset.id,
          type: AssetFileType.Preview,
          path: '/new/preview.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
        {
          assetId: asset.id,
          type: AssetFileType.Thumbnail,
          path: '/new/thumbnail.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);

      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
        {
          assetId: 'asset-id',
          path: '/new/preview.jpg',
          type: AssetFileType.Preview,
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
        {
          assetId: 'asset-id',
          path: '/new/thumbnail.jpg',
          type: AssetFileType.Thumbnail,
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);
      expect(mocks.asset.deleteFiles).not.toHaveBeenCalled();
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/old/preview.jpg', '/old/thumbnail.jpg'] },
      });
    });

    it('should delete files when newPath is not provided', async () => {
      const asset = {
        id: 'asset-id',
        files: [
          {
            id: 'file-1',
            assetId: 'asset-id',
            type: AssetFileType.Preview,
            path: '/old/preview.jpg',
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
          },
          {
            id: 'file-2',
            assetId: 'asset-id',
            type: AssetFileType.Thumbnail,
            path: '/old/thumbnail.jpg',
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
          },
        ],
      };

      await sut['syncFiles'](asset.files, []);

      expect(mocks.asset.upsertFiles).not.toHaveBeenCalled();
      expect(mocks.asset.deleteFiles).toHaveBeenCalledWith([
        {
          id: 'file-1',
          assetId: 'asset-id',
          type: AssetFileType.Preview,
          path: '/old/preview.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
        {
          id: 'file-2',
          assetId: 'asset-id',
          type: AssetFileType.Thumbnail,
          path: '/old/thumbnail.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/old/preview.jpg', '/old/thumbnail.jpg'] },
      });
    });

    it('should not make changes when file paths already match', async () => {
      const asset = {
        id: 'asset-id',
        files: [
          {
            id: 'file-1',
            assetId: 'asset-id',
            type: AssetFileType.Preview,
            path: '/same/preview.jpg',
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
          },
          {
            id: 'file-2',
            assetId: 'asset-id',
            type: AssetFileType.Thumbnail,
            path: '/same/thumbnail.jpg',
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
          },
        ],
      };

      await sut['syncFiles'](asset.files, [
        {
          assetId: asset.id,
          type: AssetFileType.Preview,
          path: '/same/preview.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
        {
          assetId: asset.id,
          type: AssetFileType.Thumbnail,
          path: '/same/thumbnail.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);

      expect(mocks.asset.upsertFiles).not.toHaveBeenCalled();
      expect(mocks.asset.deleteFiles).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should handle mixed operations (upsert, replace, delete)', async () => {
      const asset = {
        id: 'asset-id',
        files: [
          {
            id: 'file-1',
            assetId: 'asset-id',
            type: AssetFileType.Preview,
            path: '/old/preview.jpg',
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
          },
          {
            id: 'file-2',
            assetId: 'asset-id',
            type: AssetFileType.Thumbnail,
            path: '/old/thumbnail.jpg',
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
          },
        ],
      };

      await sut['syncFiles'](asset.files, [
        {
          assetId: asset.id,
          type: AssetFileType.Preview,
          path: '/new/preview.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        }, // replace
        {
          assetId: asset.id,
          type: AssetFileType.FullSize,
          path: '/new/fullsize.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        }, // new
      ]);

      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
        {
          assetId: 'asset-id',
          path: '/new/preview.jpg',
          type: AssetFileType.Preview,
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
        {
          assetId: 'asset-id',
          path: '/new/fullsize.jpg',
          type: AssetFileType.FullSize,
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);
      expect(mocks.asset.deleteFiles).toHaveBeenCalledWith([
        {
          id: 'file-2',
          assetId: 'asset-id',
          type: AssetFileType.Thumbnail,
          path: '/old/thumbnail.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/old/preview.jpg', '/old/thumbnail.jpg'] },
      });
    });

    it('should handle empty file list', async () => {
      const asset = {
        id: 'asset-id',
        files: [],
      };

      await sut['syncFiles'](asset.files, []);

      expect(mocks.asset.upsertFiles).not.toHaveBeenCalled();
      expect(mocks.asset.deleteFiles).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('should delete non-existent file types when newPath is not provided', async () => {
      const asset = {
        id: 'asset-id',
        files: [
          {
            id: 'file-1',
            assetId: 'asset-id',
            type: AssetFileType.Preview,
            path: '/old/preview.jpg',
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
          },
        ],
      };

      await sut['syncFiles'](asset.files, []);

      expect(mocks.asset.upsertFiles).not.toHaveBeenCalled();
      expect(mocks.asset.deleteFiles).toHaveBeenCalledWith([
        {
          id: 'file-1',
          assetId: 'asset-id',
          type: AssetFileType.Preview,
          path: '/old/preview.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.FileDelete,
        data: { files: ['/old/preview.jpg'] },
      });
    });

    it('should update database when isProgressive changes', async () => {
      const asset = {
        id: 'asset-id',
        files: [
          {
            id: 'file-1',
            assetId: 'asset-id',
            type: AssetFileType.Preview,
            path: '/old/preview.jpg',
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
          },
          {
            id: 'file-2',
            assetId: 'asset-id',
            type: AssetFileType.Thumbnail,
            path: '/old/thumbnail.jpg',
            isEdited: false,
            isProgressive: false,
            isTransparent: false,
          },
        ],
      };

      await sut['syncFiles'](asset.files, [
        {
          assetId: asset.id,
          type: AssetFileType.Preview,
          path: '/old/preview.jpg',
          isEdited: false,
          isProgressive: true,
          isTransparent: false,
        },
        {
          assetId: asset.id,
          type: AssetFileType.Thumbnail,
          path: '/old/thumbnail.jpg',
          isEdited: false,
          isProgressive: false,
          isTransparent: false,
        },
      ]);

      expect(mocks.asset.upsertFiles).toHaveBeenCalledWith([
        {
          assetId: 'asset-id',
          path: '/old/preview.jpg',
          type: AssetFileType.Preview,
          isEdited: false,
          isProgressive: true,
          isTransparent: false,
        },
      ]);
      expect(mocks.asset.deleteFiles).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });
  });
});
