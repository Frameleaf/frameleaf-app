import { AssetMediaResponseDto, LoginResponseDto } from '@frameleaf/sdk';
import { createUserDto } from 'src/fixtures.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, describe, expect, it } from 'vitest';

const takenAt = '2022-07-01T10:03:00.000Z';

const dateOf = async (token: string, id: string) => {
  const { body } = await request(app).get(`/assets/${id}`).set(asBearerAuth(token));
  return { fileCreatedAt: body.fileCreatedAt, timeZone: body.exifInfo?.timeZone ?? null };
};

/** FL-930: the Date & Time Doctor applies a fix only to the caller's own photos, and only its owner undoes it. */
describe('/date-doctor', () => {
  let admin: LoginResponseDto;
  let owner: LoginResponseDto;
  let partner: LoginResponseDto;
  let original: AssetMediaResponseDto;
  let copyId: string;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup();
    [owner, partner] = await Promise.all([
      utils.userSetup(admin.accessToken, createUserDto.user1),
      utils.userSetup(admin.accessToken, createUserDto.user2),
    ]);
    original = await utils.createAsset(owner.accessToken, { fileCreatedAt: takenAt });
    await utils.createPartner(owner.accessToken, partner.userId);
    copyId = await utils.waitForPartnerCopy(partner.userId, original.id);
    await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction');
  });

  it('requires authentication', async () => {
    const { status } = await request(app)
      .post('/date-doctor/apply')
      .send({ assetIds: [original.id], shiftMinutes: 5 });
    expect(status).toBe(401);
  });

  it('previews a fix of the caller’s own photo and changes nothing', async () => {
    const before = await dateOf(owner.accessToken, original.id);
    const { status, body } = await request(app)
      .post('/date-doctor/preview')
      .set(asBearerAuth(owner.accessToken))
      .send({ assetIds: [original.id], shiftMinutes: 60 });

    expect(status).toBe(200);
    expect(body).toEqual({
      items: [
        expect.objectContaining({
          assetId: original.id,
          before: expect.objectContaining({ date: before.fileCreatedAt }),
          after: expect.objectContaining({
            date: new Date(new Date(before.fileCreatedAt).getTime() + 3_600_000).toISOString(),
          }),
        }),
      ],
    });
    expect(await dateOf(owner.accessToken, original.id)).toEqual(before);
  });

  it('refuses a partner’s copy to its source’s owner, and the source to the partner', async () => {
    const [ownerTriesCopy, partnerTriesSource] = await Promise.all([
      request(app)
        .post('/date-doctor/apply')
        .set(asBearerAuth(owner.accessToken))
        .send({ assetIds: [copyId], shiftMinutes: 5 }),
      request(app)
        .post('/date-doctor/preview')
        .set(asBearerAuth(partner.accessToken))
        .send({ assetIds: [original.id], timeZone: 'Europe/Paris' }),
    ]);

    expect(ownerTriesCopy.status).toBe(400);
    expect(partnerTriesSource.status).toBe(400);
  });

  it('applies to the owner’s photo, refuses the undo to anyone else, and undoes it for the owner', async () => {
    const before = await dateOf(owner.accessToken, original.id);
    const applied = await request(app)
      .post('/date-doctor/apply')
      .set(asBearerAuth(owner.accessToken))
      .send({ assetIds: [original.id], timeZone: 'Asia/Tokyo' });
    expect(applied.status).toBe(201);
    expect(applied.body).toEqual({
      batch: expect.objectContaining({ id: expect.any(String), count: 1, timeZone: 'Asia/Tokyo', undoneAt: null }),
      skipped: [],
    });
    const batchId = applied.body.batch.id;
    const fixed = await dateOf(owner.accessToken, original.id);
    expect(fixed.timeZone).toBe('Asia/Tokyo');

    const partnerUndo = await request(app)
      .post(`/date-doctor/batches/${batchId}/undo`)
      .set(asBearerAuth(partner.accessToken));
    expect(partnerUndo.status).toBe(400);

    const undone = await request(app).post(`/date-doctor/batches/${batchId}/undo`).set(asBearerAuth(owner.accessToken));
    expect(undone.status).toBe(200);
    expect(undone.body).toEqual(expect.objectContaining({ restored: 1, undoneAt: expect.any(String) }));
    expect(await dateOf(owner.accessToken, original.id)).toEqual(before);

    const again = await request(app).post(`/date-doctor/batches/${batchId}/undo`).set(asBearerAuth(owner.accessToken));
    expect(again.status).toBe(400);

    const listed = await request(app).get('/date-doctor/batches').set(asBearerAuth(owner.accessToken));
    expect(listed.body).toEqual([expect.objectContaining({ id: batchId, undoneAt: expect.any(String) })]);
    const othersList = await request(app).get('/date-doctor/batches').set(asBearerAuth(partner.accessToken));
    expect(othersList.body).toEqual([]);
  });

  it('lets the partner fix and undo their own copy', async () => {
    // the owner's fix and its undo reach the copy, which still follows its source, through background jobs
    await utils.waitForQueueFinish(admin.accessToken, 'backgroundTask');
    const before = await dateOf(partner.accessToken, copyId);
    const applied = await request(app)
      .post('/date-doctor/apply')
      .set(asBearerAuth(partner.accessToken))
      .send({ assetIds: [copyId], shiftMinutes: -30 });
    expect(applied.status).toBe(201);
    const fixed = await dateOf(partner.accessToken, copyId);
    expect(fixed.fileCreatedAt).toBe(new Date(new Date(before.fileCreatedAt).getTime() - 30 * 60_000).toISOString());

    const undone = await request(app)
      .post(`/date-doctor/batches/${applied.body.batch.id}/undo`)
      .set(asBearerAuth(partner.accessToken));
    expect(undone.status).toBe(200);
    expect(await dateOf(partner.accessToken, copyId)).toEqual(before);
  });
});
