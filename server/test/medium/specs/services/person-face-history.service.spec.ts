import { ConflictException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { AssetFileType, JobName, SourceType } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { PersonService } from 'src/services/person.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newEmbedding } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-57 against PostgreSQL: manual face decisions and their history survive a forced recognition
 * rebuild and a forced detection rebuild, are applied again to a face that replaced the corrected one,
 * are not applied to a replaced original, and can be undone only while the face still stands as the
 * decision left it. Every test runs on its own database: rebuilds touch every face.
 */
const setup = async () => {
  const database: Kysely<DB> = await getKyselyDB();
  const { sut, ctx } = newMediumService(PersonService, {
    database,
    real: [
      AccessRepository,
      AssetJobRepository,
      ConfigRepository,
      CryptoRepository,
      DatabaseRepository,
      PersonRepository,
      AssetRepository,
      AssetEditRepository,
      SystemMetadataRepository,
    ],
    mock: [JobRepository, LoggingRepository, StorageRepository, MachineLearningRepository, MlDestinationRepository],
  });
  const jobs = ctx.getMock(JobRepository);
  jobs.queue.mockResolvedValue();
  jobs.queueAll.mockResolvedValue();
  jobs.waitForQueueCompletion.mockResolvedValue();
  jobs.getJobCounts.mockResolvedValue({ active: 0, waiting: 0, completed: 0, delayed: 0, failed: 0, paused: 0 });
  ctx.getMock(StorageRepository).unlink.mockResolvedValue();

  const { user } = await ctx.newUser();
  const auth = factory.auth({ user });
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  await ctx.newExif({ assetId: asset.id, description: '' });
  await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: '/preview.jpg' });
  const { person: ada } = await ctx.newPerson({ ownerId: user.id, name: 'Ada' });
  const { person: bea } = await ctx.newPerson({ ownerId: user.id, name: 'Bea' });

  // Ada keeps a hand-tagged face elsewhere, so she is still there to undo back to after rebuilds
  const { asset: other } = await ctx.newAsset({ ownerId: user.id });
  await ctx.newAssetFace({ assetId: other.id, personGroupId: ada.personGroupId, sourceType: SourceType.Manual });
  // Bea has a photo of her own too, so a face moved to her is a reassignment, not "someone new"
  await ctx.newAssetFace({ assetId: other.id, personGroupId: bea.personGroupId, sourceType: SourceType.Manual });

  const box = { imageWidth: 400, imageHeight: 500, boundingBoxY1: 100, boundingBoxY2: 200 };
  const { assetFace: face } = await ctx.newAssetFace({
    assetId: asset.id,
    personGroupId: ada.personGroupId,
    ...box,
    boundingBoxX1: 50,
    boundingBoxX2: 150,
  });
  const { assetFace: neighbour } = await ctx.newAssetFace({
    assetId: asset.id,
    personGroupId: ada.personGroupId,
    ...box,
    boundingBoxX1: 250,
    boundingBoxX2: 350,
  });
  const embeddingOf = newEmbedding();
  for (const faceId of [face.id, neighbour.id]) {
    await ctx.database.insertInto('face_search').values({ faceId, embedding: embeddingOf }).execute();
  }

  const detect = (boxes: { x1: number; x2: number }[]) =>
    ctx.getMock(MachineLearningRepository).detectFaces.mockResolvedValue({
      imageWidth: 400,
      imageHeight: 500,
      faces: boxes.map(({ x1, x2 }) => ({
        boundingBox: { x1, x2, y1: 100, y2: 200 },
        embedding: newEmbedding(),
        score: 0.9,
      })),
    });
  const facesOf = () =>
    ctx.database
      .selectFrom('asset_face')
      .select(['id', 'personGroupId', 'deletedAt', 'correctedAt', 'boundingBoxX1'])
      .where('assetId', '=', asset.id)
      .orderBy('boundingBoxX1')
      .execute();

  return { sut, ctx, auth, user, asset, ada, bea, face, neighbour, detect, facesOf, jobs };
};

const reason = async (promise: Promise<unknown>) => {
  const error = await promise.catch((error_: unknown) => error_);
  expect(error).toBeInstanceOf(ConflictException);
  return ((error as ConflictException).getResponse() as { reason: string }).reason;
};

describe('face decisions through reprocessing (FL-57)', () => {
  it('keeps a correction and its history through forced recognition and forced detection, then undoes it', async () => {
    const { sut, auth, ada, bea, face, neighbour, detect, facesOf } = await setup();

    await sut.reassignFacesById(auth, bea.personGroupId, { id: face.id });

    await sut.handleQueueRecognizeFaces({ force: true });
    let faces = await facesOf();
    expect(faces.find(({ id }) => id === face.id)?.personGroupId).toBe(bea.personGroupId);
    expect(faces.find(({ id }) => id === neighbour.id)?.personGroupId).toBeNull();

    await sut.handleQueueDetectFaces({ force: true });
    faces = await facesOf();
    expect(faces.map(({ id }) => id)).toEqual([face.id]);

    // the new detection finds both faces again: the corrected one is matched, the other is new
    detect([
      { x1: 52, x2: 150 },
      { x1: 250, x2: 350 },
    ]);
    await sut.handleDetectFaces({ id: face.assetId });
    faces = await facesOf();
    expect(faces).toHaveLength(2);
    expect(faces[0]).toEqual(expect.objectContaining({ id: face.id, personGroupId: bea.personGroupId }));

    const { corrections } = await sut.getCorrectionHistory(auth, bea.personGroupId, { page: 1, size: 25 });
    expect(corrections).toEqual([
      expect.objectContaining({
        action: 'reassign',
        fromPerson: expect.objectContaining({ id: ada.personGroupId, name: 'Ada' }),
        toPerson: expect.objectContaining({ id: bea.personGroupId, name: 'Bea' }),
        evidence: expect.objectContaining({ assetId: face.assetId }),
        undoable: true,
      }),
    ]);

    await expect(sut.undoCorrection(auth, corrections[0].id)).resolves.toEqual(
      expect.objectContaining({ undoneAt: expect.any(String), undoable: false }),
    );
    expect((await facesOf())[0].personGroupId).toBe(ada.personGroupId);
    await expect(reason(sut.undoCorrection(auth, corrections[0].id))).resolves.toBe('already-undone');
  });

  it('applies a decision again to the face that replaced the corrected one, and not to recognition', async () => {
    const { sut, ctx, auth, bea, face, detect, facesOf, jobs } = await setup();

    await sut.reassignFacesById(auth, bea.personGroupId, { id: face.id });
    await sut.deleteFace(auth, face.id, { force: true }); // "not a face" permanently: the row goes

    detect([{ x1: 55, x2: 150 }]);
    jobs.queueAll.mockClear();
    await sut.handleDetectFaces({ id: face.assetId });

    const faces = await facesOf();
    const added = faces.find(({ boundingBoxX1 }) => boundingBoxX1 === 55)!;
    expect(added).toBeDefined();
    // the latest standing decision was "not a face of anyone": the new face is taken off again
    expect(added.deletedAt).not.toBeNull();
    expect(jobs.queueAll).not.toHaveBeenCalledWith(
      expect.arrayContaining([{ name: JobName.FacialRecognition, data: { id: added.id } }]),
    );
    const { corrections } = await sut.getCorrectionHistory(auth, bea.personGroupId, { page: 1, size: 25 });
    expect(corrections.map(({ action }) => action).toSorted()).toEqual(['reassign', 'remove']);
    const rows = await sql<{ faceId: string }>`
      SELECT "faceId" FROM immich_fork.face_correction WHERE "assetId" = ${face.assetId}::uuid
    `.execute(ctx.database);
    expect(rows.rows.every(({ faceId }) => faceId === added.id)).toBe(true);
  });

  it('does not apply a decision to a replaced original, and refuses to undo it', async () => {
    const { sut, ctx, auth, bea, face, detect, facesOf } = await setup();

    await sut.reassignFacesById(auth, bea.personGroupId, { id: face.id });
    await ctx.database
      .updateTable('asset')
      .set({ checksum: Buffer.from('a new original') })
      .where('id', '=', face.assetId)
      .execute();

    // the new original has no face there: the corrected face is no longer held
    detect([]);
    await sut.handleDetectFaces({ id: face.assetId });
    expect((await facesOf()).some(({ id }) => id === face.id)).toBe(false);

    const { corrections } = await sut.getCorrectionHistory(auth, bea.personGroupId, { page: 1, size: 25 });
    await expect(reason(sut.undoCorrection(auth, corrections[0].id))).resolves.toBe('source-changed');

    // a face found at the same place on the new original starts undecided
    detect([{ x1: 50, x2: 150 }]);
    await sut.handleDetectFaces({ id: face.assetId });
    const faces = await facesOf();
    expect(faces.find(({ boundingBoxX1 }) => boundingBoxX1 === 50)).toEqual(
      expect.objectContaining({ personGroupId: null, correctedAt: null }),
    );
  });

  it('undoes only while the face stands as the change left it', async () => {
    const { sut, ctx, auth, ada, bea, face, facesOf } = await setup();
    const { person: cleo } = await ctx.newPerson({ ownerId: auth.user.id, name: 'Cleo' });

    await sut.reassignFacesById(auth, bea.personGroupId, { id: face.id });
    await sut.reassignFacesById(auth, cleo.personGroupId, { id: face.id });
    const toBea = (await sut.getCorrectionHistory(auth, bea.personGroupId, { page: 1, size: 25 })).corrections;
    const older = toBea.find(({ toPerson }) => toPerson?.id === bea.personGroupId)!;
    const newer = toBea.find(({ toPerson }) => toPerson?.id === cleo.personGroupId)!;

    await expect(reason(sut.undoCorrection(auth, older.id))).resolves.toBe('face-changed');
    await sut.undoCorrection(auth, newer.id);
    expect((await facesOf()).find(({ id }) => id === face.id)?.personGroupId).toBe(bea.personGroupId);
    await sut.undoCorrection(auth, older.id);
    expect((await facesOf()).find(({ id }) => id === face.id)?.personGroupId).toBe(ada.personGroupId);

    // someone else's history is not theirs to undo
    const { user: stranger } = await ctx.newUser();
    await expect(sut.undoCorrection(factory.auth({ user: stranger }), older.id)).rejects.toThrow(
      'Correction not found',
    );
  });

  it('merges on "same" and keeps the merge in the survivor\'s history; "ignore" stops suggesting the person', async () => {
    const { sut, ctx, auth, ada, bea, face, neighbour } = await setup();
    const embedding = newEmbedding();
    for (const faceId of [face.id, neighbour.id]) {
      await ctx.database.updateTable('face_search').set({ embedding }).where('faceId', '=', faceId).execute();
    }
    await sut.reassignFacesById(auth, bea.personGroupId, { id: neighbour.id });
    const people = ctx.get(PersonRepository);
    await people.update({ ownerId: auth.user.id, personGroupId: ada.personGroupId, faceAssetId: face.id });
    await people.update({ ownerId: auth.user.id, personGroupId: bea.personGroupId, faceAssetId: neighbour.id });

    const { suggestions } = await sut.getMergeSuggestions(auth);
    expect(suggestions).toHaveLength(1);
    expect(suggestions[0].personEvidence).toEqual(expect.objectContaining({ assetId: face.assetId }));
    expect(suggestions[0].suggestionEvidence).toEqual(expect.objectContaining({ assetId: face.assetId }));

    await sut.setMergeVerdict(auth, {
      personId: ada.personGroupId,
      suggestionId: bea.personGroupId,
      verdict: 'ignore',
    });
    await expect(sut.getMergeSuggestions(auth)).resolves.toEqual({ suggestions: [] });
    await sut.deleteMergeVerdict(auth, { personId: ada.personGroupId, suggestionId: ada.personGroupId });
    await expect(sut.getMergeSuggestions(auth)).resolves.toEqual({ suggestions: [expect.anything()] });

    await expect(
      sut.setMergeVerdict(auth, { personId: bea.personGroupId, suggestionId: ada.personGroupId, verdict: 'same' }),
    ).resolves.toEqual(expect.objectContaining({ personId: bea.personGroupId, suggestionId: ada.personGroupId }));
    const { corrections } = await sut.getCorrectionHistory(auth, bea.personGroupId, { page: 1, size: 25 });
    expect(corrections[0]).toEqual(
      expect.objectContaining({
        action: 'merge',
        fromPerson: { id: ada.personGroupId, name: 'Ada', exists: false },
        undoable: false,
      }),
    );
  });
});
