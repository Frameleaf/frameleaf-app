import { Kysely } from 'kysely';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { AssetVisibility, DocumentEditAction } from 'src/enum.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { DocumentEditConflictError, DocumentRepository } from 'src/repositories/document.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { OcrRepository } from 'src/repositories/ocr.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;

beforeAll(async () => {
  database = await getKyselyDB();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new DocumentRepository(database) };
};

describe(DocumentRepository.name, () => {
  it('searches visible OCR and corrections without leaking cropped, Locked, or other owners’ text', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { asset: visible } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: archived } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Archive });
    const { asset: locked } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
    const { asset: cropped } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: manual } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: empty } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: foreign } = await ctx.newAsset({ ownerId: other.id });

    await database.insertInto('ocr_search').values([
      { assetId: visible.id, text: 'invoice' },
      { assetId: archived.id, text: 'invoice' },
      { assetId: locked.id, text: 'invoice' },
      { assetId: manual.id, text: 'invoice' },
      { assetId: empty.id, text: '' },
      { assetId: foreign.id, text: 'invoice' },
    ]).execute();

    const region = { x1: 0.1, y1: 0.1, x2: 0.4, y2: 0.1, x3: 0.4, y3: 0.4, x4: 0.1, y4: 0.4 };
    const survivingRegion = { x1: 0.6, y1: 0.6, x2: 0.9, y2: 0.6, x3: 0.9, y3: 0.9, x4: 0.6, y4: 0.9 };
    const ocr = ctx.get(OcrRepository);
    await ocr.upsert(cropped.id, [
      { assetId: cropped.id, text: 'confidential', boxScore: 1, textScore: 1, ...region },
      { assetId: cropped.id, text: 'invoice', boxScore: 1, textScore: 1, ...survivingRegion },
    ], 'confidential invoice');
    await sut.create({ assetId: cropped.id, key: 'field:total', action: DocumentEditAction.Correct,
      value: 'private-total', sourceText: 'confidential', editedById: owner.id, ...region });
    await sut.create({ assetId: manual.id, key: 'field:reference', action: DocumentEditAction.Correct,
      value: 'manual-reference', sourceText: null, editedById: owner.id });
    const search = (query?: string, lockedOwnerId?: string) =>
      sut.search({ ownerId: owner.id, lockedOwnerId, query, page: 1, size: 20 });
    const ids = async (query?: string, lockedOwnerId?: string) =>
      (await search(query, lockedOwnerId)).items.map(({ id }) => id).sort();
    await expect(ids('confidential')).resolves.toEqual([cropped.id]);
    await expect(ids('private-total')).resolves.toEqual([cropped.id]);

    const lines = await ocr.getByAssetId(cropped.id);
    await ctx.get(AssetEditRepository).replaceAll(cropped.id, [
      { action: AssetEditAction.Crop, parameters: { x: 50, y: 50, width: 50, height: 50 } },
    ]);
    await ocr.updateOcrVisibilities(cropped.id,
      [lines.find(({ text }) => text === 'invoice')!],
      [lines.find(({ text }) => text === 'confidential')!],
    );

    await expect(database.selectFrom('ocr_search').select('text').where('assetId', '=', cropped.id).executeTakeFirst())
      .resolves.toEqual({ text: 'invoice' });
    await expect(ids()).resolves.toEqual([visible.id, cropped.id, manual.id].sort());
    await expect(ids('invoice')).resolves.toEqual([visible.id, archived.id, cropped.id, manual.id].sort());
    await expect(ids('invoice', owner.id)).resolves.toEqual([visible.id, archived.id, locked.id, cropped.id, manual.id].sort());
    await expect(ids('confidential')).resolves.toEqual([]);
    await expect(ids('private-total')).resolves.toEqual([]);
    await expect(ids('manual-reference')).resolves.toEqual([manual.id]);
    await expect(search('manual-reference')).resolves.toMatchObject({ total: 1, hasNextPage: false });
  });

  it('keeps one decision per key and rejects stale updates and deletes', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const values = { assetId: asset.id, key: 'field:total', action: DocumentEditAction.Correct,
      value: '12.00', sourceText: null, editedById: user.id };
    const first = await sut.create(values);

    await expect(sut.create(values)).rejects.toBeInstanceOf(DocumentEditConflictError);
    const second = await sut.update(first.id, first.revision, { value: '13.00' });
    expect(second).toMatchObject({ revision: first.revision + 1, value: '13.00' });
    await expect(sut.update(first.id, first.revision, { value: '14.00' })).rejects.toBeInstanceOf(
      DocumentEditConflictError,
    );
    await expect(sut.delete(first.id, asset.id, first.revision)).rejects.toBeInstanceOf(DocumentEditConflictError);
    await expect(sut.getEdits(asset.id)).resolves.toEqual([expect.objectContaining({ id: first.id, value: '13.00' })]);
    await sut.delete(first.id, asset.id, second.revision);
    await expect(sut.getEdits(asset.id)).resolves.toEqual([]);
  });
});
