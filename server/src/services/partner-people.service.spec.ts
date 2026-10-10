import { ConflictException } from '@nestjs/common';
import type { FaceCorrection, PartnerPersonLink } from 'src/repositories/person.repository.js';
import { JobName } from 'src/enum.js';
import { PartnerPeopleService } from 'src/services/partner-people.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newUuid } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

const A = newUuid(); // the sharing partner (source owner)
const B = authStub.user1.user.id; // the recipient
const CLUSTER_B = newUuid();
const CLUSTER_A = newUuid();
const SOURCE_ASSET = newUuid();
const TARGET_ASSET = newUuid();
const PG_A = newUuid(); // A's person
const PG_B = newUuid(); // B's own matching person
const NEW_PG = newUuid();
const FACE_1 = newUuid();
const FACE_2 = newUuid();

const person = (ownerId: string, personGroupId: string, extra: Record<string, unknown> = {}) =>
  ({
    ownerId,
    personGroupId,
    name: '',
    birthDate: null,
    isHidden: false,
    isFavorite: false,
    color: null,
    faceAssetId: null,
    thumbnailPath: '',
    ...extra,
  }) as never;

const copyInput = { sourceAssetId: SOURCE_ASSET, targetAssetId: TARGET_ASSET, targetOwnerId: B, partnerSharedById: A };

describe(PartnerPeopleService.name, () => {
  let sut: PartnerPeopleService;
  let mocks: ServiceMocks;
  let links: PartnerPersonLink[];
  let people: Map<string, ReturnType<typeof person>>;
  const thumbnailSelection = { where: vi.fn(), execute: vi.fn() };

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PartnerPeopleService));
    thumbnailSelection.where.mockReset().mockReturnValue(thumbnailSelection);
    thumbnailSelection.execute.mockReset().mockResolvedValue([]);
    mocks.person.selectionForThumbnails.mockReturnValue(thumbnailSelection as never);
    mocks.job.collectFollowups.mockImplementation(async (collect) => {
      await collect();
    });
    links = [];
    people = new Map([[`${A}/${PG_A}`, person(A, PG_A, { name: 'Emma', birthDate: '2015-04-01' })]]);
    mocks.user.get.mockImplementation((id) =>
      Promise.resolve({ id, clusterGroupId: id === B ? CLUSTER_B : CLUSTER_A } as never),
    );
    mocks.person.getGroupClusterId.mockImplementation((id) => Promise.resolve(id === PG_A ? CLUSTER_A : CLUSTER_B));
    mocks.person.getByGroupId.mockImplementation(({ ownerId, personGroupId }) =>
      Promise.resolve(people.get(`${ownerId}/${personGroupId}`)),
    );
    mocks.person.getPartnerPersonLink.mockImplementation((ownerId, source) =>
      Promise.resolve(links.find((link) => link.ownerId === ownerId && link.sourcePersonGroupId === source)),
    );
    mocks.person.savePartnerPersonLink.mockImplementation((link) => {
      links = [...links.filter((l) => l.sourcePersonGroupId !== link.sourcePersonGroupId), link];
      return Promise.resolve();
    });
    mocks.person.getFacesForPartnerCopy.mockResolvedValue([
      { id: FACE_1, personGroupId: PG_A, hasEmbedding: true },
      { id: FACE_2, personGroupId: null, hasEmbedding: true },
    ]);
    mocks.person.getFaceEmbedding.mockResolvedValue('[0.1,0.2]');
    mocks.person.copyFacesToAsset.mockImplementation((_target, faces) => Promise.resolve(faces.length));
    mocks.person.createGroup.mockResolvedValue({ id: NEW_PG, clusterGroupId: CLUSTER_B } as never);
    mocks.person.create.mockImplementation((value) => {
      const created = person(value.ownerId, value.personGroupId, value);
      people.set(`${value.ownerId}/${value.personGroupId}`, created);
      return Promise.resolve(created);
    });
    mocks.person.recordFaceCorrections.mockImplementation((entries) =>
      Promise.resolve(entries.map((entry) => ({ ...entry, id: 'correction-1' })) as never),
    );
    mocks.partnerOrigin.getPersonMapping.mockResolvedValue(undefined);
    mocks.partnerOrigin.createPersonCopy.mockImplementation((value) => {
      people.set(`${value.ownerId}/${NEW_PG}`, person(value.ownerId, NEW_PG, value));
      links = [
        ...links.filter(
          (link) => link.ownerId !== value.ownerId || link.sourcePersonGroupId !== value.sourcePersonGroupId,
        ),
        {
          ownerId: value.ownerId,
          sourcePersonGroupId: value.sourcePersonGroupId,
          personGroupId: NEW_PG,
          kind: 'created',
          partnerSharedById: value.partnerSharedById,
          correctionId: null,
        },
      ];
      return Promise.resolve({ personGroupId: NEW_PG });
    });
    mocks.search.searchFaces.mockResolvedValue([]);
  });

  describe('copyFaces', () => {
    it("auto-merges a partner's person into the recipient's matching person and logs it with undo", async () => {
      people.set(`${B}/${PG_B}`, person(B, PG_B, { name: 'Emma R.' }));
      mocks.search.searchFaces.mockResolvedValue([{ id: newUuid(), personGroupId: PG_B, distance: 0.2 }]);

      await expect(sut.copyFaces(copyInput)).resolves.toBe(2);

      expect(mocks.search.searchFaces).toHaveBeenCalledWith(
        expect.objectContaining({
          clusterGroupId: CLUSTER_B,
          embedding: '[0.1,0.2]',
          hasPerson: true,
          maxDistance: 0.5,
        }),
      );
      expect(mocks.person.copyFacesToAsset).toHaveBeenCalledWith(TARGET_ASSET, [
        { sourceFaceId: FACE_1, faceId: expect.any(String), personGroupId: PG_B },
        { sourceFaceId: FACE_2, faceId: expect.any(String), personGroupId: null },
      ]);
      expect(mocks.person.recordFaceCorrections).toHaveBeenCalledWith([
        {
          ownerId: B,
          actorId: B,
          action: 'partner-merge',
          faceId: null,
          fromPersonId: PG_A,
          toPersonId: PG_B,
          fromPersonName: 'Emma',
          toPersonName: 'Emma R.',
        },
      ]);
      expect(links).toEqual([
        {
          ownerId: B,
          sourcePersonGroupId: PG_A,
          personGroupId: PG_B,
          kind: 'merged',
          partnerSharedById: A,
          correctionId: 'correction-1',
        },
      ]);
      expect(mocks.partnerOrigin.createPersonCopy).not.toHaveBeenCalled();
      expect(mocks.partnerOrigin.createPersonCopy).not.toHaveBeenCalled();
    });

    it("never merges into another account's person in the same recognition group", async () => {
      const otherPg = newUuid();
      mocks.search.searchFaces.mockResolvedValue([{ id: newUuid(), personGroupId: otherPg, distance: 0.1 }]);

      await sut.copyFaces(copyInput);

      expect(mocks.person.recordFaceCorrections).not.toHaveBeenCalled();
      expect(links[0]).toMatchObject({ personGroupId: NEW_PG, kind: 'created' });
    });

    it('creates a new person with an origin when nothing matches', async () => {
      let copiedFaceId: string | undefined;
      mocks.person.copyFacesToAsset.mockImplementation((_target, faces) => {
        expect(mocks.person.selectionForThumbnails).not.toHaveBeenCalled();
        expect(mocks.job.queue).not.toHaveBeenCalled();
        expect(mocks.job.queueAll).not.toHaveBeenCalled();
        copiedFaceId = faces[0].faceId;
        thumbnailSelection.execute.mockResolvedValue([
          { data: { ownerId: B, personGroupId: NEW_PG, selectionFaceId: copiedFaceId } },
        ]);
        return Promise.resolve(faces.length);
      });

      await sut.copyFaces(copyInput);

      expect(mocks.partnerOrigin.createPersonCopy).toHaveBeenCalledWith(
        {
          ownerId: B,
          sourceOwnerId: A,
          sourcePersonGroupId: PG_A,
          rootOwnerId: A,
          partnerSharedById: A,
          name: 'Emma',
          birthDate: '2015-04-01',
          isHidden: false,
        },
        undefined,
      );
      expect(links[0]).toMatchObject({ personGroupId: NEW_PG, kind: 'created', correctionId: null });
      expect(mocks.person.copyFacesToAsset).toHaveBeenCalledWith(TARGET_ASSET, [
        expect.objectContaining({ sourceFaceId: FACE_1, personGroupId: NEW_PG }),
        expect.objectContaining({ sourceFaceId: FACE_2, personGroupId: null }),
      ]);
      expect(mocks.person.selectionForThumbnails).toHaveBeenCalledWith(false, B);
      expect(thumbnailSelection.where).toHaveBeenCalledWith('person.personGroupId', 'in', [NEW_PG]);
      expect(thumbnailSelection.where).toHaveBeenCalledWith('person.faceAssetId', 'is', null);
      expect(mocks.job.collectFollowups).toHaveBeenCalledTimes(1);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PersonGenerateThumbnail,
          data: { ownerId: B, personGroupId: NEW_PG, selectionFaceId: copiedFaceId },
        },
      ]);
      expect(copiedFaceId).not.toBe(FACE_1);
      expect(mocks.person.update).not.toHaveBeenCalled();
      expect(mocks.person.recordFaceCorrections).not.toHaveBeenCalled();
    });

    it('does not enqueue a portrait when the copy transaction fails', async () => {
      const error = new Error('Face copy failed');
      mocks.person.copyFacesToAsset.mockRejectedValue(error);

      await expect(sut.copyFaces(copyInput)).rejects.toBe(error);

      expect(mocks.person.selectionForThumbnails).not.toHaveBeenCalled();
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('does not enqueue a portrait without an eligible recipient face', async () => {
      await expect(sut.copyFaces(copyInput)).resolves.toBe(2);

      expect(mocks.person.selectionForThumbnails).toHaveBeenCalledWith(false, B);
      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('uses an existing eligible face when an idempotent copy adds no rows', async () => {
      const existingFaceId = newUuid();
      mocks.person.copyFacesToAsset.mockResolvedValue(0);
      thumbnailSelection.execute.mockResolvedValue([
        { data: { ownerId: B, personGroupId: NEW_PG, selectionFaceId: existingFaceId } },
      ]);

      await expect(sut.copyFaces(copyInput)).resolves.toBe(0);

      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PersonGenerateThumbnail,
          data: { ownerId: B, personGroupId: NEW_PG, selectionFaceId: existingFaceId },
        },
      ]);
    });

    it('keeps the root owner of a person copied on (A to B to C)', async () => {
      mocks.person.getPersonOriginRoot.mockImplementation((ownerId, personGroupId) =>
        Promise.resolve(ownerId === A && personGroupId === PG_A ? 'root-user' : undefined),
      );

      await sut.copyFaces(copyInput);

      expect(mocks.partnerOrigin.createPersonCopy).toHaveBeenCalledWith(
        expect.objectContaining({ rootOwnerId: 'root-user', sourceOwnerId: A }),
        undefined,
      );
    });

    it('reuses the mapping for later copies without searching again', async () => {
      links = [
        {
          ownerId: B,
          sourcePersonGroupId: PG_A,
          personGroupId: PG_B,
          kind: 'merged',
          partnerSharedById: A,
          correctionId: 'c',
        },
      ];

      await sut.copyFaces(copyInput);

      expect(mocks.search.searchFaces).not.toHaveBeenCalled();
      expect(mocks.person.recordFaceCorrections).not.toHaveBeenCalled();
      expect(mocks.person.copyFacesToAsset).toHaveBeenCalledWith(TARGET_ASSET, [
        expect.objectContaining({ personGroupId: PG_B }),
        expect.objectContaining({ personGroupId: null }),
      ]);
    });

    it('uses the same person when both accounts share the recognition group and the recipient has it', async () => {
      mocks.person.getGroupClusterId.mockResolvedValue(CLUSTER_B);
      people.set(`${B}/${PG_A}`, person(B, PG_A, { name: 'Emma' }));

      await sut.copyFaces(copyInput);

      expect(mocks.search.searchFaces).not.toHaveBeenCalled();
      expect(mocks.partnerOrigin.createPersonCopy).not.toHaveBeenCalled();
      expect(links[0]).toMatchObject({ personGroupId: PG_A, kind: 'merged', correctionId: null });
    });

    it('creates a person without searching when the face has no embedding', async () => {
      mocks.person.getFacesForPartnerCopy.mockResolvedValue([{ id: FACE_1, personGroupId: PG_A, hasEmbedding: false }]);

      await sut.copyFaces(copyInput);

      expect(mocks.search.searchFaces).not.toHaveBeenCalled();
      expect(links[0]).toMatchObject({ kind: 'created' });
    });

    it('copies nothing when the source has no faces', async () => {
      mocks.person.getFacesForPartnerCopy.mockResolvedValue([]);
      await expect(sut.copyFaces(copyInput)).resolves.toBe(0);
      expect(mocks.person.copyFacesToAsset).not.toHaveBeenCalled();
    });
  });

  describe('undoPartnerMerge', () => {
    const mergedFaceIds = [newUuid(), newUuid()];
    const entry = {
      id: 'correction-1',
      ownerId: B,
      actorId: B,
      action: 'partner-merge',
      faceId: null,
      assetId: null,
      toPersonId: PG_B,
      fromPersonId: null,
      fromPersonName: 'Emma',
      toPersonName: 'Emma R.',
      undoneAt: null,
    } as unknown as FaceCorrection;

    beforeEach(() => {
      people.set(`${B}/${PG_B}`, person(B, PG_B, { name: 'Emma R.' }));
      mocks.person.getPartnerPersonLinkByCorrection.mockResolvedValue({
        ownerId: B,
        sourcePersonGroupId: PG_A,
        personGroupId: PG_B,
        kind: 'merged',
        partnerSharedById: A,
        correctionId: 'correction-1',
      });
      mocks.person.getPartnerMergedFaceIds.mockResolvedValue(mergedFaceIds);
    });

    it("moves the merged faces to a new person of the partner's person, with an origin", async () => {
      const createCopy = mocks.partnerOrigin.createPersonCopy.getMockImplementation()!;
      mocks.partnerOrigin.createPersonCopy.mockImplementation((value, undo) => {
        expect(mocks.person.selectionForThumbnails).not.toHaveBeenCalled();
        thumbnailSelection.execute.mockResolvedValue([
          { data: { ownerId: B, personGroupId: NEW_PG, selectionFaceId: mergedFaceIds[0] } },
        ]);
        return createCopy(value, undo);
      });

      await sut.undoPartnerMerge(authStub.user1, entry);

      expect(mocks.person.getPartnerMergedFaceIds).toHaveBeenCalledWith(B, PG_A, PG_B);
      expect(mocks.partnerOrigin.createPersonCopy).toHaveBeenCalledWith(
        expect.objectContaining({ ownerId: B, sourcePersonGroupId: PG_A, name: 'Emma' }),
        { correctionId: 'correction-1', personGroupId: PG_B, faceIds: mergedFaceIds },
      );
      expect(links[0]).toMatchObject({ personGroupId: NEW_PG, kind: 'created', correctionId: null });
      expect(mocks.person.selectionForThumbnails).toHaveBeenCalledWith(false, B);
      expect(mocks.job.queueAll).toHaveBeenCalledWith([
        {
          name: JobName.PersonGenerateThumbnail,
          data: { ownerId: B, personGroupId: NEW_PG, selectionFaceId: mergedFaceIds[0] },
        },
      ]);
    });

    it('does not enqueue a portrait when the undone faces are not eligible', async () => {
      await sut.undoPartnerMerge(authStub.user1, entry);

      expect(mocks.job.queue).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });

    it('refuses an undo that was already done', async () => {
      await expect(sut.undoPartnerMerge(authStub.user1, { ...entry, undoneAt: new Date() })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mocks.partnerOrigin.createPersonCopy).not.toHaveBeenCalled();
    });

    it('refuses when the mapping is gone', async () => {
      mocks.person.getPartnerPersonLinkByCorrection.mockResolvedValue(undefined);
      await expect(sut.undoPartnerMerge(authStub.user1, entry)).rejects.toBeInstanceOf(ConflictException);
    });

    it('reports a lost race as already undone', async () => {
      mocks.partnerOrigin.createPersonCopy.mockResolvedValue({ conflict: 'already-undone' });
      await expect(sut.undoPartnerMerge(authStub.user1, entry)).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.person.selectionForThumbnails).not.toHaveBeenCalled();
      expect(mocks.job.queueAll).not.toHaveBeenCalled();
    });
  });

  describe('propagatePerson', () => {
    it("follows the source's name and birth date into copies that left them alone", async () => {
      people.set(`${A}/${PG_A}`, person(A, PG_A, { name: 'Emma Rose', birthDate: '2015-04-01', isFavorite: true }));
      people.set(`${B}/${NEW_PG}`, person(B, NEW_PG, { name: 'Emma' }));
      mocks.partnerOrigin.getPersonFollowers.mockImplementation((ownerId) =>
        Promise.resolve(
          ownerId === A
            ? ([
                { ownerId: B, personGroupId: NEW_PG, overriddenFields: [] },
                { ownerId: 'c', personGroupId: 'pg-c', overriddenFields: ['name'] },
              ] as never)
            : ([] as never),
        ),
      );

      await sut.propagatePerson(A, PG_A);

      expect(mocks.person.update).toHaveBeenCalledWith({
        ownerId: B,
        personGroupId: NEW_PG,
        name: 'Emma Rose',
        birthDate: '2015-04-01',
        isHidden: false,
      });
      // C renamed their copy: only the birth date and hidden state follow
      expect(mocks.person.update).toHaveBeenCalledWith({
        ownerId: 'c',
        personGroupId: 'pg-c',
        birthDate: '2015-04-01',
        isHidden: false,
      });
      // onward to the followers of each copy (A to B to C)
      expect(mocks.partnerOrigin.getPersonFollowers).toHaveBeenCalledWith(B, NEW_PG);
    });

    it('stops at a loop', async () => {
      mocks.partnerOrigin.getPersonFollowers.mockImplementation((ownerId) =>
        Promise.resolve([
          ownerId === A
            ? { ownerId: B, personGroupId: PG_B, overriddenFields: [] }
            : { ownerId: A, personGroupId: PG_A, overriddenFields: [] },
        ] as never),
      );
      people.set(`${B}/${PG_B}`, person(B, PG_B));

      await sut.propagatePerson(A, PG_A);

      expect(mocks.partnerOrigin.getPersonFollowers).toHaveBeenCalledTimes(2);
    });
  });

  describe('noteEdit', () => {
    it('marks the edited followed fields as changed by the owner', async () => {
      await sut.noteEdit(B, PG_B, { name: 'Em', featureFaceAssetId: newUuid(), isFavorite: true });
      expect(mocks.partnerOrigin.markPersonOverridden).toHaveBeenCalledWith(B, [PG_B], ['name', 'cover', 'favorite']);
    });

    it('does nothing for an edit of nothing tracked', async () => {
      await sut.noteEdit(B, PG_B, {});
      expect(mocks.partnerOrigin.markPersonOverridden).not.toHaveBeenCalled();
    });
  });
});
