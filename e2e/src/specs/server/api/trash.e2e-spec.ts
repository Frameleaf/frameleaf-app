import { LoginResponseDto, getAssetInfo, getAssetStatistics } from '@immich/sdk';
import { existsSync } from 'node:fs';
import { Socket } from 'socket.io-client';
import { app, asBearerAuth, testAssetDir, testAssetDirInternal, utils } from 'src/utils.js';
import request from 'supertest';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

describe('/trash', () => {
  let admin: LoginResponseDto;
  let ws: Socket;

  beforeAll(async () => {
    await utils.resetDatabase();
    admin = await utils.adminSetup({ onboarding: false });
    ws = await utils.connectWebsocket(admin.accessToken);
  });

  afterAll(() => {
    utils.disconnectWebsocket(ws);
  });

  const bearer = () => `Bearer ${admin.accessToken}`;
  const review = (body: object) => request(app).post('/trash/review').set('Authorization', bearer()).send(body);
  const apply = (body: object) => request(app).post('/trash/apply').set('Authorization', bearer()).send(body);
  const lock = (ids: string[]) =>
    request(app).post('/assets/lock').set('Authorization', bearer()).send({ ids }).expect(204);
  /** Start from an empty visible trash, so whole-trash reviews see only this test's items. */
  const emptyVisibleTrash = () => request(app).post('/trash/empty').set('Authorization', bearer()).expect(200);
  const trashed = async () => {
    const { id } = await utils.createAsset(admin.accessToken);
    await utils.deleteAssets(admin.accessToken, [id]);
    return id;
  };

  describe('POST /trash/empty', () => {
    it('should empty the trash', async () => {
      const { id: assetId } = await utils.createAsset(admin.accessToken);
      await utils.deleteAssets(admin.accessToken, [assetId]);

      const before = await getAssetInfo({ id: assetId }, { headers: asBearerAuth(admin.accessToken) });
      expect(before).toStrictEqual(expect.objectContaining({ id: assetId, isTrashed: true }));

      const { status, body } = await request(app)
        .post('/trash/empty')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({ count: 1 });

      await utils.waitForWebsocketEvent({ event: 'assetDelete', id: assetId });

      const after = await getAssetStatistics({ isTrashed: true }, { headers: asBearerAuth(admin.accessToken) });
      expect(after.total).toBe(0);

      expect(existsSync(before.originalPath)).toBe(false);
    });

    it('should empty the trash with archived assets', async () => {
      const { id: assetId } = await utils.createAsset(admin.accessToken);
      await utils.archiveAssets(admin.accessToken, [assetId]);
      await utils.deleteAssets(admin.accessToken, [assetId]);

      const before = await getAssetInfo({ id: assetId }, { headers: asBearerAuth(admin.accessToken) });
      expect(before).toStrictEqual(expect.objectContaining({ id: assetId, isTrashed: true, isArchived: true }));

      const { status, body } = await request(app)
        .post('/trash/empty')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({ count: 1 });

      await utils.waitForWebsocketEvent({ event: 'assetDelete', id: assetId });

      const after = await getAssetStatistics({ isTrashed: true }, { headers: asBearerAuth(admin.accessToken) });
      expect(after.total).toBe(0);

      expect(existsSync(before.originalPath)).toBe(false);
    });

    it('should remove offline assets', async () => {
      utils.createImageFile(`${testAssetDir}/temp/trash-empty/offline/offline.png`);

      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        importPaths: [`${testAssetDirInternal}/temp/trash-empty/offline`],
      });

      await utils.scan(admin.accessToken, library.id);

      const { assets } = await utils.searchAssets(admin.accessToken, { libraryId: library.id });
      expect(assets.items.length).toBe(1);
      const asset = assets.items[0];

      await utils.updateLibrary(admin.accessToken, library.id, { exclusionPatterns: ['**/offline/**'] });

      await utils.scan(admin.accessToken, library.id);

      const assetBefore = await utils.getAssetInfo(admin.accessToken, asset.id);
      expect(assetBefore).toMatchObject({ isTrashed: true, isOffline: true });

      utils.createImageFile(`${testAssetDir}/temp/trash-empty/offline/offline.png`);

      const { status } = await request(app).post('/trash/empty').set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);

      await utils.waitForQueueFinish(admin.accessToken, 'backgroundTask');

      const assetAfter = await utils.getAssetInfo(admin.accessToken, asset.id);
      expect(assetAfter).toMatchObject({ isTrashed: true, isOffline: true });
    });

    it.skip('should not delete offline assets from disk', async () => {
      // Can't be tested at the moment due to no mechanism to forward time
      utils.createImageFile(`${testAssetDir}/temp/trash-empty-original/offline/offline.png`);

      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        importPaths: [`${testAssetDirInternal}/temp/trash-empty-original/offline`],
      });

      await utils.scan(admin.accessToken, library.id);

      const { assets } = await utils.searchAssets(admin.accessToken, { libraryId: library.id });
      expect(assets.items.length).toBe(1);
      const asset = assets.items[0];

      await utils.updateLibrary(admin.accessToken, library.id, { exclusionPatterns: ['**/offline/**'] });

      await utils.scan(admin.accessToken, library.id);

      const assetBefore = await utils.getAssetInfo(admin.accessToken, asset.id);
      expect(assetBefore).toMatchObject({ isTrashed: true, isOffline: true });

      utils.createImageFile(`${testAssetDir}/temp/trash-empty-original/offline/offline.png`);

      const { status } = await request(app).post('/trash/empty').set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);

      await utils.waitForQueueFinish(admin.accessToken, 'backgroundTask');

      const after = await getAssetStatistics({ isTrashed: true }, { headers: asBearerAuth(admin.accessToken) });
      expect(after.total).toBe(0);

      expect(existsSync(`${testAssetDir}/temp/trash-empty-original/offline/offline.png`)).toBe(true);

      utils.removeImageFile(`${testAssetDir}/temp/trash-empty-original/offline/offline.png`);
    });
  });

  describe('POST /trash/restore', () => {
    it('should restore all trashed assets', async () => {
      const { id: assetId } = await utils.createAsset(admin.accessToken);
      await utils.deleteAssets(admin.accessToken, [assetId]);

      const before = await getAssetInfo({ id: assetId }, { headers: asBearerAuth(admin.accessToken) });
      expect(before).toStrictEqual(expect.objectContaining({ id: assetId, isTrashed: true }));

      const { status, body } = await request(app)
        .post('/trash/restore')
        .set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({ count: 1 });

      const after = await getAssetInfo({ id: assetId }, { headers: asBearerAuth(admin.accessToken) });
      expect(after).toStrictEqual(expect.objectContaining({ id: assetId, isTrashed: false }));
    });

    it('should not restore offline assets', async () => {
      utils.createImageFile(`${testAssetDir}/temp/trash-restore-all/offline/offline.png`);

      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        importPaths: [`${testAssetDirInternal}/temp/trash-restore-all/offline`],
      });

      await utils.scan(admin.accessToken, library.id);

      const { assets } = await utils.searchAssets(admin.accessToken, { libraryId: library.id });
      expect(assets.count).toBe(1);
      const assetId = assets.items[0].id;

      await utils.updateLibrary(admin.accessToken, library.id, { exclusionPatterns: ['**/offline/**'] });

      await utils.scan(admin.accessToken, library.id);

      const before = await getAssetInfo({ id: assetId }, { headers: asBearerAuth(admin.accessToken) });
      expect(before).toStrictEqual(expect.objectContaining({ id: assetId, isOffline: true }));

      const { status } = await request(app).post('/trash/restore').set('Authorization', `Bearer ${admin.accessToken}`);
      expect(status).toBe(200);

      const after = await getAssetInfo({ id: assetId }, { headers: asBearerAuth(admin.accessToken) });
      expect(after).toStrictEqual(expect.objectContaining({ id: assetId, isOffline: true }));

      utils.removeImageFile(`${testAssetDir}/temp/trash-restore-all/offline/offline.png`);
    });
  });

  describe('POST /trash/restore/assets', () => {
    it('should restore a trashed asset by id', async () => {
      const { id: assetId } = await utils.createAsset(admin.accessToken);
      await utils.deleteAssets(admin.accessToken, [assetId]);

      const before = await utils.getAssetInfo(admin.accessToken, assetId);
      expect(before.isTrashed).toBe(true);

      const { status, body } = await request(app)
        .post('/trash/restore/assets')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ids: [assetId] });
      expect(status).toBe(200);
      expect(body).toEqual({ count: 1 });

      const after = await utils.getAssetInfo(admin.accessToken, assetId);
      expect(after.isTrashed).toBe(false);
    });

    it('should not restore an offline asset', async () => {
      utils.createImageFile(`${testAssetDir}/temp/trash-restore-selected/offline/offline.png`);

      const library = await utils.createLibrary(admin.accessToken, {
        ownerId: admin.userId,
        importPaths: [`${testAssetDirInternal}/temp/trash-restore-selected/offline`],
      });

      await utils.scan(admin.accessToken, library.id);
      await utils.waitForQueueFinish(admin.accessToken, 'library');

      const { assets } = await utils.searchAssets(admin.accessToken, { libraryId: library.id });
      expect(assets.count).toBe(1);
      const assetId = assets.items[0].id;

      await utils.updateLibrary(admin.accessToken, library.id, { exclusionPatterns: ['**/offline/**'] });

      await utils.scan(admin.accessToken, library.id);
      await utils.waitForQueueFinish(admin.accessToken, 'library');

      const before = await utils.getAssetInfo(admin.accessToken, assetId);
      expect(before.isTrashed).toBe(true);

      const { status } = await request(app)
        .post('/trash/restore/assets')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ ids: [assetId] });
      expect(status).toBe(200);

      const after = await utils.getAssetInfo(admin.accessToken, assetId);
      expect(after.isTrashed).toBe(true);

      utils.removeImageFile(`${testAssetDir}/temp/trash-restore-selected/offline/offline.png`);
    });
  });

  describe('reviewed trash (FL-47)', () => {
    it('should permanently delete exactly the reviewed items', async () => {
      await emptyVisibleTrash();
      const first = await trashed();
      const second = await trashed();

      const reviewed = await review({ action: 'empty' });
      expect(reviewed.status).toBe(200);
      expect(reviewed.body).toMatchObject({ action: 'empty', count: 2, retainedOriginals: 0 });

      const { status, body } = await apply({ action: 'empty', token: reviewed.body.token });
      expect(status).toBe(200);
      expect(body).toEqual({ count: 2 });

      await utils.waitForWebsocketEvent({ event: 'assetDelete', id: first });
      await utils.waitForWebsocketEvent({ event: 'assetDelete', id: second });
    });

    it('should refuse to empty the trash when an item arrived after the review', async () => {
      await emptyVisibleTrash();
      const reviewedId = await trashed();

      const reviewed = await review({ action: 'empty' });
      const lateId = await trashed();

      const { status } = await apply({ action: 'empty', token: reviewed.body.token });
      expect(status).toBe(409);

      await expect(utils.getAssetInfo(admin.accessToken, reviewedId)).resolves.toMatchObject({ isTrashed: true });
      await expect(utils.getAssetInfo(admin.accessToken, lateId)).resolves.toMatchObject({ isTrashed: true });
    });

    it('should refuse when an item was locked between review and apply', async () => {
      await emptyVisibleTrash();
      const open = await trashed();
      const laterLocked = await trashed();

      const reviewed = await review({ action: 'delete', ids: [open, laterLocked] });
      expect(reviewed.body.count).toBe(2);

      await lock([laterLocked]);

      // the Locked item is no longer this session's to change, so nothing is deleted
      const { status } = await apply({ action: 'delete', ids: [open, laterLocked], token: reviewed.body.token });
      expect(status).toBe(400);
      await expect(utils.getAssetInfo(admin.accessToken, open)).resolves.toMatchObject({ isTrashed: true });
    });

    it('should keep Locked items out of an ordinary session and out of empty', async () => {
      await emptyVisibleTrash();
      const open = await trashed();
      const hidden = await trashed();
      await lock([hidden]);

      // missing external-library originals from the tests above stay listed; nothing here changes them
      const summary = await request(app).get('/trash/summary').set('Authorization', bearer());
      expect(summary.status).toBe(200);
      expect(summary.body.count - summary.body.offline).toBe(1);

      const items = await request(app).get('/trash/items').set('Authorization', bearer());
      expect(items.status).toBe(200);
      const listed = items.body.items.filter((item: { isOffline: boolean }) => !item.isOffline);
      expect(listed.map(({ id }: { id: string }) => id)).toEqual([open]);

      const reviewed = await review({ action: 'empty' });
      expect(reviewed.body.count).toBe(1);
      const emptied = await apply({ action: 'empty', token: reviewed.body.token });
      expect(emptied.status).toBe(200);

      const restored = await request(app)
        .post('/trash/restore/assets')
        .set('Authorization', bearer())
        .send({ ids: [hidden] });
      expect(restored.status).toBe(400);
    });

    it('should not report a stale restore', async () => {
      const { id } = await utils.createAsset(admin.accessToken);

      const { status, body } = await request(app)
        .post('/trash/restore/assets')
        .set('Authorization', bearer())
        .send({ ids: [id] });
      expect(status).toBe(200);
      expect(body).toEqual({ count: 0 });
    });

    it('should refuse to delete an item restored after the review', async () => {
      const id = await trashed();
      const reviewed = await review({ action: 'delete', ids: [id] });

      await request(app)
        .post('/trash/restore/assets')
        .set('Authorization', bearer())
        .send({ ids: [id] })
        .expect(200);

      const { status } = await apply({ action: 'delete', ids: [id], token: reviewed.body.token });
      expect(status).toBe(409);
      await expect(utils.getAssetInfo(admin.accessToken, id)).resolves.toMatchObject({ isTrashed: false });
    });

    it('should keep albums and favourites when restoring', async () => {
      const { id } = await utils.createAsset(admin.accessToken, { isFavorite: true });
      const album = await utils.createAlbum(admin.accessToken, { albumName: 'Kept', assetIds: [id] });
      await utils.deleteAssets(admin.accessToken, [id]);

      const reviewed = await review({ action: 'restore', ids: [id] });
      const { status, body } = await apply({ action: 'restore', ids: [id], token: reviewed.body.token });
      expect(status).toBe(200);
      expect(body).toEqual({ count: 1 });

      await expect(utils.getAssetInfo(admin.accessToken, id)).resolves.toMatchObject({
        isTrashed: false,
        isFavorite: true,
      });
      const { assets } = await utils.searchAssets(admin.accessToken, { albumIds: [album.id] });
      expect(assets.items.map((asset) => asset.id)).toContain(id);
    });

    it('should move reviewed library items to the trash once', async () => {
      const { id } = await utils.createAsset(admin.accessToken);

      const reviewed = await review({ action: 'trash', ids: [id] });
      expect(reviewed.status).toBe(200);
      const moved = await apply({ action: 'trash', ids: [id], token: reviewed.body.token });
      expect(moved.status).toBe(200);
      await expect(utils.getAssetInfo(admin.accessToken, id)).resolves.toMatchObject({ isTrashed: true });

      const again = await apply({ action: 'trash', ids: [id], token: reviewed.body.token });
      expect(again.status).toBe(409);
    });

    it('should keep items a privacy mark hides out of the trash, and refuse an apply after a new mark', async () => {
      await emptyVisibleTrash();
      const [tag] = await utils.upsertTags(admin.accessToken, ['trash-private-mark']);
      const open = await trashed();
      const marked = await trashed();
      const laterMarked = await trashed();
      await utils.tagAssets(admin.accessToken, tag.id, [marked]);

      // FL-67: Locked rules change only from an unlocked session; the trash is then read locked again
      const pin = { pinCode: '123456' };
      const { body: authStatus } = await request(app).get('/auth/status').set('Authorization', bearer());
      if (!authStatus.pinCode) {
        await request(app).post('/auth/pin-code').set('Authorization', bearer()).send(pin).expect(204);
      }
      const unlocked = async (change: () => Promise<unknown>) => {
        await request(app).post('/auth/session/unlock').set('Authorization', bearer()).send(pin).expect(204);
        try {
          await change();
        } finally {
          await request(app).post('/auth/session/lock').set('Authorization', bearer()).expect(204);
        }
      };
      const setLockedTags = (tagIds: string[]) =>
        unlocked(() => utils.updateMyPreferences(admin.accessToken, { privacy: { suppression: { tagIds } } }));
      await setLockedTags([tag.id]);

      try {
        const items = await request(app).get('/trash/items').set('Authorization', bearer());
        const ids = items.body.items.map((item: { id: string }) => item.id);
        expect(ids).toEqual(expect.arrayContaining([open, laterMarked]));
        expect(ids).not.toContain(marked);

        const chosen = await review({ action: 'delete', ids: [marked] });
        expect(chosen.status).toBe(400);

        const reviewed = await review({ action: 'empty' });
        expect(reviewed.status).toBe(200);
        expect(reviewed.body.count).toBe(2);

        // another, unlocked tab marks a reviewed item: this session no longer sees it, so nothing changes
        await unlocked(() => utils.tagAssets(admin.accessToken, tag.id, [laterMarked]));
        const { status } = await apply({ action: 'empty', token: reviewed.body.token });
        expect(status).toBe(409);
        // only an unlocked session reads the marked items, to see they were left in the trash
        await unlocked(async () => {
          for (const id of [open, marked, laterMarked]) {
            await expect(utils.getAssetInfo(admin.accessToken, id)).resolves.toMatchObject({ isTrashed: true });
          }
        });
      } finally {
        await setLockedTags([]);
      }
    });

    it('should refuse a restore when the reviewed item was deleted after the review', async () => {
      const id = await trashed();
      const reviewed = await review({ action: 'restore', ids: [id] });
      expect(reviewed.status).toBe(200);

      const deleteReview = await review({ action: 'delete', ids: [id] });
      await apply({ action: 'delete', ids: [id], token: deleteReview.body.token }).expect(200);

      const { status } = await apply({ action: 'restore', ids: [id], token: reviewed.body.token });
      expect([400, 409]).toContain(status);
      const items = await request(app).get('/trash/items').set('Authorization', bearer());
      expect(items.body.items.map((item: { id: string }) => item.id)).not.toContain(id);
    });

    it('should keep a persistent history of Large files moves and undos (FL-146)', async () => {
      const { id } = await utils.createAsset(admin.accessToken);
      const activity = () =>
        request(app).get('/trash/activity').query({ tool: 'large-files' }).set('Authorization', bearer());
      const initial = await activity();
      const before = initial.body.entries.length;

      const moved = await review({ action: 'trash', ids: [id] });
      await apply({ action: 'trash', ids: [id], token: moved.body.token, source: 'large-files' }).expect(200);
      const undone = await review({ action: 'restore', ids: [id] });
      await apply({ action: 'restore', ids: [id], token: undone.body.token, source: 'large-files' }).expect(200);
      // a change made elsewhere is not part of it
      const elsewhere = await review({ action: 'trash', ids: [id] });
      await apply({ action: 'trash', ids: [id], token: elsewhere.body.token }).expect(200);

      const { status, body } = await activity();
      expect(status).toBe(200);
      expect(body.entries).toHaveLength(before + 2);
      expect(body.entries[0]).toMatchObject({ action: 'restore', itemCount: 1, unavailableCount: 0 });
      expect(body.entries[1]).toMatchObject({ action: 'trash', items: [expect.objectContaining({ assetId: id })] });

      // Locked afterwards: no longer named in an ordinary session
      await lock([id]);
      const locked = await activity();
      expect(locked.body.entries[0]).toMatchObject({ itemCount: 0, items: [], unavailableCount: 1 });

      await request(app)
        .get('/trash/activity')
        .query({ tool: 'duplicates' })
        .set('Authorization', bearer())
        .expect(400);
    });

    it("should not review another account's items", async () => {
      const other = await utils.userSetup(admin.accessToken, {
        email: 'trash-other@example.com',
        name: 'Other',
        password: 'password',
      });
      const { id } = await utils.createAsset(other.accessToken);
      await utils.deleteAssets(other.accessToken, [id]);

      const { status } = await review({ action: 'delete', ids: [id] });
      expect(status).toBe(400);

      const items = await request(app).get('/trash/items').set('Authorization', bearer());
      expect(items.body.items.map((item: { id: string }) => item.id)).not.toContain(id);
    });
  });
});
