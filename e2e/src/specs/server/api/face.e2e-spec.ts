import {
  AssetEditAction,
  AssetFaceResponseDto,
  AssetMediaResponseDto,
  LoginResponseDto,
  PersonResponseDto,
  SourceType,
} from '@immich/sdk';
import { PNG } from 'pngjs';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/** A 400x300 image with a gradient, so edits and previews have real geometry to work on. */
const makeImage = (width = 400, height = 300) => {
  const image = new PNG({ width, height });
  for (let y = 0; y < height; y++) {
    for (let x = 0; x < width; x++) {
      const index = (width * y + x) << 2;
      image.data[index] = x % 256;
      image.data[index + 1] = y % 256;
      image.data[index + 2] = (x + y) % 256;
      image.data[index + 3] = 255;
    }
  }
  return PNG.sync.write(image);
};

const listFaces = async (token: string, assetId: string, withHidden = false) => {
  const { status, body } = await request(app)
    .get('/faces')
    .query({ id: assetId, ...(withHidden && { withHidden: true }) })
    .set('Authorization', `Bearer ${token}`);
  return { status, body: body as AssetFaceResponseDto[] };
};

const correct = (token: string, id: string, dto: Record<string, unknown>) =>
  request(app).patch(`/faces/${id}`).set('Authorization', `Bearer ${token}`).send(dto);

/**
 * FL-38: the face correction contract. Faces carry a revision; corrections (reassign, unassign,
 * move, hide/show) and removals made against an older revision are refused with 409, and boxes
 * drawn on an image that was edited since are refused too. Boxes drawn on a cropped and rotated
 * image round-trip through the original image's pixels, for recognized and manual faces alike.
 */
describe('/faces (FL-38 corrections)', () => {
  let admin: LoginResponseDto;
  let stranger: LoginResponseDto;
  let asset: AssetMediaResponseDto;
  let emma: PersonResponseDto;
  let jamie: PersonResponseDto;
  let detectedId: string;

  const detected = async () => {
    const { body } = await listFaces(admin.accessToken, asset.id, true);
    return body.find((face) => face.id === detectedId)!;
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    stranger = await utils.userSetup(admin.accessToken, {
      email: 'face-stranger@immich.cloud',
      name: 'Stranger',
      password: 'password',
    });

    asset = await utils.createAsset(admin.accessToken, {
      assetData: { bytes: makeImage(), filename: 'faces.png' },
    });
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
    await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');

    [emma, jamie] = await Promise.all([
      utils.createPerson(admin.accessToken, { name: 'Emma' }),
      utils.createPerson(admin.accessToken, { name: 'Jamie' }),
    ]);
    detectedId = (await utils.createDetectedFace({
      assetId: asset.id,
      personGroupId: emma.id,
      imageWidth: 400,
      imageHeight: 300,
      box: { x1: 40, y1: 30, x2: 120, y2: 110 },
    }))!;
  });

  it('lists a recognized face with its revision and provenance', async () => {
    const { status, body } = await listFaces(admin.accessToken, asset.id);
    expect(status).toBe(200);
    expect(body).toEqual([
      expect.objectContaining({
        id: detectedId,
        sourceType: SourceType.MachineLearning,
        revision: expect.any(String),
        correctedAt: null,
        hiddenAt: null,
        person: expect.objectContaining({ id: emma.id }),
      }),
    ]);
  });

  it('reassigns with the current revision and refuses a second editor holding the old one', async () => {
    const before = await detected();
    const moved = await correct(admin.accessToken, detectedId, {
      expectedRevision: before.revision,
      expectedPersonId: emma.id,
      personId: jamie.id,
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toEqual(
      expect.objectContaining({ person: expect.objectContaining({ id: jamie.id }), correctedAt: expect.any(String) }),
    );
    expect(moved.body.revision).not.toBe(before.revision);

    const stale = await correct(admin.accessToken, detectedId, { expectedRevision: before.revision, personId: null });
    expect(stale.status).toBe(409);
    const current = await detected();
    expect(current.person?.id).toBe(jamie.id);

    const wrongPerson = await correct(admin.accessToken, detectedId, {
      expectedRevision: moved.body.revision,
      expectedPersonId: emma.id,
      personId: null,
    });
    expect(wrongPerson.status).toBe(409);
  });

  it('unassigns a recognized face', async () => {
    const before = await detected();
    const { status, body } = await correct(admin.accessToken, detectedId, {
      expectedRevision: before.revision,
      personId: null,
    });
    expect(status).toBe(200);
    expect(body.person).toBeNull();
    expect(body.sourceType).toBe(SourceType.MachineLearning);
  });

  it('hides a face restorably, and only its owner lists or changes hidden faces', async () => {
    const before = await detected();
    const hidden = await correct(admin.accessToken, detectedId, { expectedRevision: before.revision, hidden: true });
    expect(hidden.status).toBe(200);
    expect(hidden.body.hiddenAt).toEqual(expect.any(String));

    const visible = await listFaces(admin.accessToken, asset.id);
    expect(visible.body.map((face) => face.id)).not.toContain(detectedId);
    const withHidden = await listFaces(admin.accessToken, asset.id, true);
    expect(withHidden.body.map((face) => face.id)).toContain(detectedId);
    const strangerList = await listFaces(stranger.accessToken, asset.id, true);
    expect(strangerList.status).toBe(400);
    const strangerShow = await correct(stranger.accessToken, detectedId, {
      expectedRevision: hidden.body.revision,
      hidden: false,
    });
    expect(strangerShow.status).toBe(400);

    const shown = await correct(admin.accessToken, detectedId, {
      expectedRevision: hidden.body.revision,
      hidden: false,
    });
    expect(shown.status).toBe(200);
    expect(shown.body.hiddenAt).toBeNull();
  });

  it('refuses to remove a face that changed since it was read', async () => {
    const face = await detected();
    const { status } = await request(app)
      .delete(`/faces/${detectedId}`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ force: false, expectedRevision: 'an-older-revision' });
    expect(status).toBe(409);
    const after = await detected();
    expect(after.revision).toBe(face.revision);
  });

  it('round-trips manual and corrected boxes through a crop and a rotation, and refuses boxes drawn before an edit', async () => {
    const { body: before } = await request(app)
      .get('/faces/source')
      .query({ id: asset.id })
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(before.revision).toEqual(expect.any(String));
    const strangerSource = await request(app)
      .get('/faces/source')
      .query({ id: asset.id })
      .set(asBearerAuth(stranger.accessToken));
    expect(strangerSource.status).toBe(400);

    // crop to 200x150 at (100, 50), then turn a quarter: the edited image is 150x200
    const edit = await request(app)
      .put(`/assets/${asset.id}/edits`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({
        edits: [
          { action: AssetEditAction.Crop, parameters: { x: 100, y: 50, width: 200, height: 150 } },
          { action: AssetEditAction.Rotate, parameters: { angle: 90 } },
        ],
      });
    expect(edit.status).toBe(200);
    // a saved edit renders on the editor queue, which also records the edited image's size
    await utils.waitForQueueFinish(admin.accessToken, 'editor');
    await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');

    const { body: source } = await request(app)
      .get('/faces/source')
      .query({ id: asset.id })
      .set('Authorization', `Bearer ${admin.accessToken}`);
    expect(source.revision).not.toBe(before.revision);

    const drawn = {
      assetId: asset.id,
      personId: emma.id,
      imageWidth: 150,
      imageHeight: 200,
      x: 20,
      y: 40,
      width: 30,
      height: 40,
    };
    const stale = await request(app)
      .post('/faces')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ ...drawn, expectedSourceRevision: before.revision });
    expect(stale.status).toBe(409);

    const created = await request(app)
      .post('/faces')
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ ...drawn, expectedSourceRevision: source.revision });
    expect(created.status).toBe(201);
    expect(created.body).toEqual(
      expect.objectContaining({
        sourceType: SourceType.Manual,
        imageWidth: 150,
        imageHeight: 200,
        boundingBoxX1: 20,
        boundingBoxY1: 40,
        boundingBoxX2: 50,
        boundingBoxY2: 80,
      }),
    );

    // move the recognized face on the edited image
    const face = await detected();
    const moved = await correct(admin.accessToken, detectedId, {
      expectedRevision: face.revision,
      expectedSourceRevision: source.revision,
      box: { imageWidth: 150, imageHeight: 200, x: 60, y: 100, width: 40, height: 40 },
    });
    expect(moved.status).toBe(200);
    expect(moved.body).toEqual(
      expect.objectContaining({ boundingBoxX1: 60, boundingBoxY1: 100, boundingBoxX2: 100, boundingBoxY2: 140 }),
    );

    const { body: mixed } = await listFaces(admin.accessToken, asset.id);
    expect(mixed.map((row) => row.sourceType).toSorted((a, b) => String(a).localeCompare(String(b)))).toEqual([
      SourceType.MachineLearning,
      SourceType.Manual,
    ]);

    // back to the original: both faces sit inside the crop rectangle, in 400x300 pixels
    await request(app)
      .put(`/assets/${asset.id}/edits`)
      .set('Authorization', `Bearer ${admin.accessToken}`)
      .send({ edits: [] });
    const { body: original } = await listFaces(admin.accessToken, asset.id);
    for (const row of original) {
      expect(row).toEqual(expect.objectContaining({ imageWidth: 400, imageHeight: 300 }));
      expect(row.boundingBoxX1).toBeGreaterThanOrEqual(100);
      expect(row.boundingBoxX2).toBeLessThanOrEqual(300);
      expect(row.boundingBoxY1).toBeGreaterThanOrEqual(50);
      expect(row.boundingBoxY2).toBeLessThanOrEqual(200);
    }
  });
});
