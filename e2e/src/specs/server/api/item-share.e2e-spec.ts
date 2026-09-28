import { AssetMediaResponseDto, AssetVisibility, LoginResponseDto, updateConfig } from '@immich/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

/**
 * FL-83 (AL-30b, owner decision 2026-09-27): sharing individual items with a person in this
 * library. The e2e server has no Frameleaf Cloud link, so the direct-connection address and the
 * custom CNAME are covered by `server/src/utils/public-url.spec.ts`; here the link comes from the
 * Public server URL or is absent, and a forged Host header never becomes one.
 */
describe('/item-shares', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let jamie: LoginResponseDto;
  let sam: LoginResponseDto;
  let first: AssetMediaResponseDto;
  let second: AssetMediaResponseDto;

  const auth = (user: LoginResponseDto) => `Bearer ${user.accessToken}`;
  const setPublicUrl = async (externalDomain: string) => {
    const config = await utils.getSystemConfig(admin.accessToken);
    config.server.externalDomain = externalDomain;
    await updateConfig({ adminConfigDto: config }, { headers: asBearerAuth(admin.accessToken) });
  };

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    [owner, jamie, sam] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
      utils.userSetup(admin.accessToken, createUserDto.user3),
    ]);
    [first, second] = await Promise.all([utils.createAsset(owner.accessToken), utils.createAsset(owner.accessToken)]);
  });

  afterEach(async () => {
    await setPublicUrl('');
  });

  it('shares items with a person, who then sees exactly those items and nothing else', async () => {
    const shared = await request(app)
      .post('/item-shares')
      .set('Authorization', auth(owner))
      .send({ assetIds: [first.id], userIds: [jamie.userId] });
    expect(shared.status).toBe(201);
    expect(shared.body).toMatchObject({ added: 1, removed: 0, link: null });
    expect(shared.body.shares).toEqual([
      expect.objectContaining({ assetId: first.id, sharedWith: expect.objectContaining({ id: jamie.userId }) }),
    ]);

    const received = await request(app).get('/item-shares/received').set('Authorization', auth(jamie));
    expect(received.status).toBe(200);
    expect(received.body.items).toEqual([
      expect.objectContaining({
        owner: expect.objectContaining({ id: owner.userId }),
        asset: expect.objectContaining({ id: first.id }),
      }),
    ]);

    // the recipient can open the shared item, its thumbnail and its original
    const asset = await request(app).get(`/assets/${first.id}`).set('Authorization', auth(jamie));
    expect(asset.status).toBe(200);
    const thumbnail = await request(app).get(`/assets/${first.id}/thumbnail`).set('Authorization', auth(jamie));
    expect(thumbnail.status).not.toBe(400);

    // …but not the owner's other items, and nobody else sees the shared one
    const other = await request(app).get(`/assets/${second.id}`).set('Authorization', auth(jamie));
    expect(other.status).toBe(400);
    const stranger = await request(app).get(`/assets/${first.id}`).set('Authorization', auth(sam));
    expect(stranger.status).toBe(400);
    const nothing = await request(app).get('/item-shares/received').set('Authorization', auth(sam));
    expect(nothing.body.items).toEqual([]);

    // the recipient gets the usual in-app notification
    const notifications = await request(app).get('/notifications').set('Authorization', auth(jamie));
    expect(notifications.body).toEqual(
      expect.arrayContaining([expect.objectContaining({ type: 'ItemShare', title: 'Shared with you' })]),
    );
  });

  it('lists who an item is shared with, for its owner only', async () => {
    const mine = await request(app)
      .put('/item-shares/query')
      .set('Authorization', auth(owner))
      .send({ assetIds: [first.id] });
    expect(mine.status).toBe(200);
    expect(mine.body.map(({ sharedWith }: { sharedWith: { id: string } }) => sharedWith.id)).toEqual([jamie.userId]);

    const theirs = await request(app)
      .put('/item-shares/query')
      .set('Authorization', auth(jamie))
      .send({ assetIds: [first.id] });
    expect(theirs.status).toBe(400);
  });

  it('refuses sharing someone else’s item, even one shared with you', async () => {
    const { status } = await request(app)
      .post('/item-shares')
      .set('Authorization', auth(jamie))
      .send({ assetIds: [first.id], userIds: [sam.userId] });
    expect(status).toBe(400);
  });

  it('revokes a share, and the recipient loses access at once', async () => {
    const extra = await utils.createAsset(owner.accessToken);
    await request(app)
      .post('/item-shares')
      .set('Authorization', auth(owner))
      .send({ assetIds: [extra.id], userIds: [sam.userId] });
    const before = await request(app).get(`/assets/${extra.id}`).set('Authorization', auth(sam));
    expect(before.status).toBe(200);

    const revoked = await request(app)
      .delete('/item-shares')
      .set('Authorization', auth(owner))
      .send({ assetIds: [extra.id], userIds: [sam.userId] });
    expect(revoked.status).toBe(200);
    expect(revoked.body).toMatchObject({ removed: 1, shares: [] });

    const after = await request(app).get(`/assets/${extra.id}`).set('Authorization', auth(sam));
    expect(after.status).toBe(400);
    const received = await request(app).get('/item-shares/received').set('Authorization', auth(sam));
    expect(received.body.items).toEqual([]);
  });

  it('never shares a locked item, and hides a shared item once it is locked', async () => {
    const locked = await utils.createAsset(owner.accessToken);
    await request(app)
      .put(`/assets/${locked.id}`)
      .set('Authorization', auth(owner))
      .send({ visibility: AssetVisibility.Locked });
    const refused = await request(app)
      .post('/item-shares')
      .set('Authorization', auth(owner))
      .send({ assetIds: [locked.id], userIds: [jamie.userId] });
    expect(refused.status).toBe(400);

    const later = await utils.createAsset(owner.accessToken);
    await request(app)
      .post('/item-shares')
      .set('Authorization', auth(owner))
      .send({ assetIds: [later.id], userIds: [jamie.userId] });
    const visible = await request(app).get(`/assets/${later.id}`).set('Authorization', auth(jamie));
    expect(visible.status).toBe(200);

    await request(app)
      .put(`/assets/${later.id}`)
      .set('Authorization', auth(owner))
      .send({ visibility: AssetVisibility.Locked });

    const hidden = await request(app).get(`/assets/${later.id}`).set('Authorization', auth(jamie));
    expect(hidden.status).toBe(400);
    const received = await request(app).get('/item-shares/received').set('Authorization', auth(jamie));
    const ids = received.body.items.map(({ asset }: { asset: { id: string } }) => asset.id);
    expect(ids).not.toContain(later.id);
    expect(ids).not.toContain(locked.id);
  });

  it('builds the link from the Public server URL, never from a forged Host header', async () => {
    const forged = await request(app)
      .get('/item-shares/received')
      .set('Authorization', auth(jamie))
      .set('Host', 'attacker.example');
    expect(forged.body.link).toBeNull();

    await setPublicUrl('https://photos.family.example');
    const shared = await request(app)
      .post('/item-shares')
      .set('Authorization', auth(owner))
      .set('Host', 'attacker.example')
      .send({ assetIds: [second.id], userIds: [jamie.userId] });
    expect(shared.body.link).toBe('https://photos.family.example/sharing?section=shared-with-you');

    const notifications = await request(app).get('/notifications').set('Authorization', auth(jamie));
    const latest = notifications.body.find(
      ({ type, data }: { type: string; data?: string }) => type === 'ItemShare' && data?.includes('photos.family'),
    );
    expect(JSON.parse(latest.data)).toMatchObject({
      ownerId: owner.userId,
      count: 1,
      link: 'https://photos.family.example/sharing?section=shared-with-you',
    });
  });
});
