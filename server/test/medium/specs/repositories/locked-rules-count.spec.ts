import { Kysely } from 'kysely';
import { AssetType, AssetVisibility } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: defaultDatabase, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(AssetRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe('AssetRepository.countLockedRuleMatches (FL-541)', () => {
  it('counts the owner’s own photos and videos a draft of their Locked rules matches', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { person } = await ctx.newPerson({ ownerId: user.id });
    const { tag } = await ctx.newTag({ userId: user.id, value: 'private' });

    const face = async (ownerId: string, extra: object = {}) => {
      const { asset } = await ctx.newAsset({ ownerId, ...extra });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      return asset;
    };
    await face(user.id);
    await face(user.id, { visibility: AssetVisibility.Archive });
    await face(user.id, { type: AssetType.Video });
    // not counted: in Trash, already Locked (its own lock), someone else's
    await face(user.id, { deletedAt: new Date() });
    await face(user.id, { visibility: AssetVisibility.Locked });
    await face(other.id);
    const { asset: tagged } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [tagged.id] });
    await ctx.newAsset({ ownerId: user.id });

    const draft = { userId: user.id, tagIds: [], personIds: [person.personGroupId!], petIds: [] };
    await expect(sut.countLockedRuleMatches(draft)).resolves.toEqual({ photos: 2, videos: 1 });
    await expect(sut.countLockedRuleMatches({ ...draft, tagIds: [tag.id] })).resolves.toEqual({ photos: 3, videos: 1 });
    await expect(sut.countLockedRuleMatches({ ...draft, personIds: [] })).resolves.toEqual({ photos: 0, videos: 0 });
  });
});
