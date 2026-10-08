import { BadRequestException, ServiceUnavailableException } from '@nestjs/common';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import sharp from 'sharp';
import { AssetDevelopArtifactKind } from 'src/dtos/asset-develop.dto.js';
import { defaults } from 'src/dtos/config.dto.js';
import { AssetType, AssetVisibility, Colorspace } from 'src/enum.js';
import { assertPublicationMotionSource } from 'src/queue/transaction.js';
import { InpaintUnavailableError } from 'src/repositories/machine-learning.repository.js';
import { AssetDevelopService } from 'src/services/asset-develop.service.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { renderRawWithLibRaw } from 'src/utils/raw-renderer.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getForGenerateThumbnail } from 'test/mappers.js';
import { getMocks } from 'test/utils.js';

vi.mock('src/utils/raw-renderer.js', async (original) => ({
  ...(await original<typeof import('src/utils/raw-renderer.js')>()),
  renderRawWithLibRaw: vi.fn(),
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
      format: { duration: 2.5 },
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

    it('does not round fractional duration up to admit an offset after the last frame', async () => {
      mocks.assetJob.getForVideoConversion.mockResolvedValue({
        id: motionId,
        ownerId: still.ownerId,
        format: { duration: 2.5004 },
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
        format: { duration: 2.5 },
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
});
