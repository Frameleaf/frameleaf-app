import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Stats } from 'node:fs';
import { Writable } from 'node:stream';
import { setImmediate } from 'node:timers/promises';
import { CacheControl } from 'src/enum.js';
import { StudioMediaService, fillMissingFrames, getStudioMediaFolder } from 'src/services/studio-media.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { executionSignal } from 'src/utils/execution-signal.js';
import { FileDownloadResponse } from 'src/utils/file.js';
import { sourceOriginalPath } from 'src/utils/source-original.js';
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

  describe('reference timeline originals', () => {
    const reference = () => {
      const path = sourceOriginalPath({ sourceId: assetId, resourceKey: 'b'.repeat(64) });
      mocks.asset.getForVideo.mockResolvedValue({
        ownerId,
        originalPath: path,
        encodedVideoPath: null,
        editedVideoPath: null,
      });
      mocks.media.probe.mockResolvedValue(videoInfo(false));
      const abort = new AbortController();
      const input = {
        localPath: '/private/source.artifact',
        resourceId: assetId,
        resourceVersion: 'e'.repeat(64),
        verifiedSha256: 'd'.repeat(64),
        byteLength: 100,
        signal: abort.signal,
        check: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
      };
      const originals = {
        open: vi.fn(async (_id: string, _reader: unknown, authorize: () => Promise<void>, _signal?: AbortSignal) => {
          await authorize();
          return input;
        }),
      };
      Object.assign(sut, { sourceOriginalService: originals });
      return { path, input, originals, abort };
    };

    it('shares one verified input across identical filmstrip requests and joins its release after publication', async () => {
      const f = reference();
      mocks.media.composeFilmstrip.mockImplementation(() => {
        expect(f.input.release).not.toHaveBeenCalled();
        return Promise.resolve();
      });
      const results = await Promise.all([
        sut.getFilmstrip(authStub.admin, assetId, { count: 2 }),
        sut.getFilmstrip(authStub.admin, assetId, { count: 2 }),
      ]);
      expect(f.originals.open).toHaveBeenCalledOnce();
      expect(mocks.media.probe).toHaveBeenCalledWith(f.input.localPath);
      expect(mocks.media.transcode.mock.calls.every(([path]) => path === f.input.localPath)).toBe(true);
      expect(mocks.media.transcode).toHaveBeenCalledTimes(2);
      expect(f.input.release).toHaveBeenCalledOnce();
      expect(mocks.storage.stat).not.toHaveBeenCalledWith(f.path);
      expect(results[0].version).toBe(results[1].version);
      expect(JSON.stringify(results)).not.toContain('/private');
    });

    it('keys cached waveform results by verified resource version and digest, not temporary file times', async () => {
      const f = reference();
      mocks.storage.readFile.mockResolvedValue(encodeWaveformPeaks(new PeakAccumulator(1, 1).finish()));
      const first = await sut.getWaveform(authStub.admin, assetId, {});
      f.input.resourceVersion = 'f'.repeat(64);
      const second = await sut.getWaveform(authStub.admin, assetId, {});
      f.input.verifiedSha256 = 'c'.repeat(64);
      const third = await sut.getWaveform(authStub.admin, assetId, {});
      expect(new Set([first.version, second.version, third.version]).size).toBe(3);
      expect(mocks.media.probe).not.toHaveBeenCalled();
      expect(f.input.release).toHaveBeenCalledTimes(3);
      expect(mocks.storage.stat).not.toHaveBeenCalledWith(f.path);
    });

    it('rechecks source authority before publishing a generated filmstrip', async () => {
      const f = reference();
      mocks.media.transcode.mockImplementation(() => {
        f.input.check.mockRejectedValue(new Error('source revoked'));
        return Promise.resolve();
      });
      await expect(sut.getFilmstrip(authStub.admin, assetId, { count: 2 })).rejects.toThrow('source revoked');
      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(f.input.release).toHaveBeenCalledOnce();
    });

    it('retains original and work files without retrying after unconfirmed encoder shutdown', async () => {
      const f = reference();
      mocks.media.transcode.mockRejectedValue(new Error('media_process_shutdown_unconfirmed'));
      await expect(sut.getFilmstrip(authStub.admin, assetId, { count: 2 })).rejects.toThrow(
        'media_process_shutdown_unconfirmed',
      );
      expect(mocks.media.transcode).toHaveBeenCalledOnce();
      expect(f.input.release).not.toHaveBeenCalled();
      expect(mocks.storage.unlinkDir).not.toHaveBeenCalled();
      expect(mocks.storage.rename).not.toHaveBeenCalled();
      await expect(sut.getFilmstrip(authStub.admin, assetId, { count: 2 })).rejects.toThrow('generation is stopping');
      expect(f.originals.open).toHaveBeenCalledOnce();
      expect(mocks.media.transcode).toHaveBeenCalledOnce();
    });

    it.each(['confirmed', 'unconfirmed'] as const)(
      'joins active work before asset deletion and retains %s shutdown ownership',
      async (shutdown) => {
        const f = reference();
        const { promise: started, resolve: start } = Promise.withResolvers<void>();
        const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
        let nativeSignal: AbortSignal | undefined;
        mocks.media.transcode.mockImplementation(() => {
          nativeSignal = executionSignal();
          start();
          return stopped.then(() => {
            if (shutdown === 'unconfirmed') throw new Error('media_process_shutdown_unconfirmed');
            nativeSignal?.throwIfAborted();
          });
        });
        const result = sut.getFilmstrip(authStub.admin, assetId, { count: 1 });
        const rejected = expect(result).rejects.toThrow();
        await started;
        const deletion = sut.onAssetDelete({ assetId, userId: ownerId });
        try {
          await setImmediate();
          expect(nativeSignal?.aborted).toBe(true);
          expect(mocks.storage.unlinkDir).not.toHaveBeenCalledWith(folder, expect.anything());
          expect(f.input.release).not.toHaveBeenCalled();
        } finally {
          stop();
          await Promise.all([rejected, deletion]);
        }
        if (shutdown === 'confirmed') {
          expect(f.input.release).toHaveBeenCalledOnce();
          expect(mocks.storage.unlinkDir).toHaveBeenCalledWith(folder, { recursive: true, force: true });
        } else {
          expect(f.input.release).not.toHaveBeenCalled();
          expect(mocks.storage.unlinkDir).not.toHaveBeenCalled();
          await sut.onAssetDelete({ assetId, userId: ownerId });
          expect(mocks.storage.unlinkDir).not.toHaveBeenCalled();
        }
      },
    );

    it('retains quarantined generation when its asset is deleted later', async () => {
      const f = reference();
      mocks.media.transcode.mockRejectedValue(new Error('media_process_shutdown_unconfirmed'));
      await expect(sut.getFilmstrip(authStub.admin, assetId, { count: 1 })).rejects.toThrow('shutdown_unconfirmed');
      await sut.onAssetDelete({ assetId, userId: ownerId });
      expect(mocks.storage.unlinkDir).not.toHaveBeenCalled();
      expect(f.input.release).not.toHaveBeenCalled();
    });

    it.each(['write', 'recheck'])('cleans only its private waveform staging file after %s failure', async (failure) => {
      const f = reference();
      mocks.storage.createOrOverwriteFile.mockImplementation(() => {
        if (failure === 'write') return Promise.reject(new Error('waveform write failed'));
        f.input.check.mockRejectedValue(new Error('source revoked'));
        return Promise.resolve();
      });
      await expect(sut.getWaveform(authStub.admin, assetId, {})).rejects.toThrow();
      expect(mocks.storage.rename).not.toHaveBeenCalled();
      expect(mocks.storage.unlink).toHaveBeenCalledExactlyOnceWith(expect.stringMatching(/waveform-.*[.]tmp$/));
      expect(mocks.storage.unlink).not.toHaveBeenCalledWith(f.input.localPath);
      expect(f.input.release).toHaveBeenCalledOnce();
    });

    it('does not cancel shared processing when one of two waiters disconnects', async () => {
      const f = reference();
      const first = new AbortController();
      const { promise: started, resolve: start } = Promise.withResolvers<void>();
      const { promise: held, resolve: finish } = Promise.withResolvers<void>();
      let nativeSignal: AbortSignal | undefined;
      mocks.media.transcode.mockImplementation(() => {
        nativeSignal = executionSignal();
        start();
        return held;
      });
      const a = sut.getFilmstrip(authStub.admin, assetId, { count: 1 }, first.signal);
      const b = sut.getFilmstrip(authStub.admin, assetId, { count: 1 });
      const rejected = expect(a).rejects.toThrow();
      await started;
      first.abort();
      await rejected;
      expect(nativeSignal?.aborted).toBe(false);
      expect(f.input.release).not.toHaveBeenCalled();
      finish();
      await expect(b).resolves.toMatchObject({ assetId });
      expect(f.input.release).toHaveBeenCalledOnce();
    });

    it('keeps each borrowed input until its own native work stops across index and sprite requests', async () => {
      const f = reference();
      const abort = new AbortController();
      const inputs: (typeof f.input)[] = [];
      f.originals.open.mockImplementation(async (_id, _reader, authorize, signal) => {
        await authorize();
        const input = { ...f.input, signal: signal!, release: vi.fn().mockResolvedValue(undefined) };
        inputs.push(input);
        return input;
      });
      const { promise: started, resolve: start } = Promise.withResolvers<void>();
      const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
      mocks.media.transcode.mockImplementation(() => {
        const signal = executionSignal();
        start();
        return stopped.then(() => {
          signal?.throwIfAborted();
        });
      });
      const a = sut.getFilmstrip(authStub.admin, assetId, { count: 1 }, abort.signal);
      const rejected = expect(a).rejects.toThrow();
      const b = sut.viewFilmstripSprite(authStub.admin, assetId, { count: 1 });
      const outcome = b.then((value) => ({ value })).catch((error: unknown) => ({ error }));
      try {
        await started;
        await setImmediate();
        expect(inputs).toHaveLength(2);
        abort.abort();
        await setImmediate();
        expect(inputs[0].release).not.toHaveBeenCalled();
        stop();
        await rejected;
        expect(await outcome).toHaveProperty('value');
        expect(inputs.every((input) => input.release.mock.calls.length === 1)).toBe(true);
      } finally {
        stop();
        await Promise.allSettled([a, b, rejected]);
      }
    });

    it('joins native shutdown before releasing the last canceled waiter input', async () => {
      const f = reference();
      const abort = new AbortController();
      const { promise: started, resolve: start } = Promise.withResolvers<void>();
      const { promise: stopped, resolve: stop } = Promise.withResolvers<void>();
      mocks.media.transcode.mockImplementation(() => {
        start();
        return stopped.then(() => {
          executionSignal()?.throwIfAborted();
        });
      });
      const result = sut.getFilmstrip(authStub.admin, assetId, { count: 1 }, abort.signal);
      const rejected = expect(result).rejects.toThrow();
      await started;
      abort.abort();
      await Promise.resolve();
      expect(f.input.release).not.toHaveBeenCalled();
      stop();
      await rejected;
      expect(f.input.release).toHaveBeenCalledOnce();
      expect(mocks.storage.rename).not.toHaveBeenCalled();
    });
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

  it('removes canceled capacity waiters without starting their work', async () => {
    const limited = (work: () => Promise<void>, signal?: AbortSignal) =>
      (sut as unknown as { limited: (work: () => Promise<void>, signal?: AbortSignal) => Promise<void> }).limited(
        work,
        signal,
      );
    const { promise: held, resolve: finish } = Promise.withResolvers<void>();
    const active = [limited(() => held), limited(() => held)];
    const abort = new AbortController();
    const queued = vi.fn(() => Promise.resolve());
    const result = limited(queued, abort.signal);
    const rejected = expect(result).rejects.toThrow();
    abort.abort();
    await rejected;
    expect(queued).not.toHaveBeenCalled();
    finish();
    await Promise.all(active);
    await limited(queued);
    expect(queued).toHaveBeenCalledOnce();
  });

  it('keeps capacity reserved while native shutdown is unconfirmed', async () => {
    const limited = (work: () => Promise<void>, signal?: AbortSignal) =>
      (sut as unknown as { limited: (work: () => Promise<void>, signal?: AbortSignal) => Promise<void> }).limited(
        work,
        signal,
      );
    for (let index = 0; index < 2; index++)
      await expect(limited(() => Promise.reject(new Error('media_process_shutdown_unconfirmed')))).rejects.toThrow(
        'shutdown_unconfirmed',
      );
    const abort = new AbortController();
    const work = vi.fn(() => Promise.resolve());
    const result = limited(work, abort.signal);
    const rejected = expect(result).rejects.toThrow();
    abort.abort();
    await rejected;
    expect(work).not.toHaveBeenCalled();
  });

  describe('filmstrip', () => {
    it('retains encoder-owned work and stops the frame loop when shutdown is unconfirmed', async () => {
      mocks.media.probe.mockResolvedValue(videoInfo(false));
      mocks.media.transcode.mockRejectedValue(new Error('media_process_shutdown_unconfirmed'));
      await expect(sut.getFilmstrip(authStub.admin, assetId, { count: 4, height: 90 })).rejects.toThrow(
        'media_process_shutdown_unconfirmed',
      );
      expect(mocks.media.transcode).toHaveBeenCalledOnce();
      expect(mocks.storage.unlinkDir).not.toHaveBeenCalled();
      expect(mocks.media.composeFilmstrip).not.toHaveBeenCalled();
    });
    it('cuts frames from the playback rendition, never the original, and composes a sprite', async () => {
      mocks.media.probe.mockResolvedValue(videoInfo(false));
      const index = await sut.getFilmstrip(authStub.admin, assetId, { count: 4, height: 90 });

      expect(mocks.media.transcode).toHaveBeenCalledTimes(4);
      for (const call of mocks.media.transcode.mock.calls) {
        expect(call[0]).toBe(encodedPath);
      }
      expect(mocks.media.transcode.mock.calls.map((call) => call[2].inputOptions)).toEqual([
        ['-ss', '1.250'],
        ['-ss', '3.750'],
        ['-ss', '6.250'],
        ['-ss', '8.750'],
      ]);
      expect(mocks.media.composeFilmstrip).toHaveBeenCalledWith(
        expect.arrayContaining([expect.stringMatching(/\.work-.*\/0\.jpg$/)]),
        expect.objectContaining({ columns: 4, rows: 1, tileWidth: 160, tileHeight: 90, format: 'jpeg' }),
      );
      const spritePath = `${folder}/filmstrip-${version}-4x90.jpg`;
      expect(mocks.storage.rename).toHaveBeenCalledWith(expect.stringContaining('/.work-'), spritePath);
      expect(mocks.storage.createOrOverwriteFile).toHaveBeenCalledWith(
        expect.stringMatching(/[.]work-.*\/index[.]json$/),
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

    it('stages its index privately before atomically publishing the cache entry', async () => {
      mocks.media.probe.mockResolvedValue(videoInfo(false));
      await sut.getFilmstrip(authStub.admin, assetId, { count: 1 });
      expect(mocks.storage.createOrOverwriteFile).toHaveBeenCalledWith(
        expect.stringMatching(/[.]work-.*\/index[.]json$/),
        expect.any(Buffer),
      );
      expect(mocks.storage.rename).toHaveBeenCalledWith(
        expect.stringMatching(/[.]work-.*\/index[.]json$/),
        `${folder}/filmstrip-${version}-1x90.jpeg.json`,
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
