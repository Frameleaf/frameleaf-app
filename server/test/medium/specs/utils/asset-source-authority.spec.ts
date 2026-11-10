import { Kysely } from 'kysely';
import { AssetFileType } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { assertAssetSource, readAssetSource } from 'src/utils/asset-source-authority.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});
afterAll(async () => {
  await defaultDatabase?.destroy();
});

const setup = () => newMediumService(BaseService, { database: defaultDatabase, real: [], mock: [LoggingRepository] });

describe('asset source authority', () => {
  it('keeps a render current when only the XMP sidecar changes (FL-927)', async () => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: '/data/preview.jpg' });
    const source = await readAssetSource(defaultDatabase, asset.id, true);

    // saving a face writes the photo's first sidecar while an edit is still rendering
    await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Sidecar, path: '/data/photo.jpg.xmp' });
    await expect(assertAssetSource(defaultDatabase, source!)).resolves.toBeUndefined();

    await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Thumbnail, path: '/data/thumbnail.webp' });
    await expect(assertAssetSource(defaultDatabase, source!)).rejects.toThrow(
      'Asset inputs changed before publication',
    );
  });
});
