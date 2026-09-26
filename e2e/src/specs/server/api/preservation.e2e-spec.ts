import { LoginResponseDto } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

/**
 * Preservation packages (FL-74, `IMP-006`) against the running server: an export is only ever of the
 * requester's own items, whatever ids the request names; a repeated submit answers with the first
 * package; another account's package reads as missing on every route; and Locked items join only
 * from an unlocked session.
 */
describe('/preservation', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let other: LoginResponseDto;
  let mine: { id: string };
  let theirs: { id: string };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    [owner, other] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
    ]);
    [mine, theirs] = await Promise.all([utils.createAsset(owner.accessToken), utils.createAsset(other.accessToken)]);
  });

  it('counts only the requester’s own items in a selection naming someone else’s', async () => {
    const { status, body } = await request(app)
      .post('/preservation/preview')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ scope: { assetIds: [mine.id, theirs.id] } });

    expect(status).toBe(200);
    expect(body).toMatchObject({ items: 1, includedItems: 1, lockedItems: 0, lockedAllowed: false });
  });

  it('freezes only the requester’s own items, answers a repeated submit with the first package, and hides it from others', async () => {
    const create = () =>
      request(app)
        .post('/preservation/packages')
        .set('Authorization', `Bearer ${owner.accessToken}`)
        .send({ name: 'Mine only', scope: { assetIds: [mine.id, theirs.id] }, requestKey: 'fl-74-e2e-owner' });

    const first = await create();
    expect(first.status).toBe(201);
    const repeated = await create();
    expect(repeated.status).toBe(201);
    expect(repeated.body.id).toBe(first.body.id);

    const items = await request(app)
      .get(`/preservation/packages/${first.body.id}/items`)
      .set('Authorization', `Bearer ${owner.accessToken}`);
    expect(items.status).toBe(200);
    expect(items.body.total).toBe(1);
    expect(items.body.items.map((item: { sourceAssetId: string }) => item.sourceAssetId)).toEqual([mine.id]);

    for (const path of ['', '/items', '/manifest', '/download']) {
      const { status } = await request(app)
        .get(`/preservation/packages/${first.body.id}${path}`)
        .set('Authorization', `Bearer ${other.accessToken}`);
      expect(status).toBe(404);
    }
    for (const path of ['/verify', '/retry']) {
      const { status } = await request(app)
        .post(`/preservation/packages/${first.body.id}${path}`)
        .set('Authorization', `Bearer ${other.accessToken}`);
      expect(status).toBe(404);
    }
    const restore = await request(app)
      .post('/preservation/restores')
      .set('Authorization', `Bearer ${other.accessToken}`)
      .send({ packageId: first.body.id });
    expect(restore.status).toBe(404);

    const listed = await request(app).get('/preservation/packages').set('Authorization', `Bearer ${other.accessToken}`);
    expect(listed.body).toEqual([]);
  });

  it('refuses Locked items from a session that has not unlocked', async () => {
    const { status } = await request(app)
      .post('/preservation/packages')
      .set('Authorization', `Bearer ${owner.accessToken}`)
      .send({ name: 'With Locked', scope: { assetIds: [mine.id] }, includeLocked: true });

    expect(status).toBe(403);
  });
});
