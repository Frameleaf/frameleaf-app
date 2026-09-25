import { ConflictException, NotFoundException } from '@nestjs/common';
import type { FaceCorrection } from 'src/repositories/person.repository.js';
import { AssetFileType, JobName, JobStatus, SourceType } from 'src/enum.js';
import { PersonService } from 'src/services/person.service.js';
import { AssetFaceFactory } from 'test/factories/asset-face.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { PersonFactory } from 'test/factories/person.factory.js';
import { getAsDetectedFace, getForDetectedFaces, getForFacialRecognitionJob } from 'test/mappers.js';
import { newDate, newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

/**
 * FL-57: guided merge verdicts, the durable face correction history, its undo, decisions that survive
 * face reprocessing, and the invalidation of generated text after face changes.
 */
describe('PersonService face history (FL-57)', () => {
  let sut: PersonService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PersonService));
    mocks.person.getReferenceFaces.mockResolvedValue([]);
    mocks.person.getOrphanedFaceCorrections.mockResolvedValue([]);
    mocks.person.getFaceDecisionChecksums.mockResolvedValue(new Map());
    mocks.person.recordFaceCorrections.mockResolvedValue([]);
    mocks.person.hasFaces.mockResolvedValue(true);
    mocks.person.reassignFaces.mockResolvedValue(1);
    mocks.person.reanchorMergeVerdicts.mockResolvedValue(0);
    mocks.person.getVisibleEvidenceAssetIds.mockResolvedValue(new Set());
    mocks.person.getForMergePerson.mockResolvedValue([]);
  });

  const correction = (overrides: Partial<FaceCorrection> = {}): FaceCorrection => ({
    id: newUuid(),
    ownerId: newUuid(),
    actorId: newUuid(),
    action: 'reassign',
    faceId: newUuid(),
    assetId: newUuid(),
    assetChecksum: Buffer.from('original'),
    boxX1: 0.1,
    boxY1: 0.1,
    boxX2: 0.3,
    boxY2: 0.3,
    fromPersonId: newUuid(),
    toPersonId: newUuid(),
    fromPersonName: 'Before',
    toPersonName: 'After',
    createdAt: newDate(),
    undoneAt: null,
    ...overrides,
  });

  describe('merge verdicts', () => {
    const [low, high] = ['00000000-0000-4000-8000-000000000001', '00000000-0000-4000-8000-000000000002'];

    it('stores "ignore" as the reviewed person paired with itself', async () => {
      const auth = AuthFactory.create();
      mocks.access.person.checkOwnerAccess.mockImplementation((_userId, ids) => Promise.resolve(ids));
      mocks.person.setMergeVerdict.mockResolvedValue({ verdict: 'ignore', createdAt: newDate() });

      await expect(
        sut.setMergeVerdict(auth, { personId: high, suggestionId: low, verdict: 'ignore' }),
      ).resolves.toEqual(expect.objectContaining({ personId: high, suggestionId: high, verdict: 'ignore' }));
      expect(mocks.person.setMergeVerdict).toHaveBeenCalledWith(auth.user.id, high, high, 'ignore');
    });

    it('undoes "ignore" with the same person twice', async () => {
      const auth = AuthFactory.create();
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([high]));
      mocks.person.deleteMergeVerdict.mockResolvedValue(true);

      await sut.deleteMergeVerdict(auth, { personId: high, suggestionId: high });
      expect(mocks.person.deleteMergeVerdict).toHaveBeenCalledWith(auth.user.id, high, high);
    });

    it('merges on "same", keeping the named person, and records the merge', async () => {
      const auth = AuthFactory.create();
      const unnamed = PersonFactory.create({ ownerId: auth.user.id, name: '', personGroupId: low });
      const named = PersonFactory.create({ ownerId: auth.user.id, name: 'Ada', personGroupId: high });
      mocks.access.person.checkOwnerAccess.mockImplementation((_userId, ids) => Promise.resolve(ids));
      mocks.person.getByGroupId.mockImplementation(({ personGroupId }) =>
        Promise.resolve(personGroupId === low ? unnamed : named),
      );
      mocks.person.getForMergePerson.mockResolvedValue([named, unnamed]);
      mocks.person.delete.mockResolvedValue([unnamed]);

      await expect(sut.setMergeVerdict(auth, { personId: low, suggestionId: high, verdict: 'same' })).resolves.toEqual(
        expect.objectContaining({ personId: high, suggestionId: low, verdict: 'same' }),
      );
      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        oldPersonGroupId: low,
        newPersonGroupId: high,
        ownerId: auth.user.id,
        corrected: true,
      });
      expect(mocks.person.recordFaceCorrections).toHaveBeenCalledWith([
        expect.objectContaining({ action: 'merge', fromPersonId: low, toPersonId: high, actorId: auth.user.id }),
      ]);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.PersonIdentityRefresh,
        data: { ownerId: auth.user.id, personGroupIds: [high] },
      });
      expect(mocks.person.setMergeVerdict).not.toHaveBeenCalled();
    });

    it('shows each person with a reference face and its complete photo', async () => {
      const auth = AuthFactory.create();
      const [ada, eve] = [
        PersonFactory.create({ ownerId: auth.user.id, name: 'Ada' }),
        PersonFactory.create({ ownerId: auth.user.id, name: 'Eve' }),
      ];
      const assetId = newUuid();
      const faceId = newUuid();
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { facialRecognition: { maxDistance: 0.5 } } });
      mocks.person.getMergeSuggestions.mockResolvedValue([
        { personId: ada.personGroupId, suggestionId: eve.personGroupId, distance: 0.3 },
      ]);
      mocks.person.getForMergePerson.mockResolvedValue([ada, eve]);
      mocks.person.getReferenceFaces.mockResolvedValue([
        {
          personGroupId: ada.personGroupId,
          faceId,
          assetId,
          imageWidth: 100,
          imageHeight: 200,
          boundingBoxX1: 10,
          boundingBoxY1: 20,
          boundingBoxX2: 30,
          boundingBoxY2: 60,
        },
      ]);
      mocks.asset.getForFaces.mockResolvedValue({
        exifImageWidth: 100,
        exifImageHeight: 200,
        orientation: null,
        edits: [],
      } as never);

      const { suggestions } = await sut.getMergeSuggestions(auth);
      expect(suggestions[0].personEvidence).toEqual({
        assetId,
        faceId,
        box: { x: 0.1, y: 0.1, width: 0.2, height: 0.2 },
      });
      // no photo of Eve may be shown: no evidence rather than someone else's or a Locked one
      expect(suggestions[0].suggestionEvidence).toBeNull();
      expect(mocks.person.getReferenceFaces).toHaveBeenCalledWith(
        auth.user.id,
        [ada.personGroupId, eve.personGroupId],
        {},
      );
      expect(mocks.person.reanchorMergeVerdicts).toHaveBeenCalledWith(auth.user.id);
    });
  });

  describe('recording corrections', () => {
    it('records a move to someone new and refreshes the generated text of that photo', async () => {
      const auth = AuthFactory.create();
      const target = PersonFactory.create({ ownerId: auth.user.id, name: 'New' });
      const face = AssetFaceFactory.create();
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([target.personGroupId]));
      mocks.access.person.checkFaceOwnerAccess.mockResolvedValue(new Set([face.id]));
      mocks.person.getFaceById.mockResolvedValue({ ...face, person: null });
      mocks.person.getByGroupId.mockResolvedValue(target);
      mocks.person.hasFaces.mockResolvedValue(false);

      await sut.reassignFacesById(auth, target.personGroupId, { id: face.id });

      expect(mocks.person.recordFaceCorrections).toHaveBeenCalledWith([
        expect.objectContaining({
          ownerId: auth.user.id,
          action: 'new-person',
          faceId: face.id,
          fromPersonId: face.personGroupId,
          toPersonId: target.personGroupId,
        }),
      ]);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.PersonIdentityRefresh,
        data: { ownerId: auth.user.id, assetIds: [face.assetId] },
      });
    });

    it('records "not a face of anyone" after a soft delete, and before a permanent one', async () => {
      const auth = AuthFactory.create();
      const face = AssetFaceFactory.create();
      mocks.access.person.checkFaceOwnerAccess.mockResolvedValue(new Set([face.id]));
      mocks.person.getFaceById.mockResolvedValue({ ...face, person: null });
      const order: string[] = [];
      mocks.person.softDeleteAssetFaces.mockImplementation(() => Promise.resolve(void order.push('soft')));
      mocks.person.deleteAssetFace.mockImplementation(() => Promise.resolve(void order.push('hard')));
      mocks.person.recordFaceCorrections.mockImplementation(() => {
        order.push('record');
        return Promise.resolve([]);
      });

      await sut.deleteFace(auth, face.id, { force: false });
      await sut.deleteFace(auth, face.id, { force: true });

      expect(order).toEqual(['soft', 'record', 'record', 'hard']);
      expect(mocks.person.recordFaceCorrections).toHaveBeenCalledWith([
        expect.objectContaining({ action: 'remove', faceId: face.id, fromPersonId: face.personGroupId }),
      ]);
    });

    it('keeps the change when the history cannot be written during a database handoff', async () => {
      const auth = AuthFactory.create();
      const face = AssetFaceFactory.create();
      mocks.access.person.checkFaceOwnerAccess.mockResolvedValue(new Set([face.id]));
      mocks.person.getFaceById.mockResolvedValue({ ...face, person: null });
      mocks.person.recordFaceCorrections.mockRejectedValue(new ConflictException('handoff'));

      await expect(sut.deleteFace(auth, face.id, { force: false })).resolves.toBeUndefined();
      expect(mocks.person.softDeleteAssetFaces).toHaveBeenCalledWith(face.id);
    });

    it('refreshes generated text after a rename or hiding, not after a birthday', async () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ ownerId: auth.user.id, name: 'Ada', isHidden: false });
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([person.personGroupId]));
      mocks.person.getByGroupId.mockResolvedValue(person);
      mocks.person.update.mockResolvedValue(person);

      await sut.update(auth, person.personGroupId, { birthDate: '1990-01-01' });
      expect(mocks.job.queue).not.toHaveBeenCalled();

      await sut.update(auth, person.personGroupId, { name: 'Ada Lovelace' });
      await sut.update(auth, person.personGroupId, { isHidden: true });
      expect(mocks.job.queue).toHaveBeenCalledTimes(2);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.PersonIdentityRefresh,
        data: { ownerId: auth.user.id, personGroupIds: [person.personGroupId] },
      });
    });
  });

  describe('undoCorrection', () => {
    const setup = (entry: FaceCorrection, face: Partial<ReturnType<AssetFaceFactory['build']>> = {}) => {
      const auth = AuthFactory.create({ id: entry.ownerId });
      const current = AssetFaceFactory.create({
        id: entry.faceId!,
        assetId: entry.assetId!,
        personGroupId: entry.toPersonId,
        ...face,
      });
      mocks.person.getFaceCorrection.mockResolvedValue(entry);
      mocks.asset.getById.mockResolvedValue({
        id: entry.assetId,
        ownerId: entry.ownerId,
        checksum: Buffer.from('original'),
        deletedAt: null,
      } as never);
      mocks.person.getAllFacesOfAsset.mockResolvedValue([current]);
      mocks.access.person.checkFaceOwnerAccess.mockResolvedValue(new Set([current.id]));
      mocks.person.getByGroupId.mockResolvedValue(PersonFactory.create({ ownerId: entry.ownerId }));
      mocks.person.undoFaceCorrection.mockResolvedValue('undone');
      return { auth, current };
    };

    it('moves the face back and marks the change undone', async () => {
      const entry = correction();
      const { auth, current } = setup(entry);

      await expect(sut.undoCorrection(auth, entry.id)).resolves.toEqual(
        expect.objectContaining({ id: entry.id, undoneAt: expect.any(String), undoable: false }),
      );
      expect(mocks.person.undoFaceCorrection).toHaveBeenCalledWith(
        entry.id,
        { id: current.id, expectedRevision: current.updateId },
        { personGroupId: entry.fromPersonId },
      );
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.PersonIdentityRefresh,
        data: { ownerId: entry.ownerId, assetIds: [entry.assetId] },
      });
    });

    it('restores a face taken off with "not a face of anyone"', async () => {
      const entry = correction({ action: 'remove', toPersonId: null });
      const { auth, current } = setup(entry, { deletedAt: newDate(), personGroupId: entry.fromPersonId });

      await sut.undoCorrection(auth, entry.id);
      expect(mocks.person.undoFaceCorrection).toHaveBeenCalledWith(
        entry.id,
        { id: current.id, expectedRevision: current.updateId },
        { restore: true },
      );
    });

    it('finds the face that replaced the one the change was about, at the same place', async () => {
      const entry = correction();
      const { auth } = setup(entry);
      const replacement = AssetFaceFactory.create({
        assetId: entry.assetId!,
        personGroupId: entry.toPersonId,
        imageWidth: 1000,
        imageHeight: 1000,
        boundingBoxX1: 105,
        boundingBoxY1: 100,
        boundingBoxX2: 300,
        boundingBoxY2: 305,
      });
      mocks.person.getAllFacesOfAsset.mockResolvedValue([replacement]);
      mocks.access.person.checkFaceOwnerAccess.mockResolvedValue(new Set([replacement.id]));

      await sut.undoCorrection(auth, entry.id);
      expect(mocks.person.undoFaceCorrection).toHaveBeenCalledWith(
        entry.id,
        { id: replacement.id, expectedRevision: replacement.updateId },
        { personGroupId: entry.fromPersonId },
      );
    });

    const conflict = async (promise: Promise<unknown>) => {
      const error = await promise.catch((error_: unknown) => error_);
      expect(error).toBeInstanceOf(ConflictException);
      return ((error as ConflictException).getResponse() as { reason: string }).reason;
    };

    it('refuses when the face has changed since', async () => {
      const entry = correction();
      const { auth } = setup(entry, { personGroupId: newUuid() });
      await expect(conflict(sut.undoCorrection(auth, entry.id))).resolves.toBe('face-changed');
      expect(mocks.person.undoFaceCorrection).not.toHaveBeenCalled();
    });

    // FL-38: a revision-checked correction that lands between the check and the write wins
    it('refuses, and keeps the change standing, when another view corrects the face meanwhile', async () => {
      const entry = correction();
      const { auth } = setup(entry);
      mocks.person.undoFaceCorrection.mockResolvedValue('face-changed');

      await expect(conflict(sut.undoCorrection(auth, entry.id))).resolves.toBe('face-changed');
      expect(mocks.job.queue).not.toHaveBeenCalledWith(
        expect.objectContaining({ name: JobName.PersonIdentityRefresh }),
      );
    });

    it('refuses a change undone meanwhile', async () => {
      const entry = correction();
      const { auth } = setup(entry);
      mocks.person.undoFaceCorrection.mockResolvedValue('already-undone');
      await expect(conflict(sut.undoCorrection(auth, entry.id))).resolves.toBe('already-undone');
    });

    it('refuses when the original was replaced (another checksum)', async () => {
      const entry = correction({ assetChecksum: Buffer.from('older original') });
      const { auth } = setup(entry);
      await expect(conflict(sut.undoCorrection(auth, entry.id))).resolves.toBe('source-changed');
    });

    it('refuses a merge, a change already undone and a face no longer detected', async () => {
      const merge = correction({ action: 'merge', faceId: null, assetId: null });
      const { auth } = setup(correction());
      mocks.person.getFaceCorrection.mockResolvedValueOnce(merge);
      await expect(conflict(sut.undoCorrection(auth, merge.id))).resolves.toBe('not-undoable');

      mocks.person.getFaceCorrection.mockResolvedValueOnce(correction({ undoneAt: newDate() }));
      await expect(conflict(sut.undoCorrection(auth, newUuid()))).resolves.toBe('already-undone');

      const gone = correction();
      mocks.person.getFaceCorrection.mockResolvedValueOnce(gone);
      mocks.asset.getById.mockResolvedValueOnce({ id: gone.assetId, checksum: Buffer.from('original') } as never);
      mocks.person.getAllFacesOfAsset.mockResolvedValueOnce([]);
      await expect(conflict(sut.undoCorrection(auth, gone.id))).resolves.toBe('face-gone');
    });

    it("answers 404 for someone else's correction", async () => {
      mocks.person.getFaceCorrection.mockResolvedValue(undefined);
      await expect(sut.undoCorrection(AuthFactory.create(), newUuid())).rejects.toBeInstanceOf(NotFoundException);
    });
  });

  describe('reprocessing', () => {
    it('keeps a corrected face this detection no longer finds, and refreshes its embedding when it does', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();
      const corrected = AssetFaceFactory.create({ assetId: asset.id, correctedAt: newDate() });
      const plain = AssetFaceFactory.create({
        assetId: asset.id,
        boundingBoxX1: 500,
        boundingBoxX2: 600,
        boundingBoxY1: 500,
        boundingBoxY2: 600,
      });
      asset.faces = [corrected, plain] as never;
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      mocks.person.getFaceDecisionChecksums.mockResolvedValue(new Map([[corrected.id, asset.checksum]]));

      mocks.machineLearning.detectFaces.mockResolvedValue({ imageHeight: 500, imageWidth: 400, faces: [] });
      await sut.handleDetectFaces({ id: asset.id });
      expect(mocks.person.refreshFaces).toHaveBeenCalledWith([], [plain.id], []);

      mocks.machineLearning.detectFaces.mockResolvedValue(getAsDetectedFace(corrected));
      await sut.handleDetectFaces({ id: asset.id });
      expect(mocks.person.refreshFaces).toHaveBeenLastCalledWith(
        [],
        [plain.id],
        [{ faceId: corrected.id, embedding: expect.any(String) }],
      );
    });

    it('no longer keeps a corrected face once the original was replaced', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();
      const corrected = AssetFaceFactory.create({ assetId: asset.id, correctedAt: newDate() });
      asset.faces = [corrected] as never;
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      mocks.person.getFaceDecisionChecksums.mockResolvedValue(new Map([[corrected.id, Buffer.from('older')]]));
      mocks.machineLearning.detectFaces.mockResolvedValue({ imageHeight: 500, imageWidth: 400, faces: [] });

      await sut.handleDetectFaces({ id: asset.id });
      expect(mocks.person.refreshFaces).toHaveBeenCalledWith([], [corrected.id], []);
    });

    it('re-applies a decision to the new face that replaced the corrected one, and skips recognition for it', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();
      const detected = AssetFaceFactory.create({ assetId: asset.id, imageWidth: 400, imageHeight: 500 });
      const entry = correction({
        assetId: asset.id,
        assetChecksum: asset.checksum,
        boxX1: detected.boundingBoxX1 / 400,
        boxY1: detected.boundingBoxY1 / 500,
        boxX2: detected.boundingBoxX2 / 400,
        boxY2: detected.boundingBoxY2 / 500,
      });
      mocks.crypto.randomUUID.mockReturnValue(detected.id);
      mocks.machineLearning.detectFaces.mockResolvedValue(getAsDetectedFace(detected));
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      mocks.person.getOrphanedFaceCorrections.mockResolvedValue([entry]);
      mocks.person.getByGroupId.mockResolvedValue(PersonFactory.create({ personGroupId: entry.toPersonId! }));

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.person.setFacePerson).toHaveBeenCalledWith(detected.id, entry.toPersonId);
      expect(mocks.person.reanchorFaceCorrections).toHaveBeenCalledWith(entry.faceId, detected.id);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FacialRecognitionQueueAll, data: { force: false } },
      ]);
    });

    it('does not re-apply a decision about a replaced original', async () => {
      const asset = AssetFactory.from().file({ type: AssetFileType.Preview }).exif().build();
      const detected = AssetFaceFactory.create({ assetId: asset.id, imageWidth: 400, imageHeight: 500 });
      const entry = correction({
        assetId: asset.id,
        assetChecksum: Buffer.from('older original'),
        boxX1: detected.boundingBoxX1 / 400,
        boxY1: detected.boundingBoxY1 / 500,
        boxX2: detected.boundingBoxX2 / 400,
        boxY2: detected.boundingBoxY2 / 500,
      });
      mocks.crypto.randomUUID.mockReturnValue(detected.id);
      mocks.machineLearning.detectFaces.mockResolvedValue(getAsDetectedFace(detected));
      mocks.assetJob.getForDetectFacesJob.mockResolvedValue(getForDetectedFaces(asset));
      mocks.person.getOrphanedFaceCorrections.mockResolvedValue([entry]);

      await sut.handleDetectFaces({ id: asset.id });

      expect(mocks.person.setFacePerson).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        { name: JobName.FacialRecognitionQueueAll, data: { force: false } },
        { name: JobName.FacialRecognition, data: { id: detected.id } },
      ]);
    });

    it('never lets recognition assign a face a person decided belongs to no one', async () => {
      const face = AssetFaceFactory.create({ personGroupId: null, correctedAt: newDate() });
      const asset = AssetFactory.create();
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(face, asset));

      await expect(sut.handleRecognizeFaces({ id: face.id })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.search.searchFaces).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
    });

    it('keeps a decision made while recognition was matching the face', async () => {
      const face = AssetFaceFactory.create({ personGroupId: null, sourceType: SourceType.MachineLearning });
      const asset = AssetFactory.create();
      const person = PersonFactory.create({ ownerId: asset.ownerId });
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(face, asset));
      mocks.search.searchFaces.mockResolvedValue([
        { id: newUuid(), personGroupId: person.personGroupId, distance: 0.1 },
        { id: newUuid(), personGroupId: person.personGroupId, distance: 0.2 },
        { id: newUuid(), personGroupId: person.personGroupId, distance: 0.2 },
      ]);
      mocks.person.getByGroupId.mockResolvedValue(person);
      mocks.person.reassignFaces.mockResolvedValue(0);

      await expect(sut.handleRecognizeFaces({ id: face.id })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.person.reassignFaces).toHaveBeenCalledWith({
        faceIds: [face.id],
        newPersonGroupId: person.personGroupId,
        onlyUndecided: true,
      });
    });
  });
});
