import { ConflictException, ForbiddenException } from '@nestjs/common';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import sharp from 'sharp';
import { PhotographyWatermarkSchema } from 'src/dtos/photography-rendition.dto.js';
import {
  type PhotographyBrand,
  PhotographyBrandSaveDto,
  PhotographyBrandSchema,
} from 'src/dtos/photography-workspace.dto.js';
import { AssetType, AssetVisibility, CacheControl } from 'src/enum.js';
import { PhotographyWorkspaceRepository } from 'src/repositories/photography-workspace.repository.js';
import { AlbumService } from 'src/services/album.service.js';
import { AssetMediaService } from 'src/services/asset-media.service.js';
import { AssetService } from 'src/services/asset.service.js';
import { PhotographyWorkspaceService } from 'src/services/photography-workspace.service.js';
import { SearchService } from 'src/services/search.service.js';
import { ImmichFileResponse } from 'src/utils/file.js';
import { factory, newUuid } from 'test/small.factory.js';

let sourceDirectory: string;
let sourceLogo: string;
beforeAll(async () => {
  sourceDirectory = await mkdtemp(join(tmpdir(), 'photography-brand-tests-'));
  sourceLogo = join(sourceDirectory, 'logo.png');
  await writeFile(
    sourceLogo,
    await sharp({ create: { width: 32, height: 24, channels: 4, background: '#ff550088' } })
      .png()
      .toBuffer(),
  );
});
afterAll(async () => {
  await rm(sourceDirectory, { recursive: true, force: true });
});

const newBrand = (): PhotographyBrand =>
  PhotographyBrandSchema.parse({
    name: 'North Studio',
    tagline: 'Portraits',
    email: 'studio@example.test',
    phone: '',
    logoInitials: 'NS',
    logoAssetId: null,
    color: '#577059',
    background: '#f5f3ed',
    textColor: '#263329',
    font: 'editorial',
    watermarkColor: '#ffffff',
    watermarkOpacity: 45,
    watermarkPosition: 'bottom-right',
    watermarkSize: 6,
  });
const setup = () => {
  const auth = factory.auth({ session: { hasElevatedPermission: true } });
  const revision = newUuid();
  const next = newUuid();
  const brand = newBrand();
  const logo = {
    id: newUuid(),
    ownerId: auth.user.id,
    type: AssetType.Image,
    visibility: AssetVisibility.Timeline,
    isTrashed: false,
    isOffline: false,
    originalMimeType: 'image/png',
    originalFileName: 'logo.png',
    exifInfo: { latitude: 47, longitude: -122 },
    originalPath: sourceLogo,
  };
  const repository = {
    get: vi.fn().mockResolvedValue({ value: { shoots: [], brand }, updateId: revision }),
    saveBrand: vi.fn().mockResolvedValue({ updateId: next }),
  };
  const search = { searchMetadata: vi.fn().mockResolvedValue({ assets: { items: [logo], nextCursor: null } }) };
  const media = {
    viewThumbnail: vi.fn().mockResolvedValue(
      new ImmichFileResponse({
        path: '/derived/logo.webp',
        contentType: 'image/webp',
        cacheControl: CacheControl.PrivateWithCache,
      }),
    ),
  };
  const sut = new PhotographyWorkspaceService(
    repository as unknown as PhotographyWorkspaceRepository,
    {} as AlbumService,
    search as unknown as SearchService,
    {} as AssetService,
    media as unknown as AssetMediaService,
  );
  return { sut, auth, revision, next, brand, logo, repository, search, media };
};

describe('private studio branding', () => {
  it('requires an ordinary session on every branding and logo operation before reads', async () => {
    const { sut, auth, brand, repository, search, logo } = setup();
    for (const denied of [
      { ...auth, session: undefined },
      { ...auth, apiKey: {} },
      { ...auth, sharedLink: {} },
    ]) {
      const actor = denied as typeof auth;
      for (const call of [
        () => sut.getBrand(actor),
        () => sut.saveBrand(actor, { expectedRevision: null, brand }),
        () => sut.logos(actor, {}),
        () => sut.logoThumbnail(actor, logo.id),
      ]) {
        await expect(call()).rejects.toBeInstanceOf(ForbiddenException);
      }
    }
    expect(repository.get).not.toHaveBeenCalled();
    expect(search.searchMetadata).not.toHaveBeenCalled();
  });
  it('uses unsaved account identity defaults without synthesizing a studio contact or logo', async () => {
    const { sut, auth, repository } = setup();
    repository.get.mockResolvedValue(undefined);
    await expect(sut.getBrand(auth)).resolves.toMatchObject({
      revision: null,
      brand: { name: auth.user.name, email: '', phone: '', logoAssetId: null },
      logoUnavailable: false,
    });
  });
  it('writes only the actor brand with CAS and returns the persisted revision', async () => {
    const { sut, auth, brand, revision, next, repository } = setup();
    await expect(sut.saveBrand(auth, { expectedRevision: revision, brand })).resolves.toEqual({
      revision: next,
      brand,
      logoUnavailable: false,
    });
    expect(repository.saveBrand).toHaveBeenCalledWith(auth.user.id, brand, revision);
    await expect(sut.saveBrand(auth, { expectedRevision: newUuid(), brand })).rejects.toBeInstanceOf(ConflictException);
    expect(repository.saveBrand).toHaveBeenCalledTimes(1);
    repository.saveBrand.mockResolvedValue(undefined);
    await expect(sut.saveBrand(auth, { expectedRevision: revision, brand })).rejects.toBeInstanceOf(ConflictException);
  });
  it('validates ranges, colours, contact and unknown fields at the write boundary', () => {
    const brand = newBrand();
    for (const patch of [
      { watermarkOpacity: 101 },
      { watermarkSize: 2 },
      { watermarkPosition: 'arbitrary' },
      { color: 'url(example)' },
      { email: 'invalid' },
      { font: 'remote-url' },
      { originalPath: '/private' },
    ]) {
      expect(() =>
        PhotographyBrandSaveDto.schema.parse({ expectedRevision: null, brand: { ...brand, ...patch } }),
      ).toThrow();
    }
  });
  it.each(['foreign', 'locked', 'trashed', 'offline', 'video', 'svg', 'missing'])(
    'refuses %s logos during save and byte reads',
    async (condition) => {
      const { sut, auth, brand, logo, revision, repository, search, media } = setup();
      const invalid = {
        ...logo,
        ...(condition === 'foreign'
          ? { ownerId: newUuid() }
          : condition === 'locked'
            ? { visibility: AssetVisibility.Locked }
            : condition === 'trashed'
              ? { isTrashed: true }
              : condition === 'offline'
                ? { isOffline: true }
                : condition === 'video'
                  ? { type: AssetType.Video }
                  : condition === 'svg'
                    ? { originalMimeType: 'image/svg+xml' }
                    : {}),
      };
      search.searchMetadata.mockResolvedValue({
        assets: { items: condition === 'missing' ? [] : [invalid], nextCursor: null },
      });
      await expect(
        sut.saveBrand(auth, { expectedRevision: revision, brand: { ...brand, logoAssetId: logo.id } }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(sut.logoThumbnail(auth, logo.id)).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.saveBrand).not.toHaveBeenCalled();
      expect(media.viewThumbnail).not.toHaveBeenCalled();
    },
  );
  it('redacts a stale logo identity and retains it privately when a client omits the reference', async () => {
    const { sut, auth, brand, logo, revision, next, repository, search } = setup();
    repository.get.mockResolvedValue({
      value: { shoots: [], brand: { ...brand, logoAssetId: logo.id } },
      updateId: revision,
    });
    search.searchMetadata.mockResolvedValue({ assets: { items: [], nextCursor: null } });
    await expect(sut.getBrand(auth)).resolves.toMatchObject({ logoUnavailable: true, brand: { logoAssetId: null } });
    const { logoAssetId: _unused, ...input } = brand;
    await expect(sut.saveBrand(auth, { expectedRevision: revision, brand: input })).resolves.toMatchObject({
      revision: next,
      logoUnavailable: true,
      brand: { logoAssetId: null },
    });
    expect(repository.saveBrand).toHaveBeenCalledWith(auth.user.id, { ...brand, logoAssetId: logo.id }, revision);
    await sut.saveBrand(auth, { expectedRevision: revision, brand });
    expect(repository.saveBrand).toHaveBeenLastCalledWith(auth.user.id, brand, revision);
  });
  it('revalidates saved logos on every read and propagates operational failures', async () => {
    const { sut, auth, brand, logo, revision, repository, search } = setup();
    repository.get.mockResolvedValue({
      value: { shoots: [], brand: { ...brand, logoAssetId: logo.id } },
      updateId: revision,
    });
    await expect(sut.getBrand(auth)).resolves.toMatchObject({ brand: { logoAssetId: logo.id } });
    search.searchMetadata.mockResolvedValue({ assets: { items: [], nextCursor: null } });
    await expect(sut.getBrand(auth)).resolves.toMatchObject({ logoUnavailable: true, brand: { logoAssetId: null } });
    const failure = new Error('database offline');
    search.searchMetadata.mockRejectedValue(failure);
    await expect(sut.getBrand(auth)).rejects.toBe(failure);
  });
  it('projects logo candidates without EXIF, source paths or partner images and restricts search', async () => {
    const { sut, auth, logo, search } = setup();
    search.searchMetadata.mockResolvedValue({
      assets: { items: [logo, { ...logo, id: newUuid(), ownerId: newUuid() }], nextCursor: 'next' },
    });
    await expect(sut.logos(auth, { cursor: 'cursor' })).resolves.toEqual({
      logos: [{ id: logo.id, fileName: logo.originalFileName }],
      nextCursor: 'next',
    });
    expect(search.searchMetadata).toHaveBeenCalledWith(
      expect.objectContaining({ session: expect.objectContaining({ hasElevatedPermission: false }) }),
      expect.objectContaining({
        cursor: 'cursor',
        size: 80,
        filter: expect.objectContaining({
          type: { eq: AssetType.Image },
          visibility: { ne: AssetVisibility.Locked },
          trashedAt: { eq: null },
          fileSizeInBytes: { lte: 512_000 },
        }),
      }),
    );
    expect(auth.session?.hasElevatedPermission).toBe(true);
  });
  it('serves a validated transparent metadata-free PNG variant and cleans up after sending', async () => {
    const { sut, auth, logo, media } = setup();
    const file = await sut.logoThumbnail(auth, logo.id, 'light');
    expect(file).toMatchObject({ contentType: 'image/png', cacheControl: CacheControl.None, fileName: 'studio-logo' });
    const bytes = await readFile(file.path);
    expect(await sharp(bytes).metadata()).toMatchObject({ hasAlpha: true, format: 'png' });
    expect((await sharp(bytes).raw().toBuffer())[0]).toBe(255);
    expect(media.viewThumbnail).not.toHaveBeenCalled();
    file.release?.();
  });
  it('rejects mislabeled/corrupt logo pixels before saving or exposing bytes', async () => {
    const { sut, auth, brand, logo, revision, repository, search } = setup();
    const path = join(sourceDirectory, 'mislabeled.png');
    await writeFile(path, Buffer.from('<svg xmlns="http://www.w3.org/2000/svg"><rect width="20" height="20"/></svg>'));
    search.searchMetadata.mockResolvedValue({ assets: { items: [{ ...logo, originalPath: path }], nextCursor: null } });
    await expect(
      sut.saveBrand(auth, { expectedRevision: revision, brand: { ...brand, logoAssetId: logo.id } }),
    ).rejects.toThrow('Logo must be');
    await expect(sut.logoThumbnail(auth, logo.id)).rejects.toThrow('Logo must be');
    expect(repository.saveBrand).not.toHaveBeenCalled();
  });
  it('normalizes old saved branding and preserves presets through a legacy save', async () => {
    const { sut, auth, brand, revision, repository } = setup();
    const preset = {
      id: newUuid(),
      name: 'Protected proofs',
      version: 1,
      watermark: PhotographyWatermarkSchema.parse({ text: 'Studio', pattern: 'tile' }),
    };
    const saved = { ...brand, watermarkPresets: [preset], proofWatermarkPresetId: preset.id };
    repository.get.mockResolvedValue({ value: { shoots: [], brand: saved }, updateId: revision });
    const {
      watermarkPresets: _presets,
      webWatermarkPresetId: _web,
      proofWatermarkPresetId: _proof,
      exportWatermarkPresetId: _export,
      ...legacy
    } = brand;
    await sut.saveBrand(auth, PhotographyBrandSaveDto.schema.parse({ expectedRevision: revision, brand: legacy }));
    expect(repository.saveBrand).toHaveBeenCalledWith(auth.user.id, saved, revision);
    repository.get.mockResolvedValue({ value: { shoots: [], brand: legacy }, updateId: revision });
    await expect(sut.getBrand(auth)).resolves.toMatchObject({
      brand: {
        watermarkPresets: [],
        webWatermarkPresetId: null,
        proofWatermarkPresetId: null,
        exportWatermarkPresetId: null,
      },
    });
  });
  it.each(['locked', 'missing', 'offline'])(
    'preserves omitted preset references privately after their logo becomes %s, but refuses supplied references and rendering',
    async (condition) => {
      const { sut, auth, brand, logo, revision, repository, search } = setup();
      const preset = {
        id: newUuid(),
        name: 'Protected proofs',
        version: 1,
        watermark: PhotographyWatermarkSchema.parse({ text: 'Studio', type: 'logo', logoAssetId: logo.id }),
      };
      const saved = { ...brand, watermarkPresets: [preset], proofWatermarkPresetId: preset.id };
      repository.get.mockResolvedValue({ value: { shoots: [], brand: saved }, updateId: revision });
      search.searchMetadata.mockResolvedValue({
        assets: {
          items:
            condition === 'missing'
              ? []
              : [
                  {
                    ...logo,
                    ...(condition === 'locked' ? { visibility: AssetVisibility.Locked } : { isOffline: true }),
                  },
                ],
          nextCursor: null,
        },
      });
      const {
        watermarkPresets: _presets,
        webWatermarkPresetId: _web,
        proofWatermarkPresetId: _proof,
        exportWatermarkPresetId: _export,
        ...legacy
      } = brand;
      await expect(sut.saveBrand(auth, { expectedRevision: revision, brand: legacy })).resolves.toMatchObject({
        logoUnavailable: true,
        brand: { watermarkPresets: [{ watermark: { logoAssetId: null } }] },
      });
      expect(repository.saveBrand).toHaveBeenCalledWith(auth.user.id, saved, revision);
      repository.saveBrand.mockClear();
      const changed = {
        ...saved,
        watermarkPresets: [{ ...preset, watermark: { ...preset.watermark, text: 'Changed Studio' } }],
      };
      await expect(sut.saveBrand(auth, { expectedRevision: revision, brand: changed })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      await expect(
        sut.saveBrand(auth, {
          expectedRevision: revision,
          brand: { ...brand, watermarkPresets: [{ ...preset, id: newUuid() }] },
        }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      expect(repository.saveBrand).not.toHaveBeenCalled();
      await expect(
        sut.previewWatermark(auth, { watermark: preset.watermark, orientation: 'portrait', background: 'dark' }),
      ).rejects.toBeInstanceOf(ForbiddenException);
      await expect(sut.logoBytes(auth, logo.id)).rejects.toBeInstanceOf(ForbiddenException);
    },
  );
  it('increments changed preset versions while independently selecting web/proof/export defaults', async () => {
    const { sut, auth, brand, revision, repository } = setup();
    const preset = {
      id: newUuid(),
      name: 'Web signature',
      version: 1,
      watermark: PhotographyWatermarkSchema.parse({ text: 'Studio' }),
    };
    repository.get.mockResolvedValue({
      value: { shoots: [], brand: { ...brand, watermarkPresets: [preset] } },
      updateId: revision,
    });
    const updated = {
      ...brand,
      watermarkPresets: [{ ...preset, watermark: { ...preset.watermark, opacity: 70 } }],
      webWatermarkPresetId: preset.id,
      proofWatermarkPresetId: preset.id,
      exportWatermarkPresetId: null,
    };
    await sut.saveBrand(auth, { expectedRevision: revision, brand: updated });
    expect(repository.saveBrand).toHaveBeenCalledWith(
      auth.user.id,
      { ...updated, watermarkPresets: [{ ...updated.watermarkPresets[0], version: 2 }] },
      revision,
    );
    await expect(
      sut.saveBrand(auth, {
        expectedRevision: revision,
        brand: { ...updated, watermarkPresets: [{ ...preset, version: 2 }] },
      }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(
      sut.saveBrand(auth, { expectedRevision: revision, brand: { ...updated, webWatermarkPresetId: newUuid() } }),
    ).rejects.toThrow('Unknown watermark preset');
  });
  it('requires an ordinary session and generates the actual renderer preview in both orientations', async () => {
    const { sut, auth } = setup();
    const watermark = PhotographyWatermarkSchema.parse({ text: 'Studio', font: 'script', pattern: 'tile' });
    for (const orientation of ['portrait', 'landscape'] as const) {
      const bytes = await sut.previewWatermark(auth, { watermark, orientation, background: 'light' });
      expect(await sharp(bytes).metadata()).toMatchObject({
        format: 'jpeg',
        width: orientation === 'portrait' ? 480 : 720,
        height: orientation === 'portrait' ? 720 : 480,
      });
    }
    await expect(
      sut.previewWatermark({ ...auth, session: undefined }, { watermark, orientation: 'portrait', background: 'dark' }),
    ).rejects.toBeInstanceOf(ForbiddenException);
  }, 15_000);
});
