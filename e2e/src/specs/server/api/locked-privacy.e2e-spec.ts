import { LoginResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const bearer = (token: string) => ({ Authorization: `Bearer ${token}` });

const total = async (token: string) => {
  const { status, body } = await request(app).post('/search/statistics').set(bearer(token)).send({});
  expect(status).toBe(200);
  return body.total as number;
};
const facetTotal = async (token: string) => {
  const { status, body } = await request(app)
    .post('/search/facets')
    .set(bearer(token))
    .send({ facets: ['type'] });
  expect(status).toBe(200);
  return body.total as number;
};

/**
 * FL-34 over the API: a marked item leaves the counts, facets and files of a locked session; the
 * Locked view needs the PIN; another account, administrator included, never reads it or learns its
 * count.
 */
describe('Locked content over the API (FL-34)', () => {
  const pin = { pinCode: '123456' };
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let marked: { id: string };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    owner = await utils.userSetup(admin.accessToken, createUserDto.user1);
    await utils.createAsset(owner.accessToken);
    marked = await utils.createAsset(owner.accessToken);
    const { status } = await request(app).post('/auth/pin-code').set(bearer(owner.accessToken)).send(pin);
    expect(status).toBe(204);
  });

  it('drops a marked item from counts, facets and thumbnails once the session locks', async () => {
    expect(await total(owner.accessToken)).toBe(2);

    await request(app).post('/auth/session/unlock').set(bearer(owner.accessToken)).send(pin).expect(204);
    const mark = await request(app)
      .put(`/assets/${marked.id}/image-enrichment`)
      .set(bearer(owner.accessToken))
      .send({ action: 'mark-nsfw' });
    expect(mark.status).toBe(200);

    // once the session locks, the marked item is gone from every count and facet, and its files
    await request(app).post('/auth/session/lock').set(bearer(owner.accessToken)).expect(204);
    expect(await total(owner.accessToken)).toBe(1);
    expect(await facetTotal(owner.accessToken)).toBe(1);
    const { status } = await request(app).get(`/assets/${marked.id}/thumbnail`).set(bearer(owner.accessToken));
    expect([400, 403, 404]).toContain(status);
  });

  it('refuses the Locked view without the PIN', async () => {
    const { status } = await request(app)
      .get('/timeline/buckets')
      .query({ visibility: 'locked' })
      .set(bearer(owner.accessToken));
    expect(status).toBe(401);
  });

  it('never gives another account, administrator included, the item or its count', async () => {
    const { status: adminPin } = await request(app).post('/auth/pin-code').set(bearer(admin.accessToken)).send(pin);
    expect(adminPin).toBe(204);
    await request(app).post('/auth/session/unlock').set(bearer(admin.accessToken)).send(pin).expect(204);

    for (const path of [`/assets/${marked.id}`, `/assets/${marked.id}/original`, `/assets/${marked.id}/thumbnail`]) {
      const { status } = await request(app).get(path).set(bearer(admin.accessToken));
      expect([400, 403, 404]).toContain(status);
    }
    // the administrator's own library has nothing; the owner's items never reach its counts or facets
    expect(await total(admin.accessToken)).toBe(0);
    expect(await facetTotal(admin.accessToken)).toBe(0);
    const { body: people } = await request(app).get('/people').set(bearer(admin.accessToken));
    expect(people.people).toEqual([]);
  });
});
