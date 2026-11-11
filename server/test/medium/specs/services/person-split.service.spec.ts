import { ConflictException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetEditRepository } from 'src/repositories/asset-edit.repository.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DatabaseRepository } from 'src/repositories/database.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { PersonService } from 'src/services/person.service.js';
import { useRealJobPublication } from 'test/fixtures/job-publication.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-1385 against PostgreSQL: the nightly check finds a person who holds the faces of two different
 * people, the suggestion shows faces from both sides, and the three answers do what they say. Every
 * test runs on its own database: the nightly check reads every person.
 */
const frame = { imageWidth: 1000, imageHeight: 1000 };
const box = { ...frame, boundingBoxX1: 400, boundingBoxY1: 300, boundingBoxX2: 550, boundingBoxY2: 500 };

/** A face of identity `index`: its own direction, with a little of a second one so no two are identical. */
const embedding = (index: number, mix: number) => {
  const vector = Array.from({ length: 512 }, () => 0);
  vector[index] = 1;
  vector[100 + mix] = 0.3;
  return `[${vector}]`;
};

const setup = async () => {
  const database: Kysely<DB> = await getKyselyDB();
  onTestFinished(() => database.destroy());
  const { sut, ctx } = newMediumService(PersonService, {
    database,
    real: [
      AccessRepository,
      AssetJobRepository,
      ConfigRepository,
      CryptoRepository,
      DatabaseRepository,
      PersonRepository,
      SearchRepository,
      AssetRepository,
      AssetEditRepository,
      SystemMetadataRepository,
    ],
    mock: [
      EventRepository,
      JobRepository,
      LoggingRepository,
      StorageRepository,
      MachineLearningRepository,
      MlDestinationRepository,
    ],
  });
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  const jobs = ctx.getMock(JobRepository);
  useRealJobPublication(database, jobs, [sut]);
  jobs.queue.mockResolvedValue();
  jobs.queueAll.mockResolvedValue();
  ctx.getMock(StorageRepository).unlink.mockResolvedValue();

  const { user } = await ctx.newUser();
  const auth = factory.auth({ user });
  const newPersonWithFaces = async (name: string, identities: number[]) => {
    const { person } = await ctx.newPerson({ ownerId: user.id, name });
    const faceIds: string[] = [];
    for (const [mix, identity] of identities.entries()) {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId, ...box });
      await ctx.database
        .insertInto('face_search')
        .values({ faceId: assetFace.id, embedding: embedding(identity, mix) })
        .execute();
      faceIds.push(assetFace.id);
    }
    return { person, faceIds };
  };
  // Jamie holds eight faces of one person and four of another; Robin is one person
  const jamie = await newPersonWithFaces('Jamie', [0, 0, 0, 0, 0, 0, 0, 0, 1, 1, 1, 1]);
  const robin = await newPersonWithFaces('Robin', [5, 5, 5, 5, 5, 5, 5, 5]);
  const others = jamie.faceIds.slice(8);
  return { sut, ctx, auth, user, jamie, robin, others, people: ctx.get(PersonRepository) };
};

describe('PersonService split suggestions (FL-1385)', () => {
  it('finds the person who holds two different people, with faces from both sides', async () => {
    const { sut, auth, jamie, others } = await setup();

    await sut.handlePersonCleanup();

    const { suggestions } = await sut.getSplitSuggestions(auth);
    expect(suggestions).toHaveLength(1);
    const [suggestion] = suggestions;
    expect(suggestion).toMatchObject({
      person: { id: jamie.person.personGroupId, name: 'Jamie' },
      faceCount: 4,
      totalFaceCount: 12,
    });
    expect(suggestion.distance).toBeGreaterThan(0.6);
    expect(suggestion.otherEvidence).toHaveLength(3);
    expect(suggestion.personEvidence).toHaveLength(3);
    for (const { faceId } of suggestion.otherEvidence) {
      expect(others).toContain(faceId);
    }
    for (const { faceId } of suggestion.personEvidence) {
      expect(others).not.toContain(faceId);
    }
  });

  it('"split" moves the faces that look like someone else to a new person, kept in the history', async () => {
    const { sut, ctx, auth, user, jamie, others } = await setup();
    await sut.handlePersonCleanup();

    const result = await sut.setSplitVerdict(auth, { personId: jamie.person.personGroupId, verdict: 'split' });

    expect(result).toMatchObject({ verdict: 'split', movedFaceCount: 4, newPersonId: expect.any(String) });
    const moved = await ctx.database
      .selectFrom('asset_face')
      .select(['id', 'correctedAt'])
      .where('personGroupId', '=', result.newPersonId!)
      .execute();
    expect(moved.map(({ id }) => id).toSorted()).toEqual(others.toSorted());
    // an explicit decision: a recognition rebuild leaves these faces where the owner put them
    expect(moved.every(({ correctedAt }) => correctedAt !== null)).toBe(true);
    await expect(sut.getSplitSuggestions(auth)).resolves.toEqual({ suggestions: [] });
    const { corrections } = await sut.getCorrectionHistory(auth, result.newPersonId!, { page: 1, size: 10 });
    expect(corrections).toHaveLength(4);

    // merging the new person back undoes the split
    await sut.mergePerson(auth, jamie.person.personGroupId, { ids: [result.newPersonId!] });
    const back = await ctx.database
      .selectFrom('asset_face')
      .select('id')
      .where('personGroupId', '=', jamie.person.personGroupId)
      .execute();
    expect(back).toHaveLength(12);
    expect(user.id).toBe(auth.user.id);
  });

  it('puts every face back when a move fails after its write, and keeps the suggestion', async () => {
    const { sut, ctx, auth, jamie } = await setup();
    const personId = jamie.person.personGroupId;
    await sut.handlePersonCleanup();
    const peopleBefore = await ctx.database.selectFrom('person').select('personGroupId').execute();
    // the first face is written to the new person, then its history entry fails
    const record = vi.spyOn(sut, 'recordFaceCorrections').mockRejectedValueOnce(new Error('history is unavailable'));

    await expect(sut.setSplitVerdict(auth, { personId, verdict: 'split' })).rejects.toThrow('history is unavailable');
    record.mockRestore();

    const faces = await ctx.database
      .selectFrom('asset_face')
      .select('id')
      .where('personGroupId', '=', personId)
      .execute();
    expect(faces).toHaveLength(12);
    // the new person is gone again, and the question can be answered again
    const peopleAfter = await ctx.database.selectFrom('person').select('personGroupId').execute();
    expect(peopleAfter.map(({ personGroupId }) => personGroupId).toSorted()).toEqual(
      peopleBefore.map(({ personGroupId }) => personGroupId).toSorted(),
    );
    await expect(sut.getSplitSuggestions(auth)).resolves.toMatchObject({ suggestions: [{ faceCount: 4 }] });
    await expect(sut.setSplitVerdict(auth, { personId, verdict: 'split' })).resolves.toMatchObject({
      movedFaceCount: 4,
    });
  });

  it('"same" never asks again, "later" waits, and undoing an answer asks again', async () => {
    const { sut, auth, jamie, people } = await setup();
    const personId = jamie.person.personGroupId;
    await sut.handlePersonCleanup();

    await sut.setSplitVerdict(auth, { personId, verdict: 'same' });
    await expect(sut.getSplitSuggestions(auth)).resolves.toEqual({ suggestions: [] });
    // a banner in another tab that has not caught up cannot replace the answer, or split after all
    await expect(sut.setSplitVerdict(auth, { personId, verdict: 'later' })).rejects.toBeInstanceOf(ConflictException);
    await expect(sut.setSplitVerdict(auth, { personId, verdict: 'split' })).rejects.toBeInstanceOf(ConflictException);
    // the next nightly check finds the same faces and keeps the answer
    await people.upsertSplitCandidate({
      ownerId: auth.user.id,
      personId,
      faceIds: jamie.faceIds.slice(8),
      distance: 1,
    });
    await expect(sut.getSplitSuggestions(auth)).resolves.toEqual({ suggestions: [] });

    await sut.deleteSplitVerdict(auth, { personId });
    await expect(sut.getSplitSuggestions(auth)).resolves.toMatchObject({ suggestions: [{ person: { id: personId } }] });

    await sut.setSplitVerdict(auth, { personId, verdict: 'later' });
    await expect(sut.getSplitSuggestions(auth)).resolves.toEqual({ suggestions: [] });
    await people.setSplitDismissal(auth.user.id, personId, new Date(Date.now() - 1000));
    await expect(sut.getSplitSuggestions(auth)).resolves.toMatchObject({ suggestions: [{ person: { id: personId } }] });
  });

  it('answers only a person with a suggestion, and only their owner', async () => {
    const { sut, ctx, auth, jamie, robin } = await setup();
    await sut.handlePersonCleanup();

    await expect(
      sut.setSplitVerdict(auth, { personId: robin.person.personGroupId, verdict: 'split' }),
    ).rejects.toBeInstanceOf(NotFoundException);
    const { user: stranger } = await ctx.newUser();
    await expect(
      sut.setSplitVerdict(factory.auth({ user: stranger }), { personId: jamie.person.personGroupId, verdict: 'same' }),
    ).rejects.toThrow();
    await expect(sut.getSplitSuggestions(factory.auth({ user: stranger }))).resolves.toEqual({ suggestions: [] });
  });

  it('drops a suggestion once the faces are no longer mixed', async () => {
    const { sut, ctx, auth, jamie, others } = await setup();
    await sut.handlePersonCleanup();
    await expect(sut.getSplitSuggestions(auth)).resolves.toMatchObject({ suggestions: [{ faceCount: 4 }] });

    // the owner moves the other person's faces away by hand; the suggestion goes at once, and for good
    // at the next nightly check
    await ctx.database.updateTable('asset_face').set({ personGroupId: null }).where('id', 'in', others).execute();
    await expect(sut.getSplitSuggestions(auth)).resolves.toEqual({ suggestions: [] });
    await sut.handlePersonCleanup();
    await expect(
      ctx.get(PersonRepository).getSplitCandidate(auth.user.id, jamie.person.personGroupId),
    ).resolves.toBeUndefined();
  });
});
