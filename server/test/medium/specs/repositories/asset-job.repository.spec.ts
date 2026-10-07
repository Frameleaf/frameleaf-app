import { Kysely } from 'kysely';
import { AssetFileType, AssetType, AssetVisibility } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const consume = async <T>(generator: AsyncIterableIterator<T>) => {
  const values: T[] = await Array.fromAsync(generator);

  return values;
};

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { ctx } = newMediumService(BaseService, {
    database: db || defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: ctx.get(AssetJobRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetJobRepository.name, () => {
  it('backfills only uninspected non-RAW images through the existing metadata selection', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const assets = [];
    for (const options of [
      { originalFileName: 'old.HEIC' },
      { originalFileName: 'old.JPG' },
      { originalFileName: 'capture.CR2' },
      { originalFileName: 'motion.MOV', type: AssetType.Video },
      { originalFileName: 'inspected.heic' },
      { originalFileName: 'failed.heic' },
      { originalFileName: 'trashed.heic', deletedAt: new Date() },
    ]) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, ...options });
      assets.push(asset);
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
    }
    for (const index of [4, 5]) {
      await ctx.newExif({
        assetId: assets[index].id,
        imageEncoding: {
          dynamicRange: 'unknown',
          gainMap: 'none',
          reconstructionAvailable: false,
          inspectionStatus: index === 4 ? 'identified' : 'failed',
        },
      });
    }
    const ids = assets.map(({ id }) => id);
    expect(await sut.selectionForMetadataExtraction(false).where('asset.id', 'in', ids).execute()).toEqual([]);
    expect(await sut.selectionForMetadataExtraction(false, true).where('asset.id', 'in', ids).execute()).toEqual(
      expect.arrayContaining(ids.slice(0, 2).map((id) => ({ id }))),
    );
    expect(
      await sut.selectionForMetadataExtraction(false, true).where('asset.id', 'in', ids.slice(2)).execute(),
    ).toEqual([]);
  });

  it('backfills missing original HDR renditions without selecting edited, hidden, SDR or complete sources', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const assets = [];
    for (const options of [{}, {}, { isEdited: true }, { visibility: AssetVisibility.Hidden }, {}]) {
      const { asset } = await ctx.newAsset({ ownerId: user.id, thumbhash: Buffer.from('hash'), ...options });
      assets.push(asset);
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newExif({
        assetId: asset.id,
        imageEncoding: {
          dynamicRange: assets.length === 5 ? 'sdr' : 'hdr',
          gainMap: 'ultra-hdr',
          reconstructionAvailable: true,
        },
      });
      for (const type of [AssetFileType.Thumbnail, AssetFileType.Preview, AssetFileType.FullSize]) {
        await ctx.newAssetFile({ assetId: asset.id, type, path: `${asset.id}-${type}.jpg`, isEdited: asset.isEdited });
      }
    }
    for (const type of [AssetFileType.HdrPreview, AssetFileType.HdrFullSize]) {
      await ctx.newAssetFile({ assetId: assets[1].id, type, path: `${assets[1].id}-${type}.jpg` });
    }
    const ids = assets.map(({ id }) => id);
    expect(
      await sut
        .selectionForThumbnailJob({ force: false, fullsizeEnabled: false })
        .where('asset.id', 'in', ids)
        .execute(),
    ).toEqual([]);
    expect(
      await sut
        .selectionForThumbnailJob({ force: false, fullsizeEnabled: false, hdrBackfill: true })
        .where('asset.id', 'in', ids)
        .execute(),
    ).toEqual([{ id: assets[0].id, isEdited: false }]);
  });

  describe('streamForThumbnailJob', () => {
    it('should work', async () => {
      const { sut } = setup();
      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: false });
      await expect(stream.next()).resolves.toEqual({ done: true, value: undefined });
    });

    it('should queue an asset with missing thumbnails', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: false });
      await expect(consume(stream)).resolves.toEqual([expect.objectContaining({ id: asset.id })]);
    });

    it('should skip assets without missing thumbnails', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, thumbhash: Buffer.from('fake-thumbhash-buffer') });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: false });
      await expect(consume(stream)).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });

    it('should queue assets with a missing full size', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        thumbhash: Buffer.from('fake-thumbhash-buffer'),
        originalFileName: 'photo.cr2',
      });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: true });
      await expect(consume(stream)).resolves.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });

    it('should skip assets with after they have full size previews', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, thumbhash: Buffer.from('fake-thumbhash-buffer') });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.FullSize, path: 'fullsize.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: true });
      await expect(consume(stream)).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });

    it('should skip assets with web-compatible originals', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({
        ownerId: user.id,
        thumbhash: Buffer.from('fake-thumbhash-buffer'),
        originalFileName: 'photo.jpg',
      });
      await ctx.newJobStatus({ assetId: asset.id, metadataExtractedAt: new Date() });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: 'thumbnail.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'preview.jpg' });

      const stream = sut.streamForThumbnailJob({ force: false, fullsizeEnabled: true });
      await expect(consume(stream)).resolves.not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: asset.id })]),
      );
    });
  });

  describe('getForOcr', () => {
    it('should not return the edited preview file', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_edited.jpg',
        isEdited: true,
      });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        path: 'preview_unedited.jpg',
        isEdited: false,
      });

      const result = await sut.getForOcr(asset.id);

      expect(result).toEqual(
        expect.objectContaining({
          previewFile: 'preview_unedited.jpg',
        }),
      );
    });
  });
});
