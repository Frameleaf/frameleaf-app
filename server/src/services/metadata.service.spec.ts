import { BinaryField, ExifDateTime } from 'exiftool-vendored';
import { DateTime } from 'luxon';
import { randomBytes } from 'node:crypto';
import { Stats } from 'node:fs';
import type { LockableProperty } from 'src/database.js';
import type { QueueExecution } from 'src/queue/types.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { defaults } from 'src/dtos/config.dto.js';
import {
  AssetFileType,
  AssetType,
  AssetVisibility,
  ChecksumAlgorithm,
  ExifOrientation,
  ImmichWorker,
  JobName,
  JobStatus,
  SourceType,
  StorageFolder,
} from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { ImmichTags } from 'src/repositories/metadata.repository.js';
import { MetadataService, firstDateTime } from 'src/services/metadata.service.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { PersonGroupFactory } from 'test/factories/person-group.factory.js';
import { PersonFactory } from 'test/factories/person.factory.js';
import { videoInfoStub } from 'test/fixtures/media.stub.js';
import { tagStub } from 'test/fixtures/tag.stub.js';
import { getForMetadataExtraction, getForSidecarWrite } from 'test/mappers.js';
import { factory } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const forSidecarJob = (
  asset: {
    id?: string;
    ownerId?: string;
    originalPath?: string;
    physicalOriginalFileId?: string | null;
    files?: { id: string; type: AssetFileType; path: string; physicalFileId?: string | null; isEdited: boolean }[];
  } = {},
) => {
  const files = asset.files?.map((file) => ({ ...file, physicalFileId: file.physicalFileId ?? null })) ?? [];

  return {
    id: factory.uuid(),
    ownerId: factory.uuid(),
    originalPath: '/path/to/IMG_123.jpg',
    physicalOriginalFileId: null,
    ...asset,
    files,
  };
};

const makeFaceTags = (
  face: Partial<{ Name: string }> = {},
  orientation?: ImmichTags['Orientation'],
): Partial<ImmichTags> => ({
  Orientation: orientation,
  RegionInfo: {
    AppliedToDimensions: { W: 1000, H: 100, Unit: 'pixel' },
    RegionList: [
      {
        Type: 'face',
        Area: {
          X: 0.1,
          Y: 0.4,
          W: 0.2,
          H: 0.4,
          Unit: 'normalized',
        },
        ...face,
      },
    ],
  },
});

const emptyPackets = {
  totalDuration: 0,
  packetCount: 0,
  outputFrames: 0,
  keyframePts: [],
  keyframeAccDuration: [],
  keyframeOwnDuration: [],
};

describe(MetadataService.name, () => {
  let sut: MetadataService;
  let mocks: ServiceMocks;

  const mockReadTags = (exifData?: Partial<ImmichTags>, sidecarData?: Partial<ImmichTags>) => {
    mocks.metadata.readTags.mockReset();
    mocks.metadata.readTags.mockResolvedValueOnce(exifData ?? {});
    mocks.metadata.readTags.mockResolvedValueOnce(sidecarData ?? {});
  };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(MetadataService));

    mockReadTags();
    mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue([]);

    mocks.config.getWorker.mockReturnValue(ImmichWorker.Microservices);

    delete process.env.TZ;
  });

  afterEach(async () => {
    await sut.onShutdown();
  });

  it('should be defined', () => {
    expect(sut).toBeDefined();
  });

  describe('onBootstrapEvent', () => {
    it('should pause and resume queue during init', async () => {
      mocks.job.pause.mockResolvedValue();
      mocks.map.init.mockResolvedValue();
      mocks.job.resume.mockResolvedValue();

      await sut.onBootstrap();

      expect(mocks.job.pause).toHaveBeenCalledTimes(1);
      expect(mocks.map.init).toHaveBeenCalledTimes(1);
      expect(mocks.job.resume).toHaveBeenCalledTimes(1);
    });
  });

  describe('onConfigInit', () => {
    it('should update metadata processing concurrency', () => {
      sut.onConfigInit({ newConfig: defaults });

      expect(mocks.metadata.setMaxConcurrency).toHaveBeenCalledWith(defaults.job.metadataExtraction.concurrency);
      expect(mocks.metadata.setMaxConcurrency).toHaveBeenCalledTimes(1);
    });
  });

  describe('onConfigUpdate', () => {
    it('should update metadata processing concurrency', () => {
      const newConfig = structuredClone(defaults);
      newConfig.job.metadataExtraction.concurrency = 10;

      sut.onConfigUpdate({ oldConfig: defaults, newConfig });

      expect(mocks.metadata.setMaxConcurrency).toHaveBeenCalledWith(newConfig.job.metadataExtraction.concurrency);
      expect(mocks.metadata.setMaxConcurrency).toHaveBeenCalledTimes(1);
    });
  });

  describe('handleQueueMetadataExtraction', () => {
    it('should queue metadata extraction for all assets without exif values', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.selectionForMetadataExtraction.mockReturnValue({ selected: [asset] } as never);

      await expect(sut.handleQueueMetadataExtraction({ force: false })).resolves.toBe(JobStatus.Success);
      expect(mocks.assetJob.selectionForMetadataExtraction).toHaveBeenCalledWith(false);
      expect(mocks.job.queueSelection).toHaveBeenCalledWith(
        JobName.AssetExtractMetadata,
        mocks.assetJob.selectionForMetadataExtraction.mock.results[0].value,
      );
    });

    it('should queue metadata extraction for all assets', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.selectionForMetadataExtraction.mockReturnValue({ selected: [asset] } as never);

      await expect(sut.handleQueueMetadataExtraction({ force: true })).resolves.toBe(JobStatus.Success);
      expect(mocks.assetJob.selectionForMetadataExtraction).toHaveBeenCalledWith(true);
      expect(mocks.job.queueSelection).toHaveBeenCalledWith(
        JobName.AssetExtractMetadata,
        mocks.assetJob.selectionForMetadataExtraction.mock.results[0].value,
      );
    });
  });

  describe('handleMetadataExtraction', () => {
    it.each(['motion-photo', 'upload', 'copy'] as const)(
      'publishes the requested motion encode only after accepting metadata (%s)',
      async (source) => {
        const asset = AssetFactory.create({ type: AssetType.Video, visibility: AssetVisibility.Hidden });
        mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
        mocks.media.probe.mockResolvedValue(videoInfoStub.videoStreamHDR10);
        mocks.media.probePackets.mockResolvedValue(emptyPackets);
        await sut.handleMetadataExtraction({ id: asset.id, source });
        if (source === 'motion-photo') {
          expect(mocks.job.queue).toHaveBeenCalledExactlyOnceWith({
            name: JobName.AssetEncodeVideo,
            data: { id: asset.id },
          });
          expect(mocks.asset.upsertExif.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.job.queue.mock.invocationCallOrder[0],
          );
          expect(mocks.asset.upsertJobStatus.mock.invocationCallOrder[0]).toBeLessThan(
            mocks.job.queue.mock.invocationCallOrder[0],
          );
        } else {
          expect(mocks.job.queue).not.toHaveBeenCalled();
        }
      },
    );

    it('does not release a motion encode when metadata persistence fails', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video, visibility: AssetVisibility.Hidden });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue(videoInfoStub.videoStreamHDR10);
      mocks.media.probePackets.mockResolvedValue(emptyPackets);
      mocks.asset.upsertExif.mockRejectedValue(new Error('metadata persistence failed'));
      await expect(sut.handleMetadataExtraction({ id: asset.id, source: 'motion-photo' })).rejects.toThrow(
        'metadata persistence failed',
      );
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('prepares metadata without mutation and rejects a source replaced before adoption', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ Make: 'Camera' });
      const execution: QueueExecution = {
        claim: {
          id: 'claim',
          token: 'token',
          name: 'fixture',
          queue: 'fixture',
          workerId: 'worker',
          attempt: 1,
          runId: null,
          itemKey: null,
          deadlineMs: 600_000,
          startedAt: new Date(),
          data: {},
        },
        signal: new AbortController().signal,
        progress: vi.fn(),
        progressUnits: 0,
        adoptions: [],
        followups: [],
        buffering: false,
      };
      await queueExecution.run(execution, () => sut.handleMetadataExtraction({ id: asset.id }));
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.asset.upsertJobStatus).not.toHaveBeenCalled();
      expect(execution.adoptions).toHaveLength(1);
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(
        getForMetadataExtraction({ ...asset, checksum: Buffer.from('replacement') }),
      );
      await expect(execution.adoptions[0]({} as never)).rejects.toThrow('Metadata source changed');
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
    });

    it.each(['original', 'sidecar'])('rejects a failed %s read before destructive effects', async (source) => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Sidecar }).build();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.metadata.readTags.mockReset();
      const failure = new Error('file read failed');
      if (source === 'sidecar') {
        mocks.metadata.readTags.mockResolvedValueOnce({});
      }
      mocks.metadata.readTags.mockRejectedValueOnce(failure);
      await expect(sut.handleMetadataExtraction({ id: asset.id })).rejects.toBe(failure);
      expect(mocks.asset.update).not.toHaveBeenCalled();
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.asset.upsertJobStatus).not.toHaveBeenCalled();
      expect(mocks.tag.removeAssetTagValues).not.toHaveBeenCalled();
      expect(mocks.metadata.readJpegSignature).not.toHaveBeenCalled();
      expect(mocks.event.emit).not.toHaveBeenCalled();
    });

    it.each([
      { type: AssetType.Image, tags: { FileType: 'JPEG' }, locks: [], eligible: true },
      { type: AssetType.Image, tags: { FileType: 'PNG' }, locks: [], eligible: false },
      { type: AssetType.Video, tags: { FileType: 'JPEG' }, locks: [], eligible: false },
      { type: AssetType.Image, tags: { FileType: 'JPEG', Make: 'Recorded' }, locks: [], eligible: false },
      { type: AssetType.Image, tags: { FileType: 'JPEG' }, locks: ['model'], eligible: false },
      { type: AssetType.Image, tags: {}, locks: [], eligible: false },
    ])('bounds JPEG clues to eligible originals: %j', async ({ type, tags, locks, eligible }) => {
      const asset = AssetFactory.create({ type });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      // Simulate persisted varchar[] camera locks beyond the public editable-property union.
      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue(locks as unknown as LockableProperty[]);
      mockReadTags(tags);
      mocks.media.probe.mockResolvedValue(videoInfoStub.noVideoStreams);
      mocks.metadata.readJpegSignature.mockResolvedValue({
        method: 'jpeg-signature',
        signature: 'digest',
        matches: 'Camera A, Camera B or editor',
      });
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.metadata.readJpegSignature).toHaveBeenCalledTimes(eligible ? 1 : 0);
      if (eligible) {
        expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
          expect.objectContaining({
            exif: expect.objectContaining({ make: null, model: null }),
            cameraEvidence: expect.objectContaining({
              recorded: null,
              suggestion: expect.objectContaining({ matches: 'Camera A, Camera B or editor' }),
            }),
          }),
        );
      }
    });

    it('does not fingerprint sidecar identity or replace camera-locked evidence', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Sidecar }).build();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ FileType: 'JPEG' }, { Model: 'Recorded sidecar' });
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.metadata.readJpegSignature).not.toHaveBeenCalled();
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({ exif: expect.objectContaining({ model: 'Recorded sidecar' }) }),
      );
      // This mock represents a database row, not an owner-edit API request.
      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue([
        'make',
      ] as unknown as LockableProperty[]);
      mockReadTags({ FileType: 'JPEG' });
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif.mock.calls.at(-1)?.[0].cameraEvidence).toBeUndefined();
    });

    it.each([null, { method: 'jpeg-signature' as const, signature: 'unknown', matches: null }])(
      'keeps unknown or missing clues separate from identity',
      async (suggestion) => {
        const asset = AssetFactory.create();
        mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
        mockReadTags({ FileType: 'JPEG' });
        mocks.metadata.readJpegSignature.mockResolvedValue(suggestion);
        await sut.handleMetadataExtraction({ id: asset.id });
        expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
          expect.objectContaining({
            exif: expect.objectContaining({ make: null, model: null }),
            cameraEvidence: expect.objectContaining({ suggestion }),
          }),
        );
      },
    );

    it('keeps valid extraction when optional fingerprinting fails', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ FileType: 'JPEG', ImageWidth: 10 });
      mocks.metadata.readJpegSignature.mockRejectedValue(new Error('optional read failed'));
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({ exifImageWidth: 10 }),
          cameraEvidence: expect.objectContaining({ suggestion: null }),
        }),
      );
    });

    it.each(['', ' '.repeat(3), '----', 'Unknown (0)', 'n/a', ' N/A '])(
      'uses LensModel after an unusable earlier lens: %s',
      async (LensID) => {
        const asset = AssetFactory.create();
        mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
        mockReadTags({ LensID, LensModel: ' Recorded lens ' });
        await sut.handleMetadataExtraction({ id: asset.id });
        expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
          expect.objectContaining({ exif: expect.objectContaining({ lensModel: 'Recorded lens' }) }),
        );
      },
    );

    it('stores no lens when every lens candidate is a placeholder', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ LensID: 'n/a', LensType: ' N/A ', LensSpec: '----', LensModel: 'Unknown (0)' });
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({ exif: expect.objectContaining({ lensModel: null }) }),
      );
    });

    it.each([
      [-1, -1],
      [0, null],
      [1, 1],
      [5, 5],
      [6, null],
      [-2, null],
      [1.5, null],
      ['3', null],
      [NaN, null],
    ])('imports rating %s as %s', async (Rating, rating) => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ Rating } as ImmichTags);
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({ exif: expect.objectContaining({ rating }) }),
      );
    });

    beforeEach(() => {
      const time = new Date('2022-01-01T00:00:00.000Z');
      const timeMs = time.valueOf();
      mocks.storage.stat.mockResolvedValue({
        size: 123_456,
        mtime: time,
        mtimeMs: timeMs,
        birthtimeMs: timeMs,
      } as Stats);
    });

    it('should handle an asset that could not be found', async () => {
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(void 0);

      await sut.handleMetadataExtraction({ id: 'non-existent' });

      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith('non-existent');
      expect(mocks.asset.upsertExif).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('should handle a date in a sidecar file', async () => {
      const originalDate = new Date('2023-11-21T16:13:17.517Z');
      const sidecarDate = new Date('2022-01-01T00:00:00.000Z');
      const asset = AssetFactory.from().file({ type: AssetFileType.Sidecar }).build();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ CreationDate: originalDate.toISOString() }, { CreationDate: sidecarDate.toISOString() });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({ dateTimeOriginal: sidecarDate }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
      expect(mocks.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: asset.id,
          duration: null,
          fileCreatedAt: sidecarDate,
          localDateTime: sidecarDate,
        }),
      );
    });

    it('should take the file modification date when missing exif and earlier than creation date', async () => {
      const fileCreatedAt = new Date('2022-01-01T00:00:00.000Z');
      const fileModifiedAt = new Date('2021-01-01T00:00:00.000Z');
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.storage.stat.mockResolvedValue({
        size: 123_456,
        mtime: fileModifiedAt,
        mtimeMs: fileModifiedAt.valueOf(),
        birthtimeMs: fileCreatedAt.valueOf(),
      } as Stats);
      mockReadTags();

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({ dateTimeOriginal: fileModifiedAt }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: asset.id,
        duration: null,
        fileCreatedAt: fileModifiedAt,
        fileModifiedAt,
        localDateTime: fileModifiedAt,
        width: null,
        height: null,
      });
    });

    it('should take the file creation date when missing exif and earlier than modification date', async () => {
      const fileCreatedAt = new Date('2021-01-01T00:00:00.000Z');
      const fileModifiedAt = new Date('2022-01-01T00:00:00.000Z');
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.storage.stat.mockResolvedValue({
        size: 123_456,
        mtime: fileModifiedAt,
        mtimeMs: fileModifiedAt.valueOf(),
        birthtimeMs: fileCreatedAt.valueOf(),
      } as Stats);
      mockReadTags();

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({ dateTimeOriginal: fileCreatedAt }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: asset.id,
        duration: null,
        fileCreatedAt,
        fileModifiedAt,
        localDateTime: fileCreatedAt,
        width: null,
        height: null,
      });
    });

    it('should determine dateTimeOriginal regardless of the server time zone', async () => {
      process.env.TZ = 'America/Los_Angeles';
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ DateTimeOriginal: '2022:01:01 00:00:00' });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({
            dateTimeOriginal: new Date('2022-01-01T00:00:00.000Z'),
          }),
          lockedPropertiesBehavior: 'skip',
        }),
      );

      expect(mocks.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          localDateTime: new Date('2022-01-01T00:00:00.000Z'),
        }),
      );
    });

    it('should handle lists of numbers', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.storage.stat.mockResolvedValue({
        size: 123_456,
        mtime: asset.fileModifiedAt,
        mtimeMs: asset.fileModifiedAt.valueOf(),
        birthtimeMs: asset.fileCreatedAt.valueOf(),
      } as Stats);
      mockReadTags({ ISO: [160] });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({ iso: 160 }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: asset.id,
        duration: null,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        localDateTime: asset.fileCreatedAt,
        width: null,
        height: null,
      });
    });

    it('should not delete latituide and longitude without reverse geocode', async () => {
      // regression test for issue 17511
      const asset = AssetFactory.from().exif().build();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.systemMetadata.get.mockResolvedValue({ reverseGeocoding: { enabled: false } });
      mocks.storage.stat.mockResolvedValue({
        size: 123_456,
        mtime: asset.fileModifiedAt,
        mtimeMs: asset.fileModifiedAt.valueOf(),
        birthtimeMs: asset.fileCreatedAt.valueOf(),
      } as Stats);
      mockReadTags({
        GPSLatitude: asset.exifInfo.latitude!,
        GPSLongitude: asset.exifInfo.longitude!,
      });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({ city: null, state: null, country: null }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: asset.id,
        duration: null,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        localDateTime: asset.fileCreatedAt,
        width: null,
        height: null,
      });
    });

    it('should apply reverse geocoding', async () => {
      const asset = AssetFactory.from().exif({ latitude: 10, longitude: 20 }).build();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.systemMetadata.get.mockResolvedValue({ reverseGeocoding: { enabled: true } });
      mocks.map.reverseGeocode.mockResolvedValue({ city: 'City', state: 'State', country: 'Country' });
      mocks.storage.stat.mockResolvedValue({
        size: 123_456,
        mtime: asset.fileModifiedAt,
        mtimeMs: asset.fileModifiedAt.valueOf(),
        birthtimeMs: asset.fileCreatedAt.valueOf(),
      } as Stats);
      mockReadTags({ GPSLatitude: 10, GPSLongitude: 20 });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({ city: 'City', state: 'State', country: 'Country' }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: asset.id,
        duration: null,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        localDateTime: asset.fileCreatedAt,
        width: null,
        height: null,
      });
    });

    it('keeps a location the owner removed or set instead of reading the file coordinates (FL-51)', async () => {
      const asset = AssetFactory.from().exif({ latitude: null, longitude: null }).build();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue(['latitude', 'longitude']);
      mocks.systemMetadata.get.mockResolvedValue({ reverseGeocoding: { enabled: true } });
      mocks.storage.stat.mockResolvedValue({
        size: 123_456,
        mtime: asset.fileModifiedAt,
        mtimeMs: asset.fileModifiedAt.valueOf(),
        birthtimeMs: asset.fileCreatedAt.valueOf(),
      } as Stats);
      mockReadTags({ GPSLatitude: 10, GPSLongitude: 20 });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.map.reverseGeocode).not.toHaveBeenCalled();
      const [{ exif }] = mocks.asset.upsertExif.mock.calls.at(-1)!;
      expect(exif).not.toHaveProperty('city');
      expect(exif).not.toHaveProperty('state');
      expect(exif).not.toHaveProperty('country');
    });

    it('should discard latitude and longitude on null island', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({
        GPSLatitude: 0,
        GPSLongitude: 0,
      });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({ latitude: null, longitude: null }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
    });

    it('should extract tags from TagsList', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.getForMetadataExtractionTags.mockResolvedValue({
        tags: ['Parent'],
        updateId: '00000000-0000-0000-0000-000000000001',
      });
      mockReadTags({ TagsList: ['Parent'] });
      mocks.tag.upsertValue.mockResolvedValue(tagStub.parentUpsert);

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.tag.upsertValue).toHaveBeenCalledWith({ userId: asset.ownerId, value: 'Parent', parent: undefined });
    });

    it('should extract hierarchy from TagsList', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.getForMetadataExtractionTags.mockResolvedValue({
        tags: ['Parent/Child'],
        updateId: '00000000-0000-0000-0000-000000000001',
      });
      mockReadTags({ TagsList: ['Parent/Child'] });
      mocks.tag.upsertValue.mockResolvedValueOnce(tagStub.parentUpsert);
      mocks.tag.upsertValue.mockResolvedValueOnce(tagStub.childUpsert);

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(1, {
        userId: asset.ownerId,
        value: 'Parent',
        parentId: undefined,
      });
      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(2, {
        userId: asset.ownerId,
        value: 'Parent/Child',
        parentId: 'tag-parent',
      });
    });

    it('should extract tags from Keywords as a string', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.getForMetadataExtractionTags.mockResolvedValue({
        tags: ['Parent'],
        updateId: '00000000-0000-0000-0000-000000000001',
      });
      mockReadTags({ Keywords: 'Parent' });
      mocks.tag.upsertValue.mockResolvedValue(tagStub.parentUpsert);

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.tag.upsertValue).toHaveBeenCalledWith({ userId: asset.ownerId, value: 'Parent', parent: undefined });
    });

    it('should extract tags from Keywords as a list', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.getForMetadataExtractionTags.mockResolvedValue({
        tags: ['Parent'],
        updateId: '00000000-0000-0000-0000-000000000001',
      });
      mockReadTags({ Keywords: ['Parent'] });
      mocks.tag.upsertValue.mockResolvedValue(tagStub.parentUpsert);

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.tag.upsertValue).toHaveBeenCalledWith({ userId: asset.ownerId, value: 'Parent', parent: undefined });
    });

    it('should extract tags from Keywords as a list with a number', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.getForMetadataExtractionTags.mockResolvedValue({
        tags: ['Parent', '2024'],
        updateId: '00000000-0000-0000-0000-000000000001',
      });
      mockReadTags({ Keywords: ['Parent', 2024] });
      mocks.tag.upsertValue.mockResolvedValue(tagStub.parentUpsert);

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.tag.upsertValue).toHaveBeenCalledWith({ userId: asset.ownerId, value: 'Parent', parent: undefined });
      expect(mocks.tag.upsertValue).toHaveBeenCalledWith({ userId: asset.ownerId, value: '2024', parent: undefined });
    });

    it('should extract hierarchal tags from Keywords', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.getForMetadataExtractionTags.mockResolvedValue({
        tags: ['Parent/Child'],
        updateId: '00000000-0000-0000-0000-000000000001',
      });
      mockReadTags({ Keywords: 'Parent/Child' });
      mocks.tag.upsertValue.mockResolvedValue(tagStub.parentUpsert);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(1, {
        userId: asset.ownerId,
        value: 'Parent',
        parentId: undefined,
      });
      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(2, {
        userId: asset.ownerId,
        value: 'Parent/Child',
        parentId: 'tag-parent',
      });
    });

    it('should ignore Keywords when TagsList is present', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.getForMetadataExtractionTags.mockResolvedValue({
        tags: ['Parent/Child', 'Child'],
        updateId: '00000000-0000-0000-0000-000000000001',
      });
      mockReadTags({ Keywords: 'Child', TagsList: ['Parent/Child'] });
      mocks.tag.upsertValue.mockResolvedValue(tagStub.parentUpsert);

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(1, {
        userId: asset.ownerId,
        value: 'Parent',
        parentId: undefined,
      });
      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(2, {
        userId: asset.ownerId,
        value: 'Parent/Child',
        parentId: 'tag-parent',
      });
    });

    it('should extract hierarchy from HierarchicalSubject', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.getForMetadataExtractionTags.mockResolvedValue({
        tags: ['Parent/Child', 'TagA'],
        updateId: '00000000-0000-0000-0000-000000000001',
      });
      mockReadTags({ HierarchicalSubject: ['Parent|Child', 'TagA'] });
      mocks.tag.upsertValue.mockResolvedValueOnce(tagStub.parentUpsert);
      mocks.tag.upsertValue.mockResolvedValueOnce(tagStub.childUpsert);

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(1, {
        userId: asset.ownerId,
        value: 'Parent',
        parentId: undefined,
      });
      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(2, {
        userId: asset.ownerId,
        value: 'Parent/Child',
        parentId: 'tag-parent',
      });
      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(3, {
        userId: asset.ownerId,
        value: 'TagA',
        parent: undefined,
      });
    });

    it('should extract tags from HierarchicalSubject as a list with a number', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.getForMetadataExtractionTags.mockResolvedValue({
        tags: ['Parent', '2024'],
        updateId: '00000000-0000-0000-0000-000000000001',
      });
      mockReadTags({ HierarchicalSubject: ['Parent', 2024] });
      mocks.tag.upsertValue.mockResolvedValue(tagStub.parentUpsert);

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.tag.upsertValue).toHaveBeenCalledWith({ userId: asset.ownerId, value: 'Parent', parent: undefined });
      expect(mocks.tag.upsertValue).toHaveBeenCalledWith({ userId: asset.ownerId, value: '2024', parent: undefined });
    });

    it('should extract ignore / characters in a HierarchicalSubject tag', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.getForMetadataExtractionTags.mockResolvedValue({
        tags: ['Mom|Dad'],
        updateId: '00000000-0000-0000-0000-000000000001',
      });
      mockReadTags({ HierarchicalSubject: ['Mom/Dad'] });
      mocks.tag.upsertValue.mockResolvedValueOnce(tagStub.parentUpsert);

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.tag.upsertValue).toHaveBeenCalledWith({
        userId: asset.ownerId,
        value: 'Mom|Dad',
        parent: undefined,
      });
    });

    it('should ignore HierarchicalSubject when TagsList is present', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.getForMetadataExtractionTags.mockResolvedValue({
        tags: ['Parent/Child', 'Parent2/Child2'],
        updateId: '00000000-0000-0000-0000-000000000001',
      });
      mockReadTags({ HierarchicalSubject: ['Parent2|Child2'], TagsList: ['Parent/Child'] });
      mocks.tag.upsertValue.mockResolvedValue(tagStub.parentUpsert);

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(1, {
        userId: asset.ownerId,
        value: 'Parent',
        parentId: undefined,
      });
      expect(mocks.tag.upsertValue).toHaveBeenNthCalledWith(2, {
        userId: asset.ownerId,
        value: 'Parent/Child',
        parentId: 'tag-parent',
      });
    });

    it('should remove the tags the file no longer lists', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.getForMetadataExtractionTags
        .mockResolvedValueOnce({ tags: ['Parent/Child', 'Kept'], updateId: '00000000-0000-0000-0000-000000000001' })
        .mockResolvedValueOnce({ tags: ['Kept'], updateId: '00000000-0000-0000-0000-000000000001' });
      mockReadTags({ TagsList: ['Kept'] });
      mocks.tag.upsertValue.mockResolvedValue(tagStub.parentUpsert);

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.tag.removeAssetTagValues).toHaveBeenCalledWith(asset.id, asset.ownerId, ['Parent/Child']);
      expect(mocks.tag.upsertAssetIds).toHaveBeenCalledWith([{ tagId: tagStub.parentUpsert.id, assetId: asset.id }]);
      expect(mocks.tag.replaceAssetTags).not.toHaveBeenCalled();
    });

    it('should keep a tag added while the file was read', async () => {
      // A tag added through the API is on the asset but was never in the file's list, so the
      // extraction that races it has nothing of its own to remove.
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({});

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.tag.removeAssetTagValues).toHaveBeenCalledWith(asset.id, asset.ownerId, []);
      expect(mocks.tag.upsertAssetIds).toHaveBeenCalledWith([]);
      expect(mocks.tag.replaceAssetTags).not.toHaveBeenCalled();
    });

    it('should not apply motion photos if asset is video', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue(videoInfoStub.matroskaContainer);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.storage.createOrOverwriteFile).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ assetType: AssetType.Video, visibility: AssetVisibility.Hidden }),
      );
    });

    it('should handle an invalid Directory Item', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({
        MotionPhoto: 1,
        ContainerDirectory: [{ Foo: 100 }],
      });

      await sut.handleMetadataExtraction({ id: asset.id });
    });

    it('should extract the correct video orientation', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue(videoInfoStub.videoStreamVertical2160p);
      mockReadTags({});

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({ orientation: ExifOrientation.Rotate270CW.toString() }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
    });

    it('should persist CICP smallints and profile/level for HDR10 video', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue(videoInfoStub.videoStreamHDR10);
      mocks.media.probePackets.mockResolvedValue(emptyPackets);
      mockReadTags({});

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({ fps: 59.94 }),
          video: expect.objectContaining({
            codecName: 'hevc',
            profile: 2,
            level: 153,
            pixelFormat: 'yuv420p10le',
            colorPrimaries: 9,
            colorTransfer: 16,
            colorMatrix: 9,
            dvProfile: null,
          }),
        }),
      );
    });

    it('should persist Dolby Vision fields', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue(videoInfoStub.videoStreamDolbyVision);
      mocks.media.probePackets.mockResolvedValue(emptyPackets);
      mockReadTags({});

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({
            dvProfile: 8,
            dvLevel: 10,
            dvBlSignalCompatibilityId: 4,
            colorTransfer: 18, // ARIB_STD_B67
          }),
        }),
      );
    });

    it('should persist packet-derived HLS fields', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue(videoInfoStub.videoStreamHDR10);
      mocks.media.probePackets.mockResolvedValue({
        totalDuration: 12_080,
        packetCount: 1148,
        outputFrames: 1149,
        keyframePts: [-590, 10, 611, 1211],
        keyframeAccDuration: [10, 610, 6110, 12_080],
        keyframeOwnDuration: [10, 10, 10, 10],
      });
      mockReadTags({});

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({ timeBase: 600 }),
          keyframes: expect.objectContaining({
            totalDuration: 12_080,
            packetCount: 1148,
            outputFrames: 1149,
            pts: [-590, 10, 611, 1211],
            accDuration: [10, 610, 6110, 12_080],
            ownDuration: [10, 10, 10, 10],
          }),
        }),
      );
    });

    it('should omit the keyframe row when the probe returns no keyframes', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue(videoInfoStub.videoStreamHDR10);
      mocks.media.probePackets.mockResolvedValue(emptyPackets);
      mockReadTags({});

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.not.objectContaining({ keyframes: expect.anything() }),
      );
    });

    it('should continue metadata extraction when ffprobe packet scanning exceeds stdout maxBuffer', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue(videoInfoStub.videoStreamHDR10);
      mocks.media.probePackets.mockRejectedValue(
        Object.assign(new RangeError('stdout maxBuffer length exceeded'), {
          code: 'ERR_CHILD_PROCESS_STDIO_MAXBUFFER',
        }),
      );
      mockReadTags({});

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          video: expect.objectContaining({ timeBase: 600 }),
        }),
      );
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.not.objectContaining({ keyframes: expect.anything() }),
      );
    });

    it('should prefer ffprobe frameRate over exiftool VideoFrameRate', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue(videoInfoStub.videoStreamHDR10);
      mocks.media.probePackets.mockResolvedValue(emptyPackets);
      mockReadTags({ VideoFrameRate: '30' });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({ fps: 59.94 }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
    });

    it('should not insert audio/video/keyframe rows for image assets', async () => {
      const asset = AssetFactory.create({ type: AssetType.Image });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({});

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.media.probe).not.toHaveBeenCalled();
      expect(mocks.media.probePackets).not.toHaveBeenCalled();
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.not.objectContaining({
          audio: expect.anything(),
          video: expect.anything(),
          keyframes: expect.anything(),
        }),
      );
    });

    it('should extract the MotionPhotoVideo tag from Samsung HEIC motion photos', async () => {
      const asset = AssetFactory.create();
      const motionAsset = AssetFactory.create({ type: AssetType.Video, visibility: AssetVisibility.Hidden });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.storage.stat.mockResolvedValue({
        size: 123_456,
        mtime: asset.fileModifiedAt,
        mtimeMs: asset.fileModifiedAt.valueOf(),
        birthtimeMs: asset.fileCreatedAt.valueOf(),
      } as Stats);
      mockReadTags({
        Directory: 'foo/bar/',
        MotionPhoto: 1,
        MotionPhotoVideo: new BinaryField(0, ''),
        // The below two are included to ensure that the MotionPhotoVideo tag is extracted
        // instead of the EmbeddedVideoFile, since HEIC MotionPhotos include both
        EmbeddedVideoFile: new BinaryField(0, ''),
        EmbeddedVideoType: 'MotionPhoto_Data',
      });
      mocks.crypto.hashSha1.mockReturnValue(randomBytes(512));
      mocks.asset.create.mockResolvedValue(motionAsset);
      mocks.crypto.randomUUID.mockReturnValue(motionAsset.id);
      const video = randomBytes(512);
      mocks.metadata.extractBinaryTag.mockResolvedValue(video);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.metadata.extractBinaryTag).toHaveBeenCalledWith(asset.originalPath, 'MotionPhotoVideo');
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.create).toHaveBeenCalledWith({
        checksum: expect.any(Buffer),
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        id: motionAsset.id,
        visibility: AssetVisibility.Hidden,
        libraryId: asset.libraryId,
        localDateTime: asset.fileCreatedAt,
        originalFileName: `IMG_${asset.id}.mp4`,
        originalPath: expect.stringContaining(`${motionAsset.id}-MP.mp4`),
        ownerId: asset.ownerId,
        type: AssetType.Video,
      });
      expect(mocks.user.updateUsage).toHaveBeenCalledWith(asset.ownerId, 512);
      expect(mocks.storage.createFile).toHaveBeenCalledWith(expect.stringContaining(`${motionAsset.id}-MP.mp4`), video);
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: asset.id,
        livePhotoVideoId: motionAsset.id,
      });
      expect(mocks.asset.update).toHaveBeenCalledTimes(3);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: motionAsset.id, source: 'motion-photo' },
      });
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.AssetEncodeVideo }));
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should extract the EmbeddedVideo tag from Samsung JPEG motion photos', async () => {
      const asset = AssetFactory.create();
      const motionAsset = AssetFactory.create({ type: AssetType.Video, visibility: AssetVisibility.Hidden });
      mocks.storage.stat.mockResolvedValue({
        size: 123_456,
        mtime: asset.fileModifiedAt,
        mtimeMs: asset.fileModifiedAt.valueOf(),
        birthtimeMs: asset.fileCreatedAt.valueOf(),
      } as Stats);
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({
        Directory: 'foo/bar/',
        EmbeddedVideoFile: new BinaryField(0, ''),
        EmbeddedVideoType: 'MotionPhoto_Data',
        MotionPhoto: 1,
      });
      mocks.crypto.hashSha1.mockReturnValue(randomBytes(512));
      mocks.asset.create.mockResolvedValue(motionAsset);
      mocks.crypto.randomUUID.mockReturnValue(motionAsset.id);
      const video = randomBytes(512);
      mocks.metadata.extractBinaryTag.mockResolvedValue(video);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.metadata.extractBinaryTag).toHaveBeenCalledWith(asset.originalPath, 'EmbeddedVideoFile');
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.create).toHaveBeenCalledWith({
        checksum: expect.any(Buffer),
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        id: motionAsset.id,
        visibility: AssetVisibility.Hidden,
        libraryId: asset.libraryId,
        localDateTime: asset.fileCreatedAt,
        originalFileName: `IMG_${asset.id}.mp4`,
        originalPath: expect.stringContaining(`${motionAsset.id}-MP.mp4`),
        ownerId: asset.ownerId,
        type: AssetType.Video,
      });
      expect(mocks.user.updateUsage).toHaveBeenCalledWith(asset.ownerId, 512);
      expect(mocks.storage.createFile).toHaveBeenCalledWith(expect.stringContaining(`${motionAsset.id}-MP.mp4`), video);
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: asset.id,
        livePhotoVideoId: motionAsset.id,
      });
      expect(mocks.asset.update).toHaveBeenCalledTimes(3);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: motionAsset.id, source: 'motion-photo' },
      });
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.AssetEncodeVideo }));
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should extract the motion photo video from the XMP directory entry ', async () => {
      const asset = AssetFactory.create();
      const motionAsset = AssetFactory.create({ type: AssetType.Video, visibility: AssetVisibility.Hidden });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.storage.stat.mockResolvedValue({
        size: 123_456,
        mtime: asset.fileModifiedAt,
        mtimeMs: asset.fileModifiedAt.valueOf(),
        birthtimeMs: asset.fileCreatedAt.valueOf(),
      } as Stats);
      mockReadTags({
        Directory: 'foo/bar/',
        MotionPhoto: 1,
        MicroVideo: 1,
        MicroVideoOffset: 1,
      });
      mocks.crypto.hashSha1.mockReturnValue(randomBytes(512));
      mocks.asset.create.mockResolvedValue(motionAsset);
      mocks.crypto.randomUUID.mockReturnValue(motionAsset.id);
      const video = randomBytes(512);
      mocks.storage.readFile.mockResolvedValue(video);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.storage.readFile).toHaveBeenCalledWith(asset.originalPath, expect.any(Object));
      expect(mocks.asset.create).toHaveBeenCalledWith({
        checksum: expect.any(Buffer),
        checksumAlgorithm: ChecksumAlgorithm.sha1File,
        fileCreatedAt: asset.fileCreatedAt,
        fileModifiedAt: asset.fileModifiedAt,
        id: motionAsset.id,
        visibility: AssetVisibility.Hidden,
        libraryId: asset.libraryId,
        localDateTime: asset.fileCreatedAt,
        originalFileName: `IMG_${asset.id}.mp4`,
        originalPath: expect.stringContaining(`${motionAsset.id}-MP.mp4`),
        ownerId: asset.ownerId,
        type: AssetType.Video,
      });
      expect(mocks.user.updateUsage).toHaveBeenCalledWith(asset.ownerId, 512);
      expect(mocks.storage.createFile).toHaveBeenCalledWith(expect.stringContaining(`${motionAsset.id}-MP.mp4`), video);
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: asset.id,
        livePhotoVideoId: motionAsset.id,
      });
      expect(mocks.asset.update).toHaveBeenCalledTimes(3);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.AssetExtractMetadata,
        data: { id: motionAsset.id, source: 'motion-photo' },
      });
      expect(mocks.job.queue).not.toHaveBeenCalledWith(expect.objectContaining({ name: JobName.AssetEncodeVideo }));
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should delete old motion photo video assets if they do not match what is extracted', async () => {
      const motionAsset = AssetFactory.create({ type: AssetType.Video, visibility: AssetVisibility.Hidden });
      const asset = AssetFactory.create({ livePhotoVideoId: motionAsset.id });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({
        Directory: 'foo/bar/',
        MotionPhoto: 1,
        MicroVideo: 1,
        MicroVideoOffset: 1,
      });
      mocks.crypto.hashSha1.mockReturnValue(randomBytes(512));
      mocks.asset.create.mockResolvedValue(AssetFactory.create({ type: AssetType.Video }));
      const video = randomBytes(512);
      mocks.storage.readFile.mockResolvedValue(video);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.job.queue).toHaveBeenNthCalledWith(1, {
        name: JobName.AssetDelete,
        data: { id: asset.livePhotoVideoId, deleteOnDisk: true },
      });
    });

    it('should not create a new motion photo video asset if the hash of the extracted video matches an existing asset', async () => {
      const motionAsset = AssetFactory.create({ type: AssetType.Video, visibility: AssetVisibility.Hidden });
      const asset = AssetFactory.create({ livePhotoVideoId: motionAsset.id });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({
        Directory: 'foo/bar/',
        MotionPhoto: 1,
        MicroVideo: 1,
        MicroVideoOffset: 1,
      });
      mocks.crypto.hashSha1.mockReturnValue(randomBytes(512));
      mocks.asset.getByChecksum.mockResolvedValue(motionAsset);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      const video = randomBytes(512);
      mocks.storage.readFile.mockResolvedValue(video);
      mocks.storage.checkFileExists.mockResolvedValue(true);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.storage.createOrOverwriteFile).not.toHaveBeenCalled();
      // The still asset gets saved by handleMetadataExtraction, but not the video
      expect(mocks.asset.update).toHaveBeenCalledTimes(1);
      expect(mocks.job.queue).not.toHaveBeenCalled();
    });

    it('fails explicitly when a matching motion video original is missing without creating or queueing it', async () => {
      const motionAsset = AssetFactory.create({ type: AssetType.Video });
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ Directory: 'foo/bar/', MotionPhoto: 1, MicroVideo: 1, MicroVideoOffset: 1 });
      mocks.crypto.hashSha1.mockReturnValue(randomBytes(512));
      mocks.asset.getByChecksum.mockResolvedValue(motionAsset);
      mocks.storage.readFile.mockResolvedValue(randomBytes(512));
      mocks.storage.checkFileExists.mockResolvedValue(false);
      await expect(sut.handleMetadataExtraction({ id: asset.id })).rejects.toThrow('motion video original is missing');
      expect(mocks.asset.create).not.toHaveBeenCalled();
      expect(mocks.storage.createOrOverwriteFile).not.toHaveBeenCalled();
      expect(mocks.storage.createFile).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('should link and hide motion video asset to still asset if the hash of the extracted video matches an existing asset', async () => {
      const motionAsset = AssetFactory.create({ type: AssetType.Video });
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({
        Directory: 'foo/bar/',
        MotionPhoto: 1,
        MicroVideo: 1,
        MicroVideoOffset: 1,
      });
      mocks.crypto.hashSha1.mockReturnValue(randomBytes(512));
      mocks.asset.getByChecksum.mockResolvedValue(motionAsset);
      mocks.storage.checkFileExists.mockResolvedValue(true);
      const video = randomBytes(512);
      mocks.storage.readFile.mockResolvedValue(video);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: motionAsset.id,
        visibility: AssetVisibility.Hidden,
      });
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: asset.id,
        livePhotoVideoId: motionAsset.id,
      });
      expect(mocks.asset.update).toHaveBeenCalledTimes(3);
    });

    it('should not update storage usage if motion photo is external', async () => {
      const motionAsset = AssetFactory.create({ type: AssetType.Video, visibility: AssetVisibility.Hidden });
      const asset = AssetFactory.create({ isExternal: true });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({
        Directory: 'foo/bar/',
        MotionPhoto: 1,
        MicroVideo: 1,
        MicroVideoOffset: 1,
      });
      mocks.crypto.hashSha1.mockReturnValue(randomBytes(512));
      mocks.asset.create.mockResolvedValue(motionAsset);
      const video = randomBytes(512);
      mocks.storage.readFile.mockResolvedValue(video);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.user.updateUsage).not.toHaveBeenCalled();
    });

    it('should discard a bit depth that exceeds the postgres integer range', async () => {
      const asset = AssetFactory.create();

      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ BitsPerSample: 46_209_544_973 });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({ exif: expect.objectContaining({ bitsPerSample: null }) }),
      );
    });

    it('should save all metadata', async () => {
      const dateForTest = new Date('1970-01-01T00:00:00.000-11:30');
      const asset = AssetFactory.create();

      const tags: ImmichTags = {
        BitsPerSample: 1,
        ComponentBitDepth: 1,
        ImagePixelDepth: '1',
        BitDepth: 1,
        ColorBitDepth: 1,
        ColorSpace: '1',
        DateTimeOriginal: ExifDateTime.fromISO(dateForTest.toISOString()),
        ExposureTime: '100ms',
        FocalLength: 20,
        ImageDescription: 'test description',
        ISO: 100,
        LensModel: 'test lens',
        MediaGroupUUID: 'livePhoto',
        Make: 'test-factory',
        Model: "'mockel'",
        ModifyDate: ExifDateTime.fromISO(dateForTest.toISOString()),
        Orientation: 0,
        ProfileDescription: 'extensive description',
        ProjectionType: 'equirectangular',
        zone: 'UTC-11:30',
        TagsList: ['parent/child'],
        Rating: 3,
      };

      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags(tags);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: {
            assetId: asset.id,
            bitsPerSample: expect.any(Number),
            autoStackId: null,
            colorspace: tags.ColorSpace,
            dateTimeOriginal: dateForTest,
            description: tags.ImageDescription,
            exifImageHeight: null,
            exifImageWidth: null,
            exposureTime: tags.ExposureTime,
            fNumber: null,
            fileSizeInByte: 123_456,
            focalLength: tags.FocalLength,
            fps: null,
            iso: tags.ISO,
            latitude: null,
            lensModel: tags.LensModel,
            livePhotoCID: tags.MediaGroupUUID,
            longitude: null,
            make: tags.Make,
            model: tags.Model,
            modifyDate: expect.any(Date),
            orientation: tags.Orientation?.toString(),
            profileDescription: tags.ProfileDescription,
            projectionType: 'EQUIRECTANGULAR',
            timeZone: tags.zone,
            rating: tags.Rating,
            country: null,
            state: null,
            city: null,
            tags: ['parent/child'],
          },
          lockedPropertiesBehavior: 'skip',
        }),
      );
      expect(mocks.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: asset.id,
          duration: null,
          fileCreatedAt: dateForTest,
          localDateTime: DateTime.fromISO('1970-01-01T00:00:00.000Z').toJSDate(),
        }),
      );
    });

    it('should extract +00:00 timezone from raw value', async () => {
      // exiftool-vendored returns "no timezone" information even though "+00:00" might be set explicitly
      // https://github.com/photostructure/exiftool-vendored.js/issues/203

      // this only tests our assumptions of exiftool-vendored, demonstrating the issue
      const asset = AssetFactory.create();
      const someDate = '2024-09-01T00:00:00.000';
      expect(ExifDateTime.fromISO(someDate + 'Z')?.zone).toBe('UTC');
      expect(ExifDateTime.fromISO(someDate + '+00:00')?.zone).toBe('UTC'); // this is the issue, should be UTC+0
      expect(ExifDateTime.fromISO(someDate + '+04:00')?.zone).toBe('UTC+4');

      const tags: ImmichTags = {
        DateTimeOriginal: ExifDateTime.fromISO(someDate + '+00:00'),
        zone: undefined,
      };
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags(tags);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({
            timeZone: 'UTC+0',
          }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
    });

    it('should extract duration', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue({
        ...videoInfoStub.videoStreamH264,
        format: {
          ...videoInfoStub.videoStreamH264.format,
          duration: 6.21,
        },
      });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalled();
      expect(mocks.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: asset.id,
          duration: 6210,
        }),
      );
    });

    it('should only extract duration for videos', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue({
        ...videoInfoStub.videoStreamH264,
        format: {
          ...videoInfoStub.videoStreamH264.format,
          duration: 6.21,
        },
      });
      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalled();
      expect(mocks.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: asset.id,
          duration: null,
        }),
      );
    });

    it('should omit duration of zero', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue({
        ...videoInfoStub.videoStreamH264,
        format: {
          ...videoInfoStub.videoStreamH264.format,
          duration: 0,
        },
      });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalled();
      expect(mocks.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: asset.id,
          duration: null,
        }),
      );
    });

    it('should a handle duration of 1 week', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.media.probe.mockResolvedValue({
        ...videoInfoStub.videoStreamH264,
        format: {
          ...videoInfoStub.videoStreamH264.format,
          duration: 604_800,
        },
      });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.upsertExif).toHaveBeenCalled();
      expect(mocks.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          id: asset.id,
          duration: 604_800_000,
        }),
      );
    });

    it('should use Duration from exif', async () => {
      const asset = AssetFactory.create({ originalFileName: 'file.webp' });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ Duration: 123 }, {});

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.metadata.readTags).toHaveBeenCalledTimes(1);
      expect(mocks.asset.update).toHaveBeenCalledWith(expect.objectContaining({ duration: 123_000 }));
    });

    it('should prefer Duration from exif over sidecar', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.webp' }).file({ type: AssetFileType.Sidecar }).build();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));

      mockReadTags({ Duration: 123 }, { Duration: 456 });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.metadata.readTags).toHaveBeenCalledTimes(2);
      expect(mocks.asset.update).toHaveBeenCalledWith(expect.objectContaining({ duration: 123_000 }));
    });

    it('should ignore all Duration tags for definitely static images', async () => {
      const asset = AssetFactory.from({ originalFileName: 'file.dng' }).build();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ Duration: 123 }, { Duration: 456 });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.metadata.readTags).toHaveBeenCalledTimes(1);
      expect(mocks.asset.update).toHaveBeenCalledWith(expect.objectContaining({ duration: null }));
    });

    it('should ignore Duration from exif for videos', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ Duration: 123 }, {});
      mocks.media.probe.mockResolvedValue({
        ...videoInfoStub.videoStreamH264,
        format: {
          ...videoInfoStub.videoStreamH264.format,
          duration: 456,
        },
      });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.metadata.readTags).toHaveBeenCalledTimes(1);
      expect(mocks.asset.update).toHaveBeenCalledWith(expect.objectContaining({ duration: 456_000 }));
    });

    it('should trim whitespace from description', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ Description: '\t \v \f \n \r' });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({
            description: '',
          }),
          lockedPropertiesBehavior: 'skip',
        }),
      );

      mockReadTags({ ImageDescription: ' my\n description' });
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({
            description: 'my\n description',
          }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
    });

    it('should handle a numeric description', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ Description: 1000 });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({
            description: '1000',
          }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
    });

    it('should skip importing metadata when the feature is disabled', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.systemMetadata.get.mockResolvedValue({ metadata: { faces: { import: false } } });
      mockReadTags(makeFaceTags({ Name: 'Person 1' }));
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.person.getDistinctNames).not.toHaveBeenCalled();
    });

    it('should skip importing metadata face for assets without tags.RegionInfo', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.systemMetadata.get.mockResolvedValue({ metadata: { faces: { import: true } } });
      mockReadTags();
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.person.getDistinctNames).not.toHaveBeenCalled();
    });

    it('should skip importing faces without name', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.systemMetadata.get.mockResolvedValue({ metadata: { faces: { import: true } } });
      mockReadTags(makeFaceTags());
      mocks.person.getDistinctNames.mockResolvedValue([]);
      mocks.person.createAll.mockResolvedValue([]);
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.person.createAll).not.toHaveBeenCalled();
      expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      expect(mocks.person.updateAll).not.toHaveBeenCalled();
    });

    it('should skip importing faces with empty name', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.systemMetadata.get.mockResolvedValue({ metadata: { faces: { import: true } } });
      mockReadTags(makeFaceTags({ Name: '' }));
      mocks.person.getDistinctNames.mockResolvedValue([]);
      mocks.person.createAll.mockResolvedValue([]);
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.person.createAll).not.toHaveBeenCalled();
      expect(mocks.person.refreshFaces).not.toHaveBeenCalled();
      expect(mocks.person.updateAll).not.toHaveBeenCalled();
    });

    it('should handle string coordinates in face region bounding box calculation by limiting to 16 decimal places', async () => {
      const asset = AssetFactory.create();
      const person = PersonFactory.create();

      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.systemMetadata.get.mockResolvedValue({ metadata: { faces: { import: true } } });
      const faceTags = makeFaceTags({ Name: person.name });

      // Simulating EXIF returning a string with >16 decimal places
      faceTags.RegionInfo!.RegionList[0].Area.X = '0.48564814814814824';
      faceTags.RegionInfo!.RegionList[0].Area.W = '0.2';

      mockReadTags(faceTags);
      mocks.person.getDistinctNames.mockResolvedValue([]);
      mocks.person.createGroups.mockResolvedValue([PersonGroupFactory.create({ id: person.personGroupId })]);
      mocks.person.createAll.mockResolvedValue([person]);
      mocks.person.update.mockResolvedValue(person);

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.person.refreshFaces).toHaveBeenCalledWith(
        [
          expect.objectContaining({
            boundingBoxX1: Math.floor((0.4856481481481482 - 0.2 / 2) * 1000),
          }),
        ],
        [],
      );
    });

    it('should apply metadata face tags creating new people', async () => {
      const asset = AssetFactory.create();
      const person = PersonFactory.create();

      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.systemMetadata.get.mockResolvedValue({ metadata: { faces: { import: true } } });
      mockReadTags(makeFaceTags({ Name: person.name }));
      mocks.person.getDistinctNames.mockResolvedValue([]);
      mocks.person.createGroups.mockResolvedValue([PersonGroupFactory.create({ id: person.personGroupId })]);
      mocks.person.createAll.mockResolvedValue([person]);
      mocks.person.update.mockResolvedValue(person);
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.person.getDistinctNames).toHaveBeenCalledWith(asset.ownerId, { withHidden: true });
      expect(mocks.person.createAll).toHaveBeenCalledWith([expect.objectContaining({ name: person.name })]);
      expect(mocks.person.refreshFaces).toHaveBeenCalledWith(
        [
          {
            id: 'random-uuid',
            assetId: asset.id,
            personGroupId: 'random-uuid',
            imageHeight: 100,
            imageWidth: 1000,
            boundingBoxX1: 0,
            boundingBoxX2: 200,
            boundingBoxY1: 20,
            boundingBoxY2: 60,
            sourceType: SourceType.Exif,
          },
        ],
        [],
      );
      expect(mocks.person.updateAll).toHaveBeenCalledWith([
        { ownerId: asset.ownerId, personGroupId: 'random-uuid', faceAssetId: 'random-uuid' },
      ]);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PersonGenerateThumbnail,
          data: { ownerId: asset.ownerId, personGroupId: 'random-uuid' },
        },
      ]);
    });

    it('should not make a face tag on a Locked photo the thumbnail of a person it creates (FL-53)', async () => {
      const asset = AssetFactory.create({ visibility: AssetVisibility.Locked });
      const person = PersonFactory.create();

      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.systemMetadata.get.mockResolvedValue({ metadata: { faces: { import: true } } });
      mockReadTags(makeFaceTags({ Name: person.name }));
      mocks.person.getDistinctNames.mockResolvedValue([]);
      mocks.person.createGroups.mockResolvedValue([PersonGroupFactory.create({ id: person.personGroupId })]);
      mocks.person.createAll.mockResolvedValue([person]);
      await sut.handleMetadataExtraction({ id: asset.id });

      // the person and the face are still created; the face is simply not their thumbnail
      expect(mocks.person.createAll).toHaveBeenCalledWith([expect.objectContaining({ name: person.name })]);
      expect(mocks.person.refreshFaces).toHaveBeenCalledWith(
        [expect.objectContaining({ assetId: asset.id, sourceType: SourceType.Exif })],
        [],
      );
      expect(mocks.person.updateAll).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalledWith(
        expect.arrayContaining([expect.objectContaining({ name: JobName.PersonGenerateThumbnail })]),
      );
    });

    it('should assign metadata face tags to existing persons', async () => {
      const asset = AssetFactory.create();
      const person = PersonFactory.create();

      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.systemMetadata.get.mockResolvedValue({ metadata: { faces: { import: true } } });
      mockReadTags(makeFaceTags({ Name: person.name }));
      mocks.person.getDistinctNames.mockResolvedValue([{ personGroupId: person.personGroupId, name: person.name }]);
      mocks.person.createGroups.mockResolvedValue([]);
      mocks.person.createAll.mockResolvedValue([]);
      mocks.person.update.mockResolvedValue(person);
      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.person.getDistinctNames).toHaveBeenCalledWith(asset.ownerId, { withHidden: true });
      expect(mocks.person.createAll).not.toHaveBeenCalled();
      expect(mocks.person.refreshFaces).toHaveBeenCalledWith(
        [
          {
            id: 'random-uuid',
            assetId: asset.id,
            personGroupId: person.personGroupId,
            imageHeight: 100,
            imageWidth: 1000,
            boundingBoxX1: 0,
            boundingBoxX2: 200,
            boundingBoxY1: 20,
            boundingBoxY2: 60,
            sourceType: SourceType.Exif,
          },
        ],
        [],
      );
      expect(mocks.person.updateAll).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalledWith();
    });

    describe('handleFaceTagOrientation', () => {
      const orientationTests = [
        {
          description: 'undefined',
          orientation: undefined,
          expected: { imgW: 1000, imgH: 100, x1: 0, x2: 200, y1: 20, y2: 60 },
        },
        {
          description: 'Horizontal = 1',
          orientation: ExifOrientation.Horizontal,
          expected: { imgW: 1000, imgH: 100, x1: 0, x2: 200, y1: 20, y2: 60 },
        },
        {
          description: 'MirrorHorizontal = 2',
          orientation: ExifOrientation.MirrorHorizontal,
          expected: { imgW: 1000, imgH: 100, x1: 800, x2: 1000, y1: 20, y2: 60 },
        },
        {
          description: 'Rotate180 = 3',
          orientation: ExifOrientation.Rotate180,
          expected: { imgW: 1000, imgH: 100, x1: 800, x2: 1000, y1: 40, y2: 80 },
        },
        {
          description: 'MirrorVertical = 4',
          orientation: ExifOrientation.MirrorVertical,
          expected: { imgW: 1000, imgH: 100, x1: 0, x2: 200, y1: 40, y2: 80 },
        },
        {
          description: 'MirrorHorizontalRotate270CW = 5',
          orientation: ExifOrientation.MirrorHorizontalRotate270CW,
          expected: { imgW: 100, imgH: 1000, x1: 20, x2: 60, y1: 0, y2: 200 },
        },
        {
          description: 'Rotate90CW = 6',
          orientation: ExifOrientation.Rotate90CW,
          expected: { imgW: 100, imgH: 1000, x1: 40, x2: 80, y1: 0, y2: 200 },
        },
        {
          description: 'MirrorHorizontalRotate90CW = 7',
          orientation: ExifOrientation.MirrorHorizontalRotate90CW,
          expected: { imgW: 100, imgH: 1000, x1: 40, x2: 80, y1: 800, y2: 1000 },
        },
        {
          description: 'Rotate270CW = 8',
          orientation: ExifOrientation.Rotate270CW,
          expected: { imgW: 100, imgH: 1000, x1: 20, x2: 60, y1: 800, y2: 1000 },
        },
      ];

      it.each(orientationTests)(
        'should transform RegionInfo geometry according to exif orientation $description',
        async ({ orientation, expected }) => {
          const { imgW, imgH, x1, x2, y1, y2 } = expected;
          const asset = AssetFactory.create();
          const person = PersonFactory.create();

          mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
          mocks.systemMetadata.get.mockResolvedValue({ metadata: { faces: { import: true } } });
          mockReadTags(makeFaceTags({ Name: person.name }, orientation));
          mocks.person.getDistinctNames.mockResolvedValue([]);
          mocks.person.createGroups.mockResolvedValue([PersonGroupFactory.create({ id: person.personGroupId })]);
          mocks.person.createAll.mockResolvedValue([person]);
          mocks.person.update.mockResolvedValue(person);
          await sut.handleMetadataExtraction({ id: asset.id });
          expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
          expect(mocks.person.getDistinctNames).toHaveBeenCalledWith(asset.ownerId, {
            withHidden: true,
          });
          expect(mocks.person.createAll).toHaveBeenCalledWith([expect.objectContaining({ name: person.name })]);
          expect(mocks.person.refreshFaces).toHaveBeenCalledWith(
            [
              {
                id: 'random-uuid',
                assetId: asset.id,
                personGroupId: 'random-uuid',
                imageWidth: imgW,
                imageHeight: imgH,
                boundingBoxX1: x1,
                boundingBoxX2: x2,
                boundingBoxY1: y1,
                boundingBoxY2: y2,
                sourceType: SourceType.Exif,
              },
            ],
            [],
          );
          expect(mocks.person.updateAll).toHaveBeenCalledWith([
            { ownerId: asset.ownerId, personGroupId: 'random-uuid', faceAssetId: 'random-uuid' },
          ]);
          expect(mocks.job.queueAll).toHaveBeenCalledWith([
            {
              name: JobName.PersonGenerateThumbnail,
              data: { ownerId: asset.ownerId, personGroupId: 'random-uuid' },
            },
          ]);
        },
      );
    });

    it('should handle invalid modify date', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ ModifyDate: '00:00:00.000' });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({
            modifyDate: expect.any(Date),
          }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
    });

    it('should handle invalid rating value', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ Rating: 6 });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({
            rating: null,
          }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
    });

    it('should handle valid rating value', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ Rating: 5 });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({
            rating: 5,
          }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
    });

    it('should handle 0 as unrated -> null', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ Rating: 0 });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({
            rating: null,
          }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
    });

    it('should handle livePhotoCID not set', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.findLivePhotoMatch).not.toHaveBeenCalled();
      expect(mocks.asset.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ visibility: AssetVisibility.Hidden }),
      );
      expect(mocks.album.removeAssetsFromAll).not.toHaveBeenCalled();
    });

    it('should handle not finding a match', async () => {
      const asset = AssetFactory.create({ type: AssetType.Video });
      mocks.media.probe.mockResolvedValue(videoInfoStub.videoStreamVertical2160p);
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ ContentIdentifier: 'CID' });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.findLivePhotoMatch).toHaveBeenCalledWith({
        livePhotoCID: 'CID',
        ownerId: asset.ownerId,
        otherAssetId: asset.id,
        libraryId: null,
        type: AssetType.Image,
      });
      expect(mocks.asset.update).not.toHaveBeenCalledWith(
        expect.objectContaining({ visibility: AssetVisibility.Hidden }),
      );
      expect(mocks.album.removeAssetsFromAll).not.toHaveBeenCalled();
    });

    it('should link photo and video', async () => {
      const motionAsset = AssetFactory.create({ type: AssetType.Video });
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.findLivePhotoMatch.mockResolvedValue(motionAsset);
      mockReadTags({ ContentIdentifier: 'CID' });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.assetJob.getForMetadataExtraction).toHaveBeenCalledWith(asset.id);
      expect(mocks.asset.findLivePhotoMatch).toHaveBeenCalledWith({
        libraryId: null,
        livePhotoCID: 'CID',
        ownerId: asset.ownerId,
        otherAssetId: asset.id,
        type: AssetType.Video,
      });
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: asset.id,
        livePhotoVideoId: motionAsset.id,
      });
      expect(mocks.asset.update).toHaveBeenCalledWith({
        id: motionAsset.id,
        visibility: AssetVisibility.Hidden,
      });
      expect(mocks.album.removeAssetsFromAll).toHaveBeenCalledWith([motionAsset.id]);
    });

    it('should notify clients on live photo link', async () => {
      const motionAsset = AssetFactory.create({ type: AssetType.Video });
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.findLivePhotoMatch.mockResolvedValue(motionAsset);
      mockReadTags({ ContentIdentifier: 'CID' });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.event.emit).toHaveBeenCalledWith('AssetHide', {
        userId: motionAsset.ownerId,
        assetId: motionAsset.id,
      });
    });

    it('should search by libraryId', async () => {
      const motionAsset = AssetFactory.create({ type: AssetType.Video, libraryId: 'library-id' });
      const asset = AssetFactory.create({ libraryId: 'library-id' });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mocks.asset.findLivePhotoMatch.mockResolvedValue(motionAsset);
      mockReadTags({ ContentIdentifier: 'CID' });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.event.emit).toHaveBeenCalledWith('AssetMetadataExtracted', {
        assetId: asset.id,
        userId: asset.ownerId,
      });
      expect(mocks.asset.findLivePhotoMatch).toHaveBeenCalledWith({
        ownerId: asset.ownerId,
        otherAssetId: asset.id,
        livePhotoCID: 'CID',
        libraryId: 'library-id',
        type: AssetType.Video,
      });
    });

    it.each([
      {
        exif: {
          Make: '1',
          Model: '2',
          Device: { Manufacturer: '3', ModelName: '4' },
          AndroidMake: '4',
          AndroidModel: '5',
        },
        expected: { make: '1', model: '2' },
      },
      {
        exif: { Device: { Manufacturer: '1', ModelName: '2' }, AndroidMake: '3', AndroidModel: '4' },
        expected: { make: '1', model: '2' },
      },
      { exif: { AndroidMake: '1', AndroidModel: '2' }, expected: { make: '1', model: '2' } },
      { exif: { DeviceManufacturer: '1', DeviceModelName: '2' }, expected: { make: '1', model: '2' } },
      {
        exif: { Make: '1', Model: '2', DeviceManufacturer: '3', DeviceModelName: '4' },
        expected: { make: '1', model: '2' },
      },
      {
        exif: { Make: ' ', Model: '', Device: { Manufacturer: ' Apple ', ModelName: ' iPhone 16 Pro ' } },
        expected: { make: 'Apple', model: 'iPhone 16 Pro' },
      },
      {
        exif: {
          Make: '',
          Model: ' ',
          Device: { Manufacturer: '', ModelName: ' ' },
          AndroidMake: 'Google',
          AndroidModel: 'Pixel 9',
        },
        expected: { make: 'Google', model: 'Pixel 9' },
      },
      {
        exif: { Make: 'NIKON', UniqueCameraModel: 'NIKON Z 8' },
        expected: { make: 'NIKON', model: 'NIKON Z 8' },
      },
      { exif: { CameraModel: 'Phase One IQ4 150MP' }, expected: { make: null, model: 'Phase One IQ4 150MP' } },
      {
        exif: { Model: 'FutureCam 9000', UniqueCameraModel: 'Alternate', CameraModel: 'Other' },
        expected: { make: null, model: 'FutureCam 9000' },
      },
      {
        exif: {
          CanonModelID: 'EOS Rebel T3i / 600D / Kiss X5',
          SonyModelID: 'DSLR-A380/A390',
          ImageWidth: 6000,
          ImageHeight: 4000,
        },
        expected: { make: null, model: null },
      },
      { exif: { Make: ' ', Model: '' }, expected: { make: null, model: null } },
    ])('should read camera make and model $exif -> $expected', async ({ exif, expected }) => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags(exif);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining(expected),
          lockedPropertiesBehavior: 'skip',
        }),
      );
    });

    it('reads a recorded camera model from a sidecar when the original has no camera metadata', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Sidecar }).build();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({}, { CameraModel: 'Hasselblad X2D 100C' });

      await sut.handleMetadataExtraction({ id: asset.id });

      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({ exif: expect.objectContaining({ make: null, model: 'Hasselblad X2D 100C' }) }),
      );
    });

    it.each([
      { exif: {}, expected: null },
      { exif: { LensID: '1', LensSpec: '2', LensType: '3', LensModel: '4' }, expected: '1' },
      { exif: { LensSpec: '2', LensType: '3', LensModel: '4' }, expected: '3' },
      { exif: { LensSpec: '2', LensModel: '4' }, expected: '2' },
      { exif: { LensModel: '4' }, expected: '4' },
      { exif: { LensID: '----' }, expected: null },
      { exif: { LensID: 'Unknown (0 ff ff)' }, expected: null },
      {
        exif: { LensID: 'Unknown (E1 40 19 36 2C 35 DF 0E) Tamron 10-24mm f/3.5-4.5 Di II VC HLD (B023) ?' },
        expected: null,
      },
      { exif: { LensID: ' Unknown 6-30mm' }, expected: null },
      { exif: { LensID: '' }, expected: null },
    ])('should read camera lens information $exif -> $expected', async ({ exif, expected }) => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags(exif);

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.upsertExif).toHaveBeenCalledWith(
        expect.objectContaining({
          exif: expect.objectContaining({
            lensModel: expected,
          }),
          lockedPropertiesBehavior: 'skip',
        }),
      );
    });

    it('should properly set width/height for normal images', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ ImageWidth: 1000, ImageHeight: 2000 });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 1000,
          height: 2000,
        }),
      );
    });

    it('should properly swap asset width/height for rotated images', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ ImageWidth: 1000, ImageHeight: 2000, Orientation: 6 });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 2000,
          height: 1000,
        }),
      );
    });

    it('should overwrite existing width/height for unedited assets', async () => {
      const asset = AssetFactory.create({ width: 1920, height: 1080, isEdited: false });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ ImageWidth: 1280, ImageHeight: 720 });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          width: 1280,
          height: 720,
        }),
      );
    });

    it('should not overwrite existing width/height for edited assets', async () => {
      const asset = AssetFactory.create({ width: 1920, height: 1080, isEdited: true });
      mocks.assetJob.getForMetadataExtraction.mockResolvedValue(getForMetadataExtraction(asset));
      mockReadTags({ ImageWidth: 1280, ImageHeight: 720 });

      await sut.handleMetadataExtraction({ id: asset.id });
      expect(mocks.asset.update).toHaveBeenCalledWith(
        expect.objectContaining({
          width: undefined,
          height: undefined,
        }),
      );
      expect(mocks.asset.update).not.toHaveBeenCalledWith(
        expect.objectContaining({
          width: 1280,
          height: 720,
        }),
      );
    });
  });

  describe('handleQueueSidecar', () => {
    it('should queue assets with sidecar files', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.selectionForSidecar.mockReturnValue({ selected: [asset] } as never);

      await sut.handleQueueSidecar({ force: true });

      expect(mocks.assetJob.selectionForSidecar).toHaveBeenCalledWith(true);
      expect(mocks.job.queueSelection).toHaveBeenCalledWith(
        JobName.SidecarCheck,
        mocks.assetJob.selectionForSidecar.mock.results[0].value,
      );
    });

    it('should queue assets without sidecar files', async () => {
      const asset = AssetFactory.create();
      mocks.assetJob.selectionForSidecar.mockReturnValue({ selected: [asset] } as never);

      await sut.handleQueueSidecar({ force: false });

      expect(mocks.assetJob.selectionForSidecar).toHaveBeenCalledWith(false);
      expect(mocks.job.queueSelection).toHaveBeenCalledWith(
        JobName.SidecarCheck,
        mocks.assetJob.selectionForSidecar.mock.results[0].value,
      );
    });
  });

  describe('handleSidecarCheck', () => {
    it('should do nothing if asset could not be found', async () => {
      mocks.assetJob.getForSidecarCheckJob.mockResolvedValue(void 0);

      await expect(sut.handleSidecarCheck({ id: 'non-existent' })).resolves.toBeUndefined();

      expect(mocks.asset.update).not.toHaveBeenCalled();
    });

    it('should detect a new sidecar at .jpg.xmp', async () => {
      const asset = forSidecarJob({ originalPath: '/path/to/IMG_123.jpg', files: [] });

      mocks.assetJob.getForSidecarCheckJob.mockResolvedValue(asset);
      mocks.storage.checkFileExists.mockResolvedValueOnce(true);

      await expect(sut.handleSidecarCheck({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.upsertFile).toHaveBeenCalledWith({
        assetId: asset.id,
        type: AssetFileType.Sidecar,
        path: '/path/to/IMG_123.jpg.xmp',
      });
    });

    it('should detect a new sidecar at .xmp', async () => {
      const asset = forSidecarJob({
        originalPath: '/path/to/IMG_123.jpg',
        files: [],
      });

      mocks.assetJob.getForSidecarCheckJob.mockResolvedValue(asset);
      mocks.storage.checkFileExists.mockResolvedValueOnce(false);
      mocks.storage.checkFileExists.mockResolvedValueOnce(true);

      await expect(sut.handleSidecarCheck({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.upsertFile).toHaveBeenCalledWith({
        assetId: asset.id,
        type: AssetFileType.Sidecar,
        path: '/path/to/IMG_123.xmp',
      });
    });

    it('should unset sidecar path if file no longer exist', async () => {
      const asset = forSidecarJob({
        originalPath: '/path/to/IMG_123.jpg',
        files: [{ id: 'sidecar', path: '/path/to/IMG_123.jpg.xmp', type: AssetFileType.Sidecar, isEdited: false }],
      });
      mocks.assetJob.getForSidecarCheckJob.mockResolvedValue(asset);
      mocks.storage.checkFileExists.mockResolvedValue(false);

      await expect(sut.handleSidecarCheck({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.deleteFile).toHaveBeenCalledWith({ assetId: asset.id, type: AssetFileType.Sidecar });
    });

    it('should do nothing if the sidecar file still exists', async () => {
      const asset = forSidecarJob({
        originalPath: '/path/to/IMG_123.jpg',
        files: [{ id: 'sidecar', path: '/path/to/IMG_123.jpg.xmp', type: AssetFileType.Sidecar, isEdited: false }],
      });

      mocks.assetJob.getForSidecarCheckJob.mockResolvedValue(asset);
      mocks.storage.checkFileExists.mockResolvedValueOnce(true);

      await expect(sut.handleSidecarCheck({ id: asset.id })).resolves.toBe(JobStatus.Skipped);

      expect(mocks.asset.upsertFile).not.toHaveBeenCalled();
      expect(mocks.asset.deleteFile).not.toHaveBeenCalled();
    });

    it('should not attach the shared original sidecar for a non-canonical physical asset', async () => {
      const asset = forSidecarJob({
        id: 'duplicate-asset',
        ownerId: 'duplicate-owner',
        originalPath: '/path/to/master/IMG_123.jpg',
        physicalOriginalFileId: 'physical-file',
        files: [
          { id: 'sidecar', path: '/path/to/master/IMG_123.jpg.xmp', type: AssetFileType.Sidecar, isEdited: false },
        ],
      });
      const sidecarPath = StorageCore.getNestedPath(StorageFolder.Upload, asset.ownerId, `${asset.id}.xmp`);

      mocks.assetJob.getForSidecarCheckJob.mockResolvedValue(asset);
      mocks.physicalFile.isOriginalCanonical.mockResolvedValue(false);
      mocks.storage.checkFileExists.mockImplementation((path) => Promise.resolve(path === sidecarPath));

      await expect(sut.handleSidecarCheck({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.upsertFile).toHaveBeenCalledWith({
        assetId: asset.id,
        type: AssetFileType.Sidecar,
        path: sidecarPath,
      });
      expect(mocks.storage.checkFileExists).not.toHaveBeenCalledWith(
        '/path/to/master/IMG_123.jpg.xmp',
        expect.anything(),
      );
    });
  });

  describe('handleSidecarWrite', () => {
    it('should skip assets that no longer exist on the sidecar lock connection', async () => {
      const connection = { lockConnection: true } as never;
      mocks.database.withAssetSidecarLock.mockImplementation(async (_id, fn) => fn(connection));
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(void 0);
      mocks.assetJob.getForSidecarCheckJob.mockResolvedValue(void 0);
      await expect(sut.handleSidecarWrite({ id: 'asset-123' })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.assetJob.getForSidecarWriteJob).toHaveBeenCalledWith('asset-123', connection);
      expect(mocks.assetJob.getForSidecarCheckJob).toHaveBeenCalledWith('asset-123', connection);
      expect(mocks.assetJob.getLockedPropertiesForMetadataExtraction).not.toHaveBeenCalled();
      expect(mocks.metadata.writeTags).not.toHaveBeenCalled();
      expect(mocks.asset.upsertFile).not.toHaveBeenCalled();
      expect(mocks.asset.unlockProperties).not.toHaveBeenCalled();
    });

    it('should fail an existing asset missing EXIF on the sidecar lock connection', async () => {
      const asset = AssetFactory.from().build();
      const connection = { lockConnection: true } as never;
      mocks.database.withAssetSidecarLock.mockImplementation(async (_id, fn) => fn(connection));
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(void 0);
      mocks.assetJob.getForSidecarCheckJob.mockResolvedValue(forSidecarJob(asset));
      await expect(sut.handleSidecarWrite({ id: asset.id })).resolves.toBe(JobStatus.Failed);
      expect(mocks.assetJob.getForSidecarWriteJob).toHaveBeenCalledWith(asset.id, connection);
      expect(mocks.assetJob.getForSidecarCheckJob).toHaveBeenCalledWith(asset.id, connection);
      expect(mocks.assetJob.getLockedPropertiesForMetadataExtraction).not.toHaveBeenCalled();
      expect(mocks.metadata.writeTags).not.toHaveBeenCalled();
      expect(mocks.asset.upsertFile).not.toHaveBeenCalled();
      expect(mocks.asset.unlockProperties).not.toHaveBeenCalled();
    });

    it('should skip jobs with no metadata', async () => {
      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue([]);
      const asset = AssetFactory.from().file({ type: AssetFileType.Sidecar }).exif().build();
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(getForSidecarWrite(asset));
      await expect(sut.handleSidecarWrite({ id: asset.id })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.metadata.writeTags).not.toHaveBeenCalled();
    });

    it('should write tags', async () => {
      const description = 'this is a description';
      const gps = 12;
      const date = '2023-11-21T22:56:12.196-06:00';
      const asset = AssetFactory.from()
        .file({ type: AssetFileType.Sidecar })
        .exif({ description, dateTimeOriginal: new Date(date), latitude: gps, longitude: gps })
        .build();

      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue([
        'description',
        'latitude',
        'longitude',
        'dateTimeOriginal',
        'timeZone',
      ]);
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(getForSidecarWrite(asset));
      await expect(
        sut.handleSidecarWrite({
          id: asset.id,
        }),
      ).resolves.toBe(JobStatus.Success);
      expect(mocks.metadata.writeTags).toHaveBeenCalledWith(asset.files[0].path, {
        DateTimeOriginal: date,
        Description: description,
        ImageDescription: description,
        GPSLatitude: gps,
        GPSLongitude: gps,
      });
      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith(
        asset.id,
        ['description', 'latitude', 'longitude', 'dateTimeOriginal', 'timeZone'],
        undefined,
      );
    });

    it('writes one sidecar per asset at a time, on the lock connection (FL-195)', async () => {
      const asset = AssetFactory.from()
        .file({ type: AssetFileType.Sidecar })
        .exif({ latitude: 12, longitude: 12 })
        .build();
      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue(['latitude', 'longitude']);
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(getForSidecarWrite(asset));
      const trx = { lockConnection: true } as never;
      let locked = false;
      mocks.database.withAssetSidecarLock.mockImplementation(async (_id, fn) => {
        locked = true;
        const result = await fn(trx);
        locked = false;
        return result;
      });
      mocks.metadata.writeTags.mockImplementation(() => {
        expect(locked).toBe(true);
        return Promise.resolve();
      });
      await expect(sut.handleSidecarWrite({ id: asset.id })).resolves.toBe(JobStatus.Success);
      expect(mocks.database.withAssetSidecarLock).toHaveBeenCalledWith(asset.id, expect.any(Function));
      expect(mocks.metadata.writeTags).toHaveBeenCalled();
      // a second pooled connection per holder could deadlock the pool (see withAssetSidecarLock)
      expect(mocks.assetJob.getForSidecarWriteJob).toHaveBeenCalledWith(asset.id, trx);
      expect(mocks.assetJob.getLockedPropertiesForMetadataExtraction).toHaveBeenCalledWith(asset.id, trx);
      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith(asset.id, ['latitude', 'longitude'], trx);
    });

    it('keeps the properties locked when the sidecar could not be written (FL-195)', async () => {
      const asset = AssetFactory.from()
        .file({ type: AssetFileType.Sidecar })
        .exif({ latitude: 12, longitude: 12 })
        .build();
      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue(['latitude', 'longitude']);
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(getForSidecarWrite(asset));
      mocks.metadata.writeTags.mockRejectedValue(new Error('File already exists: IMG.xmp_exiftool'));
      await expect(sut.handleSidecarWrite({ id: asset.id })).rejects.toThrow('File already exists');
      expect(mocks.asset.unlockProperties).not.toHaveBeenCalled();
    });

    it('writes the tags set in Frameleaf and keeps them locked', async () => {
      const asset = AssetFactory.from()
        .file({ type: AssetFileType.Sidecar })
        .exif({ tags: ['Parent/Child', 'Trip'] })
        .build();
      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue(['tags', 'rating']);
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(getForSidecarWrite(asset));

      await expect(sut.handleSidecarWrite({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.metadata.writeTags).toHaveBeenCalledWith(
        asset.files[0].path,
        expect.objectContaining({ TagsList: ['Parent/Child', 'Trip'] }),
      );
      // a sidecar written behind later tag edits must not become the tags' source
      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith(asset.id, ['rating'], undefined);
    });

    it('writes a removed location as no coordinates and keeps it locked (FL-51)', async () => {
      const asset = AssetFactory.from()
        .file({ type: AssetFileType.Sidecar })
        .exif({ latitude: null, longitude: null })
        .build();

      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue(['latitude', 'longitude', 'rating']);
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(getForSidecarWrite(asset));

      await expect(sut.handleSidecarWrite({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.metadata.writeTags).toHaveBeenCalledWith(
        asset.files[0].path,
        expect.objectContaining({ GPSLatitude: null, GPSLongitude: null }),
      );
      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith(asset.id, ['rating'], undefined);
    });

    it('keeps a removed location and a typed place name locked together (FL-51, FL-36)', async () => {
      const asset = AssetFactory.from()
        .file({ type: AssetFileType.Sidecar })
        .exif({ latitude: null, longitude: null })
        .build();

      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue([
        'latitude',
        'longitude',
        'city',
        'rating',
      ]);
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(getForSidecarWrite(asset));

      await expect(sut.handleSidecarWrite({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith(asset.id, ['rating'], undefined);
    });

    it('should write rating', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Sidecar }).exif().build();
      asset.exifInfo.rating = 4;

      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue(['rating']);
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(getForSidecarWrite(asset));
      await expect(sut.handleSidecarWrite({ id: asset.id })).resolves.toBe(JobStatus.Success);
      expect(mocks.metadata.writeTags).toHaveBeenCalledWith(asset.files[0].path, { Rating: 4 });
      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith(asset.id, ['rating'], undefined);
    });

    it('keeps a typed place name locked after writing the sidecar (FL-36, V-24)', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Sidecar }).exif().build();
      asset.exifInfo.rating = 2;

      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue(['rating', 'city', 'state', 'country']);
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(getForSidecarWrite(asset));
      await expect(sut.handleSidecarWrite({ id: asset.id })).resolves.toBe(JobStatus.Success);
      expect(mocks.metadata.writeTags).toHaveBeenCalledWith(asset.files[0].path, { Rating: 2 });
      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith(asset.id, ['rating'], undefined);
    });

    it('should write null rating as 0', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Sidecar }).exif().build();
      asset.exifInfo.rating = null;

      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue(['rating']);
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(getForSidecarWrite(asset));
      await expect(sut.handleSidecarWrite({ id: asset.id })).resolves.toBe(JobStatus.Success);
      expect(mocks.metadata.writeTags).toHaveBeenCalledWith(asset.files[0].path, { Rating: 0 });
      expect(mocks.asset.unlockProperties).toHaveBeenCalledWith(asset.id, ['rating'], undefined);
    });

    it('should write non-canonical physical asset sidecars to an owner-scoped path', async () => {
      const asset = AssetFactory.from({
        id: 'duplicate-asset',
        ownerId: 'duplicate-owner',
        originalPath: '/path/to/master/IMG_123.jpg',
        physicalOriginalFileId: 'physical-file',
      })
        .file({ type: AssetFileType.Sidecar, path: '/path/to/master/IMG_123.jpg.xmp' })
        .exif({ rating: 4 })
        .build();
      const sidecarPath = StorageCore.getNestedPath(StorageFolder.Upload, asset.ownerId, `${asset.id}.xmp`);

      mocks.assetJob.getLockedPropertiesForMetadataExtraction.mockResolvedValue(['rating']);
      mocks.assetJob.getForSidecarWriteJob.mockResolvedValue(getForSidecarWrite(asset));
      mocks.physicalFile.isOriginalCanonical.mockResolvedValue(false);

      await expect(sut.handleSidecarWrite({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(mocks.metadata.writeTags).toHaveBeenCalledWith(sidecarPath, { Rating: 4 });
      expect(mocks.asset.upsertFile).toHaveBeenCalledWith(
        {
          assetId: asset.id,
          type: AssetFileType.Sidecar,
          path: sidecarPath,
        },
        undefined,
      );
    });
  });

  describe('firstDateTime', () => {
    it('should ignore date-only tags like GPSDateStamp', () => {
      const tags = {
        GPSDateStamp: '2023:08:08', // Date-only tag, should be ignored
        SonyDateTime2: '2023:07:07 07:00:00',
      };

      const result = firstDateTime(tags);
      expect(result?.tag).toBe('SonyDateTime2');
      expect(result?.dateTime?.toISOString()).toBe('2023-07-07T07:00:00');
    });

    it('should respect full priority order with all date tags present', () => {
      const tags = {
        // SubSec and standard EXIF date tags
        SubSecDateTimeOriginal: '2023:01:01 01:00:00',
        SubSecCreateDate: '2023:02:02 02:00:00',
        SubSecMediaCreateDate: '2023:03:03 03:00:00',
        DateTimeOriginal: '2023:04:04 04:00:00',
        CreateDate: '2023:05:05 05:00:00',
        MediaCreateDate: '2023:06:06 06:00:00',
        CreationDate: '2023:07:07 07:00:00',
        DateTimeCreated: '2023:08:08 08:00:00',

        // Additional date tags
        TimeCreated: '2023:09:09 09:00:00',
        GPSDateTime: '2023:10:10 10:00:00',
        DateTimeUTC: '2023:11:11 11:00:00',
        GPSDateStamp: '2023:12:12', // Date-only tag, should be ignored
        SonyDateTime2: '2023:13:13 13:00:00',

        // Non-standard tag
        SourceImageCreateTime: '2023:14:14 14:00:00',
      };

      const result = firstDateTime(tags);
      // Should use SubSecDateTimeOriginal as it has highest priority
      expect(result?.tag).toBe('SubSecDateTimeOriginal');
      expect(result?.dateTime?.toISOString()).toBe('2023-01-01T01:00:00');
    });

    it('should handle missing SubSec tags and use available date tags', () => {
      const tags = {
        // Standard date tags
        CreationDate: '2023:07:07 07:00:00',
        DateTimeCreated: '2023:08:08 08:00:00',

        // Additional date tags
        TimeCreated: '2023:09:09 09:00:00',
        GPSDateTime: '2023:10:10 10:00:00',
        DateTimeUTC: '2023:11:11 11:00:00',
        GPSDateStamp: '2023:12:12', // Date-only tag, should be ignored
        SonyDateTime2: '2023:13:13 13:00:00',
      };

      const result = firstDateTime(tags);
      // Should use CreationDate when available
      expect(result?.tag).toBe('CreationDate');
      expect(result?.dateTime?.toISOString()).toBe('2023-07-07T07:00:00');
    });

    it('should handle invalid date formats gracefully', () => {
      const tags = {
        TimeCreated: 'invalid-date',
        GPSDateTime: '2023:10:10 10:00:00',
        DateTimeUTC: 'also-invalid',
        SonyDateTime2: '2023:13:13 13:00:00',
      };

      const result = firstDateTime(tags);
      // Should skip invalid dates and use the first valid one
      expect(result?.tag).toBe('GPSDateTime');
      expect(result?.dateTime?.toISOString()).toBe('2023-10-10T10:00:00');
    });

    it('should prefer CreationDate over CreateDate', () => {
      const tags = {
        CreationDate: '2025:05:24 18:26:20+02:00',
        CreateDate: '2025:08:27 08:45:40',
      };

      const result = firstDateTime(tags);
      expect(result?.tag).toBe('CreationDate');
      expect(result?.dateTime?.toDate()?.toISOString()).toBe('2025-05-24T16:26:20.000Z');
    });
  });
});
