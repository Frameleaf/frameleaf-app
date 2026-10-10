import { Kysely, sql } from 'kysely';
import { AssetVisibility, PetObservationSource, PetObservationState, PetRecognitionRunStatus } from 'src/enum.js';
import { publicationTransaction } from 'src/queue/transaction.js';
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
  it('filters suppressed people from detail counts and returned observations', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { person } = await ctx.newPerson({ ownerId: user.id });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    const pet = await sut.create({ ownerId: user.id, name: 'Biscuit' });
    await sut.upsertObservation({ petId: pet.id, assetId: asset.id, state: PetObservationState.Confirmed });
    const options = {
      hiddenContent: {
        userId: user.id,
        personIds: [person.personGroupId],
        petIds: [],
        tagIds: [],
        includeNsfw: false,
        scope: 'owned' as const,
      },
    };
    expect((await sut.getById(user.id, pet.id, options))!.assetCount).toBe(0);
    expect(await sut.getObservations(user.id, pet.id, options)).toEqual([]);
    expect((await sut.getById(user.id, pet.id))!.assetCount).toBe(1);
    expect(await sut.getObservations(user.id, pet.id)).toHaveLength(1);
  });

  it('leaves trashed photos out of detail counts and observations while preserving merge inputs', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, deletedAt: new Date() });
    const pet = await sut.create({ ownerId: user.id, name: 'Biscuit' });
    await sut.upsertObservation({ petId: pet.id, assetId: asset.id, state: PetObservationState.Confirmed });
    expect((await sut.getById(user.id, pet.id))!.assetCount).toBe(0);
    expect((await sut.getAll(user.id, { withHidden: false }))[0].assetCount).toBe(0);
    expect(await sut.getObservations(user.id, pet.id)).toEqual([]);
    expect(await sut.getObservations(user.id, pet.id, { withLocked: true })).toHaveLength(1);
  });

  it('stores recognition runs and source revisions in the canonical schema', async () => {
    const { rows } = await sql<{
      name: string | null;
    }>`SELECT to_regclass('public.pet_recognition_run')::text AS name`.execute(defaultDatabase);
    expect(rows[0].name).toBe('pet_recognition_run');
    const columns = await sql<{ column_name: string }>`SELECT column_name FROM information_schema.columns
      WHERE table_schema = 'public' AND table_name = 'pet_observation'
      AND column_name IN ('sourceChecksum', 'staleAt') ORDER BY column_name`.execute(defaultDatabase);
    expect(columns.rows.map(({ column_name }) => column_name)).toEqual(['sourceChecksum', 'staleAt']);
  });

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
      await expect(sut.getById(user.id, pet.id, ordinary)).resolves.toEqual(expect.objectContaining({ assetCount: 1 }));

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

  describe('source checksums (FL-58)', () => {
    it('records the original a decision was made on and flags only drawn regions once it is replaced', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const biscuit = await sut.create({ ownerId: user.id, name: 'Biscuit' });
      const rex = await sut.create({ ownerId: user.id, name: 'Rex' });
      const region = await sut.upsertObservation({
        petId: biscuit.id,
        assetId: asset.id,
        state: PetObservationState.Confirmed,
        source: PetObservationSource.Manual,
        boundingBoxX1: 10,
        boundingBoxY1: 10,
        boundingBoxX2: 100,
        boundingBoxY2: 100,
        imageWidth: 200,
        imageHeight: 200,
      });
      const whole = await sut.upsertObservation({
        petId: rex.id,
        assetId: asset.id,
        state: PetObservationState.Confirmed,
        source: PetObservationSource.Manual,
      });

      expect(Buffer.from(region.sourceChecksum!).equals(Buffer.from(asset.checksum))).toBe(true);
      await expect(sut.flagStaleRegions(asset.id)).resolves.toBe(0);

      const replaced = Buffer.from('a replaced original');
      await ctx.database.updateTable('asset').set({ checksum: replaced }).where('id', '=', asset.id).execute();
      await expect(sut.getOwnedAssetChecksum(user.id, asset.id)).resolves.toEqual(replaced);
      await expect(sut.flagStaleRegions(asset.id)).resolves.toBe(1);

      const after = await sut.getObservationsForAsset(user.id, asset.id);
      const flagged = after.find(({ id }) => id === region.id)!;
      expect(flagged.staleAt).not.toBeNull();
      // kept, not deleted, and the identity stays confirmed
      expect(flagged.state).toBe(PetObservationState.Confirmed);
      expect(after.find(({ id }) => id === whole.id)!.staleAt).toBeNull();

      // redrawing on the new original is a fresh, current decision
      const redrawn = await sut.upsertObservation({
        petId: biscuit.id,
        assetId: asset.id,
        state: PetObservationState.Confirmed,
        source: PetObservationSource.Manual,
        boundingBoxX1: 20,
        boundingBoxY1: 20,
        boundingBoxX2: 120,
        boundingBoxY2: 120,
        imageWidth: 200,
        imageHeight: 200,
      });
      expect(redrawn.staleAt).toBeNull();
      expect(Buffer.from(redrawn.sourceChecksum!).equals(replaced)).toBe(true);
    });

    it('never reads another account’s asset checksum', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: other.id });

      await expect(sut.getOwnedAssetChecksum(user.id, asset.id)).resolves.toBeUndefined();
    });
  });

  describe('model reprocessing (FL-58)', () => {
    it('replaces only the model side when the revision changes; answered pairs stay answered', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const biscuit = await sut.create({ ownerId: user.id, name: 'Biscuit' });
      const rex = await sut.create({ ownerId: user.id, name: 'Rex' });
      const ignored = await sut.upsertObservation({
        petId: rex.id,
        assetId: asset.id,
        state: PetObservationState.Rejected,
        source: PetObservationSource.Review,
      });
      const manual = await sut.upsertObservation({
        petId: biscuit.id,
        assetId: asset.id,
        state: PetObservationState.Confirmed,
        source: PetObservationSource.Manual,
      });

      const [old] = await sut.replaceDetections(
        asset.id,
        [],
        [{ modelName: 'clip', modelRevision: 'clip-knn-0:clip' }],
      );
      await sut.upsertCandidates([{ detectionId: old.id, petId: rex.id, score: 0.8 }]);

      const stored = await sut.getDetectionsForAsset(asset.id);
      const [fresh] = await sut.replaceDetections(
        asset.id,
        stored.map(({ id }) => id),
        [{ modelName: 'clip', modelRevision: 'clip-knn-1:clip' }],
      );

      await expect(sut.getDetectionsForAsset(asset.id)).resolves.toEqual([
        expect.objectContaining({ id: fresh.id, modelRevision: 'clip-knn-1:clip' }),
      ]);
      // the candidate went with its detection; the durable decisions did not
      await expect(sut.getCandidates(user.id, 10)).resolves.toEqual([]);
      await expect(sut.getDecisionsForAsset(user.id, asset.id)).resolves.toEqual(
        expect.arrayContaining([
          { petId: rex.id, state: PetObservationState.Rejected },
          { petId: biscuit.id, state: PetObservationState.Confirmed },
        ]),
      );
      await expect(sut.getObservationById(user.id, ignored.id)).resolves.toBeDefined();
      await expect(sut.getObservationById(user.id, manual.id)).resolves.toMatchObject({
        source: PetObservationSource.Manual,
      });
      await expect(sut.getById(user.id, biscuit.id)).resolves.toMatchObject({ name: 'Biscuit' });
    });

    it('deletes only the answered pets’ proposals for a whole-photo detection', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const biscuit = await sut.create({ ownerId: user.id, name: 'Biscuit' });
      const rex = await sut.create({ ownerId: user.id, name: 'Rex' });
      const [detection] = await sut.replaceDetections(asset.id, [], [{ modelName: 'clip', modelRevision: 'r' }]);
      await sut.upsertCandidates([
        { detectionId: detection.id, petId: biscuit.id, score: 0.9 },
        { detectionId: detection.id, petId: rex.id, score: 0.75 },
      ]);

      await sut.deleteCandidates(detection.id, [biscuit.id]);

      await expect(sut.getCandidates(user.id, 10)).resolves.toEqual([expect.objectContaining({ petId: rex.id })]);
    });
  });

  describe('recognition runs (FL-58)', () => {
    it('follows one owner’s run from start to completion, and a restart replaces it', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();

      const run = await sut.startRun(user.id, 'local');
      expect(run).toMatchObject({ ownerId: user.id, status: PetRecognitionRunStatus.Queued });
      await sut.setRunAssets(run.id, 2);
      await sut.recordRunProgress(run.id, 1);
      await expect(sut.getRun(user.id)).resolves.toMatchObject({
        status: PetRecognitionRunStatus.Running,
        processedCount: 1,
        proposalCount: 1,
      });
      await sut.recordRunProgress(run.id, 0);
      await expect(sut.getRun(user.id)).resolves.toMatchObject({
        status: PetRecognitionRunStatus.Completed,
        processedCount: 2,
      });
      await expect(sut.isRunActive(run.id)).resolves.toBe(false);

      const again = await sut.startRun(user.id, 'lan');
      expect(again.id).not.toBe(run.id);
      await expect(sut.isRunActive(again.id)).resolves.toBe(true);
    });

    it('stops counting a cancelled run', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const run = await sut.startRun(user.id, null);
      await sut.setRunAssets(run.id, 5);

      await expect(sut.cancelRun(user.id)).resolves.toMatchObject({ status: PetRecognitionRunStatus.Cancelled });
      await sut.recordRunProgress(run.id, 3);

      await expect(sut.isRunActive(run.id)).resolves.toBe(false);
      await expect(sut.getRun(user.id)).resolves.toMatchObject({ processedCount: 0, proposalCount: 0 });
    });

    it('rolls back canonical run setup and counters with the caller transaction', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const run = await sut.startRun(user.id, 'local');
      await sut.setRunAssets(run.id, 3);
      await expect(
        defaultDatabase.transaction().execute((tx) =>
          publicationTransaction.run(tx, async () => {
            const writer = new PetRepository(tx, LoggingRepository.create());
            const replacement = await writer.startRun(user.id, 'lan');
            await writer.setRunAssets(replacement.id, 9);
            throw new Error('setup interrupted');
          }),
        ),
      ).rejects.toThrow('setup interrupted');
      await expect(sut.getRun(user.id)).resolves.toMatchObject({
        id: run.id,
        assetCount: 3,
        processedCount: 0,
        status: PetRecognitionRunStatus.Running,
      });
    });
  });
});
