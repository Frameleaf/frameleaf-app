import { ConflictException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { AssetEditAction } from 'src/dtos/editing.dto.js';
import { SourceType } from 'src/enum.js';
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
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  return newMediumService(PersonService, {
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
    mock: [JobRepository, LoggingRepository, StorageRepository, MachineLearningRepository, MlDestinationRepository],
  });
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

/**
 * FL-38: the face correction contract against Postgres — `updateId` as the face revision, the
 * conditional update that refuses a stale correction, restorable hiding, and boxes on a cropped
 * and rotated image that round-trip through the stored original coordinates.
 */
describe(`${PersonService.name} face corrections (FL-38)`, () => {
  const newOwnedFace = async () => {
    const { sut, ctx } = setup();
    ctx.getMock(JobRepository).queueAll.mockResolvedValue();
    ctx.getMock(JobRepository).queue.mockResolvedValue();
    const { user } = await ctx.newUser();
    const { person } = await ctx.newPerson({ ownerId: user.id, name: 'Emma' });
    const { person: other } = await ctx.newPerson({ ownerId: user.id, name: 'Jamie' });
    const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 400, height: 300 });
    await ctx.newExif({ assetId: asset.id, exifImageWidth: 400, exifImageHeight: 300 });
    const { assetFace } = await ctx.newAssetFace({
      assetId: asset.id,
      personGroupId: person.personGroupId,
      imageWidth: 400,
      imageHeight: 300,
      boundingBoxX1: 10,
      boundingBoxY1: 20,
      boundingBoxX2: 110,
      boundingBoxY2: 120,
    });
    const auth = factory.auth({ user });
    const [face] = await sut.getFacesById(auth, { id: asset.id });
    return { sut, ctx, auth, user, person, other, asset, face, faceId: assetFace.id };
  };

  it('renews the revision on every correction and refuses a correction made against an older one', async () => {
    const { sut, auth, asset, other, face, person } = await newOwnedFace();
    expect(face.revision).toEqual(expect.any(String));
    expect(face.sourceType).toBe(SourceType.MachineLearning);
    expect(face.correctedAt).toBeNull();

    const reassigned = await sut.correctFace(auth, face.id, {
      expectedRevision: face.revision!,
      expectedPersonId: person.personGroupId,
      personId: other.personGroupId,
    });
    expect(reassigned.person?.id).toBe(other.personGroupId);
    expect(reassigned.revision).not.toBe(face.revision);
    expect(reassigned.correctedAt).toEqual(expect.any(String));

    // a second editor still holding the first revision cannot overwrite the reassignment
    await expect(
      sut.correctFace(auth, face.id, { expectedRevision: face.revision!, personId: null }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(sut.getFacesById(auth, { id: asset.id })).resolves.toEqual([
      expect.objectContaining({
        id: face.id,
        revision: reassigned.revision,
        person: expect.objectContaining({ id: other.personGroupId }),
      }),
    ]);
  });

  it('unassigns, hides, lists hidden and shows a face again', async () => {
    const { sut, auth, asset, face } = await newOwnedFace();

    const unassigned = await sut.correctFace(auth, face.id, { expectedRevision: face.revision!, personId: null });
    expect(unassigned.person).toBeNull();

    const hidden = await sut.correctFace(auth, face.id, { expectedRevision: unassigned.revision!, hidden: true });
    expect(hidden.hiddenAt).toEqual(expect.any(String));
    await expect(sut.getFacesById(auth, { id: asset.id })).resolves.toHaveLength(0);
    await expect(sut.getFacesById(auth, { id: asset.id, withHidden: true })).resolves.toEqual([
      expect.objectContaining({ id: face.id, hiddenAt: expect.any(String) }),
    ]);

    const shown = await sut.correctFace(auth, face.id, { expectedRevision: hidden.revision!, hidden: false });
    expect(shown.hiddenAt).toBeNull();
    await expect(sut.getFacesById(auth, { id: asset.id })).resolves.toEqual([
      expect.objectContaining({ id: face.id, person: null }),
    ]);
  });

  it('removes a face only at the revision the caller saw', async () => {
    const { sut, auth, asset, face, other } = await newOwnedFace();
    const moved = await sut.correctFace(auth, face.id, {
      expectedRevision: face.revision!,
      personId: other.personGroupId,
    });

    await expect(
      sut.deleteFace(auth, face.id, { force: true, expectedRevision: face.revision! }),
    ).rejects.toBeInstanceOf(ConflictException);
    await expect(sut.getFacesById(auth, { id: asset.id })).resolves.toHaveLength(1);

    await sut.deleteFace(auth, face.id, { force: true, expectedRevision: moved.revision! });
    await expect(sut.getFacesById(auth, { id: asset.id, withHidden: true })).resolves.toHaveLength(0);
  });

  it('keeps boxes on a cropped, rotated image round-tripping, and refuses boxes drawn before an edit', async () => {
    const { sut, ctx } = setup();
    ctx.getMock(JobRepository).queueAll.mockResolvedValue();
    ctx.getMock(JobRepository).queue.mockResolvedValue();
    const { user } = await ctx.newUser();
    const { person } = await ctx.newPerson({ ownerId: user.id });
    // a 4000x3000 original shown cropped to 2000x1500 and turned a quarter: 1500x2000
    const { asset } = await ctx.newAsset({ id: factory.uuid(), ownerId: user.id, width: 1500, height: 2000 });
    await ctx.newExif({ assetId: asset.id, exifImageWidth: 4000, exifImageHeight: 3000 });
    const auth = factory.auth({ user });
    const before = await sut.getFaceSource(auth, { id: asset.id });

    await ctx.newEdits(asset.id, {
      edits: [
        { action: AssetEditAction.Crop, parameters: { x: 1000, y: 500, width: 2000, height: 1500 } },
        { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
      ],
    });
    const source = await sut.getFaceSource(auth, { id: asset.id });
    expect(source.revision).not.toBe(before.revision);

    const drawn = { imageWidth: 750, imageHeight: 1000, x: 100, y: 200, width: 50, height: 100 };
    await expect(
      sut.createFace(auth, {
        assetId: asset.id,
        personId: person.personGroupId,
        expectedSourceRevision: before.revision,
        ...drawn,
      }),
    ).rejects.toBeInstanceOf(ConflictException);

    const created = await sut.createFace(auth, {
      assetId: asset.id,
      personId: person.personGroupId,
      expectedSourceRevision: source.revision,
      ...drawn,
    });
    expect(created).toEqual(
      expect.objectContaining({
        sourceType: SourceType.Manual,
        imageWidth: 1500,
        imageHeight: 2000,
        boundingBoxX1: 200,
        boundingBoxY1: 400,
        boundingBoxX2: 300,
        boundingBoxY2: 600,
      }),
    );

    // move it on the displayed image; the listed box is where it was placed
    const moved = await sut.correctFace(auth, created.id, {
      expectedRevision: created.revision!,
      expectedSourceRevision: source.revision,
      box: { imageWidth: 750, imageHeight: 1000, x: 300, y: 100, width: 100, height: 100 },
    });
    expect(moved).toEqual(
      expect.objectContaining({ boundingBoxX1: 600, boundingBoxY1: 200, boundingBoxX2: 800, boundingBoxY2: 400 }),
    );
    await expect(sut.getFacesById(auth, { id: asset.id })).resolves.toEqual([
      expect.objectContaining({ id: created.id, boundingBoxX1: 600, boundingBoxY1: 200 }),
    ]);

    // without the edits the same face sits in the original image's pixels
    await ctx.newEdits(asset.id, { edits: [] });
    const [original] = await sut.getFacesById(auth, { id: asset.id });
    expect(original).toEqual(expect.objectContaining({ imageWidth: 4000, imageHeight: 3000 }));
    expect(original.boundingBoxX1).toBeGreaterThanOrEqual(1000);
    expect(original.boundingBoxY2).toBeLessThanOrEqual(2000);
  });
});
