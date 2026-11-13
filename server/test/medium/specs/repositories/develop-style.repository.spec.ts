import type { Kysely } from 'kysely';
import type { DB } from 'src/schema/index.js';
import { DevelopStyleRepository } from 'src/repositories/develop-style.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

it('does not recreate a profile that was forgotten while a refresh was training', async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const repository = new DevelopStyleRepository(db);
  const profile = {
    userId: user.id,
    version: 1,
    sampleCount: 50,
    modelJson: { imageSize: 0, embeddingMean: [], axes: [], coefficients: [], producerModelKey: null },
    trainedAt: new Date('2026-10-01T00:00:00Z'),
  };
  expect(await repository.saveProfile(profile, null)).toBe(true);
  const newer = { ...profile, trainedAt: new Date('2026-10-08T00:00:00Z') };
  expect(await repository.saveProfile(newer, profile.trainedAt)).toBe(true);

  await repository.forget(user.id);
  expect(await repository.saveProfile({ ...newer, trainedAt: new Date('2026-10-15T00:00:00Z') }, newer.trainedAt)).toBe(
    false,
  );
  expect(await repository.getProfile(user.id)).toBeUndefined();
});
