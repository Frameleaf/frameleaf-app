import { Kysely } from 'kysely';
import { SyncRequestType } from 'src/enum.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/**
 * FL-326 (spec §4.8): a partner receives their own copies, which arrive through their own asset
 * streams. The partner asset exif stream stays for older clients and sends nothing.
 */
describe(SyncRequestType.PartnerAssetExifsV1, () => {
  it("sends nothing of a partner's library, whatever it holds", async () => {
    const { auth, user, ctx } = await setup();
    const { user: partner } = await ctx.newUser();
    await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
    const { asset } = await ctx.newAsset({ ownerId: partner.id });
    await ctx.newExif({ assetId: asset.id, make: 'Canon' });

    await ctx.assertSyncIsComplete(auth, [SyncRequestType.PartnerAssetExifsV1]);
  });
});
