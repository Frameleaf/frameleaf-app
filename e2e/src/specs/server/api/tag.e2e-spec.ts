import {
  AssetMediaResponseDto,
  LoginResponseDto,
  Permission,
  TagCreateDto,
  TagResponseDto,
  createTag,
  getAllTags,
  tagAssets,
  upsertTags,
} from '@frameleaf/sdk';
import { withApiAssetReadiness } from 'src/api-asset-readiness.js';
import { createUserDto } from 'src/fixtures.js';
import { errorDto } from 'src/responses.js';
import { app, asBearerAuth, utils } from 'src/utils.js';
import request from 'supertest';
import { beforeAll, beforeEach, describe, expect, it } from 'vitest';

const create = (accessToken: string, dto: TagCreateDto) =>
  createTag({ tagCreateDto: dto }, { headers: asBearerAuth(accessToken) });

const upsert = (accessToken: string, tags: string[]) =>
  upsertTags({ tagUpsertDto: { tags } }, { headers: asBearerAuth(accessToken) });

const merge = (accessToken: string, id: string, targetId: string) =>
  request(app).post(`/tags/${id}/merge`).send({ targetId }).set('Authorization', `Bearer ${accessToken}`);

// Tagging writes each sidecar and reads it back. A read still on its way when a tag goes would create
// that tag again from the list it started with, as it would after a delete.
const settleTagging = async (adminAccessToken: string) => {
  await utils.waitForQueueFinish(adminAccessToken, 'sidecar');
  await utils.waitForQueueFinish(adminAccessToken, 'metadataExtraction');
};

describe('/tags', () => {
  let admin: LoginResponseDto;
  let user: LoginResponseDto;
  let userAsset: AssetMediaResponseDto;

  beforeAll(async () => {
    await utils.resetDatabase();

    admin = await utils.adminSetup();
    user = await utils.userSetup(admin.accessToken, createUserDto.user1);
    userAsset = await utils.createAsset(user.accessToken);
  });

  // Ordered sidecar/metadata waits share this hook's budget; the existing reset limits remain unchanged.
  const tagResetTimeout = process.env.CI ? 98_000 : 48_000;
  beforeEach(
    withApiAssetReadiness(tagResetTimeout, async (signal) => {
      // Sidecar completion enqueues metadata; wait for the producer before its consumer.
      await utils.waitForQueueFinish(admin.accessToken, 'sidecar', undefined, signal);
      await utils.waitForQueueFinish(admin.accessToken, 'metadataExtraction', undefined, signal);
      await utils.resetDatabase(['tag'], signal);
    }),
    tagResetTimeout,
  );

  describe('POST /tags', () => {
    it('should work with tag.create', async () => {
      const { secret } = await utils.createApiKey(user.accessToken, [Permission.TagCreate]);
      const { status, body } = await request(app).post('/tags').set('x-api-key', secret).send({ name: 'TagA' });
      expect(body).toEqual({
        id: expect.any(String),
        name: 'TagA',
        value: 'TagA',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(status).toBe(201);
    });

    it('should create a tag', async () => {
      const { status, body } = await request(app)
        .post('/tags')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ name: 'TagA' });
      expect(body).toEqual({
        id: expect.any(String),
        name: 'TagA',
        value: 'TagA',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(status).toBe(201);
    });

    it('should allow multiple users to create tags with the same value', async () => {
      await create(admin.accessToken, { name: 'TagA' });
      const { status, body } = await request(app)
        .post('/tags')
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ name: 'TagA' });
      expect(body).toEqual({
        id: expect.any(String),
        name: 'TagA',
        value: 'TagA',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(status).toBe(201);
    });

    // owner decision, September 27, 2026 ("use the existing tag regardless", FL-46)
    it('should answer an existing name with that tag instead of an error', async () => {
      const existing = await create(admin.accessToken, { name: 'TagA' });
      const { status, body } = await request(app)
        .post('/tags')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ name: 'TagA', color: '#00ff00' });
      expect(status).toBe(201);
      expect(body).toEqual(expect.objectContaining({ id: existing.id, name: 'TagA', value: 'TagA' }));
      expect(body.color).toBeUndefined();
    });

    it('should create a nested tag', async () => {
      const parent = await create(admin.accessToken, { name: 'TagA' });
      const { status, body } = await request(app)
        .post('/tags')
        .set('Authorization', `Bearer ${admin.accessToken}`)
        .send({ name: 'TagB', parentId: parent.id });
      expect(body).toEqual({
        id: expect.any(String),
        parentId: parent.id,
        name: 'TagB',
        value: 'TagA/TagB',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
      expect(status).toBe(201);
    });
  });

  describe('GET /tags', () => {
    it('should start off empty', async () => {
      const { status, body } = await request(app).get('/tags').set('Authorization', `Bearer ${admin.accessToken}`);
      expect(body).toEqual([]);
      expect(status).toEqual(200);
    });

    it('should return a list of tags', async () => {
      const [tagA, tagB, tagC] = await Promise.all([
        create(admin.accessToken, { name: 'TagA' }),
        create(admin.accessToken, { name: 'TagB' }),
        create(admin.accessToken, { name: 'TagC' }),
      ]);
      const { status, body } = await request(app).get('/tags').set('Authorization', `Bearer ${admin.accessToken}`);
      expect(body).toHaveLength(3);
      expect(body).toEqual([tagA, tagB, tagC]);
      expect(status).toEqual(200);
    });

    it('should return a nested tags', async () => {
      await upsert(admin.accessToken, ['TagA/TagB/TagC', 'TagD']);
      const { status, body } = await request(app).get('/tags').set('Authorization', `Bearer ${admin.accessToken}`);

      expect(body).toHaveLength(4);
      expect(status).toEqual(200);

      const tags = body as TagResponseDto[];
      const tagA = tags.find((tag) => tag.value === 'TagA') as TagResponseDto;
      const tagB = tags.find((tag) => tag.value === 'TagA/TagB') as TagResponseDto;
      const tagC = tags.find((tag) => tag.value === 'TagA/TagB/TagC') as TagResponseDto;
      const tagD = tags.find((tag) => tag.value === 'TagD') as TagResponseDto;

      expect(tagA).toEqual(expect.objectContaining({ name: 'TagA', value: 'TagA' }));
      expect(tagB).toEqual(expect.objectContaining({ name: 'TagB', value: 'TagA/TagB', parentId: tagA.id }));
      expect(tagC).toEqual(expect.objectContaining({ name: 'TagC', value: 'TagA/TagB/TagC', parentId: tagB.id }));
      expect(tagD).toEqual(expect.objectContaining({ name: 'TagD', value: 'TagD' }));
    });
  });

  describe('GET /tags/statistics', () => {
    it('should require authentication', async () => {
      const { status } = await request(app).get('/tags/statistics');
      expect(status).toBe(401);
    });

    it('should count items per tag, including subtags, and never an archived or trashed one (FL-46)', async () => {
      const [rockies] = await upsert(user.accessToken, ['trips/rockies']);
      const [trips] = await upsert(user.accessToken, ['trips']);
      await upsert(user.accessToken, ['empty']);
      const visible = await utils.createAsset(user.accessToken);
      const tripsOnly = await utils.createAsset(user.accessToken);
      // a hidden descendant item: tagged with the subtag, but archived, so never counted
      const archived = await utils.createAsset(user.accessToken);
      const trashed = await utils.createAsset(user.accessToken);
      await utils.archiveAssets(user.accessToken, [archived.id]);
      await utils.deleteAssets(user.accessToken, [trashed.id]);
      await utils.tagAssets(user.accessToken, rockies.id, [visible.id, archived.id, trashed.id]);
      await utils.tagAssets(user.accessToken, trips.id, [tripsOnly.id]);

      const { status, body } = await request(app)
        .get('/tags/statistics')
        .set('Authorization', `Bearer ${user.accessToken}`);

      expect(status).toBe(200);
      expect(body).toHaveLength(2);
      expect(body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: trips.id, count: 1, total: 2 }),
          expect.objectContaining({ id: rockies.id, count: 1, total: 1 }),
        ]),
      );
    });

    it("should not count another user's tags", async () => {
      const [tag] = await upsert(user.accessToken, ['mine']);
      await utils.tagAssets(user.accessToken, tag.id, [userAsset.id]);

      const { status, body } = await request(app)
        .get('/tags/statistics')
        .set('Authorization', `Bearer ${admin.accessToken}`);

      expect(status).toBe(200);
      expect(body).toEqual([]);
    });
  });

  describe('PUT /tags', () => {
    it('should upsert tags', async () => {
      const { status, body } = await request(app)
        .put(`/tags`)
        .send({ tags: ['TagA/TagB/TagC/TagD'] })
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual([expect.objectContaining({ name: 'TagD', value: 'TagA/TagB/TagC/TagD' })]);
    });

    it('should upsert tags in parallel without conflicts', async () => {
      const [[tag1], [tag2], [tag3], [tag4]] = await Promise.all([
        upsert(admin.accessToken, ['TagA/TagB/TagC/TagD']),
        upsert(admin.accessToken, ['TagA/TagB/TagC/TagD']),
        upsert(admin.accessToken, ['TagA/TagB/TagC/TagD']),
        upsert(admin.accessToken, ['TagA/TagB/TagC/TagD']),
      ]);

      const { id, parentId, createdAt } = tag1;
      for (const tag of [tag1, tag2, tag3, tag4]) {
        expect(tag).toMatchObject({
          id,
          parentId,
          createdAt,
          name: 'TagD',
          value: 'TagA/TagB/TagC/TagD',
        });
      }
    });
  });

  describe('PUT /tags/assets', () => {
    it('should skip assets that are not owned by the user', async () => {
      const [tagA, tagB, tagC, assetA, assetB] = await Promise.all([
        create(user.accessToken, { name: 'TagA' }),
        create(user.accessToken, { name: 'TagB' }),
        create(user.accessToken, { name: 'TagC' }),
        utils.createAsset(user.accessToken),
        utils.createAsset(admin.accessToken),
      ]);
      const { status, body } = await request(app)
        .put(`/tags/assets`)
        .send({ tagIds: [tagA.id, tagB.id, tagC.id], assetIds: [assetA.id, assetB.id] })
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({ count: 3 });
    });

    it('should skip tags that are not owned by the user', async () => {
      const [tagA, tagB, tagC, assetA, assetB] = await Promise.all([
        create(user.accessToken, { name: 'TagA' }),
        create(user.accessToken, { name: 'TagB' }),
        create(admin.accessToken, { name: 'TagC' }),
        utils.createAsset(user.accessToken),
        utils.createAsset(user.accessToken),
      ]);
      const { status, body } = await request(app)
        .put(`/tags/assets`)
        .send({ tagIds: [tagA.id, tagB.id, tagC.id], assetIds: [assetA.id, assetB.id] })
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({ count: 4 });
    });

    it('should bulk tag assets', async () => {
      const [tagA, tagB, tagC, assetA, assetB] = await Promise.all([
        create(user.accessToken, { name: 'TagA' }),
        create(user.accessToken, { name: 'TagB' }),
        create(user.accessToken, { name: 'TagC' }),
        utils.createAsset(user.accessToken),
        utils.createAsset(user.accessToken),
      ]);
      const { status, body } = await request(app)
        .put(`/tags/assets`)
        .send({ tagIds: [tagA.id, tagB.id, tagC.id], assetIds: [assetA.id, assetB.id] })
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({ count: 6 });
    });
  });

  describe('GET /tags/:id', () => {
    it('should get tag details', async () => {
      const tag = await create(user.accessToken, { name: 'TagA' });
      const { status, body } = await request(app)
        .get(`/tags/${tag.id}`)
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({
        id: expect.any(String),
        name: 'TagA',
        value: 'TagA',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });

    it('should get nested tag details', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      const tagB = await create(user.accessToken, { name: 'TagB', parentId: tagA.id });
      const tagC = await create(user.accessToken, { name: 'TagC', parentId: tagB.id });
      const tagD = await create(user.accessToken, { name: 'TagD', parentId: tagC.id });

      const { status, body } = await request(app)
        .get(`/tags/${tagD.id}`)
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual({
        id: expect.any(String),
        parentId: tagC.id,
        name: 'TagD',
        value: 'TagA/TagB/TagC/TagD',
        createdAt: expect.any(String),
        updatedAt: expect.any(String),
      });
    });
  });

  describe('PUT /tags/:id', () => {
    it('should update a tag', async () => {
      const tag = await create(user.accessToken, { name: 'tagA' });
      const { status, body } = await request(app)
        .put(`/tags/${tag.id}`)
        .send({ color: '#000000' })
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ color: `#000000` }));
    });

    it('should update a tag color without a # prefix', async () => {
      const tag = await create(user.accessToken, { name: 'tagA' });
      const { status, body } = await request(app)
        .put(`/tags/${tag.id}`)
        .send({ color: '000000' })
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ color: `#000000` }));
    });

    it('should move a nested tag and its children to the top level', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      const tagB = await create(user.accessToken, { name: 'TagB', parentId: tagA.id });
      const tagC = await create(user.accessToken, { name: 'TagC', parentId: tagB.id });
      const { status, body } = await request(app)
        .put(`/tags/${tagB.id}`)
        .send({ parentId: null })
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ id: tagB.id, value: 'TagB' }));
      expect(body.parentId).toBeUndefined();
      const tags = await getAllTags({ headers: asBearerAuth(user.accessToken) });
      expect(tags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: tagA.id, value: 'TagA' }),
          expect.objectContaining({ id: tagC.id, value: 'TagB/TagC', parentId: tagB.id }),
        ]),
      );
    });

    it('should not move a tag under its own child', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      const tagB = await create(user.accessToken, { name: 'TagB', parentId: tagA.id });
      const { status, body } = await request(app)
        .put(`/tags/${tagA.id}`)
        .send({ parentId: tagB.id })
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(400);
      expect(body).toEqual(errorDto.badRequest('A tag cannot be moved under itself or one of its descendants'));
    });
  });

  describe('DELETE /tags/:id', () => {
    it('should delete a tag', async () => {
      const tag = await create(user.accessToken, { name: 'TagA' });
      const { status } = await request(app)
        .delete(`/tags/${tag.id}`)
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(204);
    });

    it('should delete a nested tag (root)', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      await create(user.accessToken, { name: 'TagB', parentId: tagA.id });
      const { status } = await request(app)
        .delete(`/tags/${tagA.id}`)
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(204);
      const tags = await getAllTags({ headers: asBearerAuth(user.accessToken) });
      expect(tags.length).toBe(0);
    });

    it('should delete a nested tag (leaf)', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      const tagB = await create(user.accessToken, { name: 'TagB', parentId: tagA.id });
      const { status } = await request(app)
        .delete(`/tags/${tagB.id}`)
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(204);
      const tags = await getAllTags({ headers: asBearerAuth(user.accessToken) });
      expect(tags.length).toBe(1);
      expect(tags[0]).toEqual(tagA);
    });
  });

  describe('POST /tags/:id/merge', () => {
    it('should require authentication', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      const tagB = await create(user.accessToken, { name: 'TagB' });
      const { status } = await request(app).post(`/tags/${tagA.id}/merge`).send({ targetId: tagB.id });
      expect(status).toBe(401);
    });

    it('should need both tag.delete and tag.update from an API key', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      const tagB = await create(user.accessToken, { name: 'TagB' });
      const withKey = async (permissions: Permission[]) => {
        const { secret } = await utils.createApiKey(user.accessToken, permissions);
        return request(app).post(`/tags/${tagA.id}/merge`).set('x-api-key', secret).send({ targetId: tagB.id });
      };

      const updateOnly = await withKey([Permission.TagUpdate]);
      expect(updateOnly.status).toBe(403);
      expect(updateOnly.body).toEqual(errorDto.forbidden('Missing required permission: tag.delete'));
      const deleteOnly = await withKey([Permission.TagDelete]);
      expect(deleteOnly.status).toBe(403);
      expect(deleteOnly.body).toEqual(errorDto.forbidden('Missing required permission: tag.update'));
      expect(await getAllTags({ headers: asBearerAuth(user.accessToken) })).toHaveLength(2);

      const both = await withKey([Permission.TagDelete, Permission.TagUpdate]);
      expect(both.status).toBe(200);
      expect(both.body).toEqual(expect.objectContaining({ id: tagB.id, value: 'TagB' }));
    });

    it('should give every item the other tag, move the tags inside it and delete the merged tag', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      const inside = await create(user.accessToken, { name: 'Inside', parentId: tagA.id });
      const tagB = await create(user.accessToken, { name: 'TagB', color: '#5794f7' });
      const onBoth = await utils.createAsset(user.accessToken);
      const onInside = await utils.createAsset(user.accessToken);
      // an item the Tags screen does not count still carries the other tag afterwards
      const archived = await utils.createAsset(user.accessToken);
      await utils.archiveAssets(user.accessToken, [archived.id]);
      await utils.tagAssets(user.accessToken, tagA.id, [userAsset.id, onBoth.id, archived.id]);
      await utils.tagAssets(user.accessToken, tagB.id, [onBoth.id]);
      await utils.tagAssets(user.accessToken, inside.id, [onInside.id]);
      await settleTagging(admin.accessToken);

      const { status, body } = await merge(user.accessToken, tagA.id, tagB.id);
      expect(status).toBe(200);
      expect(body).toEqual(expect.objectContaining({ id: tagB.id, name: 'TagB', value: 'TagB', color: '#5794f7' }));
      expect(body.parentId).toBeUndefined();

      const tags = await getAllTags({ headers: asBearerAuth(user.accessToken) });
      expect(tags).toHaveLength(2);
      expect(tags).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: tagB.id, value: 'TagB' }),
          expect.objectContaining({ id: inside.id, value: 'TagB/Inside', parentId: tagB.id }),
        ]),
      );
      const statistics = await request(app).get('/tags/statistics').set('Authorization', `Bearer ${user.accessToken}`);
      expect(statistics.body).toHaveLength(2);
      expect(statistics.body).toEqual(
        expect.arrayContaining([
          expect.objectContaining({ id: tagB.id, count: 2, total: 3 }),
          expect.objectContaining({ id: inside.id, count: 1, total: 1 }),
        ]),
      );
      for (const id of [userAsset.id, onBoth.id, archived.id]) {
        const asset = await utils.getAssetInfo(user.accessToken, id);
        expect(asset.tags?.map((tag) => tag.value)).toEqual(['TagB']);
      }
      const moved = await utils.getAssetInfo(user.accessToken, onInside.id);
      expect(moved.tags?.map((tag) => tag.value)).toEqual(['TagB/Inside']);
      const gone = await request(app).get(`/tags/${tagA.id}`).set('Authorization', `Bearer ${user.accessToken}`);
      expect(gone.status).toBe(404);
    });

    it('should merge a tag inside it into the tag of the same name there', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      const insideA = await create(user.accessToken, { name: 'Same', parentId: tagA.id });
      const deeper = await create(user.accessToken, { name: 'Deeper', parentId: insideA.id });
      const tagB = await create(user.accessToken, { name: 'TagB' });
      const insideB = await create(user.accessToken, { name: 'Same', parentId: tagB.id });
      await utils.tagAssets(user.accessToken, insideA.id, [userAsset.id]);
      await settleTagging(admin.accessToken);

      const { status } = await merge(user.accessToken, tagA.id, tagB.id);
      expect(status).toBe(200);

      const tags = await getAllTags({ headers: asBearerAuth(user.accessToken) });
      expect(tags.map(({ id, value }) => [id, value])).toEqual([
        [tagB.id, 'TagB'],
        [insideB.id, 'TagB/Same'],
        [deeper.id, 'TagB/Same/Deeper'],
      ]);
      const asset = await utils.getAssetInfo(user.accessToken, userAsset.id);
      expect(asset.tags?.map((tag) => tag.id)).toEqual([insideB.id]);
    });

    it('should not merge a tag into itself or a tag inside it', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      const tagB = await create(user.accessToken, { name: 'TagB', parentId: tagA.id });
      for (const targetId of [tagA.id, tagB.id]) {
        const { status, body } = await merge(user.accessToken, tagA.id, targetId);
        expect(status).toBe(400);
        expect(body).toEqual(errorDto.badRequest('A tag cannot be merged into itself or one of its descendants'));
      }
      expect(await getAllTags({ headers: asBearerAuth(user.accessToken) })).toHaveLength(2);
    });

    it("should answer another user's tag, in either place, like a tag that does not exist", async () => {
      const mine = await create(user.accessToken, { name: 'Mine' });
      const theirs = await create(admin.accessToken, { name: 'Theirs' });
      for (const [id, targetId] of [
        [mine.id, theirs.id],
        [theirs.id, mine.id],
        [mine.id, '00000000-0000-4000-8000-000000000000'],
      ]) {
        const { status, body } = await merge(user.accessToken, id, targetId);
        expect(status).toBe(404);
        expect(body).toEqual(errorDto.notFound('Tag not found'));
      }
      expect(await getAllTags({ headers: asBearerAuth(user.accessToken) })).toEqual([mine]);
      expect(await getAllTags({ headers: asBearerAuth(admin.accessToken) })).toEqual([theirs]);
    });

    it('should require the tag to merge into', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      const { status } = await request(app)
        .post(`/tags/${tagA.id}/merge`)
        .send({})
        .set('Authorization', `Bearer ${user.accessToken}`);
      expect(status).toBe(400);
    });
  });

  describe('PUT /tags/:id/assets', () => {
    it('should be able to tag own asset', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      const { status, body } = await request(app)
        .put(`/tags/${tagA.id}/assets`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ ids: [userAsset.id] });

      expect(status).toBe(200);
      expect(body).toEqual([expect.objectContaining({ id: userAsset.id, success: true })]);
    });

    it("should not be able to add assets to another user's tag", async () => {
      const tagA = await create(admin.accessToken, { name: 'TagA' });
      const { status, body } = await request(app)
        .put(`/tags/${tagA.id}/assets`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ ids: [userAsset.id] });

      expect(status).toBe(404);
      expect(body).toEqual(errorDto.notFound('Tag not found'));
    });

    // FL-36: a bulk tag reports each item of a mixed or stale selection instead of failing the batch.
    it('reports each item of a mixed selection', async () => {
      const tagA = await create(user.accessToken, { name: 'TagMixed' });
      const [ownAsset, otherAsset] = await Promise.all([
        utils.createAsset(user.accessToken),
        utils.createAsset(admin.accessToken),
      ]);
      const staleId = '00000000-0000-4000-8000-000000000000';
      const { status, body } = await request(app)
        .put(`/tags/${tagA.id}/assets`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ ids: [ownAsset.id, otherAsset.id, staleId] });

      expect(status).toBe(200);
      expect(body).toEqual([
        expect.objectContaining({ id: ownAsset.id, success: true }),
        expect.objectContaining({ id: otherAsset.id, success: false, error: 'no_permission' }),
        expect.objectContaining({ id: staleId, success: false, error: 'no_permission' }),
      ]);
    });

    it('should add duplicate assets only once', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      const { status, body } = await request(app)
        .put(`/tags/${tagA.id}/assets`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ ids: [userAsset.id, userAsset.id] });

      expect(status).toBe(200);
      expect(body).toEqual([
        expect.objectContaining({ id: userAsset.id, success: true }),
        expect.objectContaining({ id: userAsset.id, success: false, error: 'duplicate' }),
      ]);
    });
  });

  describe('DELETE /tags/:id/assets', () => {
    it('should be able to remove own asset from own tag', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      await tagAssets(
        { id: tagA.id, bulkIdsDto: { ids: [userAsset.id] } },
        { headers: asBearerAuth(user.accessToken) },
      );
      const { status, body } = await request(app)
        .delete(`/tags/${tagA.id}/assets`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ ids: [userAsset.id] });

      expect(status).toBe(200);
      expect(body).toEqual([expect.objectContaining({ id: userAsset.id, success: true })]);
    });

    it.skip('should remove duplicate assets only once', async () => {
      const tagA = await create(user.accessToken, { name: 'TagA' });
      await tagAssets(
        { id: tagA.id, bulkIdsDto: { ids: [userAsset.id] } },
        { headers: asBearerAuth(user.accessToken) },
      );
      const { status, body } = await request(app)
        .delete(`/tags/${tagA.id}/assets`)
        .set('Authorization', `Bearer ${user.accessToken}`)
        .send({ ids: [userAsset.id, userAsset.id] });

      expect(status).toBe(200);
      expect(body).toEqual([
        expect.objectContaining({ id: userAsset.id, success: true }),
        expect.objectContaining({ id: userAsset.id, success: false, error: 'not_found' }),
      ]);
    });
  });
});
