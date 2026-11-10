import { JobName, SharedLinkType } from '@frameleaf/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, utils } from 'src/utils.js';
import request from 'supertest';
import { expect, it } from 'vitest';

it('scopes processing failures to the owner and lets them retry a set-aside item', async () => {
  await utils.resetDatabase();
  const admin = await utils.adminSetup();
  const owner = await utils.userSetup(admin.accessToken, createUserDto.user1);
  const other = await utils.userSetup(admin.accessToken, createUserDto.user2);
  const { id } = await utils.createAsset(owner.accessToken);
  await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
  await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');
  const db = await utils.connectDatabase();
  const step = JobName.AssetGenerateThumbnails;
  await db.query(
    `INSERT INTO asset_processing_failure ("assetId", step, attempts, "lastError", "lastFailedAt", "quarantinedAt")
     VALUES ($1::uuid, $2, 3, 'unreadable', now(), now())`,
    [id, step],
  );

  const path = '/assets/processing-failures';
  const list = (token: string) => request(app).get(path).auth(token, { type: 'bearer' });
  const retry = (token: string) =>
    request(app)
      .post(`${path}/retry`)
      .auth(token, { type: 'bearer' })
      .send({
        items: [{ assetId: id, step }],
      });
  const expected = [expect.objectContaining({ assetId: id, step, ownerId: owner.userId, attempts: 3 })];
  await list(owner.accessToken)
    .expect(200)
    .expect(({ body }) => {
      expect(body).toEqual(expected);
    });
  await list(admin.accessToken)
    .query({ userId: owner.userId })
    .expect(200)
    .expect(({ body }) => {
      expect(body).toEqual(expected);
    });
  await list(other.accessToken).query({ userId: owner.userId }).expect(200, []);
  await utils.createPartner(owner.accessToken, other.userId);
  await list(other.accessToken).expect(200, []);
  await retry(other.accessToken).expect(404);
  const share = await utils.createSharedLink(owner.accessToken, { type: SharedLinkType.Individual, assetIds: [id] });
  await request(app).get(path).query({ key: share.key }).expect(403);
  await retry(owner.accessToken).expect(204);
  await utils.waitForQueueFinish(admin.accessToken, 'thumbnailGeneration');
  await list(owner.accessToken).expect(200, []);
  expect(await utils.getAssetInfo(owner.accessToken, id)).toMatchObject({ id });
}, 60_000);
