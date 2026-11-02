import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Stats } from 'node:fs';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Writable } from 'node:stream';
import { AssetVisibility, CacheControl, JobStatus } from 'src/enum.js';
import { StudioMediaService, fillMissingFrames, getStudioMediaFolder } from 'src/services/studio-media.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { PeakAccumulator, encodeWaveformPeaks, studioMediaFingerprint } from 'src/utils/studio-media.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { videoInfoStub } from 'test/fixtures/media.stub.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const assetId = '00000000-0000-4000-8000-000000000001';
const ownerId = authStub.admin.user.id;
const encodedPath = '/data/encoded-video/video.mp4';
const stats = { size: 1234, mtimeMs: 1_700_000_000_000 } as Stats;
const version = studioMediaFingerprint({ path: encodedPath, size: stats.size, mtimeMs: stats.mtimeMs });

const videoInfo = (audio: boolean) => ({
  ...videoInfoStub.noAudioStreams,
  format: { ...videoInfoStub.noAudioStreams.format, duration: 10 },
  audioStreams: audio ? [{ index: 1, codecName: 'aac', profile: null, bitrate: 0, channels: 2 }] : [],
});

describe(StudioMediaService.name, () => {
  let sut: StudioMediaService;
  let mocks: ServiceMocks;
  let folder: string;

  beforeEach(() => {
    clearConfigCache();
    ({ sut, mocks } = newTestService(StudioMediaService));
    folder = getStudioMediaFolder(ownerId, assetId);
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([assetId]));
    mocks.asset.getForVideo.mockResolvedValue({
      ownerId,
      originalPath: '/data/library/original.mov',
      encodedVideoPath: encodedPath,
      editedVideoPath: null,
    });
    mocks.storage.stat.mockResolvedValue(stats);
    mocks.storage.readdir.mockResolvedValue([]);
    mocks.storage.readFile.mockRejectedValue(new Error('ENOENT'));
    mocks.storage.checkFileExists.mockResolvedValue(true);
    mocks.storage.unlinkDir.mockResolvedValue();
  });

  it('keeps its cache in a hidden folder beside the thumbnails', () => {
    expect(folder).toBe(`/data/thumbs/${ownerId}/00/00/.${assetId}-timeline`);
  });

  describe('access', () => {
    it('requires asset.view, as thumbnails do', async () => {
      mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.getFilmstrip(authStub.admin, assetId, {})).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut.getWaveform(authStub.admin, assetId, {})).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('accepts a shared link that can see the asset', async () => {
      mocks.access.asset.checkSharedLinkAccess.mockResolvedValue(new Set([assetId]));
      mocks.storage.readFile.mockResolvedValue(encodeWaveformPeaks(new PeakAccumulator(1, 1).finish()));
      await expect(sut.getWaveform(authStub.adminSharedLink, assetId, {})).resolves.toMatchObject({ hasAudio: true });
      expect(mocks.access.asset.checkSharedLinkAccess).toHaveBeenCalled();
    });

    it('is 404 for anything that is not a video', async () => {
      mocks.asset.getForVideo.mockResolvedValue(undefined);
      await expect(sut.getFilmstrip(authStub.admin, assetId, {})).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.getWaveform(authStub.admin, assetId, {})).rejects.toBeInstanceOf(NotFoundException);
    });

    it('is 404 when the video file is gone', async () => {
      mocks.storage.stat.mockRejectedValue(new Error('ENOENT'));
      await expect(sut.getFilmstrip(authStub.admin, assetId, {})).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  it('bounds the generation wait queue and releases it after failures', async () => {
    const limited = (work: () => Promise<void>) =>
      (sut as unknown as { limited: (work: () => Promise<void>) => Promise<void> }).limited(work);
    const { promise: held, resolve: finish } = Promise.withResolvers<void>();
    const work = vi.fn(() => held);
    const accepted = Array.from({ length: 10 }, () => limited(work));
    await expect(limited(work)).rejects.toThrow('Studio media generation is busy');
    finish();
    await Promise.all(accepted);
    await expect(limited(() => Promise.reject(new Error('failed')))).rejects.toThrow('failed');
    await expect(limited(() => Promise.resolve())).resolves.toBeUndefined();
  });

  describe('filmstrip', () => {
    it('cuts a short video in one pass from the playback rendition, never the original, and composes a sprite', async () => {
      mocks.media.probe.mockResolvedValue(videoInfo(false));
      const index = await sut.getFilmstrip(authStub.admin, assetId, { count: 4, height: 90 });

      // FL-650: one decoding pass, starting at the centre of the first slice, one frame per slice
      expect(mocks.media.transcode).toHaveBeenCalledOnce();
      const [input, output, command] = mocks.media.transcode.mock.calls[0];
      expect(input).toBe(encodedPath);
      expect(output).toMatch(/\.work-.*\/pass-%d\.jpg$/);
      expect(command.inputOptions).toEqual(['-ss', '1.250']);
      expect(command.outputOptions).toEqual(
        expect.arrayContaining(['-frames:v', '4', '-vf', 'fps=4000/10000,scale=-2:90:flags=bilinear']),
      );
      expect(mocks.media.composeFilmstrip).toHaveBeenCalledWith(
        [1, 2, 3, 4].map((frame) => expect.stringMatching(new RegExp(String.raw`\.work-.*/pass-${frame}\.jpg$`))),
        expect.objectContaining({ columns: 4, rows: 1, tileWidth: 160, tileHeight: 90, format: 'jpeg' }),
      );
      const spritePath = `${folder}/filmstrip-${version}-4x90.jpg`;
      expect(mocks.storage.rename).toHaveBeenCalledWith(expect.stringContaining('/.work-'), spritePath);
      expect(mocks.storage.createOrOverwriteFile).toHaveBeenCalledWith(
        `${folder}/filmstrip-${version}-4x90.jpeg.json`,
        expect.any(Buffer),
      );
      expect(mocks.storage.unlinkDir).toHaveBeenCalledWith(expect.stringContaining('/.work-'), {
        recursive: true,
        force: true,
      });
      expect(index).toEqual({
        assetId,
        version,
        durationMs: 10_000,
        format: 'jpeg',
        mimeType: 'image/jpeg',
        frameWidth: 160,
        frameHeight: 90,
        columns: 4,
        rows: 1,
        spriteWidth: 640,
        spriteHeight: 90,
        frames: [
          { index: 0, timeMs: 1250, x: 0, y: 0 },
          { index: 1, timeMs: 3750, x: 160, y: 0 },
          { index: 2, timeMs: 6250, x: 320, y: 0 },
          { index: 3, timeMs: 8750, x: 480, y: 0 },
        ],
      });
    });

    it('seeks once per frame in a video longer than ten minutes', async () => {
      mocks.media.probe.mockResolvedValue({
        ...videoInfo(false),
        format: { ...videoInfo(false).format, duration: 1200 },
      });
      await sut.getFilmstrip(authStub.admin, assetId, { count: 4, height: 90 });

      expect(mocks.media.transcode.mock.calls.map((call) => call[2].inputOptions)).toEqual([
        ['-ss', '150.000'],
        ['-ss', '450.000'],
        ['-ss', '750.000'],
        ['-ss', '1050.000'],
      ]);
      for (const call of mocks.media.transcode.mock.calls) {
        expect(call[0]).toBe(encodedPath);
      }
    });

    it('falls back to a seek per frame when the single pass fails', async () => {
      mocks.media.probe.mockResolvedValue(videoInfo(false));
      mocks.media.transcode.mockRejectedValueOnce(new Error('decoder error'));
      await sut.getFilmstrip(authStub.admin, assetId, { count: 4, height: 90 });

      expect(mocks.media.transcode.mock.calls.map((call) => call[2].inputOptions)).toEqual([
        ['-ss', '1.250'],
        ['-ss', '1.250'],
        ['-ss', '3.750'],
        ['-ss', '6.250'],
        ['-ss', '8.750'],
      ]);
      expect(mocks.media.composeFilmstrip).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringMatching(/\.work-.*\/0\.jpg$/)]),
        expect.anything(),
      );
    });

    it('serves the cached index and sprite without running ffmpeg', async () => {
      const cached = { assetId, version, mimeType: 'image/webp', frames: [] };
      mocks.storage.readFile.mockResolvedValue(Buffer.from(JSON.stringify(cached)));

      await expect(sut.getFilmstrip(authStub.admin, assetId, { format: 'webp' })).resolves.toEqual(cached);
      await expect(sut.viewFilmstripSprite(authStub.admin, assetId, { format: 'webp', version })).resolves.toEqual(
        new FileDownloadResponse({
          path: `${folder}/filmstrip-${version}-20x90.webp`,
          contentType: 'image/webp',
          cacheControl: CacheControl.PrivateWithCache,
        }),
      );
      expect(mocks.storage.readFile).toHaveBeenCalledWith(`${folder}/filmstrip-${version}-20x90.webp.json`);
      expect(mocks.media.probe).not.toHaveBeenCalled();
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    describe('handleWarmFilmstrip (FL-650)', () => {
      it("makes the player's seek-bar variant ahead of time, with no user", async () => {
        mocks.media.probe.mockResolvedValue(videoInfo(false));

        await expect(sut.handleWarmFilmstrip({ id: assetId })).resolves.toBe(JobStatus.Success);

        expect(mocks.access.asset.checkOwnerAccess).not.toHaveBeenCalled();
        expect(mocks.media.transcode).toHaveBeenCalledOnce();
        expect(mocks.media.transcode.mock.calls[0][2].outputOptions).toEqual(
          expect.arrayContaining(['-frames:v', '120']),
        );
        expect(mocks.storage.rename).toHaveBeenCalledWith(
          expect.stringContaining('/.work-'),
          `${folder}/filmstrip-${version}-120x180.jpg`,
        );
      });

      it('is a quick cache hit when the previews exist', async () => {
        mocks.storage.readFile.mockResolvedValue(Buffer.from(JSON.stringify({ assetId, version, frames: [] })));

        await expect(sut.handleWarmFilmstrip({ id: assetId })).resolves.toBe(JobStatus.Success);
        expect(mocks.media.transcode).not.toHaveBeenCalled();
      });

      it('skips anything that is not a video', async () => {
        mocks.asset.getForVideo.mockResolvedValue(undefined);
        await expect(sut.handleWarmFilmstrip({ id: assetId })).resolves.toBe(JobStatus.Skipped);
      });
    });

    describe('handleVideoFingerprint (FL-651)', () => {
      const index = {
        assetId,
        version,
        durationMs: 2000,
        frameWidth: 320,
        frameHeight: 180,
        frames: [
          { index: 0, timeMs: 500, x: 0, y: 0 },
          { index: 1, timeMs: 1500, x: 320, y: 0 },
        ],
      };

      beforeEach(() => {
        mocks.assetJob.getForVideoDuplicateFrameJob.mockResolvedValue({
          id: assetId,
          ownerId,
          visibility: AssetVisibility.Timeline,
        } as never);
        mocks.storage.readFile.mockResolvedValue(Buffer.from(JSON.stringify(index)));
        mocks.duplicateRepository.upsertVideoFingerprint.mockResolvedValue();
      });

      it("hashes every frame of the seek-bar filmstrip and removes the retired check's frames", async () => {
        const rising = Array.from({ length: 72 }, (_, pixel) => (pixel % 9) * 20);
        const black = Array.from({ length: 72 }, () => 0);
        mocks.media.filmstripFrameGrids.mockResolvedValue([rising, black]);
        mocks.storage.checkFileExists.mockImplementation((path) =>
          Promise.resolve(!path.includes('_video_duplicate_7')),
        );

        await expect(sut.handleVideoFingerprint({ id: assetId })).resolves.toBe(JobStatus.Success);

        expect(mocks.media.transcode).not.toHaveBeenCalled();
        expect(mocks.media.filmstripFrameGrids).toHaveBeenCalledWith(`${folder}/filmstrip-${version}-120x180.jpg`, [
          { left: 0, top: 0, width: 320, height: 180 },
          { left: 320, top: 0, width: 320, height: 180 },
        ]);
        expect(mocks.duplicateRepository.upsertVideoFingerprint).toHaveBeenCalledWith({
          assetId,
          durationMs: 2000,
          hashes: ['-1', null],
        });
        const { files } = (mocks.job.queue.mock.calls[0][0] as { data: { files: string[] } }).data;
        expect(files).toHaveLength(7);
        expect(files[0]).toMatch(new RegExp(String.raw`${assetId}_video_duplicate_0\.jpeg$`));
      });

      it('video fingerprint skips encrypted files', async () => {
        // FL-721 (spec §8.3): a sealed video (FLLK) is never decoded for a fingerprint
        const directory = await mkdtemp(join(tmpdir(), 'fingerprint-locked-'));
        const sealed = join(directory, 'video.mp4');
        await writeFile(sealed, Buffer.concat([Buffer.from('FLLK'), Buffer.alloc(64, 1)]));
        try {
          mocks.asset.getForVideo.mockResolvedValue({
            ownerId,
            originalPath: sealed,
            encodedVideoPath: null,
            editedVideoPath: null,
          });
          mocks.media.filmstripFrameGrids.mockResolvedValue([]);

          await expect(sut.handleVideoFingerprint({ id: assetId })).resolves.toBe(JobStatus.Skipped);

          expect(mocks.media.probe).not.toHaveBeenCalled();
          expect(mocks.media.transcode).not.toHaveBeenCalled();
          expect(mocks.media.filmstripFrameGrids).not.toHaveBeenCalled();
          expect(mocks.duplicateRepository.upsertVideoFingerprint).not.toHaveBeenCalled();
        } finally {
          await rm(directory, { recursive: true, force: true });
        }
      });

      it('skips locked videos', async () => {
        mocks.assetJob.getForVideoDuplicateFrameJob.mockResolvedValue({
          id: assetId,
          ownerId,
          visibility: AssetVisibility.Locked,
        } as never);
        await expect(sut.handleVideoFingerprint({ id: assetId })).resolves.toBe(JobStatus.Skipped);
        expect(mocks.duplicateRepository.upsertVideoFingerprint).not.toHaveBeenCalled();
      });
    });

    it('refuses a sprite for an index of an earlier version of the video', async () => {
      await expect(
        sut.viewFilmstripSprite(authStub.admin, assetId, { version: '0123456789abcdef' }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it('drops caches made from an earlier version of the video', async () => {
      mocks.media.probe.mockResolvedValue(videoInfo(false));
      mocks.storage.readdir.mockResolvedValue([
        'filmstrip-aaaaaaaaaaaaaaaa-20x90.jpg',
        'waveform-aaaaaaaaaaaaaaaa-mono.bin',
        `waveform-${version}-mono.bin`,
        '.work-in-progress',
      ]);
      await sut.getFilmstrip(authStub.admin, assetId, { count: 1 });
      expect(mocks.storage.unlink).toHaveBeenCalledWith(`${folder}/filmstrip-aaaaaaaaaaaaaaaa-20x90.jpg`);
      expect(mocks.storage.unlink).toHaveBeenCalledWith(`${folder}/waveform-aaaaaaaaaaaaaaaa-mono.bin`);
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith(`${folder}/waveform-${version}-mono.bin`);
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith(`${folder}/.work-in-progress`);
    });

    it('is 404 when no frame could be cut', async () => {
      mocks.media.probe.mockResolvedValue(videoInfo(false));
      mocks.media.transcode.mockRejectedValue(new Error('ffmpeg failed'));
      await expect(sut.getFilmstrip(authStub.admin, assetId, { count: 2 })).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.media.composeFilmstrip).not.toHaveBeenCalled();
    });

    it('shares one generation between concurrent requests', async () => {
      mocks.media.probe.mockResolvedValue(videoInfo(false));
      await Promise.all([
        sut.getFilmstrip(authStub.admin, assetId, { count: 2 }),
        sut.getFilmstrip(authStub.admin, assetId, { count: 2 }),
      ]);
      expect(mocks.media.composeFilmstrip).toHaveBeenCalledTimes(1);
    });

    it('fills a missing frame from its neighbour', () => {
      expect(fillMissingFrames([null, 'a', null, 'b', null])).toEqual(['a', 'a', 'a', 'b', 'b']);
      expect(fillMissingFrames([null, null])).toBeNull();
    });
  });

  describe('waveform', () => {
    it('decodes the first audio track, caches the peaks and resamples them', async () => {
      mocks.media.probe.mockResolvedValue(videoInfo(true));
      mocks.media.transcode.mockImplementation((_input, output) => {
        const samples = Buffer.alloc(8000 * 2);
        samples.writeInt16LE(16_384, 0);
        samples.writeInt16LE(-32_768, 2);
        (output as Writable).write(samples);
        return Promise.resolve();
      });

      const result = await sut.getWaveform(authStub.admin, assetId, { buckets: 4 });

      expect(mocks.media.transcode).toHaveBeenCalledWith(
        encodedPath,
        expect.any(Writable),
        expect.objectContaining({ outputOptions: expect.arrayContaining(['-map', '0:1', '-ac', '1']) }),
      );
      const cachePath = `${folder}/waveform-${version}-mono.bin`;
      expect(mocks.storage.createOrOverwriteFile).toHaveBeenCalledWith(
        expect.stringMatching(/\.tmp$/),
        expect.any(Buffer),
      );
      expect(mocks.storage.rename).toHaveBeenCalledWith(expect.stringMatching(/\.tmp$/), cachePath);
      expect(result).toEqual({
        assetId,
        version,
        hasAudio: true,
        durationMs: 1000,
        bucketCount: 4,
        bucketDurationMs: 250,
        channels: [{ min: [-1, 0, 0, 0], max: [0.5, 0, 0, 0] }],
      });
    });

    it('decodes every channel when asked', async () => {
      mocks.media.probe.mockResolvedValue(videoInfo(true));
      mocks.media.transcode.mockResolvedValue();
      await sut.getWaveform(authStub.admin, assetId, { channels: 'all' });
      expect(mocks.media.transcode.mock.calls[0][2].outputOptions).toEqual(expect.arrayContaining(['-ac', '2']));
      expect(mocks.storage.rename).toHaveBeenCalledWith(expect.any(String), `${folder}/waveform-${version}-all.bin`);
    });

    it('returns an empty result for a video without audio, and remembers it', async () => {
      mocks.media.probe.mockResolvedValue(videoInfo(false));
      await expect(sut.getWaveform(authStub.admin, assetId, {})).resolves.toEqual({
        assetId,
        version,
        hasAudio: false,
        durationMs: 0,
        bucketCount: 0,
        bucketDurationMs: 0,
        channels: [],
      });
      expect(mocks.media.transcode).not.toHaveBeenCalled();
      expect(mocks.storage.createOrOverwriteFile).toHaveBeenCalled();
    });

    it('serves cached peaks without probing', async () => {
      const accumulator = new PeakAccumulator(1, 1);
      accumulator.write(Buffer.from([0, 64]));
      mocks.storage.readFile.mockResolvedValue(encodeWaveformPeaks(accumulator.finish()));
      await expect(sut.getWaveform(authStub.admin, assetId, {})).resolves.toMatchObject({
        hasAudio: true,
        bucketCount: 1,
        channels: [{ min: [0.5], max: [0.5] }],
      });
      expect(mocks.media.probe).not.toHaveBeenCalled();
    });
  });

  it('removes the cache with the asset', async () => {
    await sut.onAssetDelete({ assetId, userId: ownerId });
    expect(mocks.storage.unlinkDir).toHaveBeenCalledWith(folder, { recursive: true, force: true });
  });
});
