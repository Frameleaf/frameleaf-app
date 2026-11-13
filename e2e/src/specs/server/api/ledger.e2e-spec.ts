import { LoginResponseDto } from '@frameleaf/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const get = (path: string, token: string) => request(app).get(path).set('Authorization', `Bearer ${token}`);
const summary = async (token: string) => {
  const { status, body } = await get('/users/me/ledger/summary', token);
  expect(status).toBe(200);
  return body as { total: number; states: Record<string, number> };
};
const items = async (token: string, state?: string) => {
  const { status, body } = await get(`/users/me/ledger${state ? `?state=${state}` : ''}`, token);
  expect(status).toBe(200);
  return (body as { items: Array<Record<string, unknown>> }).items;
};

// FL-921: the nothing-lost ledger follows an original from its upload to its removal, per account.
describe('/users/me/ledger', { timeout: process.env.CI ? 120_000 : 30_000 }, () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);
  });

  it('requires authentication', async () => {
    const { status } = await request(app).get('/users/me/ledger/summary');
    expect(status).toBe(401);
  });

  it('refuses a state it does not know', async () => {
    const { status } = await get('/users/me/ledger?state=lost', user.accessToken);
    expect(status).toBe(400);
  });

  it('follows an upload into the Trash and back, then a permanent deletion, with who did it', async () => {
    const { id } = await utils.createAsset(user.accessToken);
    await utils.waitForAllQueuesFinish(admin.accessToken);

    expect(await summary(user.accessToken)).toMatchObject({ total: 1, states: { kept: 1, trashed: 0, removed: 0 } });
    expect(await items(user.accessToken)).toEqual([
      expect.objectContaining({ assetId: id, addedVia: 'upload', state: 'kept', stateBy: user.userId, reason: null }),
    ]);

    await utils.deleteAssets(user.accessToken, [id]);
    expect(await items(user.accessToken, 'trashed')).toEqual([
      expect.objectContaining({ assetId: id, state: 'trashed', stateBy: user.userId }),
    ]);

    const restore = await request(app)
      .post('/trash/restore/assets')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ ids: [id] });
    expect(restore.status).toBe(200);
    expect(await summary(user.accessToken)).toMatchObject({ total: 1, states: { kept: 1, trashed: 0 } });

    const remove = await request(app)
      .delete('/assets')
      .set('Authorization', `Bearer ${user.accessToken}`)
      .send({ ids: [id], force: true });
    expect(remove.status).toBe(204);
    expect(await items(user.accessToken, 'removed')).toEqual([
      expect.objectContaining({ assetId: id, state: 'removed', stateBy: user.userId, reason: 'deleted' }),
    ]);
    // the row outlives the photo
    await utils.waitForAllQueuesFinish(admin.accessToken);
    expect(await summary(user.accessToken)).toMatchObject({ total: 1, states: { kept: 0, removed: 1, missing: 0 } });

    // each account reads its own ledger only
    expect(await summary(admin.accessToken)).toMatchObject({ total: 0 });
    expect(await items(admin.accessToken)).toEqual([]);
  });

  describe('GET /admin/ledger/summary', () => {
    it('is for administrators', async () => {
      const { status } = await get('/admin/ledger/summary', user.accessToken);
      expect(status).toBe(403);
    });

    it('totals every account and names no file', async () => {
      const { status, body } = await get('/admin/ledger/summary', admin.accessToken);
      expect(status).toBe(200);
      expect(body).toEqual({
        total: expect.any(Number),
        states: {
          kept: expect.any(Number),
          trashed: expect.any(Number),
          removed: expect.any(Number),
          merged: expect.any(Number),
          missing: expect.any(Number),
        },
        missingByOwner: expect.any(Array),
      });
      expect(body.total).toBeGreaterThanOrEqual(1);
    });
  });
});
