import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AssetType, LibraryScope } from 'src/enum.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { fontFactsFromName } from 'src/utils/font-file.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
const setup = () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(AssetRepository), jobs: ctx.get(AssetJobRepository) };
};
beforeAll(async () => {
  database = await getKyselyDB();
});

describe('fonts in Boards (FL-1359)', () => {
  const facts = {
    ...fontFactsFromName('Inter.ttf'),
    family: 'Inter',
    weight: 400,
    glyphCount: 2937,
    axes: [{ tag: 'wght', name: 'Weight', min: 100, default: 400, max: 900 }],
    instances: [{ name: 'Bold', coordinates: { wght: 700 } }],
    features: ['liga', 'tnum'],
    scripts: ['latin', 'greek'],
    licenseUrl: 'https://openfontlicense.org',
  };
  const newFont = async (ctx: ReturnType<typeof setup>['ctx']) => {
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      type: AssetType.Other,
      originalFileName: 'Inter.ttf',
      libraryScope: LibraryScope.Design,
    });
    return { user, asset };
  };

  it('keeps a font’s facts, replaces them on a second read, and removes them with the font', async () => {
    const { ctx, sut } = setup();
    const { asset } = await newFont(ctx);

    await expect(sut.getFont(asset.id)).resolves.toMatchObject({ originalFileName: 'Inter.ttf', font: null });

    await sut.upsertFont(asset.id, facts);
    await expect(sut.getFont(asset.id)).resolves.toMatchObject({ font: { assetId: asset.id, ...facts } });

    await sut.upsertFont(asset.id, { ...facts, style: 'Italic', italic: true, axes: [] });
    await expect(sut.getFont(asset.id)).resolves.toMatchObject({ font: { style: 'Italic', italic: true, axes: [] } });

    await database.deleteFrom('asset').where('id', '=', asset.id).execute();
    await expect(
      database.selectFrom('asset_font').select('assetId').where('assetId', '=', asset.id).execute(),
    ).resolves.toEqual([]);
  });

  it.each([LibraryScope.Personal, LibraryScope.Both])('keeps a font in Boards: no move to %s', async (scope) => {
    const { ctx, sut } = setup();
    const { user, asset } = await newFont(ctx);

    await expect(sut.setLibraryScope([asset.id], user.id, scope)).rejects.toBeInstanceOf(BadRequestException);
    await expect(sut.getById(asset.id)).resolves.toMatchObject({ libraryScope: LibraryScope.Design });
    await expect(sut.setLibraryScope([asset.id], user.id, LibraryScope.Design)).resolves.toBeDefined();
  });

  it('leaves a font out of search and text reading, though it has a preview', async () => {
    const { ctx, jobs } = setup();
    const { user, asset: font } = await newFont(ctx);
    const { asset: photo } = await ctx.newAsset({ ownerId: user.id, libraryScope: LibraryScope.Design });
    for (const { id } of [font, photo]) {
      await ctx.newJobStatus({ assetId: id });
      await ctx.newAssetFile({ assetId: id, type: 'preview' as never, path: `/thumbs/${id}_preview.jpeg` });
    }
    const ids = async (selection: { execute: () => Promise<{ id: string }[]> }) =>
      (await selection.execute()).map(({ id }) => id).filter((id) => id === font.id || id === photo.id);

    await expect(ids(jobs.selectionForEncodeClip(false))).resolves.toEqual([photo.id]);
    await expect(ids(jobs.selectionForOcrJob(false))).resolves.toEqual([photo.id]);
  });
});
