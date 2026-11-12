import { Kysely } from 'kysely';
import { MediaOperationDestination, UserMetadataKey } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { assertCloudProcessingAllowed } from 'src/utils/cloud-processing-choice.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-1484: someone who keeps their photos at home never has Frameleaf Cloud work recorded for them. */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

it('finds the people who keep their photos at home and refuses Frameleaf Cloud work for their photos', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const sut = new UserRepository(db);
  const { user: emma } = await ctx.newUser();
  const { user: taylor } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: emma.id });

  await sut.upsertMetadata(emma.id, {
    key: UserMetadataKey.Preferences,
    value: { cloudProcessing: { enabled: false } },
  });
  await sut.upsertMetadata(taylor.id, {
    key: UserMetadataKey.Preferences,
    value: { cloudProcessing: { enabled: true } },
  });

  await expect(sut.getCloudProcessingOptOuts([emma.id, taylor.id])).resolves.toEqual(new Set([emma.id]));
  await expect(sut.getCloudProcessingOptOuts([taylor.id])).resolves.toEqual(new Set());
  expect((await sut.getCloudProcessingOptOuts()).has(emma.id)).toBe(true);

  const cloud = { destination: MediaOperationDestination.FrameleafCloud, ownerId: taylor.id };
  await expect(assertCloudProcessingAllowed(db, cloud)).resolves.toBeUndefined();
  // Emma's own work, or Taylor's work that names Emma's photo, never goes to Frameleaf Cloud
  await expect(assertCloudProcessingAllowed(db, { ...cloud, ownerId: emma.id })).rejects.toThrow('stay at home');
  await expect(assertCloudProcessingAllowed(db, { ...cloud, snapshot: { assetIds: [asset.id] } })).rejects.toThrow(
    'stay at home',
  );
  // work at home is never refused
  await expect(
    assertCloudProcessingAllowed(db, { destination: MediaOperationDestination.Local, ownerId: emma.id }),
  ).resolves.toBeUndefined();
});
