import type { OutputInfo } from 'sharp';
import { defaults } from 'src/dtos/config.dto.js';
import { Colorspace } from 'src/enum.js';
import { AssetDevelopService } from 'src/services/asset-develop.service.js';
import { RawRenderError, renderRawWithLibRaw } from 'src/utils/raw-renderer.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { getForGenerateThumbnail } from 'test/mappers.js';
import { getMocks } from 'test/utils.js';

vi.mock('src/utils/raw-renderer.js', async (original) => ({
  ...(await original<typeof import('src/utils/raw-renderer.js')>()),
  renderRawWithLibRaw: vi.fn(),
}));

describe('AssetDevelopService sensor source', () => {
  const mocks = getMocks();
  const sensor = Buffer.from('sensor TIFF');
  const pixels = Buffer.from('decoded sensor pixels');
  const info = { width: 2048, height: 3072, channels: 3 } as OutputInfo;
  let sut: AssetDevelopService;
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(renderRawWithLibRaw).mockReset().mockResolvedValue(sensor);
    mocks.media.decodeImage.mockResolvedValue({ data: pixels, info });
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

  it.each([true, false])(
    'uses sensor pixels with embedded extraction %s and enhanced RAW disabled',
    async (extractEmbedded) => {
      const source = getForGenerateThumbnail(
        AssetFactory.from({ originalFileName: 'photo.DNG' })
          .exif({
            orientation: '6',
            colorspace: 'sRGB',
          })
          .build(),
      );
      const image = { ...defaults.image, extractEmbedded, enhancedRaw: { enabled: false } };
      expect(await sut['decodeSource'](source, image, 1536)).toEqual({
        data: pixels,
        info,
        colorspace: Colorspace.Srgb,
      });
      expect(renderRawWithLibRaw).toHaveBeenCalledExactlyOnceWith(source.originalPath, undefined);
      expect(mocks.media.extract).not.toHaveBeenCalled();
      expect(mocks.media.decodeImage).toHaveBeenCalledExactlyOnceWith(sensor, {
        colorspace: Colorspace.Srgb,
        processInvalidImages: false,
        size: 1536,
      });
    },
  );

  it('decodes full sensor resolution for a developed master', async () => {
    const source = getForGenerateThumbnail(AssetFactory.from({ originalFileName: 'photo.CR2' }).exif().build());
    await sut['decodeSource'](source, { ...defaults.image, extractEmbedded: true });
    expect(mocks.media.decodeImage).toHaveBeenCalledWith(sensor, expect.objectContaining({ size: undefined }));
    expect(mocks.media.extract).not.toHaveBeenCalled();
  });

  it('propagates a failed sensor render without substituting a camera JPEG', async () => {
    const source = getForGenerateThumbnail(AssetFactory.from({ originalFileName: 'photo.NEF' }).exif().build());
    const error = new RawRenderError('damaged', 'ERR_RAW_DAMAGED');
    vi.mocked(renderRawWithLibRaw).mockRejectedValue(error);
    await expect(sut['decodeSource'](source, { ...defaults.image, extractEmbedded: true })).rejects.toBe(error);
    expect(renderRawWithLibRaw).toHaveBeenCalledOnce();
    expect(mocks.media.extract).not.toHaveBeenCalled();
    expect(mocks.media.decodeImage).not.toHaveBeenCalled();
  });

  it.each(['photo.jpeg', 'layered.psd'])('preserves successful original decoding for %s', async (originalFileName) => {
    const source = getForGenerateThumbnail(AssetFactory.from({ originalFileName, isExternal: true }).exif().build());
    await sut['decodeSource'](source, { ...defaults.image, extractEmbedded: true });
    expect(renderRawWithLibRaw).not.toHaveBeenCalled();
    expect(mocks.media.decodeImage).toHaveBeenCalledWith(
      source.originalPath,
      expect.objectContaining({ processInvalidImages: false }),
    );
  });
});
