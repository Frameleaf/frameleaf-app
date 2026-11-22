import { Kysely } from 'kysely';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;
beforeAll(async () => {
  database = await getKyselyDB();
});

const vector = `[${Array.from({ length: 768 }, (_, index) => (index === 0 ? 1 : 0)).join(',')}]`;

describe('visual search for partner copies', () => {
  it('queues a copy only once its source has been read', async () => {
    const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
    const jobs = ctx.get(AssetJobRepository);
    const { user: sharer } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    const { asset: source } = await ctx.newAsset({ ownerId: sharer.id });
    const { asset: copy } = await ctx.newAsset({ ownerId: partner.id });
    for (const { id } of [source, copy]) {
      await ctx.newJobStatus({ assetId: id });
      await ctx.newAssetFile({ assetId: id, type: 'preview' as never, path: `/thumbs/${id}_preview.jpeg` });
    }
    await ctx.get(PartnerOriginRepository).createAssetOrigin({
      id: copy.id,
      sourceId: source.id,
      ownerId: partner.id,
      rootOwnerId: sharer.id,
      partnerSharedById: sharer.id,
    });
    const queued = async () =>
      (await jobs.selectionForEncodeClip(false).execute())
        .map(({ id }) => id)
        .filter((id) => id === source.id || id === copy.id);

    // the copy's job would only be skipped: it takes the source's result, and the source has none yet
    await expect(queued()).resolves.toEqual([source.id]);

    await database.insertInto('smart_search').values({ assetId: source.id, embedding: vector }).execute();
    await expect(queued()).resolves.toEqual([copy.id]);

    // a copy whose source is gone reads its own picture
    await database.deleteFrom('smart_search').where('assetId', '=', source.id).execute();
    await database.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', source.id).execute();
    await expect(queued()).resolves.toEqual([copy.id]);
  });
});
