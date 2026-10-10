import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetType, CacheControl } from 'src/enum.js';
import { StudioCatalogService, exactFrameRateOf } from 'src/services/studio-catalog.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getMocks } from 'test/utils.js';

const ASSET = '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01';

describe(StudioCatalogService.name, () => {
  let sut: StudioCatalogService;
  let access: { asset: { checkOwnerAccess: ReturnType<typeof vi.fn> } };
  let assets: { getById: ReturnType<typeof vi.fn> };
  let media: { probe: ReturnType<typeof vi.fn> };
  let storage: { checkFileExists: ReturnType<typeof vi.fn> };

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
    storage = { checkFileExists: vi.fn().mockResolvedValue(true) };
    sut = new StudioCatalogService(
      mocks.logger as never,
      access as never,
      assets as never,
      media as never,
      storage as never,
    );
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
  describe('bundled title fonts (graph protocol 14.3.5)', () => {
    const TITLE_FAMILIES = [
      'Inter',
      'Inter Tight',
      'Anton',
      'Bebas Neue',
      'Orbitron',
      'Playfair Display',
      'Space Grotesk',
    ];

    it('lists the seven title families with licence, copyright and hashed files', () => {
      const { families } = sut.getFontCatalog();
      expect(families.map((family) => family.family)).toEqual(TITLE_FAMILIES);
      const hashes = new Set<string>();
      for (const family of families) {
        expect(family.license).toBe('OFL-1.1');
        expect(family.copyright).toMatch(/^Copyright \d{4} The .+ Project Authors/);
        expect(family.version).toMatch(/^\d+\.\d+\.\d+$/);
        expect(
          family.files.some((file) => file.weight === 400 && file.style === 'normal' && file.subset === 'latin'),
        ).toBe(true);
        for (const file of family.files) {
          expect(file.sha256).toMatch(/^[a-f0-9]{64}$/);
          expect(file.path).toBe(`/studio/fonts/${file.sha256}`);
          expect(file.file).toMatch(file.format === 'ttf' ? /^[a-z0-9-]+\.ttf$/ : /^[a-z0-9-]+\.woff2$/);
          expect([400, 500, 600, 700]).toContain(file.weight);
          expect(file.size).toBeGreaterThan(0);
          hashes.add(file.sha256);
        }
      }
      expect(hashes.size).toBe(families.reduce((count, family) => count + family.files.length, 0));
      expect(families.find((family) => family.family === 'Playfair Display')?.reservedFontName).toBe(
        'Playfair Display',
      );
    });

    it('serves a catalogue file by its hash from its package, cacheable for good', async () => {
      const [family] = sut.getFontCatalog().families;
      const [file] = family.files;
      const response = await sut.getFontFile(file.sha256);
      expect(response.contentType).toBe('font/woff2');
      expect(response.cacheControl).toBe(CacheControl.PrivateImmutable);
      expect(response.fileName).toBe(file.file);
      expect(response.path.replaceAll('\\', '/')).toMatch(new RegExp(`/@fontsource/inter/files/${file.file}$`));
      expect(storage.checkFileExists).toHaveBeenCalledWith(response.path);
    });

    it('lists every font as WOFF2 and as its decoded TTF, and serves the TTF from the resources', async () => {
      for (const family of sut.getFontCatalog().families) {
        const woff2 = family.files.filter((file) => file.format === 'woff2');
        const ttf = family.files.filter((file) => file.format === 'ttf');
        expect(ttf).toHaveLength(woff2.length);
        for (const source of woff2) {
          expect(source.decodedFrom).toBeNull();
          const decoded = ttf.find((file) => file.decodedFrom === source.sha256);
          expect(decoded).toMatchObject({ weight: source.weight, style: source.style, subset: source.subset });
          expect(decoded!.file).toBe(source.file.replace(/\.woff2$/, '.ttf'));
        }
      }
      const decoded = sut.getFontCatalog().families[0].files.find((file) => file.format === 'ttf')!;
      const response = await sut.getFontFile(decoded.sha256);
      expect(response.contentType).toBe('font/ttf');
      expect(response.path.replaceAll('\\', '/')).toMatch(
        new RegExp(`/server/resources/studio-fonts/${decoded.file}$`),
      );
    });

    it('serves nothing the catalogue does not list', async () => {
      for (const sha256 of [
        'a'.repeat(64),
        '../../package.json',
        'inter-latin-400-normal.woff2',
        `${sut.getFontCatalog().families[0].files[0].sha256}/../x`,
        sut.getFontCatalog().families[0].files[0].sha256.toUpperCase(),
        '',
      ]) {
        await expect(sut.getFontFile(sha256)).rejects.toBeInstanceOf(NotFoundException);
      }
      expect(storage.checkFileExists).not.toHaveBeenCalled();
    });

    it('answers not found when the installed package lost the file', async () => {
      storage.checkFileExists.mockResolvedValue(false);
      await expect(sut.getFontFile(sut.getFontCatalog().families[0].files[0].sha256)).rejects.toBeInstanceOf(
        NotFoundException,
      );
    });
  });
});
