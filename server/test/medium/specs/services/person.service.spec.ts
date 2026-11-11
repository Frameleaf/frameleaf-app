import { Kysely, sql } from 'kysely';
import { DateTime } from 'luxon';
import { randomUUID } from 'node:crypto';
import type { OutputInfo } from 'sharp';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetEditAction, MirrorAxis } from 'src/dtos/editing.dto.js';
import { AssetFaceCreateDto } from 'src/dtos/person.dto.js';
import {
  AssetFileType,
  AssetMetadataKey,
  AssetType,
  AssetVisibility,
  JobName,
  JobStatus,
  MlWorkload,
  SourceType,
} from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { QueueExecution } from 'src/queue/types.js';
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
import { MediaRepository } from 'src/repositories/media.repository.js';
import { MlDestinationRepository } from 'src/repositories/ml-destination.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StorageRepository } from 'src/repositories/storage.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { up as redetectFacesOfEditedPhotos } from 'src/schema/migrations/1794351387000-RedetectFacesOfEditedPhotos.js';
import { BaseService } from 'src/services/base.service.js';
import { MediaService } from 'src/services/media.service.js';
import { PartnerPeopleService } from 'src/services/partner-people.service.js';
import { PersonService } from 'src/services/person.service.js';
import { JobOf } from 'src/types.js';
import { useRealJobPublication } from 'test/fixtures/job-publication.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory, newEmbedding } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const service = newMediumService(PersonService, {
    database: db || defaultDatabase,
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
    mock: [
      EventRepository,
      JobRepository,
      LoggingRepository,
      StorageRepository,
      MachineLearningRepository,
      MlDestinationRepository,
    ],
  });
  service.ctx.getMock(EventRepository).emit.mockResolvedValue();
  // FL-57: face changes queue the refresh of generated text that may name the wrong people
  service.ctx.getMock(JobRepository).queue.mockResolvedValue();
  useRealJobPublication(service.ctx.database, service.ctx.getMock(JobRepository), [service.sut]);
  return service;
};

const nsfwMetadata = (isNsfw: boolean, review?: { action: string; isNsfw: boolean }) => ({
  nsfwDetection: {
    status: 'success',
    result: { isNsfw, score: isNsfw ? 0.95 : 0.05, labels: { explicit: isNsfw ? 0.95 : 0.05 } },
    ...(review && { review }),
  },
});

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(PersonService.name, () => {
  describe('nsfw privacy', () => {
    it('should hide people that only have private NSFW faces', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { person: safePerson } = await ctx.newPerson({ ownerId: user.id, name: 'Safe' });
      const { person: nsfwOnlyPerson } = await ctx.newPerson({ ownerId: user.id, name: 'NSFW only' });
      const { person: mixedPerson } = await ctx.newPerson({ ownerId: user.id, name: 'Mixed' });

      const { asset: safeAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: nsfwAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: mixedSafeAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: mixedNsfwAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newMetadata({
        assetId: nsfwAsset.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(true),
      });
      await ctx.newMetadata({
        assetId: mixedNsfwAsset.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(true),
      });

      await ctx.newAssetFace({ personGroupId: safePerson.personGroupId, assetId: safeAsset.id });
      await ctx.newAssetFace({ personGroupId: nsfwOnlyPerson.personGroupId, assetId: nsfwAsset.id });
      await ctx.newAssetFace({ personGroupId: mixedPerson.personGroupId, assetId: mixedSafeAsset.id });
      await ctx.newAssetFace({ personGroupId: mixedPerson.personGroupId, assetId: mixedNsfwAsset.id });

      const auth = factory.auth({ user });
      const hiddenAuth = { ...auth, hideNsfwAssets: true };

      await expect(sut.getAll(auth, { page: 1, size: 100 })).resolves.toEqual(
        expect.objectContaining({
          total: 3,
          people: expect.arrayContaining([
            expect.objectContaining({ id: safePerson.personGroupId }),
            expect.objectContaining({ id: nsfwOnlyPerson.personGroupId }),
            expect.objectContaining({ id: mixedPerson.personGroupId }),
          ]),
        }),
      );

      const hiddenResponse = await sut.getAll(hiddenAuth, { page: 1, size: 100 });
      expect(hiddenResponse.total).toBe(2);
      expect(hiddenResponse.people).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: safePerson.personGroupId }),
          expect.objectContaining({ id: mixedPerson.personGroupId }),
        ]),
      );
      expect(hiddenResponse.people).not.toEqual(
        expect.arrayContaining([expect.objectContaining({ id: nsfwOnlyPerson.personGroupId })]),
      );
    });

    it('should hide person details and count only non-NSFW assets while hide mode is active', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { person: nsfwOnlyPerson } = await ctx.newPerson({ ownerId: user.id, name: 'NSFW only' });
      const { person: mixedPerson } = await ctx.newPerson({ ownerId: user.id, name: 'Mixed' });

      const { asset: nsfwAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: mixedSafeAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: mixedNsfwAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newMetadata({ assetId: nsfwAsset.id, key: AssetMetadataKey.MlEnrichment, value: nsfwMetadata(true) });
      await ctx.newMetadata({
        assetId: mixedNsfwAsset.id,
        key: AssetMetadataKey.MlEnrichment,
        value: nsfwMetadata(true),
      });

      await ctx.newAssetFace({ personGroupId: nsfwOnlyPerson.personGroupId, assetId: nsfwAsset.id });
      await ctx.newAssetFace({ personGroupId: mixedPerson.personGroupId, assetId: mixedSafeAsset.id });
      await ctx.newAssetFace({ personGroupId: mixedPerson.personGroupId, assetId: mixedNsfwAsset.id });

      const auth = factory.auth({ user });
      const hiddenAuth = { ...auth, hideNsfwAssets: true };

      await expect(sut.getById(hiddenAuth, nsfwOnlyPerson.personGroupId)).rejects.toThrow('Person not found');
      await expect(sut.getById(hiddenAuth, mixedPerson.personGroupId)).resolves.toEqual(
        expect.objectContaining({ id: mixedPerson.personGroupId }),
      );
      await expect(sut.getStatistics(auth, mixedPerson.personGroupId)).resolves.toEqual(
        expect.objectContaining({ assets: 2 }),
      );
      await expect(sut.getStatistics(hiddenAuth, mixedPerson.personGroupId)).resolves.toEqual(
        expect.objectContaining({ assets: 1 }),
      );
    });

    it('splits the person page count into photos and videos over timeline assets only (FL-37)', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Counted' });
      const { asset: photo } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      const { asset: video } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video });
      const { asset: archived } = await ctx.newAsset({
        ownerId: user.id,
        type: AssetType.Image,
        visibility: AssetVisibility.Archive,
      });
      const { asset: trashed } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Video, deletedAt: new Date() });
      for (const asset of [photo, video, archived, trashed]) {
        await ctx.newAssetFace({ personGroupId: person.personGroupId, assetId: asset.id });
      }
      // two faces of the same person on one photo still count that photo once
      await ctx.newAssetFace({ personGroupId: person.personGroupId, assetId: photo.id });

      await expect(sut.getStatistics(factory.auth({ user }), person.personGroupId)).resolves.toEqual({
        assets: 2,
        photos: 1,
        videos: 1,
      });
    });

    it('should not serve person thumbnails generated from private NSFW feature faces', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id, thumbnailPath: '/person/thumbnail.jpg' });
      const { asset: safeAsset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: nsfwAsset } = await ctx.newAsset({ ownerId: user.id });

      await ctx.newMetadata({ assetId: nsfwAsset.id, key: AssetMetadataKey.MlEnrichment, value: nsfwMetadata(true) });

      const { assetFace: safeFace } = await ctx.newAssetFace({
        personGroupId: person.personGroupId,
        assetId: safeAsset.id,
      });
      const { assetFace: nsfwFace } = await ctx.newAssetFace({
        personGroupId: person.personGroupId,
        assetId: nsfwAsset.id,
      });
      await ctx
        .get(PersonRepository)
        .update({ ownerId: person.ownerId, personGroupId: person.personGroupId, faceAssetId: nsfwFace.id });

      const auth = factory.auth({ user });
      const hiddenAuth = { ...auth, hideNsfwAssets: true };

      await expect(sut.getThumbnail(auth, person.personGroupId)).resolves.toEqual(
        expect.objectContaining({ path: '/person/thumbnail.jpg' }),
      );
      await expect(sut.getThumbnail(hiddenAuth, person.personGroupId)).rejects.toThrow();

      await ctx
        .get(PersonRepository)
        .update({ ownerId: person.ownerId, personGroupId: person.personGroupId, faceAssetId: safeFace.id });

      await expect(sut.getThumbnail(hiddenAuth, person.personGroupId)).resolves.toEqual(
        expect.objectContaining({ path: '/person/thumbnail.jpg' }),
      );
    });
  });

  // FL-1408 (M9): an empty People page can say the first scan is still running
  describe('getAll before anybody has been found', () => {
    it('says face recognition is still working until every photo has been looked at', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const auth = factory.auth({ user });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newJobStatus({ assetId: asset.id, facesRecognizedAt: null });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'waiting-preview.jpg' });

      await expect(sut.getAll(auth, { page: 1, size: 100 })).resolves.toEqual(
        expect.objectContaining({ total: 0, scanning: true }),
      );

      await ctx.newJobStatus({ assetId: asset.id, facesRecognizedAt: new Date().toISOString() });
      await expect(sut.getAll(auth, { page: 1, size: 100 })).resolves.not.toHaveProperty('scanning');
    });
  });

  describe('Locked media (FL-34)', () => {
    it('never shows Locked (while locked) or foreign media as correction history evidence (FL-57, FL-195)', async () => {
      // its own database: the corrected faces it leaves would outlast the forced recognition tests below
      const { sut, ctx } = setup(await getKyselyDB());
      const personRepo = ctx.get(PersonRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { person } = await ctx.newPerson({ ownerId: user1.id });
      await ctx.newPerson({ ownerId: user2.id, personGroupId: person.personGroupId });

      const { asset: locked1 } = await ctx.newAsset({ ownerId: user1.id, visibility: AssetVisibility.Locked });
      const { asset: timeline1 } = await ctx.newAsset({ ownerId: user1.id });
      const { asset: timeline2 } = await ctx.newAsset({ ownerId: user2.id });
      for (const asset of [locked1, timeline1, timeline2]) {
        const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, imageWidth: 100, imageHeight: 100 });
        await personRepo.reassignFace(assetFace.id, person.personGroupId);
        await personRepo.recordFaceCorrections([
          {
            ownerId: user1.id,
            actorId: user1.id,
            action: 'reassign',
            faceId: assetFace.id,
            toPersonId: person.personGroupId,
          },
        ]);
      }

      const locked = await sut.getCorrectionHistory(factory.auth({ user: user1 }), person.personGroupId, {
        page: 1,
        size: 25,
      });
      expect(locked.corrections).toHaveLength(3);
      expect(locked.corrections.filter(({ evidence }) => evidence).map(({ evidence }) => evidence!.assetId)).toEqual([
        timeline1.id,
      ]);
      expect(locked.corrections.filter(({ evidenceRevoked }) => evidenceRevoked)).toHaveLength(2);

      // FL-195: the owner's unlocked session sees their own marked photo as evidence like any other;
      // someone else's media never
      const unlocked = await sut.getCorrectionHistory(
        factory.auth({ user: user1, session: { hasElevatedPermission: true } }),
        person.personGroupId,
        { page: 1, size: 25 },
      );
      expect(unlocked.corrections).toHaveLength(3);
      expect(
        unlocked.corrections
          .filter(({ evidence }) => evidence)
          .map(({ evidence }) => evidence!.assetId)
          .toSorted(),
      ).toEqual([locked1.id, timeline1.id].toSorted());
      expect(unlocked.corrections.filter(({ evidenceRevoked }) => evidenceRevoked)).toHaveLength(1);

      // the history is the owner's: the partner sees none of it
      await expect(
        sut.getCorrectionHistory(factory.auth({ user: user2 }), person.personGroupId, { page: 1, size: 25 }),
      ).resolves.toEqual({ corrections: [], hasNextPage: false });
    });

    it("reaches a face on the caller's own Locked media only from an elevated session", async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });

      await expect(sut.deleteFace(factory.auth({ user }), assetFace.id, { force: false })).rejects.toThrow(
        'Not found or no face.delete access',
      );
      await expect(
        sut.deleteFace(factory.auth({ user, session: { hasElevatedPermission: true } }), assetFace.id, {
          force: false,
        }),
      ).resolves.toBeUndefined();
    });
  });

  describe('suppressed people (owner decision, September 22, 2026)', () => {
    it('should answer a suppressed person like a missing one while locked, with or without photos', async () => {
      const { sut, ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const { person: withPhoto } = await ctx.newPerson({ ownerId: user.id, name: 'With photo' });
      const { person: withoutPhoto } = await ctx.newPerson({ ownerId: user.id, name: 'Without photo' });
      const { person: visible } = await ctx.newPerson({ ownerId: user.id, name: 'Visible' });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: otherAsset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAssetFace({ personGroupId: withPhoto.personGroupId, assetId: asset.id });
      await ctx.newAssetFace({ personGroupId: visible.personGroupId, assetId: otherAsset.id });

      const auth = factory.auth({ user });
      const hiddenContent = {
        userId: user.id,
        includeNsfw: false,
        tagIds: [],
        personIds: [withPhoto.personGroupId, withoutPhoto.personGroupId],
        petIds: [],
        scope: 'owned' as const,
      };
      const lockedAuth = { ...auth, hideNsfwAssets: true, hiddenContent };
      const unlockedAuth = { ...auth, suppressedContent: hiddenContent };

      const missing = await sut.getById(lockedAuth, factory.uuid()).catch((error: Error) => error.message);
      expect(missing).toBe('Person not found');
      for (const person of [withPhoto, withoutPhoto]) {
        await expect(sut.getById(lockedAuth, person.personGroupId)).rejects.toThrow(missing);
        await expect(sut.getStatistics(lockedAuth, person.personGroupId)).rejects.toThrow(missing);
        await expect(sut.update(lockedAuth, person.personGroupId, { name: 'Renamed' })).rejects.toThrow(missing);
        await expect(sut.getById(unlockedAuth, person.personGroupId)).resolves.toEqual(
          expect.objectContaining({ id: person.personGroupId }),
        );
      }

      await expect(sut.getById(lockedAuth, visible.personGroupId)).resolves.toEqual(
        expect.objectContaining({ id: visible.personGroupId }),
      );
      await expect(ctx.get(PersonRepository).getByGroupId(withoutPhoto)).resolves.toEqual(
        expect.objectContaining({ name: 'Without photo' }),
      );
    });
  });

  describe('delete', () => {
    it('should throw an error when there is no access', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const personId = factory.uuid();
      await expect(sut.delete(auth, personId)).rejects.toThrow('Person not found');
    });

    it('should delete the person', async () => {
      const { sut, ctx } = setup();
      const personRepo = ctx.get(PersonRepository);
      const storageMock = ctx.getMock(StorageRepository);
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const auth = factory.auth({ user });
      storageMock.unlink.mockResolvedValue();

      await expect(personRepo.getByGroupId(person)).resolves.toEqual(
        expect.objectContaining({ personGroupId: person.personGroupId }),
      );
      await expect(sut.delete(auth, person.personGroupId)).resolves.toBeUndefined();
      await expect(personRepo.getByGroupId(person)).resolves.toBeUndefined();

      expect(storageMock.unlink).toHaveBeenCalledWith(person.thumbnailPath);
    });
  });

  describe('deleteAll', () => {
    it('should throw an error when there is no access', async () => {
      const { sut } = setup();
      const auth = factory.auth();
      const personId = factory.uuid();
      await expect(sut.deleteAll(auth, { ids: [personId] })).rejects.toThrow('Not found or no person.delete access');
    });

    it('should delete the person', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const personRepo = ctx.get(PersonRepository);
      const { user } = await ctx.newUser();
      const { person: person1 } = await ctx.newPerson({ ownerId: user.id });
      const { person: person2 } = await ctx.newPerson({ ownerId: user.id });
      const auth = factory.auth({ user });
      storageMock.unlink.mockResolvedValue();

      await expect(
        sut.deleteAll(auth, { ids: [person1.personGroupId, person2.personGroupId] }),
      ).resolves.toBeUndefined();
      await expect(personRepo.getByGroupId(person1)).resolves.toBeUndefined();
      await expect(personRepo.getByGroupId(person2)).resolves.toBeUndefined();

      expect(storageMock.unlink).toHaveBeenCalledTimes(2);
      expect(storageMock.unlink).toHaveBeenCalledWith(person1.thumbnailPath);
      expect(storageMock.unlink).toHaveBeenCalledWith(person2.thumbnailPath);
    });
  });

  describe('handleDetectFaces', () => {
    it.each(['empty', 'nonmatching'] as const)(
      'keeps imported faces, people and featured faces through an imported %s detection',
      async (result) => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();
        const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Imported person', isHidden: true });
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await ctx.newExif({ assetId: asset.id, description: '' });
        await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'imported-preview.jpg' });
        const { assetFace } = await ctx.newAssetFace({
          assetId: asset.id,
          personGroupId: person.personGroupId,
          sourceType: SourceType.MachineLearning,
          correctedAt: null,
          deletedAt: null,
          imageWidth: 100,
          imageHeight: 100,
          boundingBoxX1: 10,
          boundingBoxY1: 10,
          boundingBoxX2: 30,
          boundingBoxY2: 30,
        });
        await ctx.get(PersonRepository).update({ ...person, faceAssetId: assetFace.id });
        const readFaces = () =>
          ctx.database.selectFrom('asset_face').selectAll().where('assetId', '=', asset.id).execute();
        const readPerson = () =>
          ctx.database
            .selectFrom('person')
            .selectAll()
            .where('ownerId', '=', user.id)
            .where('personGroupId', '=', person.personGroupId)
            .executeTakeFirstOrThrow();
        const before = { faces: await readFaces(), person: await readPerson() };
        ctx.getMock(MachineLearningRepository).detectFaces.mockResolvedValue({
          imageWidth: 100,
          imageHeight: 100,
          faces:
            result === 'empty'
              ? []
              : [{ boundingBox: { x1: 70, y1: 70, x2: 90, y2: 90 }, embedding: newEmbedding(), score: 1 }],
        });
        const queue = `import-faces-${randomUUID()}`;
        const worker = randomUUID();
        const runId = randomUUID();
        const store = new SqlQueueStore(ctx.database);
        await store.initialize([queue], worker);
        await sql`insert into job_run(id, kind, selection) values (${runId}::uuid, 'immich-import-derived', '{}'::jsonb)`.execute(
          ctx.database,
        );
        await store.enqueue([
          {
            queue,
            name: JobName.AssetDetectFaces,
            data: { id: asset.id, preserveImportedFaces: true },
            runId,
            itemKey: asset.id,
            rootItemKey: asset.id,
            safeToRetry: true,
            sensitive: false,
            deadlineMs: 60_000,
          },
        ]);
        await store.finishEnumeration(runId);
        ctx.getMock(JobRepository).queueAll.mockResolvedValue();
        const [claim] = await store.claim(queue, worker);
        expect(claim).toMatchObject({ attempt: 1, runId, data: { id: asset.id, preserveImportedFaces: true } });
        const execution: QueueExecution = {
          claim,
          signal: new AbortController().signal,
          progress: vi.fn(),
          progressUnits: 0,
          adoptions: [],
          followups: [],
          buffering: false,
        };
        await queueExecution.run(execution, () =>
          sut.handleDetectFaces(claim.data as unknown as JobOf<JobName.AssetDetectFaces>),
        );
        await store.complete(claim, execution.followups, (tx) =>
          publicationTransaction.run(tx, () =>
            queueExecution.run(execution, async () => {
              execution.buffering = true;
              for (const adopt of execution.adoptions) await adopt(tx);
            }),
          ),
        );

        const faces = await readFaces();
        expect(faces).toEqual(expect.arrayContaining(before.faces));
        expect(faces).toHaveLength(result === 'empty' ? 1 : 2);
        expect(await readPerson()).toEqual(before.person);
        const added = faces.filter(({ id }) => id !== assetFace.id).map(({ id }) => id);
        const embedded = await ctx.database
          .selectFrom('face_search')
          .select('faceId')
          .where('faceId', 'in', [assetFace.id, ...added])
          .execute();
        expect(embedded.map(({ faceId }) => faceId)).toEqual(added);
        // Recognised, so a later "Missing" face detection (no preservation) leaves the photo alone
        await expect(
          ctx.database
            .selectFrom('asset_job_status')
            .select('facesRecognizedAt')
            .where('assetId', '=', asset.id)
            .executeTakeFirstOrThrow(),
        ).resolves.toEqual({ facesRecognizedAt: expect.any(Date) });
        expect((await sql`select state from job where "runId" = ${runId}::uuid`.execute(ctx.database)).rows).toEqual([
          { state: 'completed' },
        ]);
        expect(ctx.getMock(JobRepository).queueAll).toHaveBeenCalledTimes(result === 'empty' ? 0 : 1);
      },
    );

    it('still removes a face detected here that an imported detection no longer finds', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: 'detected-preview.jpg' });
      const face = { imageWidth: 100, imageHeight: 100, boundingBoxX1: 10, boundingBoxY1: 10 };
      const { assetFace: detected } = await ctx.newAssetFace({
        ...face,
        assetId: asset.id,
        personGroupId: person.personGroupId,
        sourceType: SourceType.MachineLearning,
        boundingBoxX2: 30,
        boundingBoxY2: 30,
      });
      // one face detected here (stored with its embedding), one imported (none)
      await ctx.database.insertInto('face_search').values({ faceId: detected.id, embedding: newEmbedding() }).execute();
      const { assetFace: imported } = await ctx.newAssetFace({
        ...face,
        assetId: asset.id,
        personGroupId: person.personGroupId,
        sourceType: SourceType.MachineLearning,
        boundingBoxX1: 60,
        boundingBoxY1: 60,
        boundingBoxX2: 90,
        boundingBoxY2: 90,
      });
      ctx
        .getMock(MachineLearningRepository)
        .detectFaces.mockResolvedValue({ imageWidth: 100, imageHeight: 100, faces: [] });

      await expect(sut.handleDetectFaces({ id: asset.id, preserveImportedFaces: true })).resolves.toBe(
        JobStatus.Success,
      );
      expect(
        await ctx.database.selectFrom('asset_face').select('id').where('assetId', '=', asset.id).execute(),
      ).toEqual([{ id: imported.id }]);
    });

    it.each([false, true])('retains manual-face overlaps (contested=%s)', async (contested) => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newExif({ assetId: asset.id, description: '' });
      await ctx.newAssetFile({
        assetId: asset.id,
        type: AssetFileType.Preview,
        isEdited: false,
        path: 'overlapping-preview.jpg',
      });
      const boxes = [
        {
          imageWidth: 800,
          imageHeight: 1000,
          boundingBoxX1: 200,
          boundingBoxY1: 200,
          boundingBoxX2: 400,
          boundingBoxY2: 400,
        },
        {
          imageWidth: 200,
          imageHeight: 250,
          boundingBoxX1: contested ? 60 : 55,
          boundingBoxY1: contested ? 60 : 55,
          boundingBoxX2: contested ? 110 : 105,
          boundingBoxY2: contested ? 110 : 105,
        },
      ];
      const ids: string[] = [];
      for (const box of boxes) {
        const { person } = await ctx.newPerson({ ownerId: user.id });
        const { assetFace } = await ctx.newAssetFace({
          ...box,
          assetId: asset.id,
          personGroupId: person.personGroupId,
          sourceType: SourceType.Manual,
        });
        ids.push(assetFace.id);
      }
      const readFaces = () =>
        ctx.database.selectFrom('asset_face').selectAll().where('assetId', '=', asset.id).orderBy('id').execute();
      const before = await readFaces();
      const people = await ctx.database
        .selectFrom('person')
        .selectAll()
        .where('ownerId', '=', user.id)
        .orderBy('personGroupId')
        .execute();
      const embeddings = [0, 1].map((index) =>
        JSON.stringify(Array.from({ length: 512 }, (_, column) => Number(column === index))),
      );
      ctx.getMock(MachineLearningRepository).detectFaces.mockResolvedValue({
        imageWidth: 400,
        imageHeight: 500,
        faces: [
          {
            boundingBox: contested ? { x1: 105, y1: 105, x2: 205, y2: 205 } : { x1: 100, y1: 100, x2: 200, y2: 200 },
            embedding: embeddings[0],
            score: 1,
          },
          {
            boundingBox: contested ? { x1: 90, y1: 90, x2: 190, y2: 190 } : { x1: 110, y1: 110, x2: 210, y2: 210 },
            embedding: embeddings[1],
            score: 1,
          },
        ],
      });
      await expect(sut.handleDetectFaces({ id: asset.id, preserveImportedFaces: true })).resolves.toBe(
        JobStatus.Success,
      );
      expect(await readFaces()).toEqual(before);
      expect(
        await ctx.database
          .selectFrom('person')
          .selectAll()
          .where('ownerId', '=', user.id)
          .orderBy('personGroupId')
          .execute(),
      ).toEqual(people);
      expect(
        await ctx.database
          .selectFrom('face_search')
          .select(['faceId', 'embedding'])
          .where('faceId', 'in', ids)
          .orderBy('faceId')
          .execute(),
      ).toEqual(
        ids
          .map((faceId, index) => ({ faceId, embedding: embeddings[contested ? 1 - index : index] }))
          .sort((a, b) => a.faceId.localeCompare(b.faceId)),
      );
      expect(ctx.getMock(JobRepository).queueAll).not.toHaveBeenCalled();
    });

    it.each([false, true].flatMap((corrected) => [0.5, 1, 2].map((scale) => ({ corrected, scale }))))(
      'repairs an imported ML face without face_search, preserving decisions (corrected=$corrected, scale=$scale)',
      async ({ corrected, scale }) => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();
        const { person } = await ctx.newPerson({ ownerId: user.id });
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await ctx.newExif({ assetId: asset.id, description: '' });
        await ctx.newAssetFile({
          assetId: asset.id,
          type: AssetFileType.Preview,
          isEdited: false,
          path: 'imported-preview.jpg',
        });
        const { assetFace } = await ctx.newAssetFace({
          assetId: asset.id,
          personGroupId: person.personGroupId,
          sourceType: SourceType.MachineLearning,
          correctedAt: corrected ? new Date() : null,
          deletedAt: null,
        });
        const readFace = () =>
          ctx.database.selectFrom('asset_face').selectAll().where('id', '=', assetFace.id).executeTakeFirstOrThrow();
        const readEmbedding = () =>
          ctx.database.selectFrom('face_search').selectAll().where('faceId', '=', assetFace.id).execute();
        const before = await readFace();
        await ctx.get(PersonRepository).update({ ...person, faceAssetId: assetFace.id });
        const readPerson = () =>
          ctx.database
            .selectFrom('person')
            .selectAll()
            .where('ownerId', '=', user.id)
            .where('personGroupId', '=', person.personGroupId)
            .executeTakeFirstOrThrow();
        const personBefore = await readPerson();
        expect(await readEmbedding()).toEqual([]);
        const embedding = newEmbedding();
        ctx.getMock(MachineLearningRepository).detectFaces.mockResolvedValue({
          imageHeight: assetFace.imageHeight * scale,
          imageWidth: assetFace.imageWidth * scale,
          faces: [
            {
              boundingBox: {
                x1: assetFace.boundingBoxX1 * scale,
                y1: assetFace.boundingBoxY1 * scale,
                x2: assetFace.boundingBoxX2 * scale,
                y2: assetFace.boundingBoxY2 * scale,
              },
              embedding,
              score: 1,
            },
          ],
        });

        await expect(sut.handleDetectFaces({ id: asset.id, preserveImportedFaces: true })).resolves.toBe(
          JobStatus.Success,
        );
        expect(await readEmbedding()).toEqual([{ faceId: assetFace.id, embedding: expect.any(String) }]);
        expect(await readFace()).toEqual(before);
        // Replaying the repair upserts the same derived row, without a new face or recognition assignment.
        await expect(sut.handleDetectFaces({ id: asset.id, preserveImportedFaces: true })).resolves.toBe(
          JobStatus.Success,
        );
        expect(await readEmbedding()).toHaveLength(1);
        expect(
          await ctx.database.selectFrom('asset_face').select('id').where('assetId', '=', asset.id).execute(),
        ).toEqual([{ id: assetFace.id }]);
        expect(await readFace()).toEqual(before);
        expect(await readPerson()).toEqual(personBefore);
        expect(ctx.getMock(JobRepository).queueAll).not.toHaveBeenCalled();
      },
    );

    // FL-1387: a stored box is a box on the unedited picture (`mapFaces` applies the edits, the person
    // thumbnail crops the original), so faces are found in the unedited preview.
    it('stores the faces of an edited photo where they are in the unedited picture', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const config = await ctx.getConfig();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      // a 1000 x 500 photo, turned a quarter turn in the editor: it is shown 500 x 1000
      const { asset } = await ctx.newAsset({ ownerId: user.id, width: 500, height: 1000 });
      await ctx.newExif({ assetId: asset.id, description: '', exifImageWidth: 1000, exifImageHeight: 500 });
      await ctx.newEdits(asset.id, { edits: [{ action: AssetEditAction.Rotate, parameters: { angle: 90 } }] });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, isEdited: true, path: 'edited.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, isEdited: false, path: 'unedited.jpg' });
      // one face, as a detector finds it in either preview
      const found = (imageWidth: number, imageHeight: number, [x1, y1, x2, y2]: number[]) => ({
        imageWidth,
        imageHeight,
        faces: [{ boundingBox: { x1, y1, x2, y2 }, embedding: newEmbedding(), score: 1 }],
      });
      ctx
        .getMock(MachineLearningRepository)
        .detectFaces.mockImplementation((_destination, path) =>
          Promise.resolve(
            path === 'edited.jpg' ? found(500, 1000, [100, 100, 300, 300]) : found(1000, 500, [100, 200, 300, 400]),
          ),
        );

      await expect(sut.handleDetectFaces({ id: asset.id })).resolves.toBe(JobStatus.Success);

      expect(ctx.getMock(MachineLearningRepository).detectFaces).toHaveBeenCalledWith(
        expect.objectContaining({ workload: MlWorkload.Face }),
        'unedited.jpg',
        config.machineLearning.facialRecognition,
      );
      // the viewer draws the face where it is in the turned picture
      const shown = { boundingBoxX1: 100, boundingBoxY1: 100, boundingBoxX2: 300, boundingBoxY2: 300 };
      const auth = factory.auth({ user });
      await expect(sut.getFacesById(auth, { id: asset.id })).resolves.toEqual([
        expect.objectContaining({ ...shown, imageWidth: 500, imageHeight: 1000 }),
      ]);

      // the person thumbnail is cut from the original (2000 x 1000 here) around the same face
      const [face] = await ctx.database.selectFrom('asset_face').select('id').where('assetId', '=', asset.id).execute();
      await ctx.get(PersonRepository).reassignFace(face.id, person.personGroupId);
      StorageCore.reset(); // so the thumbnail folder is made through this MediaService's storage mock
      const media = newMediumService(MediaService, {
        database: ctx.database,
        real: [ConfigRepository, PersonRepository, SystemMetadataRepository],
        mock: [JobRepository, LoggingRepository, MediaRepository, StorageRepository],
      });
      StorageCore.setMediaLocation('/data');
      media.ctx.getMock(JobRepository).guardAssetSource.mockResolvedValue();
      media.ctx.getMock(StorageRepository).mkdirSync.mockReturnValue();
      media.ctx.getMock(MediaRepository).generateThumbnail.mockResolvedValue();
      media.ctx.getMock(MediaRepository).decodeImage.mockResolvedValue({
        data: Buffer.from(''),
        info: { width: 2000, height: 1000 } as OutputInfo,
      });
      await expect(
        media.sut.handleGeneratePersonThumbnail({
          ownerId: user.id,
          personGroupId: person.personGroupId,
          selectionFaceId: face.id,
        }),
      ).resolves.toBe(JobStatus.Success);
      expect(media.ctx.getMock(MediaRepository).generateThumbnail).toHaveBeenCalledWith(
        expect.anything(),
        expect.objectContaining({
          edits: [{ action: AssetEditAction.Crop, parameters: { x: 180, y: 380, width: 440, height: 440 } }],
        }),
        expect.any(String),
      );
      StorageCore.reset();

      // a second detection finds the same face again, so it keeps its place and its person
      await expect(sut.handleDetectFaces({ id: asset.id })).resolves.toBe(JobStatus.Success);
      await expect(sut.getFacesById(auth, { id: asset.id })).resolves.toEqual([
        expect.objectContaining({
          ...shown,
          id: face.id,
          person: expect.objectContaining({ id: person.personGroupId }),
        }),
      ]);
    });

    it('repairs a box stored on the edited picture when the face is found again, and hides one a crop leaves out', async () => {
      const { sut, ctx } = setup();
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      // a 1000 x 500 photo cropped to its middle 800 x 400
      const { asset } = await ctx.newAsset({ ownerId: user.id, width: 800, height: 400 });
      await ctx.newExif({ assetId: asset.id, description: '', exifImageWidth: 1000, exifImageHeight: 500 });
      await ctx.newEdits(asset.id, {
        edits: [{ action: AssetEditAction.Crop, parameters: { x: 100, y: 50, width: 800, height: 400 } }],
      });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, isEdited: true, path: 'edited.jpg' });
      await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, isEdited: false, path: 'unedited.jpg' });
      await expect(ctx.get(AssetJobRepository).getForDetectFacesJob(asset.id)).resolves.toMatchObject({
        files: [{ path: 'unedited.jpg' }],
      });
      // as detection used to store it: the box of the face in the cropped picture
      const shown = { boundingBoxX1: 300, boundingBoxY1: 150, boundingBoxX2: 500, boundingBoxY2: 250 };
      const { assetFace } = await ctx.newAssetFace({
        assetId: asset.id,
        personGroupId: person.personGroupId,
        sourceType: SourceType.MachineLearning,
        imageWidth: 800,
        imageHeight: 400,
        ...shown,
      });
      await ctx.get(PersonRepository).update({ ...person, faceAssetId: assetFace.id });
      ctx.getMock(MachineLearningRepository).detectFaces.mockResolvedValue({
        imageWidth: 1000,
        imageHeight: 500,
        faces: [
          { boundingBox: { x1: 400, y1: 200, x2: 600, y2: 300 }, embedding: newEmbedding(), score: 1 },
          // in the strip the crop cut off
          { boundingBox: { x1: 10, y1: 100, x2: 60, y2: 150 }, embedding: newEmbedding(), score: 1 },
        ],
      });

      await expect(sut.handleDetectFaces({ id: asset.id })).resolves.toBe(JobStatus.Success);

      await expect(sut.getFacesById(factory.auth({ user }), { id: asset.id })).resolves.toEqual([
        expect.objectContaining({
          ...shown,
          id: assetFace.id,
          imageWidth: 800,
          imageHeight: 400,
          person: expect.objectContaining({ id: person.personGroupId }),
        }),
      ]);
      await expect(
        ctx.database
          .selectFrom('asset_face')
          .select(['boundingBoxX1', 'imageWidth', 'isVisible'])
          .where('assetId', '=', asset.id)
          .orderBy('boundingBoxX1')
          .execute(),
      ).resolves.toEqual([
        { boundingBoxX1: 10, imageWidth: 1000, isVisible: false },
        { boundingBoxX1: 400, imageWidth: 1000, isVisible: true },
      ]);
      // the person's main photo was cut from the old box, so it is made again
      expect(ctx.getMock(JobRepository).queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PersonGenerateThumbnail,
          data: { ownerId: user.id, personGroupId: person.personGroupId },
        },
      ]);
    });

    it('detects again, after the FL-1387 migration, only what was last detected on an edited preview', async () => {
      const { ctx } = setup(await getKyselyDB());
      const { user } = await ctx.newUser();
      const detectedAt = new Date('2026-11-01T12:00:00Z');
      const newDetected = async (editedAt?: string) => {
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, path: `${asset.id}.jpg` });
        if (editedAt) {
          const path = `${asset.id}_edited.jpg`;
          await ctx.newAssetFile({ assetId: asset.id, type: AssetFileType.Preview, isEdited: true, path });
          await ctx.database
            .updateTable('asset_file')
            .set({ createdAt: new Date(editedAt) })
            .where('path', '=', path)
            .execute();
        }
        await ctx.get(AssetRepository).upsertJobStatus({ assetId: asset.id, facesRecognizedAt: detectedAt });
        return asset.id;
      };
      const unedited = await newDetected();
      const editedBefore = await newDetected('2026-10-31T12:00:00Z');
      const editedAfter = await newDetected('2026-11-02T12:00:00Z');
      // an imported face (no embedding) would be removed by an ordinary detection that does not find it
      const imported = await newDetected('2026-10-31T12:00:00Z');
      await ctx.newAssetFace({ assetId: imported, sourceType: SourceType.MachineLearning });

      await redetectFacesOfEditedPhotos(ctx.database);

      const rows = await ctx.database.selectFrom('asset_job_status').select(['assetId', 'facesRecognizedAt']).execute();
      expect(Object.fromEntries(rows.map((row) => [row.assetId, row.facesRecognizedAt]))).toEqual({
        [unedited]: detectedAt,
        [editedBefore]: null,
        [editedAfter]: detectedAt,
        [imported]: detectedAt,
      });
    });
  });

  describe('handleQueueRecognizeFaces', () => {
    it('freezes all faces for forced recognition without deleting people before admission', async () => {
      const { sut, ctx } = setup();
      const jobRepo = ctx.getMock(JobRepository);
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();
      jobRepo.waitForQueueCompletion.mockResolvedValue();
      jobRepo.getJobCounts.mockResolvedValue({ active: 0, waiting: 0, completed: 0, delayed: 0, failed: 0, paused: 0 });
      jobRepo.queueAll.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { user: user1 } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: assetUser1 } = await ctx.newAsset({ ownerId: user1.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { person: personUser1 } = await ctx.newPerson({ ownerId: user1.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      const { assetFace: assetFaceUser1 } = await ctx.newAssetFace({
        assetId: assetUser1.id,
        personGroupId: personUser1.personGroupId,
      });

      await sut.handleQueueRecognizeFaces({ force: true });

      await expect(
        ctx.database
          .selectFrom('person')
          .select(['ownerId', 'personGroupId'])
          .where('ownerId', 'in', [user.id, user1.id])
          .orderBy('ownerId')
          .execute(),
      ).resolves.toEqual(
        [
          { ownerId: user.id, personGroupId: person.personGroupId },
          { ownerId: user1.id, personGroupId: personUser1.personGroupId },
        ].toSorted((a, b) => a.ownerId.localeCompare(b.ownerId)),
      );
      await expect(
        ctx.database
          .selectFrom('asset_face')
          .select(['id', 'personGroupId'])
          .where('id', 'in', [assetFace.id, assetFaceUser1.id])
          .orderBy('id')
          .execute(),
      ).resolves.toEqual(
        [
          { id: assetFace.id, personGroupId: person.personGroupId },
          { id: assetFaceUser1.id, personGroupId: personUser1.personGroupId },
        ].toSorted((a, b) => a.id.localeCompare(b.id)),
      );
      const { rows } = await sql<{
        itemKey: string;
        rootItemKey: string;
        selection: JobOf<JobName.FacialRecognition>;
        state: string;
      }>`select "itemKey", "rootItemKey", data selection, state from job
        where name = ${JobName.FacialRecognition}
        and "itemKey" in (${assetFace.id}, ${assetFaceUser1.id})`.execute(ctx.database);
      // Other earlier fixtures can also be selected, but both owners' roots must have a waiting job.
      expect(rows).toHaveLength(2);
      expect(rows).toEqual(
        expect.arrayContaining([
          {
            itemKey: assetFace.id,
            rootItemKey: asset.id,
            selection: { id: assetFace.id, deferred: false, force: true },
            state: 'pending',
          },
          {
            itemKey: assetFaceUser1.id,
            rootItemKey: assetUser1.id,
            selection: { id: assetFaceUser1.id, deferred: false, force: true },
            state: 'pending',
          },
        ]),
      );
      expect(jobRepo.queueAll).not.toHaveBeenCalled();
    });

    it('freezes only the specified cluster group without changing either owner before admission', async () => {
      const { sut, ctx } = setup();
      const jobRepo = ctx.getMock(JobRepository);
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();
      jobRepo.waitForQueueCompletion.mockResolvedValue();
      jobRepo.getJobCounts.mockResolvedValue({ active: 0, waiting: 0, completed: 0, delayed: 0, failed: 0, paused: 0 });
      jobRepo.queueAll.mockResolvedValue();

      const { user } = await ctx.newUser();
      const { user: user1 } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: assetUser1 } = await ctx.newAsset({ ownerId: user1.id });
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { person: personUser1 } = await ctx.newPerson({ ownerId: user1.id });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      const { assetFace: assetFaceUser1 } = await ctx.newAssetFace({
        assetId: assetUser1.id,
        personGroupId: personUser1.personGroupId,
      });

      await sut.handleQueueRecognizeFaces({ force: true, clusterGroupId: user.clusterGroupId });

      await expect(
        ctx.database
          .selectFrom('person')
          .select(['ownerId', 'personGroupId'])
          .where('ownerId', 'in', [user.id, user1.id])
          .orderBy('ownerId')
          .execute(),
      ).resolves.toEqual(
        [
          { ownerId: user.id, personGroupId: person.personGroupId },
          { ownerId: user1.id, personGroupId: personUser1.personGroupId },
        ].toSorted((a, b) => a.ownerId.localeCompare(b.ownerId)),
      );
      await expect(
        ctx.database
          .selectFrom('asset_face')
          .select(['id', 'personGroupId'])
          .where('id', 'in', [assetFace.id, assetFaceUser1.id])
          .orderBy('id')
          .execute(),
      ).resolves.toEqual(
        [
          { id: assetFace.id, personGroupId: person.personGroupId },
          { id: assetFaceUser1.id, personGroupId: personUser1.personGroupId },
        ].toSorted((a, b) => a.id.localeCompare(b.id)),
      );
      const { rows } = await sql<{
        itemKey: string;
        rootItemKey: string;
        selection: JobOf<JobName.FacialRecognition>;
        state: string;
      }>`select "itemKey", "rootItemKey", data selection, state from job
        where name = ${JobName.FacialRecognition}
        and "itemKey" in (${assetFace.id}, ${assetFaceUser1.id})`.execute(ctx.database);
      expect(rows).toEqual([
        {
          itemKey: assetFace.id,
          rootItemKey: asset.id,
          selection: { id: assetFace.id, deferred: false, force: true },
          state: 'pending',
        },
      ]);
      expect(rows.some(({ itemKey }) => itemKey === assetFaceUser1.id)).toBe(false);
      expect(jobRepo.queueAll).not.toHaveBeenCalled();
    });
  });

  describe('mergePeople', () => {
    it.each(['mapping failure', 'deletion failure', 'queue failure'] as const)(
      'preserves face-to-partner mapping authority on %s',
      async (failure) => {
        const { sut, ctx } = setup();
        const { user } = await ctx.newUser();
        const auth = factory.auth({ user });
        const { person: survivor } = await ctx.newPerson({ ownerId: user.id, name: 'Alice' });
        const { person: removed } = await ctx.newPerson({ ownerId: user.id, name: 'Alicia' });
        const { asset } = await ctx.newAsset({ ownerId: user.id });
        const { assetFace: face } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: removed.personGroupId });
        const { user: sharer } = await ctx.newUser();
        const { person: sourcePerson } = await ctx.newPerson({ ownerId: sharer.id, name: 'Alice' });
        const people = ctx.get(PersonRepository);
        await people.savePartnerPersonLink({
          ownerId: user.id,
          sourcePersonGroupId: sourcePerson.personGroupId,
          personGroupId: removed.personGroupId,
          kind: 'created',
          partnerSharedById: sharer.id,
          correctionId: null,
        });
        ctx.getMock(StorageRepository).unlink.mockResolvedValue();
        const jobs = ctx.getMock(JobRepository);
        const original = people.repointPartnerPersonLinks.bind(people);
        const mapping =
          failure === 'mapping failure'
            ? vi.spyOn(people, 'repointPartnerPersonLinks').mockImplementationOnce(async (...args) => {
                await original(...args);
                throw new Error('mapping failed');
              })
            : undefined;
        const remove = people.delete.bind(people);
        const deletion =
          failure === 'deletion failure'
            ? vi.spyOn(people, 'delete').mockImplementationOnce(async (...args) => {
                await remove(...args);
                throw new Error('deletion failed');
              })
            : undefined;
        if (failure === 'queue failure') jobs.queue.mockRejectedValueOnce(new Error('queue failed'));
        let results;
        try {
          results = await sut.mergePeople(auth, { ids: [survivor.personGroupId, removed.personGroupId] });
        } finally {
          mapping?.mockRestore();
          deletion?.mockRestore();
        }
        if (failure !== 'queue failure') {
          expect(results).toEqual([{ id: removed.personGroupId, success: false, error: 'unknown' }]);
          expect((await people.getFaceById(face.id, { viewingUserId: user.id })).personGroupId).toBe(
            removed.personGroupId,
          );
          expect((await people.getPartnerPersonLink(user.id, sourcePerson.personGroupId))?.personGroupId).toBe(
            removed.personGroupId,
          );
          expect(ctx.getMock(StorageRepository).unlink).not.toHaveBeenCalled();
          expect(jobs.queue).not.toHaveBeenCalled();
        } else {
          expect(results).toEqual([{ id: removed.personGroupId, success: true }]);
          expect((await people.getPartnerPersonLink(user.id, sourcePerson.personGroupId))?.personGroupId).toBe(
            survivor.personGroupId,
          );
          const { asset: source } = await ctx.newAsset({ ownerId: sharer.id });
          const { asset: copy } = await ctx.newAsset({ ownerId: user.id });
          await ctx.newAssetFace({ assetId: source.id, personGroupId: sourcePerson.personGroupId });
          await BaseService.create(PartnerPeopleService, sut).copyFaces({
            sourceAssetId: source.id,
            targetAssetId: copy.id,
            targetOwnerId: user.id,
            partnerSharedById: sharer.id,
          });
          expect(await people.getFaces(copy.id, { viewingUserId: user.id })).toEqual([
            expect.objectContaining({ personGroupId: survivor.personGroupId }),
          ]);
        }
      },
    );

    it('merges differently named own people in request order and keeps the first name', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person: first } = await ctx.newPerson({ ownerId: user.id, name: 'Alice' });
      const { person: second } = await ctx.newPerson({ ownerId: user.id, name: 'Alicia' });
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: second.personGroupId });
      ctx.getMock(StorageRepository).unlink.mockResolvedValue();
      await expect(
        sut.mergePeople(factory.auth({ user }), { ids: [first.personGroupId, second.personGroupId] }),
      ).resolves.toEqual([{ id: second.personGroupId, success: true }]);
      await expect(
        ctx.get(PersonRepository).getByGroupId({ ownerId: user.id, personGroupId: first.personGroupId }),
      ).resolves.toMatchObject({ name: 'Alice' });
      await expect(ctx.get(PersonRepository).getFaces(asset.id, { viewingUserId: user.id })).resolves.toEqual([
        expect.objectContaining({ personGroupId: first.personGroupId }),
      ]);
    });

    it('should merge people of multiple users', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { person: person1 } = await ctx.newPerson({ ownerId: user1.id, name: undefined });
      const { person: person2 } = await ctx.newPerson({ ownerId: user1.id });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person1.personGroupId,
      });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person2.personGroupId,
        name: undefined,
      });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person2.personGroupId });
      storageMock.unlink.mockResolvedValue();

      const auth = factory.auth({ user: user1 });

      await sut.mergePeople(auth, { ids: [person1.personGroupId, person2.personGroupId] });
      const user1People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user1.id }));
      const user2People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user2.id }));
      expect(user1People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      expect(user2People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      await expect(ctx.get(PersonRepository).getFaces(asset.id, { viewingUserId: asset.ownerId })).resolves.toEqual([
        expect.objectContaining({ personGroupId: person1.personGroupId }),
      ]);
    });

    it('should skip people with a different name', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { person: person1 } = await ctx.newPerson({ ownerId: user1.id });
      const { person: person2 } = await ctx.newPerson({ ownerId: user1.id });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person1.personGroupId,
        name: 'Person 1',
      });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person2.personGroupId,
        name: 'Person 2',
      });
      storageMock.unlink.mockResolvedValue();

      const auth = factory.auth({ user: user1 });

      await sut.mergePeople(auth, { ids: [person1.personGroupId, person2.personGroupId] });
      const user1People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user1.id }));
      const user2People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user2.id }));
      expect(user1People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      expect(user2People).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ personGroupId: person1.personGroupId }),
          expect.objectContaining({ personGroupId: person2.personGroupId }),
        ]),
      );
    });

    it('should skip people with a different birth date', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { person: person1 } = await ctx.newPerson({ ownerId: user1.id });
      const { person: person2 } = await ctx.newPerson({ ownerId: user1.id });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person1.personGroupId,
        birthDate: DateTime.now().minus({ years: 1 }).toJSDate(),
      });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person2.personGroupId,
        birthDate: DateTime.now().minus({ years: 2 }).toJSDate(),
      });
      storageMock.unlink.mockResolvedValue();

      const auth = factory.auth({ user: user1 });

      await sut.mergePeople(auth, { ids: [person1.personGroupId, person2.personGroupId] });
      const user1People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user1.id }));
      const user2People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user2.id }));
      expect(user1People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      expect(user2People).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ personGroupId: person1.personGroupId }),
          expect.objectContaining({ personGroupId: person2.personGroupId }),
        ]),
      );
    });

    it('should not merge into person another user does not have', async () => {
      const { sut, ctx } = setup();
      const storageMock = ctx.getMock(StorageRepository);
      const { user: user1 } = await ctx.newUser();
      const { user: user2 } = await ctx.newUser({ clusterGroupId: user1.clusterGroupId });
      const { person: person1 } = await ctx.newPerson({ ownerId: user1.id });
      const { person: person2 } = await ctx.newPerson({ ownerId: user1.id });
      await ctx.newPerson({
        ownerId: user2.id,
        personGroupId: person2.personGroupId,
      });
      const { asset } = await ctx.newAsset({ ownerId: user2.id });
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person2.personGroupId });
      storageMock.unlink.mockResolvedValue();

      const auth = factory.auth({ user: user1 });

      await sut.mergePeople(auth, { ids: [person1.personGroupId, person2.personGroupId] });
      const user1People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user1.id }));
      const user2People = await Array.fromAsync(ctx.get(PersonRepository).getAll({ ownerId: user2.id }));
      expect(user1People).toEqual([expect.objectContaining({ personGroupId: person1.personGroupId })]);
      expect(user2People).toEqual([expect.objectContaining({ personGroupId: person2.personGroupId })]);
      await expect(ctx.get(PersonRepository).getFaces(asset.id, { viewingUserId: asset.ownerId })).resolves.toEqual([
        expect.objectContaining({ personGroupId: person2.personGroupId }),
      ]);
    });
  });

  describe('createFace', () => {
    it('should store and retrieve the face as-is when there are no edits', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 200, height: 200 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 200,
        imageHeight: 200,
        x: 50,
        y: 50,
        width: 150,
        height: 150,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      // retrieve an asset's faces
      const faces = sut.getFacesById(auth, { id: asset.id });

      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 50,
            boundingBoxX2: 200,
            boundingBoxY2: 200,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Crop)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 150, height: 200 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 50,
              y: 50,
              width: 150,
              height: 200,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 150,
        imageHeight: 200,
        x: 0,
        y: 0,
        width: 100,
        height: 100,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      // retrieve an asset's faces
      const faces = sut.getFacesById(auth, { id: asset.id });

      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 0,
            boundingBoxY1: 0,
            boundingBoxX2: 100,
            boundingBoxY2: 100,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });

      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toHaveLength(1);
      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 50,
            boundingBoxX2: 150,
            boundingBoxY2: 150,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Rotate 90)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 100, height: 200 });
      await ctx.newExif({ assetId: asset.id, exifImageWidth: 200, exifImageHeight: 100 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 100,
        imageHeight: 200,
        x: 25,
        y: 50,
        width: 10,
        height: 10,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: expect.closeTo(25, 1),
            boundingBoxY1: expect.closeTo(50, 1),
            boundingBoxX2: expect.closeTo(35, 1),
            boundingBoxY2: expect.closeTo(60, 1),
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 65,
            boundingBoxX2: 60,
            boundingBoxY2: 75,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Mirror Horizontal)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 200, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 100, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 200,
        imageHeight: 100,
        x: 50,
        y: 25,
        width: 100,
        height: 50,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 25,
            boundingBoxX2: 150,
            boundingBoxY2: 75,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 25,
            boundingBoxX2: 150,
            boundingBoxY2: 75,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Crop + Rotate)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 200, height: 150 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 50,
              y: 0,
              width: 150,
              height: 200,
            },
          },
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 200,
        imageHeight: 150,
        x: 50,
        y: 25,
        width: 10,
        height: 20,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: expect.closeTo(50, 1),
            boundingBoxY1: expect.closeTo(25, 1),
            boundingBoxX2: expect.closeTo(60, 1),
            boundingBoxY2: expect.closeTo(45, 1),
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 75,
            boundingBoxY1: 140,
            boundingBoxX2: 95,
            boundingBoxY2: 150,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Crop + Mirror)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 150, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 100, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 50,
              y: 0,
              width: 150,
              height: 100,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 150,
        imageHeight: 100,
        x: 25,
        y: 25,
        width: 75,
        height: 50,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 25,
            boundingBoxY1: 25,
            boundingBoxX2: 100,
            boundingBoxY2: 75,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 100,
            boundingBoxY1: 25,
            boundingBoxX2: 175,
            boundingBoxY2: 75,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Rotate + Mirror)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 200, height: 150 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 150 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 90,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 200,
        imageHeight: 150,
        x: 50,
        y: 25,
        width: 15,
        height: 20,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: expect.closeTo(50, 1),
            boundingBoxY1: expect.closeTo(25, 1),
            boundingBoxX2: expect.closeTo(65, 1),
            boundingBoxY2: expect.closeTo(45, 1),
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 25,
            boundingBoxY1: 50,
            boundingBoxX2: 45,
            boundingBoxY2: 65,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates when the asset is edited (Crop + Rotate + Mirror)', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 150, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 200 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Crop,
            parameters: {
              x: 50,
              y: 25,
              width: 100,
              height: 150,
            },
          },
          {
            action: AssetEditAction.Rotate,
            parameters: {
              angle: 270,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 150,
        imageHeight: 150,
        x: 25,
        y: 50,
        width: 75,
        height: 50,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 25,
            boundingBoxY1: 49,
            boundingBoxX2: 99,
            boundingBoxY2: 100,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 50,
            boundingBoxY1: 75,
            boundingBoxX2: 100,
            boundingBoxY2: 150,
          }),
        ]),
      );
    });

    it('should properly transform the coordinates with multiple mirrors in sequence', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 100, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 100, exifImageWidth: 100 });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Vertical,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 100,
        imageHeight: 100,
        x: 10,
        y: 10,
        width: 80,
        height: 80,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 10,
            boundingBoxY1: 10,
            boundingBoxX2: 90,
            boundingBoxY2: 90,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 10,
            boundingBoxY1: 10,
            boundingBoxX2: 90,
            boundingBoxY2: 90,
          }),
        ]),
      );
    });

    it('should properly handle exif orientation when creating a face on an edited asset', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { person } = await ctx.newPerson({ ownerId: user.id });
      const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 100, height: 100 });
      await ctx.newExif({ assetId: asset.id, exifImageHeight: 200, exifImageWidth: 100, orientation: '6' });
      ctx.getMock(JobRepository).queueAll.mockResolvedValue();

      await ctx.newEdits(asset.id, {
        edits: [
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Horizontal,
            },
          },
          {
            action: AssetEditAction.Mirror,
            parameters: {
              axis: MirrorAxis.Vertical,
            },
          },
        ],
      });

      const auth = factory.auth({ user });

      const dto: AssetFaceCreateDto = {
        imageWidth: 100,
        imageHeight: 100,
        x: 10,
        y: 10,
        width: 80,
        height: 80,
        personId: person.personGroupId,
        assetId: asset.id,
      };

      await sut.createFace(auth, dto);

      const faces = sut.getFacesById(auth, { id: asset.id });
      await expect(faces).resolves.toHaveLength(1);
      await expect(faces).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 110,
            boundingBoxY1: 10,
            boundingBoxX2: 190,
            boundingBoxY2: 90,
          }),
        ]),
      );

      // remove edits and verify the stored coordinates map to the original image
      await ctx.newEdits(asset.id, { edits: [] });
      const facesAfterRemovingEdits = sut.getFacesById(auth, { id: asset.id });

      await expect(facesAfterRemovingEdits).resolves.toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            person: expect.objectContaining({ id: person.personGroupId }),
            boundingBoxX1: 10,
            boundingBoxY1: 10,
            boundingBoxX2: 90,
            boundingBoxY2: 90,
          }),
        ]),
      );
    });
  });
});
