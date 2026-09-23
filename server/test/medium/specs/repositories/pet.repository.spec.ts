import { Kysely } from 'kysely';
import { AssetVisibility, PetObservationState } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PetRepository } from 'src/repositories/pet.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const database = db || defaultDatabase;
  const { ctx } = newMediumService(BaseService, {
    database,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: new PetRepository(database, LoggingRepository.create()) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(PetRepository.name, () => {
  describe('Locked media (FL-34)', () => {
    it("should count, list and propose Locked media only for its owner's elevated session", async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset: timeline } = await ctx.newAsset({ ownerId: user.id });
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const pet = await sut.create({ ownerId: user.id, name: 'Biscuit' });
      for (const asset of [timeline, locked]) {
        await sut.upsertObservation({ petId: pet.id, assetId: asset.id, state: PetObservationState.Confirmed });
      }
      const lockedObservation = (await sut.getObservations(user.id, pet.id, { withLocked: true })).find(
        ({ assetId }) => assetId === locked.id,
      );

      const ordinary = {};
      const elevated = { lockedOwnerId: user.id };

      await expect(sut.getAll(user.id, { withHidden: false, ...ordinary })).resolves.toEqual([
        expect.objectContaining({ id: pet.id, assetCount: 1 }),
      ]);
      await expect(sut.getAll(user.id, { withHidden: false, ...elevated })).resolves.toEqual([
        expect.objectContaining({ id: pet.id, assetCount: 2 }),
      ]);
      await expect(sut.getById(user.id, pet.id, ordinary)).resolves.toEqual(
        expect.objectContaining({ assetCount: 1 }),
      );

      const observed = async (options: { lockedOwnerId?: string }) =>
        (await sut.getObservations(user.id, pet.id, options)).map(({ assetId }) => assetId).sort();
      await expect(observed(ordinary)).resolves.toEqual([timeline.id]);
      await expect(observed(elevated)).resolves.toEqual([timeline.id, locked.id].sort());

      expect(lockedObservation).toBeDefined();
      await expect(sut.getObservationById(user.id, lockedObservation!.id, ordinary)).resolves.toBeUndefined();
      await expect(sut.getObservationById(user.id, lockedObservation!.id, elevated)).resolves.toEqual(
        expect.objectContaining({ assetId: locked.id }),
      );
    });
  });
});
