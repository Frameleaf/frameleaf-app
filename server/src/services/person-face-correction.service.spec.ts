import { BadRequestException, ConflictException, NotFoundException } from '@nestjs/common';
import { AssetEditAction, AssetEditActionItem, MirrorAxis } from 'src/dtos/editing.dto.js';
import { mapFaces } from 'src/dtos/person.dto.js';
import { JobName, JobStatus, SourceType } from 'src/enum.js';
import { PersonService } from 'src/services/person.service.js';
import { getFaceSourceRevision } from 'src/utils/face-source.js';
import { AssetFaceFactory } from 'test/factories/asset-face.factory.js';
import { AssetFactory } from 'test/factories/asset.factory.js';
import { AuthFactory } from 'test/factories/auth.factory.js';
import { PersonFactory } from 'test/factories/person.factory.js';
import { getForAsset, getForAssetFace, getForFacialRecognitionJob } from 'test/mappers.js';
import { newDate } from 'test/small.factory.js';
import { ServiceMocks, newTestService } from 'test/utils.js';

/**
 * FL-38: revision-checked face corrections (reassign, unassign, move/resize, hide/show), the face
 * source revision, and the geometry of boxes drawn on an edited (cropped, rotated, mirrored)
 * preview. Kept apart from person.service.spec.ts so the correction contract reads on its own.
 */
describe(`${PersonService.name} face corrections (FL-38)`, () => {
  let sut: PersonService;
  let mocks: ServiceMocks;

  beforeEach(() => {
    ({ sut, mocks } = newTestService(PersonService));
  });

  /** A 4000x3000 original, cropped to 2000x1500 at (1000, 500) and turned a quarter: 1500x2000 shown. */
  const editedAsset = () => {
    const asset = AssetFactory.create({ width: 1500, height: 2000 });
    const edits: AssetEditActionItem[] = [
      { action: AssetEditAction.Crop, parameters: { x: 1000, y: 500, width: 2000, height: 1500 } },
      { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
    ];
    const exifInfo = { exifImageWidth: 4000, exifImageHeight: 3000, orientation: null };
    return {
      asset,
      edits,
      exifInfo,
      row: { ...getForAsset(asset), edits, exifInfo: { ...getForAsset(asset).exifInfo, ...exifInfo } } as never,
    };
  };

  const allowFace = (id: string) => mocks.access.person.checkFaceOwnerAccess.mockResolvedValue(new Set([id]));
  const allowAsset = (id: string) => mocks.access.asset.checkOwnerAccess.mockResolvedValue(new Set([id]));
  const allowPerson = (id: string) => mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([id]));

  describe('getFaceSourceRevision', () => {
    it('changes with the pixels a box is drawn on, not with other metadata', () => {
      const base = { checksum: Buffer.from('abc'), width: 400, height: 300, edits: [], exifInfo: null };
      const revision = getFaceSourceRevision(base);
      expect(getFaceSourceRevision({ ...base })).toBe(revision);
      expect(getFaceSourceRevision({ ...base, checksum: Buffer.from('abd') })).not.toBe(revision);
      expect(getFaceSourceRevision({ ...base, width: 300, height: 400 })).not.toBe(revision);
      expect(
        getFaceSourceRevision({ ...base, edits: [{ action: AssetEditAction.Rotate, parameters: { angle: 180 } }] }),
      ).not.toBe(revision);
      expect(
        getFaceSourceRevision({
          ...base,
          exifInfo: { exifImageWidth: 400, exifImageHeight: 300, orientation: '6' },
        }),
      ).not.toBe(revision);
    });
  });

  describe('getFaceSource', () => {
    it('returns the source revision to the asset owner only', async () => {
      const auth = AuthFactory.create();
      const { asset, row } = editedAsset();
      mocks.asset.getById.mockResolvedValue(row);

      await expect(sut.getFaceSource(auth, { id: asset.id })).rejects.toBeInstanceOf(BadRequestException);

      allowAsset(asset.id);
      await expect(sut.getFaceSource(auth, { id: asset.id })).resolves.toEqual({
        assetId: asset.id,
        revision: getFaceSourceRevision(row),
      });
    });
  });

  describe('getFacesById withHidden', () => {
    it('lists hidden faces for the owner and refuses them to anyone else', async () => {
      const auth = AuthFactory.create();
      const hidden = AssetFaceFactory.create({ deletedAt: newDate() });
      mocks.person.getFaces.mockResolvedValue([getForAssetFace(hidden)]);
      mocks.asset.getForFaces.mockResolvedValue({
        edits: [],
        exifImageHeight: 500,
        exifImageWidth: 400,
        orientation: null,
      });

      // a partner can read the asset but does not own it
      mocks.access.asset.checkPartnerAccess.mockResolvedValue(new Set([hidden.assetId]));
      await expect(sut.getFacesById(auth, { id: hidden.assetId, withHidden: true })).rejects.toBeInstanceOf(
        BadRequestException,
      );

      allowAsset(hidden.assetId);
      const [face] = await sut.getFacesById(auth, { id: hidden.assetId, withHidden: true });
      expect(face.hiddenAt).toBe(hidden.deletedAt!.toISOString());
      expect(face.revision).toBe(hidden.updateId);
      expect(mocks.person.getFaces).toHaveBeenLastCalledWith(hidden.assetId, {
        viewingUserId: auth.user.id,
        isVisible: true,
        withHidden: true,
      });
    });
  });

  describe('createFace', () => {
    it('stores a box drawn on a cropped, rotated preview in original pixels, and it round-trips', async () => {
      const auth = AuthFactory.create();
      const { asset, row, edits } = editedAsset();
      const person = PersonFactory.create({ faceAssetId: 'feature' });
      allowAsset(asset.id);
      allowPerson(person.personGroupId);
      mocks.asset.getById.mockResolvedValue(row);
      mocks.person.getByGroupId.mockResolvedValue(person);

      // drawn on a half-size (750x1000) preview of the 1500x2000 edited image
      const drawn = { imageWidth: 750, imageHeight: 1000, x: 100, y: 200, width: 50, height: 100 };
      mocks.person.createAssetFace.mockImplementation((face) => {
        mocks.person.getFaceForCorrection.mockResolvedValue(
          getForAssetFace(AssetFaceFactory.create({ ...(face as object), sourceType: SourceType.Manual })),
        );
        return Promise.resolve();
      });
      mocks.asset.getForFaces.mockResolvedValue({
        edits,
        exifImageWidth: 4000,
        exifImageHeight: 3000,
        orientation: null,
      });

      const created = await sut.createFace(auth, {
        assetId: asset.id,
        personId: person.personGroupId,
        expectedSourceRevision: getFaceSourceRevision(row),
        ...drawn,
      });

      expect(mocks.person.createAssetFace).toHaveBeenCalledWith({
        id: 'random-uuid',
        assetId: asset.id,
        personGroupId: person.personGroupId,
        imageWidth: 4000,
        imageHeight: 3000,
        boundingBoxX1: 1400,
        boundingBoxY1: 1700,
        boundingBoxX2: 1600,
        boundingBoxY2: 1800,
        sourceType: SourceType.Manual,
      });
      // the response is in the edited image's space: the drawn box, at full size
      expect(created).toEqual(
        expect.objectContaining({
          imageWidth: 1500,
          imageHeight: 2000,
          boundingBoxX1: 200,
          boundingBoxY1: 400,
          boundingBoxX2: 300,
          boundingBoxY2: 600,
          sourceType: SourceType.Manual,
        }),
      );
    });

    it('refuses a box drawn on an image that changed since (409) and stores nothing', async () => {
      const auth = AuthFactory.create();
      const { asset, row } = editedAsset();
      const person = PersonFactory.create();
      allowAsset(asset.id);
      allowPerson(person.personGroupId);
      mocks.asset.getById.mockResolvedValue(row);
      mocks.person.getByGroupId.mockResolvedValue(person);

      await expect(
        sut.createFace(auth, {
          assetId: asset.id,
          personId: person.personGroupId,
          expectedSourceRevision: 'drawn-before-the-crop',
          imageWidth: 750,
          imageHeight: 1000,
          x: 1,
          y: 1,
          width: 10,
          height: 10,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.person.createAssetFace).not.toHaveBeenCalled();
    });
  });

  describe('correctFace', () => {
    const setup = (faceOverrides = {}) => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ faceAssetId: 'another-face' });
      const face = AssetFaceFactory.from({ ...faceOverrides })
        .person({ personGroupId: person.personGroupId, ownerId: auth.user.id })
        .build();
      allowFace(face.id);
      mocks.person.getFaceForCorrection.mockResolvedValue(getForAssetFace(face));
      mocks.person.correctFace.mockResolvedValue(1);
      mocks.asset.getForFaces.mockResolvedValue({
        edits: [],
        exifImageHeight: 500,
        exifImageWidth: 400,
        orientation: null,
      });
      return { auth, face, person };
    };

    it('requires face access', async () => {
      const { auth, face } = setup();
      mocks.access.person.checkFaceOwnerAccess.mockResolvedValue(new Set());
      await expect(
        sut.correctFace(auth, face.id, { expectedRevision: face.updateId, personId: null }),
      ).rejects.toBeInstanceOf(BadRequestException);
      expect(mocks.person.correctFace).not.toHaveBeenCalled();
    });

    it('answers 404 for a face that no longer exists', async () => {
      const { auth, face } = setup();
      mocks.person.getFaceForCorrection.mockResolvedValue(undefined);
      await expect(
        sut.correctFace(auth, face.id, { expectedRevision: face.updateId, personId: null }),
      ).rejects.toBeInstanceOf(NotFoundException);
    });

    it('refuses a stale revision or a changed person without writing', async () => {
      const { auth, face } = setup();
      await expect(
        sut.correctFace(auth, face.id, { expectedRevision: 'older', personId: null }),
      ).rejects.toBeInstanceOf(ConflictException);
      await expect(
        sut.correctFace(auth, face.id, {
          expectedRevision: face.updateId,
          expectedPersonId: null,
          personId: null,
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.person.correctFace).not.toHaveBeenCalled();
    });

    it('refuses when another editor wins the race between read and write', async () => {
      const { auth, face } = setup();
      mocks.person.correctFace.mockResolvedValue(0);
      await expect(
        sut.correctFace(auth, face.id, { expectedRevision: face.updateId, personId: null }),
      ).rejects.toBeInstanceOf(ConflictException);
    });

    it('unassigns a detected face as a correction', async () => {
      const { auth, face, person } = setup();
      const result = await sut.correctFace(auth, face.id, {
        expectedRevision: face.updateId,
        expectedPersonId: person.personGroupId,
        personId: null,
      });
      expect(mocks.person.correctFace).toHaveBeenCalledWith(face.id, face.updateId, {
        personGroupId: null,
        box: undefined,
        hidden: undefined,
      });
      expect(result).toEqual(mapFaces(getForAssetFace(face), auth, [], { width: 400, height: 500 }));
    });

    it('reassigns to another person the owner can update', async () => {
      const { auth, face } = setup();
      const target = PersonFactory.create({ faceAssetId: null });
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set([target.personGroupId]));
      mocks.person.getByGroupId.mockResolvedValue(target);
      mocks.person.getRandomFace.mockResolvedValue(face);

      await sut.correctFace(auth, face.id, { expectedRevision: face.updateId, personId: target.personGroupId });

      expect(mocks.person.correctFace).toHaveBeenCalledWith(face.id, face.updateId, {
        personGroupId: target.personGroupId,
        box: undefined,
        hidden: undefined,
      });
      // the target had no featured face yet
      expect(mocks.person.getRandomFace).toHaveBeenCalledWith(target.personGroupId);
    });

    it('refuses reassignment to a person the caller cannot update', async () => {
      const { auth, face } = setup();
      const target = PersonFactory.create();
      mocks.access.person.checkOwnerAccess.mockResolvedValue(new Set());
      await expect(
        sut.correctFace(auth, face.id, { expectedRevision: face.updateId, personId: target.personGroupId }),
      ).rejects.toBeInstanceOf(NotFoundException);
      expect(mocks.person.correctFace).not.toHaveBeenCalled();
    });

    it('moves a detected face on a mirrored image back into original pixels', async () => {
      const { auth, face } = setup();
      const asset = AssetFactory.create({ width: 4000, height: 3000 });
      const edits: AssetEditActionItem[] = [
        { action: AssetEditAction.Mirror, parameters: { axis: MirrorAxis.Horizontal } },
      ];
      const row = {
        ...getForAsset(asset),
        edits,
        exifInfo: { exifImageWidth: 4000, exifImageHeight: 3000, orientation: null },
      } as never;
      mocks.asset.getById.mockResolvedValue(row);

      await sut.correctFace(auth, face.id, {
        expectedRevision: face.updateId,
        expectedSourceRevision: getFaceSourceRevision(row),
        box: { imageWidth: 1000, imageHeight: 750, x: 100, y: 100, width: 50, height: 50 },
      });

      expect(mocks.person.correctFace).toHaveBeenCalledWith(face.id, face.updateId, {
        personGroupId: undefined,
        box: {
          imageWidth: 4000,
          imageHeight: 3000,
          boundingBoxX1: 3400,
          boundingBoxY1: 400,
          boundingBoxX2: 3600,
          boundingBoxY2: 600,
        },
        hidden: undefined,
      });
    });

    it('keeps a box on an unedited image in the drawn image size', async () => {
      const { auth, face } = setup();
      const asset = AssetFactory.create({ width: 400, height: 500 });
      mocks.asset.getById.mockResolvedValue({ ...getForAsset(asset), edits: [] } as never);

      await sut.correctFace(auth, face.id, {
        expectedRevision: face.updateId,
        box: { imageWidth: 400, imageHeight: 500, x: 10, y: 20, width: 30, height: 40 },
      });

      expect(mocks.person.correctFace).toHaveBeenCalledWith(face.id, face.updateId, {
        personGroupId: undefined,
        box: {
          imageWidth: 400,
          imageHeight: 500,
          boundingBoxX1: 10,
          boundingBoxY1: 20,
          boundingBoxX2: 40,
          boundingBoxY2: 60,
        },
        hidden: undefined,
      });
    });

    it('refuses a move drawn on an image that changed since', async () => {
      const { auth, face } = setup();
      const { row } = editedAsset();
      mocks.asset.getById.mockResolvedValue(row);
      await expect(
        sut.correctFace(auth, face.id, {
          expectedRevision: face.updateId,
          expectedSourceRevision: 'before-the-edit',
          box: { imageWidth: 750, imageHeight: 1000, x: 1, y: 1, width: 10, height: 10 },
        }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.person.correctFace).not.toHaveBeenCalled();
    });

    it('redraws the person photo when the featured face moves, and picks another when it is hidden', async () => {
      const auth = AuthFactory.create();
      const face = AssetFaceFactory.create();
      const person = PersonFactory.create({ faceAssetId: face.id, personGroupId: face.personGroupId ?? undefined });
      const withFeature = { ...getForAssetFace(face), personGroupId: person.personGroupId, person: person as never };
      allowFace(face.id);
      mocks.person.getFaceForCorrection.mockResolvedValue(withFeature);
      mocks.person.correctFace.mockResolvedValue(1);
      mocks.asset.getForFaces.mockResolvedValue({
        edits: [],
        exifImageHeight: 500,
        exifImageWidth: 400,
        orientation: null,
      });
      mocks.asset.getById.mockResolvedValue({ ...getForAsset(AssetFactory.create()), edits: [] } as never);

      await sut.correctFace(auth, face.id, {
        expectedRevision: face.updateId,
        box: { imageWidth: 400, imageHeight: 500, x: 10, y: 20, width: 30, height: 40 },
      });
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.PersonGenerateThumbnail,
        data: { ownerId: person.ownerId, personGroupId: person.personGroupId },
      });

      mocks.person.getRandomFace.mockResolvedValue(AssetFaceFactory.create());
      await sut.correctFace(auth, face.id, { expectedRevision: face.updateId, hidden: true });
      expect(mocks.person.correctFace).toHaveBeenLastCalledWith(face.id, face.updateId, {
        personGroupId: undefined,
        box: undefined,
        hidden: true,
      });
      expect(mocks.person.getRandomFace).toHaveBeenCalledWith(person.personGroupId);
    });

    it('shows a hidden face again', async () => {
      const { auth, face } = setup({ deletedAt: newDate() });
      await sut.correctFace(auth, face.id, { expectedRevision: face.updateId, hidden: false });
      expect(mocks.person.correctFace).toHaveBeenCalledWith(face.id, face.updateId, {
        personGroupId: undefined,
        box: undefined,
        hidden: false,
      });
    });
  });

  describe('deleteFace with expectedRevision', () => {
    it('removes a face only at the revision the caller saw', async () => {
      const auth = AuthFactory.create();
      const face = AssetFaceFactory.create();
      allowFace(face.id);
      mocks.person.getFaceById.mockResolvedValue({ ...face, person: null } as never);

      mocks.person.deleteFaceAtRevision.mockResolvedValue(0);
      await expect(sut.deleteFace(auth, face.id, { force: true, expectedRevision: 'older' })).rejects.toBeInstanceOf(
        ConflictException,
      );

      mocks.person.deleteFaceAtRevision.mockResolvedValue(1);
      await expect(
        sut.deleteFace(auth, face.id, { force: true, expectedRevision: face.updateId }),
      ).resolves.toBeUndefined();
      expect(mocks.person.deleteFaceAtRevision).toHaveBeenLastCalledWith(face.id, face.updateId, { force: true });
      expect(mocks.person.deleteAssetFace).not.toHaveBeenCalled();
    });
  });

  // FL-57: the FL-38 correction paths write the owner's correction history and refresh generated text
  describe('correction history of revision-checked corrections', () => {
    const setup = () => {
      const auth = AuthFactory.create();
      const person = PersonFactory.create({ faceAssetId: 'another-face', name: 'Ada' });
      const face = AssetFaceFactory.from()
        .person({ personGroupId: person.personGroupId, ownerId: auth.user.id, name: 'Ada' })
        .build();
      allowFace(face.id);
      mocks.person.getFaceForCorrection.mockResolvedValue(getForAssetFace(face));
      mocks.person.correctFace.mockResolvedValue(1);
      mocks.asset.getForFaces.mockResolvedValue({
        edits: [],
        exifImageHeight: 500,
        exifImageWidth: 400,
        orientation: null,
      });
      return { auth, face, person };
    };
    const from = (face: { id: string; personGroupId: string | null }) => ({
      faceId: face.id,
      fromPersonId: face.personGroupId,
      fromPersonName: 'Ada',
    });

    it('records a move to another person and queues the identity refresh', async () => {
      const { auth, face } = setup();
      const target = PersonFactory.create({ faceAssetId: 'x', name: 'Blair' });
      allowPerson(target.personGroupId);
      mocks.person.getByGroupId.mockResolvedValue(target);
      mocks.person.hasFaces.mockResolvedValue(true);

      await sut.correctFace(auth, face.id, { expectedRevision: face.updateId, personId: target.personGroupId });

      expect(mocks.person.recordFaceCorrections).toHaveBeenCalledWith([
        expect.objectContaining({
          ...from(face),
          action: 'reassign',
          toPersonId: target.personGroupId,
          toPersonName: 'Blair',
        }),
      ]);
      expect(mocks.job.queue).toHaveBeenCalledWith({
        name: JobName.PersonIdentityRefresh,
        data: { ownerId: auth.user.id, assetIds: [face.assetId] },
      });
    });

    it('records a move to a person with no faces yet as someone new', async () => {
      const { auth, face } = setup();
      const target = PersonFactory.create({ faceAssetId: 'x', name: 'Cy' });
      allowPerson(target.personGroupId);
      mocks.person.getByGroupId.mockResolvedValue(target);
      mocks.person.hasFaces.mockResolvedValue(false);

      await sut.correctFace(auth, face.id, { expectedRevision: face.updateId, personId: target.personGroupId });

      expect(mocks.person.recordFaceCorrections).toHaveBeenCalledWith([
        expect.objectContaining({ action: 'new-person', toPersonId: target.personGroupId }),
      ]);
    });

    it('records a take-off, a hide and a moved box', async () => {
      const { auth, face } = setup();

      await sut.correctFace(auth, face.id, { expectedRevision: face.updateId, personId: null });
      expect(mocks.person.recordFaceCorrections).toHaveBeenLastCalledWith([
        expect.objectContaining({ ...from(face), action: 'unassign' }),
      ]);

      await sut.correctFace(auth, face.id, { expectedRevision: face.updateId, hidden: true });
      expect(mocks.person.recordFaceCorrections).toHaveBeenLastCalledWith([
        expect.objectContaining({ ...from(face), action: 'remove' }),
      ]);

      mocks.asset.getById.mockResolvedValue(getForAsset(AssetFactory.create({ width: 400, height: 500 })));
      await sut.correctFace(auth, face.id, {
        expectedRevision: face.updateId,
        box: { imageWidth: 400, imageHeight: 500, x: 10, y: 10, width: 50, height: 50 },
      });
      expect(mocks.person.recordFaceCorrections).toHaveBeenLastCalledWith([
        expect.objectContaining({
          ...from(face),
          action: 'box-move',
          toPersonId: face.personGroupId,
          toPersonName: 'Ada',
        }),
      ]);
    });

    it('records nothing when the correction is refused', async () => {
      const { auth, face } = setup();
      mocks.person.correctFace.mockResolvedValue(0);
      await expect(
        sut.correctFace(auth, face.id, { expectedRevision: face.updateId, personId: null }),
      ).rejects.toBeInstanceOf(ConflictException);
      expect(mocks.person.recordFaceCorrections).not.toHaveBeenCalled();
    });

    it('records a removal at a revision, and withdraws it when the removal is refused', async () => {
      const auth = AuthFactory.create();
      const face = AssetFaceFactory.create();
      allowFace(face.id);
      mocks.person.getFaceById.mockResolvedValue({ ...face, person: null } as never);
      mocks.person.recordFaceCorrections.mockResolvedValue([{ id: 'correction-1' }] as never);

      mocks.person.deleteFaceAtRevision.mockResolvedValue(0);
      await expect(sut.deleteFace(auth, face.id, { force: true, expectedRevision: 'older' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      expect(mocks.person.deleteFaceCorrection).toHaveBeenCalledWith('correction-1');

      await expect(sut.deleteFace(auth, face.id, { force: false, expectedRevision: 'older' })).rejects.toBeInstanceOf(
        ConflictException,
      );
      // a refused soft removal records nothing (the force attempt above recorded once)
      expect(mocks.person.recordFaceCorrections).toHaveBeenCalledTimes(1);

      mocks.person.deleteFaceAtRevision.mockResolvedValue(1);
      await sut.deleteFace(auth, face.id, { force: false, expectedRevision: face.updateId });
      expect(mocks.person.recordFaceCorrections).toHaveBeenLastCalledWith([
        expect.objectContaining({ action: 'remove', faceId: face.id, fromPersonId: face.personGroupId }),
      ]);
    });
  });

  describe('handleRecognizeFaces', () => {
    it('leaves a face its owner corrected (for example unassigned) alone', async () => {
      const asset = AssetFactory.create();
      const face = AssetFaceFactory.create({ assetId: asset.id, correctedAt: newDate() });
      mocks.systemMetadata.get.mockResolvedValue({ machineLearning: { enabled: true } } as never);
      mocks.person.getFaceForFacialRecognitionJob.mockResolvedValue(getForFacialRecognitionJob(face, asset));

      await expect(sut.handleRecognizeFaces({ id: face.id })).resolves.toBe(JobStatus.Skipped);
      expect(mocks.search.searchFaces).not.toHaveBeenCalled();
      expect(mocks.person.reassignFaces).not.toHaveBeenCalled();
    });
  });
});
