import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetType } from 'src/enum.js';
import { StudioCatalogService, exactFrameRateOf } from 'src/services/studio-catalog.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getMocks } from 'test/utils.js';

const ASSET = '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01';

describe(StudioCatalogService.name, () => {
  let sut: StudioCatalogService;
  let access: { asset: { checkOwnerAccess: ReturnType<typeof vi.fn> } };
  let assets: { getById: ReturnType<typeof vi.fn> };
  let media: { probe: ReturnType<typeof vi.fn> };

  const video = (overrides: Record<string, unknown> = {}) => ({
    id: ASSET,
    type: AssetType.Video,
    originalPath: '/data/upload/clip.mov',
    originalFileName: 'clip.mov',
    duration: '0:00:10.010000',
    width: 1920,
    height: 1080,
    exifInfo: { fps: 29.97, exifImageWidth: 1920, exifImageHeight: 1080 },
    ...overrides,
  });

  beforeEach(() => {
    const mocks = getMocks();
    access = mocks.access as never;
    access.asset.checkOwnerAccess.mockResolvedValue(new Set([ASSET]));
    assets = { getById: vi.fn().mockResolvedValue(video()) };
    media = {
      probe: vi.fn().mockResolvedValue({
        format: { duration: 10.01 },
        videoStreams: [
          {
            width: 1920,
            height: 1080,
            rotation: 0,
            codecName: 'h264',
            frameCount: 300,
            frameRate: 29.97,
            frameRateRational: { num: 30_000, den: 1001 },
          },
        ],
        audioStreams: [{ codecName: 'aac' }],
      }),
    };
    sut = new StudioCatalogService(mocks.logger as never, access as never, assets as never, media as never);
  });

  it('reads the exact frame rate and the audio track from the original', async () => {
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toEqual({
      assetId: ASSET,
      type: AssetType.Video,
      mimeType: 'video/quicktime',
      width: 1920,
      height: 1080,
      durationSeconds: 10.01,
      frameRate: { num: 30_000, den: 1001 },
      fps: 30_000 / 1001,
      frameCount: 300,
      hasAudio: true,
      audioCodec: 'aac',
      videoCodec: 'h264',
      source: 'probe',
    });
    expect(media.probe).toHaveBeenCalledWith('/data/upload/clip.mov');
  });

  it('swaps the size of a quarter-turned video and reports a silent one', async () => {
    media.probe.mockResolvedValue({
      format: { duration: 2 },
      videoStreams: [
        {
          width: 1920,
          height: 1080,
          rotation: 90,
          codecName: 'hevc',
          frameCount: 0,
          frameRate: 60,
          frameRateRational: null,
        },
      ],
      audioStreams: [],
    });
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({
      width: 1080,
      height: 1920,
      frameRate: { num: 60, den: 1 },
      fps: 60,
      frameCount: null,
      hasAudio: false,
      audioCodec: null,
    });
  });

  it('falls back to stored metadata when the original cannot be read', async () => {
    media.probe.mockRejectedValue(new Error('offline'));
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({
      source: 'stored',
      frameRate: { num: 30_000, den: 1001 },
      hasAudio: null,
      durationSeconds: 10.01,
    });
  });

  it('answers a still without probing it', async () => {
    assets.getById.mockResolvedValue(video({ type: AssetType.Image, originalFileName: 'a.jpg', exifInfo: null }));
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({
      type: AssetType.Image,
      mimeType: 'image/jpeg',
      fps: 0,
      frameRate: null,
      hasAudio: false,
      durationSeconds: 0,
    });
    expect(media.probe).not.toHaveBeenCalled();
  });

  it('refuses an asset the caller cannot read', async () => {
    access.asset.checkOwnerAccess.mockResolvedValue(new Set());
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).rejects.toThrow();
    expect(assets.getById).not.toHaveBeenCalled();
  });

  it('answers 404 for an asset that is gone', async () => {
    assets.getById.mockResolvedValue(undefined);
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).rejects.toBeInstanceOf(NotFoundException);
  });

  it('lists the reviewed resource inventory', () => {
    expect(sut.getResourceInventory().items.length).toBeGreaterThan(0);
  });

  it('reads integer and NTSC rates exactly from a stored float, and nothing else', () => {
    expect(exactFrameRateOf(25)).toEqual({ num: 25, den: 1 });
    expect(exactFrameRateOf(23.976)).toEqual({ num: 24_000, den: 1001 });
    expect(exactFrameRateOf(59.94005994005994)).toEqual({ num: 60_000, den: 1001 });
    expect(exactFrameRateOf(23.5)).toBeNull();
    expect(exactFrameRateOf(null)).toBeNull();
  });
});
