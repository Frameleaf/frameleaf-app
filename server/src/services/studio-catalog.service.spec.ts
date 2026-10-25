import { NotFoundException } from '@nestjs/common';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import { AssetType, CacheControl } from 'src/enum.js';
import { StudioCatalogService, exactFrameRateOf, studioMediaColorOf } from 'src/services/studio-catalog.service.js';
import { sourceOriginalPath } from 'src/utils/source-original.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { getMocks } from 'test/utils.js';

const ASSET = '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01';

describe(StudioCatalogService.name, () => {
  let sut: StudioCatalogService;
  let access: { asset: { checkOwnerAccess: ReturnType<typeof vi.fn> } };
  let assets: { getById: ReturnType<typeof vi.fn>; getVideoColor: ReturnType<typeof vi.fn> };
  let media: { probe: ReturnType<typeof vi.fn<(...args: any[]) => Promise<any>>> };
  let integrity: { sourceEpochs: ReturnType<typeof vi.fn> };
  let sessions: { getAuth: ReturnType<typeof vi.fn> };
  let storage: { checkFileExists: ReturnType<typeof vi.fn> };
  let originals: { open: ReturnType<typeof vi.fn<(...args: any[]) => Promise<any>>> };

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

  /** A stored `asset_video` row: BT.709 8-bit unless overridden. */
  const stream = (overrides: Record<string, unknown> = {}) => ({
    colorTransfer: 1,
    colorPrimaries: 1,
    colorMatrix: 1,
    pixelFormat: 'yuv420p',
    dvProfile: null,
    ...overrides,
  });

  beforeEach(() => {
    const mocks = getMocks();
    access = mocks.access as never;
    access.asset.checkOwnerAccess.mockResolvedValue(new Set([ASSET]));
    assets = { getById: vi.fn().mockResolvedValue(video()), getVideoColor: vi.fn().mockResolvedValue(stream()) };
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
    originals = { open: vi.fn() };
    sessions = { getAuth: vi.fn().mockResolvedValue(authStub.adminWithElevatedPermission) };
    sut = new StudioCatalogService(
      mocks.logger as never,
      access as never,
      assets as never,
      media as never,
      storage as never,
      originals as never,
    );
    integrity = { sourceEpochs: vi.fn() };
    Object.assign(sut, { sessionRepository: sessions, integrityRepository: integrity });
  });

  describe('reference original facts', () => {
    const reference = () => {
      const asset = video({
        ownerId: authStub.admin.user.id,
        originalPath: sourceOriginalPath({ sourceId: ASSET, resourceKey: 'b'.repeat(64) }),
        checksum: Buffer.from('logical checksum'),
      });
      assets.getById.mockResolvedValue(asset);
      const abort = new AbortController();
      const input = {
        localPath: '/private/source.artifact',
        resourceId: ASSET,
        resourceVersion: 'a'.repeat(64),
        verifiedSha256: 'c'.repeat(64),
        signal: abort.signal,
        check: vi.fn().mockResolvedValue(undefined),
        release: vi.fn().mockResolvedValue(undefined),
      };
      originals.open.mockImplementation(async (_id, _reader, authorize) => {
        await authorize();
        input.check.mockImplementation(authorize);
        return input;
      });
      const epoch = {
        assetId: ASSET,
        ownerId: authStub.admin.user.id,
        epoch: '0',
        reference: { resourceId: input.resourceId, version: input.resourceVersion, sha256: input.verifiedSha256 },
      };
      integrity.sourceEpochs.mockResolvedValue([epoch]);
      return { asset, input, abort, epoch };
    };

    it('holds verified input through probing and uses its colour instead of stale stored colour', async () => {
      const f = reference();
      assets.getVideoColor.mockResolvedValue(stream({ colorTransfer: 16 }));
      media.probe.mockImplementation((path, options) => {
        expect(path).toBe(f.input.localPath);
        expect(options.signal).toBe(f.input.signal);
        expect(f.input.release).not.toHaveBeenCalled();
        return Promise.resolve({
          format: { duration: 2 },
          videoStreams: [{ ...stream(), width: 640, height: 480 }],
          audioStreams: [],
        });
      });
      await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({
        source: 'probe',
        colorTransfer: 'sdr',
        width: 640,
      });
      expect(f.input.check).toHaveBeenCalledTimes(2);
      expect(f.input.release).toHaveBeenCalledOnce();
    });

    it.each(['ownerId', 'originalPath', 'checksum'] as const)('refuses changed %s before probing', async (field) => {
      const f = reference();
      assets.getById.mockResolvedValueOnce(f.asset).mockResolvedValue({
        ...f.asset,
        [field]: field === 'checksum' ? Buffer.from('changed') : 'changed',
      });
      await expect(sut.getMediaFacts(authStub.admin, ASSET)).rejects.toThrow('Studio source changed');
      expect(media.probe).not.toHaveBeenCalled();
    });

    it('does not answer facts after source access is revoked during probing', async () => {
      const f = reference();
      media.probe.mockImplementation(() => {
        f.input.check.mockRejectedValue(new Error('source revoked'));
        return Promise.resolve({ format: {}, videoStreams: [], audioStreams: [] });
      });
      await expect(sut.getMediaFacts(authStub.admin, ASSET)).rejects.toThrow('source revoked');
      expect(f.input.release).toHaveBeenCalledOnce();
    });

    it('rechecks the lease after a stopped failed probe before returning labelled stored metadata', async () => {
      const f = reference();
      media.probe.mockRejectedValue(new Error('unsupported probe'));
      await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({ source: 'stored' });
      expect(f.input.check).toHaveBeenCalledTimes(2);
      expect(f.input.release).toHaveBeenCalledOnce();
    });

    it('propagates source cancellation and releases after the probe has stopped', async () => {
      const f = reference();
      const error = new Error('source canceled');
      media.probe.mockImplementation(() => {
        f.abort.abort(error);
        return Promise.reject(error);
      });
      await expect(sut.getMediaFacts(authStub.admin, ASSET)).rejects.toBe(error);
      expect(f.input.release).toHaveBeenCalledOnce();
    });

    it.each([
      'media_process_shutdown_unconfirmed',
      'source_original_shutdown_unconfirmed',
      'artifact_close_unconfirmed',
    ])('retains the probe input and refuses new probing after %s', async (code) => {
      const f = reference();
      media.probe.mockRejectedValueOnce(new Error(code));
      await expect(sut.getMediaFacts(authStub.admin, ASSET)).rejects.toThrow(code);
      expect(f.input.release).not.toHaveBeenCalled();
      await expect(sut.getMediaFacts(authStub.admin, ASSET)).rejects.toThrow(/unconfirmed/);
      expect(originals.open).toHaveBeenCalledOnce();
      expect(media.probe).toHaveBeenCalledOnce();
    });

    it('retains quarantine when the source descriptor close is unconfirmed', async () => {
      const f = reference();
      f.input.release.mockRejectedValueOnce(new Error('artifact_close_unconfirmed'));
      await expect(sut.getMediaFacts(authStub.admin, ASSET)).rejects.toThrow('artifact_close_unconfirmed');
      await expect(sut.getMediaFacts(authStub.admin, ASSET)).rejects.toThrow(/unconfirmed/);
      expect(originals.open).toHaveBeenCalledOnce();
    });

    it.each(['during probe', 'during release'] as const)('rechecks the actor session %s', async (phase) => {
      const f = reference();
      if (phase === 'during probe')
        media.probe.mockImplementationOnce(() => {
          sessions.getAuth.mockResolvedValue(undefined);
          return Promise.resolve({ format: {}, videoStreams: [], audioStreams: [] });
        });
      else
        f.input.release.mockImplementationOnce(() => {
          sessions.getAuth.mockResolvedValue(undefined);
          return Promise.resolve();
        });
      await expect(sut.getMediaFacts(authStub.adminWithElevatedPermission, ASSET)).rejects.toThrow();
      expect(f.input.release).toHaveBeenCalledOnce();
    });

    it('rechecks live privacy after PIN elevation is removed', async () => {
      reference();
      media.probe.mockImplementationOnce(() => {
        sessions.getAuth.mockResolvedValue({
          ...authStub.adminWithElevatedPermission,
          session: { ...authStub.adminWithElevatedPermission.session, hasElevatedPermission: false },
        });
        access.asset.checkOwnerAccess = vi.fn((_owner, ids, elevated) =>
          Promise.resolve(elevated ? new Set(ids) : new Set()),
        );
        return Promise.resolve({ format: {}, videoStreams: [], audioStreams: [] });
      });
      await expect(sut.getMediaFacts(authStub.adminWithElevatedPermission, ASSET)).rejects.toThrow();
    });

    it.each(['resourceId', 'version', 'sha256', 'revoked'] as const)(
      'refuses a %s change during input release',
      async (field) => {
        const f = reference();
        f.input.release.mockImplementationOnce(() => {
          integrity.sourceEpochs.mockResolvedValue(
            field === 'revoked'
              ? []
              : [
                  {
                    ...f.epoch,
                    reference: {
                      ...f.epoch.reference,
                      [field]: field === 'resourceId' ? '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e02' : 'e'.repeat(64),
                    },
                  },
                ],
          );
          return Promise.resolve();
        });
        await expect(sut.getMediaFacts(authStub.admin, ASSET)).rejects.toThrow('Studio source changed');
        expect(f.input.release).toHaveBeenCalledOnce();
      },
    );

    it('does not acquire bytes for a still or a caller without access', async () => {
      reference();
      access.asset.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(sut.getMediaFacts(authStub.admin, ASSET)).rejects.toThrow();
      expect(originals.open).not.toHaveBeenCalled();
      access.asset.checkOwnerAccess.mockResolvedValue(new Set([ASSET]));
      assets.getById.mockResolvedValue(video({ type: AssetType.Image }));
      await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({ source: 'stored' });
      expect(originals.open).not.toHaveBeenCalled();
    });

    it('does not pass an unavailable reference URI to a native tool', async () => {
      reference();
      originals.open.mockRejectedValue(new Error('source_original_unavailable'));
      await expect(sut.getMediaFacts(authStub.admin, ASSET)).rejects.toThrow('source_original_unavailable');
      expect(media.probe).not.toHaveBeenCalled();
    });
  });

  it('passes request cancellation to a managed original probe too', async () => {
    const controller = new AbortController();
    await sut.getMediaFacts(authStub.admin, ASSET, controller.signal);
    expect(media.probe).toHaveBeenCalledWith('/data/upload/clip.mov', {
      countFrames: false,
      signal: controller.signal,
    });
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
      colorTransfer: 'sdr',
      colorTransferCode: 1,
      colorPrimariesCode: 1,
      colorMatrixCode: 1,
      bitDepth: 8,
      dolbyVisionProfile: null,
      source: 'probe',
    });
    expect(assets.getVideoColor).toHaveBeenCalledWith(ASSET);
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
      colorTransfer: 'sdr',
      colorTransferCode: null,
      colorPrimariesCode: null,
      colorMatrixCode: null,
      bitDepth: null,
      dolbyVisionProfile: null,
    });
    expect(media.probe).not.toHaveBeenCalled();
    expect(assets.getVideoColor).not.toHaveBeenCalled();
  });

  it.each([
    { name: 'PQ (H.273 transfer 16)', row: { colorTransfer: 16 }, colorTransfer: 'pq' },
    { name: 'HLG (H.273 transfer 18)', row: { colorTransfer: 18 }, colorTransfer: 'hlg' },
    { name: 'Dolby Vision 8.4 over an HLG base', row: { colorTransfer: 18, dvProfile: 8 }, colorTransfer: 'hdr' },
    { name: 'Dolby Vision 8.1 over a PQ base', row: { colorTransfer: 16, dvProfile: 8 }, colorTransfer: 'hdr' },
    { name: 'Dolby Vision 5, transfer unspecified', row: { colorTransfer: 2, dvProfile: 5 }, colorTransfer: 'hdr' },
    { name: 'BT.709', row: { colorTransfer: 1 }, colorTransfer: 'sdr' },
    { name: 'an unspecified transfer', row: { colorTransfer: 2 }, colorTransfer: 'sdr' },
    { name: 'BT.2020 10-bit, not an HDR transfer', row: { colorTransfer: 14 }, colorTransfer: 'sdr' },
    { name: 'a reserved transfer', row: { colorTransfer: 0 }, colorTransfer: 'sdr' },
  ])('marks $name as $colorTransfer', async ({ row, colorTransfer }) => {
    assets.getVideoColor.mockResolvedValue(stream(row));
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({
      colorTransfer,
      colorTransferCode: row.colorTransfer,
      dolbyVisionProfile: 'dvProfile' in row ? row.dvProfile : null,
    });
  });

  it('answers the stored H.273 codes and the bit depth of the pixel format', async () => {
    assets.getVideoColor.mockResolvedValue(
      stream({ colorTransfer: 16, colorPrimaries: 9, colorMatrix: 9, pixelFormat: 'yuv420p10le' }),
    );
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({
      colorTransfer: 'pq',
      colorTransferCode: 16,
      colorPrimariesCode: 9,
      colorMatrixCode: 9,
      bitDepth: 10,
      dolbyVisionProfile: null,
      source: 'probe',
    });
  });

  it('answers no bit depth for a pixel format it cannot describe', async () => {
    assets.getVideoColor.mockResolvedValue(stream({ pixelFormat: 'not-a-format' }));
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({ bitDepth: null });
  });

  it('answers the stored colour when the original cannot be read', async () => {
    media.probe.mockRejectedValue(new Error('offline'));
    assets.getVideoColor.mockResolvedValue(stream({ colorTransfer: 18, colorPrimaries: 9, colorMatrix: 9 }));
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({
      source: 'stored',
      colorTransfer: 'hlg',
      colorTransferCode: 18,
    });
  });

  it('prefers the stored colour to the probe, and uses the probe only when nothing is stored', async () => {
    const probed = {
      width: 3840,
      height: 2160,
      rotation: 0,
      codecName: 'hevc',
      frameCount: 0,
      frameRate: 30,
      frameRateRational: { num: 30, den: 1 },
      colorTransfer: 16,
      colorPrimaries: 9,
      colorMatrix: 9,
      pixelFormat: 'yuv420p10le',
      dvProfile: null,
    };
    media.probe.mockResolvedValue({ format: { duration: 1 }, videoStreams: [probed], audioStreams: [] });
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({
      colorTransfer: 'sdr',
      colorTransferCode: 1,
      bitDepth: 8,
    });

    assets.getVideoColor.mockResolvedValue(undefined);
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({
      source: 'probe',
      colorTransfer: 'pq',
      colorTransferCode: 16,
      colorPrimariesCode: 9,
      colorMatrixCode: 9,
      bitDepth: 10,
      dolbyVisionProfile: null,
    });
  });

  it('answers sdr with no codes for a video nothing is known about', async () => {
    media.probe.mockRejectedValue(new Error('offline'));
    assets.getVideoColor.mockResolvedValue(undefined);
    await expect(sut.getMediaFacts(authStub.admin, ASSET)).resolves.toMatchObject({
      source: 'stored',
      colorTransfer: 'sdr',
      colorTransferCode: null,
      colorPrimariesCode: null,
      colorMatrixCode: null,
      bitDepth: null,
      dolbyVisionProfile: null,
    });
  });

  it('marks as HDR exactly the streams the project HDR rule counts', () => {
    // StudioResourceService.hdrLibraryAssets: transfer 16 or 18, or any Dolby Vision profile
    for (const colorTransfer of [0, 1, 2, 14, 16, 18]) {
      for (const dvProfile of [null, 5, 8]) {
        const counted = colorTransfer === 16 || colorTransfer === 18 || dvProfile !== null;
        const marked = studioMediaColorOf(stream({ colorTransfer, dvProfile }) as never).colorTransfer;
        expect(marked !== 'sdr').toBe(counted);
      }
    }
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
      expect(response.cacheControl).toBe(CacheControl.None);
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
