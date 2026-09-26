import { LoginResponseDto, PersonResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * FL-57: the correction history of a person (`GET /people/:id/corrections`) and undo
 * (`POST /people/corrections/:id/undo`). Moving a face records the decision; the history is
 * owner-only and paged; undo puts the face back once and refuses a second time with a reason.
 */
describe('/people corrections', () => {
  let admin: LoginResponseDto;
  let other: LoginResponseDto;
  let ada: PersonResponseDto;
  let blair: PersonResponseDto;
  let assetId: string;
  let faceId: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    other = await utils.userSetup(admin.accessToken, createUserDto.user1);
    [ada, blair] = await Promise.all([
      utils.createPerson(admin.accessToken, { name: 'Ada' }),
      utils.createPerson(admin.accessToken, { name: 'Blair' }),
    ]);
    const asset = await utils.createAsset(admin.accessToken);
    assetId = asset.id;
    await utils.createFace({ assetId, personGroupId: ada.id });
    const { body: faces } = await request(app).get(`/faces?id=${assetId}`).set(asBearerAuth(admin.accessToken));
    faceId = faces[0].id;
  });

  it('records a moved face in both people’s history', async () => {
    const { status } = await request(app)
      .put(`/faces/${blair.id}`)
      .set(asBearerAuth(admin.accessToken))
      .send({ id: faceId });
    expect(status).toBe(200);

    for (const person of [ada, blair]) {
      const { status, body } = await request(app)
        .get(`/people/${person.id}/corrections`)
        .set(asBearerAuth(admin.accessToken));
      expect(status).toBe(200);
      expect(body.hasNextPage).toBe(false);
      // Blair had no faces yet, so the move is recorded as naming a new person
      expect(body.corrections).toEqual([
        expect.objectContaining({
          action: 'new-person',
          fromPerson: expect.objectContaining({ id: ada.id, name: 'Ada' }),
          toPerson: expect.objectContaining({ id: blair.id, name: 'Blair' }),
          evidenceRevoked: false,
          undoable: true,
          undoneAt: null,
        }),
      ]);
    }
  });

  it('keeps the history owner-only', async () => {
    // another account's person answers 404, like every single-person route (FL-37)
    const { status } = await request(app).get(`/people/${blair.id}/corrections`).set(asBearerAuth(other.accessToken));
    expect(status).toBe(404);
  });

  it('refuses a page size over 100', async () => {
    const { status } = await request(app)
      .get(`/people/${blair.id}/corrections?size=101`)
      .set(asBearerAuth(admin.accessToken));
    expect(status).toBe(400);
  });

  it('undoes a move once, then refuses with a reason', async () => {
    const {
      body: { corrections },
    } = await request(app).get(`/people/${blair.id}/corrections`).set(asBearerAuth(admin.accessToken));
    const id = corrections[0].id;

    const undone = await request(app).post(`/people/corrections/${id}/undo`).set(asBearerAuth(admin.accessToken));
    expect(undone.status).toBe(200);
    expect(undone.body).toEqual(expect.objectContaining({ id, undoable: false, undoneAt: expect.any(String) }));

    const { body: faces } = await request(app).get(`/faces?id=${assetId}`).set(asBearerAuth(admin.accessToken));
    expect(faces[0].person.id).toBe(ada.id);

    const again = await request(app).post(`/people/corrections/${id}/undo`).set(asBearerAuth(admin.accessToken));
    expect(again.status).toBe(409);
    expect(again.body).toEqual(expect.objectContaining({ reason: 'already-undone' }));
  });

  it("does not undo another user's decision", async () => {
    const {
      body: { corrections },
    } = await request(app).get(`/people/${blair.id}/corrections`).set(asBearerAuth(admin.accessToken));
    const { status } = await request(app)
      .post(`/people/corrections/${corrections[0].id}/undo`)
      .set(asBearerAuth(other.accessToken));
    expect(status).toBe(404);
  });
});
