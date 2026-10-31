import {
  AssetMediaResponseDto,
  AssetVisibility,
  LoginResponseDto,
  RemoteAccessMode,
  RemoteHostnameStatus,
  updateConfig,
} from '@frameleaf/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { afterEach, beforeAll, describe, expect, it } from 'vitest';

const candidate = (uri: string, custom = false) => ({
  kind: 'wan',
  uri,
  protocol: 'https',
  address: new URL(uri).hostname,
  port: Number(new URL(uri).port || 443),
  local: false,
  relay: custom,
  ipv6: false,
  custom,
  dnsRebindingProtection: false,
  httpsRequired: true,
  verified: true,
});

/**
 * FL-83 (AL-30b, owner decision 2026-09-27): sharing individual items with a person in this
 * library. The link comes from the Public server URL, or a linked server's published direct and
 * verified custom addresses; a forged Host header never becomes one.
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

  it(
    'applies the owner’s Locked tag rule to existing shares and new recipients',
    { timeout: process.env.CI ? 150_000 : 50_000 },
    async ({ signal }) => {
      const privateAsset = await utils.createAsset(owner.accessToken, undefined, { signal });
      await utils.waitForAssetReady(admin.accessToken, privateAsset.id, {
        headers: asBearerAuth(owner.accessToken),
        signal,
      });
      await request(app)
        .post('/item-shares')
        .set('Authorization', auth(owner))
        .send({ assetIds: [privateAsset.id], userIds: [jamie.userId] })
        .expect(201);

      const [tag] = await utils.upsertTags(owner.accessToken, ['FL-198 Private']);
      await utils.tagAssets(owner.accessToken, tag.id, [privateAsset.id]);
      const paths = [
        `/assets/${privateAsset.id}`,
        `/assets/${privateAsset.id}/thumbnail`,
        `/assets/${privateAsset.id}/original`,
      ];
      for (const path of paths) {
        await request(app).get(path).set('Authorization', auth(jamie)).expect(200);
      }
      const receivedBefore = await request(app)
        .get('/item-shares/received')
        .set('Authorization', auth(jamie))
        .expect(200);
      expect(receivedBefore.body.items.map(({ asset }: { asset: { id: string } }) => asset.id)).toContain(
        privateAsset.id,
      );

      await request(app)
        .post('/auth/pin-code')
        .set('Authorization', auth(owner))
        .send({ pinCode: '246810' })
        .expect(204);
      await request(app)
        .post('/auth/session/unlock')
        .set('Authorization', auth(owner))
        .send({ pinCode: '246810' })
        .expect(204);
      await request(app)
        .put('/users/me/preferences')
        .set('Authorization', auth(owner))
        .send({ privacy: { suppression: { tagIds: [tag.id] } } })
        .expect(200);

      for (const path of paths) {
        const { status } = await request(app).get(path).set('Authorization', auth(jamie));
        expect([400, 403, 404]).toContain(status);
      }
      const received = await request(app).get('/item-shares/received').set('Authorization', auth(jamie)).expect(200);
      expect(received.body.items.map(({ asset }: { asset: { id: string } }) => asset.id)).not.toContain(
        privateAsset.id,
      );
      await request(app)
        .post('/item-shares')
        .set('Authorization', auth(owner))
        .send({ assetIds: [privateAsset.id], userIds: [sam.userId] })
        .expect(400);
      await request(app).get(`/assets/${privateAsset.id}`).set('Authorization', auth(sam)).expect(400);
    },
  );

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

  it('uses a published direct address or verified custom CNAME in API links and notifications', async () => {
    const cloudUrl = 'https://cloud.frameleaf.test';
    const direct = 'https://1-2-3-4.lbl.direct.frameleaf.test:2443';
    const customHost = 'photos.family.example';
    const path = '/sharing?section=shared-with-you';
    const config = await utils.getSystemConfig(admin.accessToken);
    const savedRemote = config.frameleafCloud?.remoteAccess;
    if (!savedRemote) {
      throw new Error('Frameleaf Cloud remote access config is missing');
    }
    const client = await utils.connectDatabase();
    const savedConfig = await client.query('SELECT value FROM system_metadata WHERE key = $1', ['system-config']);
    const putMetadata = (key: string, value: unknown) =>
      client.query(
        `INSERT INTO system_metadata (key, value) VALUES ($1, $2::jsonb)
         ON CONFLICT (key) DO UPDATE SET value = EXCLUDED.value`,
        [key, JSON.stringify(value)],
      );
    const setRemote = async (remote: typeof savedRemote) => {
      await client.query(
        `INSERT INTO system_metadata (key, value) VALUES ('system-config', jsonb_build_object('frameleafCloud', jsonb_build_object('remoteAccess', $1::jsonb)))
         ON CONFLICT (key) DO UPDATE SET value = system_metadata.value || jsonb_build_object(
           'frameleafCloud', coalesce(system_metadata.value -> 'frameleafCloud', '{}'::jsonb) || jsonb_build_object('remoteAccess', $1::jsonb)
         )`,
        [JSON.stringify(remote)],
      );
      await utils.getSystemConfig(admin.accessToken); // refresh the server's cached config
    };
    const published = [candidate(direct), candidate(`https://${customHost}`, true)];
    const state = {
      status: 'ready',
      bootId: 'item-share-e2e',
      updatedAt: new Date().toISOString(),
      names: { instanceId: 'instance-1', names: { relay: 'r.lbl.frameleaf.test' } },
      relay: { connected: true },
      candidates: published,
    };
    const link = {
      status: 'linked',
      cloudUrl,
      instanceId: 'instance-1',
      services: { publicUrl: 'https://r.lbl.frameleaf.test' },
    };

    try {
      await putMetadata('frameleaf-cloud-link', link);
      await setRemote({ ...savedRemote, enabled: true, mode: RemoteAccessMode.RelayAndDirect });
      await putMetadata('frameleaf-remote-access', state);

      const directAsset = await utils.createAsset(owner.accessToken);
      const directShare = await request(app)
        .post('/item-shares')
        .set('Authorization', auth(owner))
        .set('Host', 'attacker.example')
        .send({ assetIds: [directAsset.id], userIds: [sam.userId] })
        .expect(201);
      expect(directShare.body.link).toBe(`${direct}${path}`);
      const directNotifications = await request(app).get('/notifications').set('Authorization', auth(sam)).expect(200);
      expect(directNotifications.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: JSON.stringify({ ownerId: owner.userId, count: 1, link: `${direct}${path}` }),
          }),
        ]),
      );
      const unverified = await request(app)
        .get('/item-shares/received')
        .set('Authorization', auth(sam))
        .set('Host', customHost)
        .expect(200);
      expect(unverified.body.link).toBe(`${direct}${path}`);

      await setRemote({
        ...savedRemote,
        enabled: true,
        mode: RemoteAccessMode.RelayAndDirect,
        customHostname: {
          host: customHost,
          status: RemoteHostnameStatus.Verified,
          checkedAt: new Date().toISOString(),
        },
      });
      state.updatedAt = new Date().toISOString();
      await putMetadata('frameleaf-remote-access', state);

      const customAsset = await utils.createAsset(owner.accessToken);
      const customShare = await request(app)
        .post('/item-shares')
        .set('Authorization', auth(owner))
        .set('Host', customHost)
        .send({ assetIds: [customAsset.id], userIds: [sam.userId] })
        .expect(201);
      expect(customShare.body.link).toBe(`https://${customHost}${path}`);
      const received = await request(app)
        .get('/item-shares/received')
        .set('Authorization', auth(sam))
        .set('Host', customHost)
        .expect(200);
      expect(received.body.link).toBe(`https://${customHost}${path}`);
      const customNotifications = await request(app).get('/notifications').set('Authorization', auth(sam)).expect(200);
      expect(customNotifications.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: JSON.stringify({ ownerId: owner.userId, count: 1, link: `https://${customHost}${path}` }),
          }),
        ]),
      );

      state.updatedAt = new Date().toISOString();
      state.relay.connected = false;
      await putMetadata('frameleaf-remote-access', state);
      const disconnected = await request(app)
        .get('/item-shares/received')
        .set('Authorization', auth(sam))
        .set('Host', customHost)
        .expect(200);
      expect(disconnected.body.link).toBe(`${direct}${path}`);

      const ipv6 = 'https://2001-db8--1.lbl.frameleaf.test:2443';
      state.candidates = [{ ...candidate(ipv6), kind: 'ipv6', ipv6: true, verified: false }];
      state.updatedAt = new Date().toISOString();
      await putMetadata('frameleaf-remote-access', state);
      const ipv6Asset = await utils.createAsset(owner.accessToken);
      const ipv6Share = await request(app)
        .post('/item-shares')
        .set('Authorization', auth(owner))
        .set('Host', 'attacker.example')
        .send({ assetIds: [ipv6Asset.id], userIds: [sam.userId] })
        .expect(201);
      expect(ipv6Share.body.link).toBe(`${ipv6}${path}`);
      const ipv6Notifications = await request(app).get('/notifications').set('Authorization', auth(sam)).expect(200);
      expect(ipv6Notifications.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({
            data: JSON.stringify({ ownerId: owner.userId, count: 1, link: `${ipv6}${path}` }),
          }),
        ]),
      );

      state.candidates = published.filter((entry) => entry.relay);
      state.updatedAt = new Date().toISOString();
      await putMetadata('frameleaf-remote-access', state);
      for (const publicUrl of ['https://r.lbl.frameleaf.test', `https://${customHost}`]) {
        link.services.publicUrl = publicUrl;
        await putMetadata('frameleaf-cloud-link', link);
        const noAddress = await request(app)
          .get('/item-shares/received')
          .set('Authorization', auth(sam))
          .set('Host', customHost)
          .expect(200);
        expect(noAddress.body.link).toBeNull();
      }
    } finally {
      if (savedConfig.rows.length > 0) {
        await putMetadata('system-config', savedConfig.rows[0].value);
      } else {
        await client.query("DELETE FROM system_metadata WHERE key = 'system-config'");
      }
      await utils.getSystemConfig(admin.accessToken);
      await client.query(
        "DELETE FROM system_metadata WHERE key IN ('frameleaf-cloud-link', 'frameleaf-remote-access')",
      );
    }
  });
});
