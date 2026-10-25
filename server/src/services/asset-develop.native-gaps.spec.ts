import { BadRequestException, ConflictException, ServiceUnavailableException } from '@nestjs/common';
import { copyFile, mkdtemp, readFile, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { AssetDevelopArtifactKind } from 'src/dtos/asset-develop.dto.js';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetType, AssetVisibility, Colorspace } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { assertPublicationMotionSource } from 'src/queue/transaction.js';
import { InpaintUnavailableError } from 'src/repositories/machine-learning.repository.js';
import { AssetDevelopService } from 'src/services/asset-develop.service.js';
import { renderDarktable } from 'src/utils/darktable-renderer.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { renderRawWithLibRaw } from 'src/utils/raw-renderer.js';
import { sourceOriginalPath } from 'src/utils/source-original.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForGenerateThumbnail } from 'test/mappers.js';
import { getMocks } from 'test/utils.js';

vi.mock('src/utils/raw-renderer.js', async (original) => ({
  ...(await original<typeof import('src/utils/raw-renderer.js')>()),
  renderRawWithLibRaw: vi.fn(),
}));

vi.mock('src/utils/darktable-renderer.js', async (original) => ({
  ...(await original<typeof import('src/utils/darktable-renderer.js')>()),
  renderDarktable: vi.fn(),
}));

type Admits = { admitGeneratedArtifact: (...args: unknown[]) => Promise<unknown> };

/** Native API gaps: Live/Motion Photo key frames, version 1 subject/sky proposals and server fills. */
describe('AssetDevelopService native API gaps', () => {
  const mocks = getMocks();
  let sut: AssetDevelopService;
  let folder: string;
  let originalPath: string;
  const still = AssetFactory.from({ ownerId: authStub.user1.user.id, type: AssetType.Image })
    .exif({ orientation: null, colorspace: 'sRGB', exifImageWidth: 400, exifImageHeight: 300 })
    .build();
  const motionId = '0b9f8d1e-0000-4000-8000-000000000001';

  beforeAll(async () => {
    folder = await mkdtemp(path.join(tmpdir(), 'native-gaps-spec-'));
    originalPath = path.join(folder, 'IMG_0001.jpg');
    await sharp({ create: { width: 400, height: 300, channels: 3, background: { r: 90, g: 120, b: 200 } } })
      .jpeg()
      .toFile(originalPath);
    await copyFile(originalPath, path.join(folder, 'borrowed.artifact'));
  });
  afterAll(() => rm(folder, { recursive: true, force: true }));

  beforeEach(() => {
    vi.clearAllMocks();
    mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([still.id]));
    mocks.asset.getById.mockImplementation((id) =>
      Promise.resolve({
        ...still,
        id,
        originalPath,
        livePhotoVideoId: id === still.id ? motionId : null,
        visibility: id === motionId ? AssetVisibility.Hidden : AssetVisibility.Timeline,
      } as never),
    );
    mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue({ ...getForGenerateThumbnail(still), originalPath });
    mocks.assetJob.getForVideoConversion.mockResolvedValue({
      id: motionId,
      ownerId: still.ownerId,
      originalPath: '/library/IMG_0001.mov',
      videoStream: { index: 0, codecName: 'hevc', colorTransfer: 'bt709' },
      format: { duration: 2500 },
    } as never);
    mocks.systemMetadata.get.mockResolvedValue({});
    mocks.media.decodeImage.mockResolvedValue({
      data: Buffer.alloc(4 * 4 * 3),
      info: { width: 4, height: 4, channels: 3 },
    } as never);
    sut = new AssetDevelopService(
      mocks.logger as never,
      mocks.access as never,
      mocks.asset as never,
      mocks.assetJob as never,
      {} as never,
      mocks.config as never,
      mocks.crypto as never,
      mocks.job as never,
      mocks.media as never,
      {} as never,
      mocks.storage as never,
      mocks.systemMetadata as never,
      mocks.mediaOperation as never,
      mocks.machineLearning as never,
    );
  });

  describe('keyFrame (Live and Motion Photos)', () => {
    it('fails closed when motion adoption has no database transaction', async () => {
      await expect(
        assertPublicationMotionSource(still.id, still.ownerId, still.checksum, motionId, Buffer.alloc(20, 4)),
      ).rejects.toThrow('Motion publication requires a database transaction');
    });

    it('decodes the still from the motion clip frame at the key frame time', async () => {
      const source = { ...getForGenerateThumbnail(still), originalPath };
      const result = await sut['decodeSource'](source, defaults.image, 1280, { timeMs: 1200 });
      expect(mocks.assetJob.getForVideoConversion).toHaveBeenCalledWith(motionId);
      const [input, output, command] = mocks.media.transcode.mock.calls[0];
      expect(input).toBe('/library/IMG_0001.mov');
      expect(String(output)).toMatch(/frame\.png$/);
      expect(command.inputOptions).toEqual(['-ss', '1.200']);
      expect(command.outputOptions).toEqual(expect.arrayContaining(['-frames:v', '1', '-c:v', 'png']));
      expect(mocks.media.decodeImage).toHaveBeenCalledWith(output, expect.objectContaining({ size: 1280 }));
      expect(mocks.media.inspectImageEncoding).not.toHaveBeenCalled();
      expect(result.colorspace).toBe(Colorspace.Srgb);
    });

    it('authorizes the linked clip separately before preview decoding', async () => {
      await expect(
        sut.preview(authStub.user1, still.id, {
          recipe: { ...defaultDevelopRecipe(), keyFrame: { timeMs: 1000 } },
          size: 100,
        }),
      ).rejects.toThrow();
      expect(mocks.access.asset.checkOwnerAccess).toHaveBeenCalledWith(
        authStub.user1.user.id,
        new Set([motionId]),
        undefined,
      );
      expect(mocks.media.transcode).not.toHaveBeenCalled();
    });

    it.each([{ isLocked: true }, { deletedAt: new Date() }, { isOffline: true }])(
      'refuses an unavailable motion clip in background decoding: %j',
      async (state) => {
        mocks.asset.getById.mockImplementation((id) =>
          Promise.resolve({ ...still, id, livePhotoVideoId: motionId, ...state } as never),
        );
        await expect(
          sut['decodeSource'](getForGenerateThumbnail(still), defaults.image, 1280, { timeMs: 0 }),
        ).rejects.toThrow();
        expect(mocks.media.transcode).not.toHaveBeenCalled();
      },
    );

    it('reads the stored duration in milliseconds', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({
        id: motionId,
        ownerId: still.ownerId,
        originalPath: '/library/IMG_0001.mov',
        format: { duration: 2501 },
      } as never);
      await expect(sut['requireMotionClip'](still, 2501)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'develop_key_frame_out_of_range' }),
      });
      await expect(sut['requireMotionClip'](still, 2500)).resolves.toBeDefined();
    });

    it('refuses a key frame for a photo without a motion clip', async () => {
      mocks.asset.getById.mockResolvedValue({ ...still, livePhotoVideoId: null } as never);
      await expect(sut['requireMotionClip'](still, 0)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'develop_key_frame_unavailable' }),
      });
    });

    it("refuses another owner's clip and a time past the end", async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValueOnce({
        ownerId: 'someone-else',
        format: { duration: 2500 },
      } as never);
      await expect(sut['requireMotionClip'](still, 0)).rejects.toBeInstanceOf(BadRequestException);
      await expect(sut['requireMotionClip'](still, 2600)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'develop_key_frame_out_of_range' }),
      });
      await expect(sut['requireMotionClip'](still, 2500)).rejects.toMatchObject({
        response: expect.objectContaining({ code: 'develop_key_frame_out_of_range' }),
      });
      await expect(sut['requireMotionClip'](still, 2499)).resolves.toBeDefined();
    });
  });

  describe('subject and sky proposals in original coordinates', () => {
    it('keeps the RAW-only sensor behaviour when coordinates are omitted', async () => {
      await expect(sut.proposeSemanticMask(authStub.user1, still.id, { target: 'subject' })).rejects.toThrow(
        'Native semantic masks require a RAW original',
      );
      expect(mocks.machineLearning.semanticMaskLocal).not.toHaveBeenCalled();
    });

    it('proposes on any still and admits the mask as an artifact covering the whole original', async () => {
      mocks.machineLearning.semanticMaskLocal.mockImplementation(async (canvas: Buffer) => {
        const { width, height } = await sharp(canvas).metadata();
        return sharp({ create: { width: width!, height: height!, channels: 3, background: '#fff' } })
          .toColourspace('b-w')
          .png()
          .toBuffer();
      });
      const admitted = { id: 'a'.repeat(64), kind: AssetDevelopArtifactKind.Mask, width: 400, height: 300 };
      const admit = vi.spyOn(sut as unknown as Admits, 'admitGeneratedArtifact').mockResolvedValue(admitted as never);
      await expect(
        sut.proposeSemanticMask(authStub.user1, still.id, { target: 'sky', coordinates: 'original' }),
      ).resolves.toEqual(admitted);
      const [canvas, target] = mocks.machineLearning.semanticMaskLocal.mock.calls[0];
      expect(target).toBe('sky');
      expect(await sharp(canvas).metadata()).toMatchObject({ format: 'jpeg', width: 400, height: 300 });
      expect(admit).toHaveBeenCalledWith(
        authStub.user1,
        still.id,
        AssetDevelopArtifactKind.Mask,
        expect.any(Buffer),
        undefined,
      );
      expect(renderRawWithLibRaw).not.toHaveBeenCalled();
    });

    it('refuses a worker mask that does not match the canvas', async () => {
      mocks.machineLearning.semanticMaskLocal.mockResolvedValue(
        await sharp({ create: { width: 10, height: 10, channels: 3, background: '#000' } })
          .toColourspace('b-w')
          .png()
          .toBuffer(),
      );
      await expect(
        sut.proposeSemanticMask(authStub.user1, still.id, { target: 'subject', coordinates: 'original' }),
      ).rejects.toThrow('invalid mask');
    });
  });

  describe('Clean Up Remove fills', () => {
    const region = { region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 }, feather: 0 };

    it('sends the area with context and its mask, and admits the bounding box as a fill', async () => {
      mocks.machineLearning.inpaintLocal.mockImplementation(async (image: Buffer) => {
        const { width, height } = await sharp(image).metadata();
        return sharp({ create: { width: width!, height: height!, channels: 3, background: { r: 1, g: 2, b: 3 } } })
          .png()
          .toBuffer();
      });
      const admit = vi
        .spyOn(sut as unknown as Admits, 'admitGeneratedArtifact')
        .mockResolvedValue({ id: 'f'.repeat(64), kind: AssetDevelopArtifactKind.Fill } as never);
      await sut.generateFill(authStub.user1, still.id, region);
      const [image, mask] = mocks.machineLearning.inpaintLocal.mock.calls[0];
      // box 100..300 × 75..225 with half its longer side (100) as context, clamped to the 400 × 300 original
      expect(await sharp(image).metadata()).toMatchObject({ format: 'png', width: 400, height: 300 });
      expect(await sharp(mask).metadata()).toMatchObject({ format: 'png', channels: 1 });
      const maskPixels = await sharp(mask).extractChannel(0).raw().toBuffer({ resolveWithObject: true });
      expect(maskPixels.info).toMatchObject({ width: 400, height: 300, channels: 1 });
      expect(maskPixels.data[150 * 400 + 200]).toBe(255);
      expect(maskPixels.data[10 * 400 + 10]).toBe(0);
      const call = admit.mock.calls[0] as unknown as [unknown, unknown, AssetDevelopArtifactKind, Buffer];
      const kind = call[2];
      const png = call[3];
      expect(kind).toBe(AssetDevelopArtifactKind.Fill);
      expect(await sharp(png).metadata()).toMatchObject({ width: 200, height: 150, channels: 4 });
    });

    it('answers 503 develop_inpaint_unavailable while no inpainting model exists', async () => {
      mocks.machineLearning.inpaintLocal.mockRejectedValue(new InpaintUnavailableError('unknown task (422)'));
      const error = await sut.generateFill(authStub.user1, still.id, region).catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(ServiceUnavailableException);
      expect((error as ServiceUnavailableException).getResponse()).toMatchObject({
        code: 'develop_inpaint_unavailable',
      });
    });
  });

  describe('reference helper originals', () => {
    const referenceFixture = () => {
      vi.mocked(renderRawWithLibRaw).mockReset();
      vi.mocked(renderDarktable).mockReset();
      const source = {
        ...getForGenerateThumbnail(still),
        originalPath: sourceOriginalPath({ sourceId: still.id, resourceKey: 'b'.repeat(64) }),
      };
      mocks.assetJob.getForGenerateThumbnailJob.mockResolvedValue(source);
      mocks.asset.getById.mockResolvedValue({ ...still, originalPath: source.originalPath } as never);
      const reference = { resourceId: still.id, version: 'c'.repeat(64), sha256: 'd'.repeat(64) };
      const snapshot = {
        assetId: still.id,
        path: source.originalPath,
        checksum: source.checksum.toString('hex'),
        reference,
      };
      const binding = { kind: 'bound', parent: snapshot, input: snapshot };
      const input = {
        localPath: path.join(folder, 'borrowed.artifact'),
        resourceId: reference.resourceId,
        resourceVersion: reference.version,
        verifiedSha256: reference.sha256,
        signal: new AbortController().signal,
        check: vi.fn(),
        release: vi.fn().mockResolvedValue(undefined),
      };
      const originals = {
        open: vi.fn(async (_id, _reader, authorize: () => Promise<void>) => {
          input.check.mockImplementation(authorize);
          await authorize();
          return input;
        }),
      };
      Object.assign(sut, {
        sourceOriginalService: originals,
        assetDevelopRepository: {
          getSourceBinding: vi.fn().mockResolvedValue(binding),
          assertRenderSource: vi.fn().mockResolvedValue({
            assetId: source.id,
            ownerId: source.ownerId,
            derivatives: false,
            checksum: source.checksum.toString('hex'),
            revision: {},
          }),
        },
      });
      mocks.machineLearning.semanticMaskLocal.mockImplementation(async (canvas: Buffer) => {
        const { width, height } = await sharp(canvas).metadata();
        return sharp({ create: { width: width!, height: height!, channels: 3, background: '#fff' } })
          .toColourspace('b-w')
          .png()
          .toBuffer();
      });
      mocks.machineLearning.inpaintLocal.mockImplementation(async (canvas: Buffer) => {
        const { width, height } = await sharp(canvas).metadata();
        return sharp({ create: { width: width!, height: height!, channels: 3, background: '#fff' } })
          .png()
          .toBuffer();
      });
      const admit = vi.spyOn(sut as unknown as Admits, 'admitGeneratedArtifact').mockImplementation((...args) => {
        expect(input.release).not.toHaveBeenCalled();
        return Promise.resolve({ id: 'a'.repeat(64), kind: args[2] });
      });
      return { source, input, originals, admit };
    };

    it.each(['mask', 'fill', 'sensor'] as const)(
      'uses a held opaque original lease for %s generation',
      async (action) => {
        const f = referenceFixture();
        if (action === 'sensor') {
          f.source.originalFileName = 'IMG_0001.CR2';
          vi.mocked(renderDarktable).mockResolvedValue(await readFile(originalPath));
        }
        const result =
          action === 'fill'
            ? await sut.generateFill(authStub.user1, still.id, {
                region: { x: 0.25, y: 0.25, w: 0.5, h: 0.5 },
                feather: 0,
              })
            : await sut.proposeSemanticMask(authStub.user1, still.id, {
                target: 'sky',
                ...(action === 'mask' && { coordinates: 'original' as const }),
              });
        expect(result.id).toBe('a'.repeat(64));
        expect(result.kind).toBe(action === 'fill' ? AssetDevelopArtifactKind.Fill : AssetDevelopArtifactKind.Mask);
        expect(f.originals.open).toHaveBeenCalledOnce();
        expect(f.input.release).toHaveBeenCalledOnce();
        expect(f.admit).toHaveBeenCalledOnce();
        expect(f.admit.mock.calls[0][5]).toMatchObject({
          binding: { kind: 'bound', input: { assetId: still.id } },
          policy: { assetId: still.id, ownerId: still.ownerId },
          check: f.input.check,
        });
        expect(f.source.originalPath).toMatch(/^frameleaf-source:/u);
        if (action === 'sensor')
          expect(renderDarktable).toHaveBeenCalledWith(
            f.input.localPath,
            expect.objectContaining({ sensorCanvas: true }),
            expect.any(AbortSignal),
            undefined,
            'IMG_0001.CR2',
          );
      },
    );

    it('decodes RAW proposals from the borrowed input without changing their source identity', async () => {
      const f = referenceFixture();
      f.source.originalFileName = 'IMG_0001.CR2';
      vi.mocked(renderRawWithLibRaw).mockResolvedValue(await readFile(originalPath));
      await sut.proposeSemanticMask(authStub.user1, still.id, { target: 'sky', coordinates: 'original' });
      expect(renderRawWithLibRaw).toHaveBeenCalledWith(f.input.localPath, expect.any(AbortSignal));
      expect(f.source.originalPath).toMatch(/^frameleaf-source:/u);
      expect(f.input.release).toHaveBeenCalledOnce();
    });

    it.each(['permission', 'provider'] as const)(
      'rechecks %s before admitting the generated bitmap',
      async (changed) => {
        const f = referenceFixture();
        const generate = mocks.machineLearning.semanticMaskLocal.getMockImplementation()!;
        mocks.machineLearning.semanticMaskLocal.mockImplementation(async (...args) => {
          const png = await generate(...args);
          if (changed === 'permission') mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set());
          else f.input.check.mockRejectedValue(new ServiceUnavailableException('source_original_unavailable'));
          return png;
        });
        await expect(
          sut.proposeSemanticMask(authStub.user1, still.id, { target: 'sky', coordinates: 'original' }),
        ).rejects.toBeInstanceOf(changed === 'permission' ? BadRequestException : ServiceUnavailableException);
        expect(f.admit).not.toHaveBeenCalled();
        expect(f.input.release).toHaveBeenCalledOnce();
      },
    );

    it('retains the source and refuses reacquisition after unknown sensor shutdown', async () => {
      const f = referenceFixture();
      f.source.originalFileName = 'IMG_0001.CR2';
      vi.mocked(renderDarktable).mockRejectedValueOnce(new Error('media_process_shutdown_unconfirmed'));
      await expect(sut.proposeSemanticMask(authStub.user1, still.id, { target: 'sky' })).rejects.toThrow(
        'media_process_shutdown_unconfirmed',
      );
      expect(f.input.release).not.toHaveBeenCalled();
      expect(f.admit).not.toHaveBeenCalled();
      await expect(sut.proposeSemanticMask(authStub.user1, still.id, { target: 'sky' })).rejects.toBeInstanceOf(
        ServiceUnavailableException,
      );
      expect(f.originals.open).toHaveBeenCalledOnce();
    });

    it('refuses a false RAW success while its executor has not confirmed stop', async () => {
      const f = referenceFixture();
      f.source.originalFileName = 'IMG_0001.CR2';
      const canvas = await readFile(originalPath);
      const context = { signal: new AbortController().signal, executorStopUnconfirmed: false };
      vi.mocked(renderRawWithLibRaw).mockImplementationOnce(() => {
        context.executorStopUnconfirmed = true;
        return Promise.resolve(canvas);
      });
      await expect(
        queueExecution.run(context as never, () =>
          sut.proposeSemanticMask(authStub.user1, still.id, { target: 'sky', coordinates: 'original' }),
        ),
      ).rejects.toThrow('media_process_shutdown_unconfirmed');
      expect(mocks.machineLearning.semanticMaskLocal).not.toHaveBeenCalled();
      expect(f.input.release).not.toHaveBeenCalled();
      expect(f.admit).not.toHaveBeenCalled();
    });

    it.each(['mask', 'fill', 'sensor'] as const)(
      'does not acquire an original for a pre-canceled %s request',
      async (action) => {
        const f = referenceFixture();
        f.source.originalFileName = 'IMG_0001.CR2';
        const signal = AbortSignal.abort();
        await expect(
          action === 'fill'
            ? sut.generateFill(authStub.user1, still.id, { region: { x: 0, y: 0, w: 0.5, h: 0.5 }, feather: 0 }, signal)
            : sut.proposeSemanticMask(
                authStub.user1,
                still.id,
                { target: 'sky', ...(action === 'mask' && { coordinates: 'original' as const }) },
                signal,
              ),
        ).rejects.toThrow();
        expect(f.originals.open).not.toHaveBeenCalled();
        expect(f.admit).not.toHaveBeenCalled();
      },
    );

    it('propagates source cancellation to RAW work and waits for its rejection before release', async () => {
      const f = referenceFixture();
      f.source.originalFileName = 'IMG_0001.CR2';
      const controller = new AbortController();
      f.input.signal = controller.signal;
      const started = Promise.withResolvers<AbortSignal>();
      vi.mocked(renderRawWithLibRaw).mockImplementationOnce((_path, signal) => {
        started.resolve(signal!);
        return new Promise((_resolve, reject) => {
          signal!.addEventListener('abort', () => reject(signal!.reason), { once: true });
        });
      });
      const result = sut.proposeSemanticMask(authStub.user1, still.id, { target: 'sky', coordinates: 'original' });
      const rejected = expect(result).rejects.toThrow();
      const signal = await started.promise;
      expect(f.input.release).not.toHaveBeenCalled();
      controller.abort();
      expect(signal.aborted).toBe(true);
      await rejected;
      expect(f.input.release).toHaveBeenCalledOnce();
      expect(f.admit).not.toHaveBeenCalled();
    });

    it('joins artifact admission before releasing a canceled request original', async () => {
      const f = referenceFixture();
      const entered = Promise.withResolvers<void>();
      const completed = Promise.withResolvers<unknown>();
      f.admit.mockImplementationOnce(() => {
        entered.resolve();
        return completed.promise;
      });
      const controller = new AbortController();
      const result = sut.proposeSemanticMask(
        authStub.user1,
        still.id,
        { target: 'sky', coordinates: 'original' },
        controller.signal,
      );
      const rejected = expect(result).rejects.toThrow();
      await entered.promise;
      controller.abort();
      expect(f.input.release).not.toHaveBeenCalled();
      completed.resolve({ id: 'a'.repeat(64), kind: AssetDevelopArtifactKind.Mask });
      await rejected;
      expect(f.input.release).toHaveBeenCalledOnce();
    });

    it('refuses mismatched source resources before computing or admitting a mask', async () => {
      const f = referenceFixture();
      f.input.resourceVersion = 'e'.repeat(64);
      await expect(
        sut.proposeSemanticMask(authStub.user1, still.id, { target: 'sky', coordinates: 'original' }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.machineLearning.semanticMaskLocal).not.toHaveBeenCalled();
      expect(f.admit).not.toHaveBeenCalled();
      expect(f.input.release).toHaveBeenCalledOnce();
    });
  });
});
