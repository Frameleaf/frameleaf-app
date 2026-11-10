import { Kysely } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { DB } from 'src/schema/index.js';
import { AssistantService } from 'src/services/assistant.service.js';
import { SearchService } from 'src/services/search.service.js';
import { upsertTags } from 'src/utils/tag.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

/** The assistant on a real SearchService and database; the catalogue services answer with no names. */
const setup = () => {
  const { sut: search, ctx } = newMediumService(SearchService, {
    database: defaultDatabase,
    real: [
      AccessRepository,
      AssetRepository,
      ConfigRepository,
      DatabaseRepository,
      PartnerRepository,
      PersonRepository,
      SearchRepository,
      SystemMetadataRepository,
      TagRepository,
    ],
    mock: [LoggingRepository],
  });
  const none = { getAll: () => Promise.resolve([]) };
  const sut = new AssistantService(
    { setContext: () => {}, debug: () => {} } as never,
    search,
    { search: () => Promise.resolve({ items: [], total: 0, nextCursor: null }) } as never,
    { getAll: () => Promise.resolve({ people: [] }) } as never,
    none as never,
    none as never,
    none as never,
    {} as never,
    {} as never,
  );
  return { sut, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssistantService.name, () => {
  // "screenshots in <city>" is a rules plan with a file name and a city filter; smart search is not involved
  const question = (city: string) => `screenshots in ${city}`;
  // the rules read a place as letters and title-case it
  const newCity = () =>
    `Assistant ${factory
      .uuid()
      .replaceAll(/[^a-f]/g, '')
      .slice(0, 6)
      .replace(/^./, (letter) => letter.toUpperCase())}`;

  it('returns only the asker’s own visible items, never Locked ones, even in an unlocked session', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: stranger } = await ctx.newUser();
    const city = newCity();
    const add = async (ownerId: string, visibility = AssetVisibility.Timeline) => {
      const { asset } = await ctx.newAsset({ ownerId, visibility, originalFileName: 'Screenshot 2024.png' });
      await ctx.newExif({ assetId: asset.id, city });
      return asset;
    };
    const visible = await add(user.id);
    await add(user.id, AssetVisibility.Locked);
    await add(stranger.id);

    for (const session of [{}, { hasElevatedPermission: true }]) {
      const response = await sut.ask(factory.auth({ user, session }), { query: question(city) });
      expect(response.answeredBy).toBe('rules');
      expect(response.results.assets.items.map(({ id }) => id)).toEqual([visible.id]);
      expect(response.reasons[0].items.map(({ kind }) => kind)).toEqual(['place', 'file']);
    }
  });

  it('leaves out items hidden by the asker’s own rules while the session is not unlocked', async () => {
    const { sut, ctx } = setup();
    const { user } = await ctx.newUser();
    const city = newCity();
    const { asset: shown } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'Screenshot 1.png' });
    const { asset: hidden } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'Screenshot 2.png' });
    await ctx.newExif({ assetId: shown.id, city });
    await ctx.newExif({ assetId: hidden.id, city });
    const [tag] = await upsertTags(ctx.get(TagRepository), { userId: user.id, tags: ['Private'] });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [hidden.id] });
    const auth = {
      ...factory.auth({ user }),
      hiddenContent: {
        userId: user.id,
        includeNsfw: true,
        tagIds: [tag.id],
        personIds: [],
        petIds: [],
        scope: 'owned' as const,
      },
    };

    const response = await sut.ask(auth, { query: question(city) });
    expect(response.results.assets.items.map(({ id }) => id)).toEqual([shown.id]);
  });
});
