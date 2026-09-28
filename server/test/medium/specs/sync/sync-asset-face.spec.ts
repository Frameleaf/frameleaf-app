import { Kysely } from 'kysely';
import { AssetVisibility, SyncEntityType, SyncRequestType } from 'src/enum.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = async (db?: Kysely<DB>) => {
  const ctx = new SyncTestContext(db || defaultDatabase);
  const { auth, user, session } = await ctx.newSyncAuthUser();
  return { auth, user, session, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(SyncEntityType.AssetFaceV2, () => {
  it('should detect and sync the first asset face', async () => {
    const { auth, ctx } = await setup();
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
    const { person } = await ctx.newPerson({ ownerId: auth.user.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV2]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({
          id: assetFace.id,
          assetId: asset.id,
          personId: person.personGroupId,
          imageWidth: assetFace.imageWidth,
          imageHeight: assetFace.imageHeight,
          boundingBoxX1: assetFace.boundingBoxX1,
          boundingBoxY1: assetFace.boundingBoxY1,
          boundingBoxX2: assetFace.boundingBoxX2,
          boundingBoxY2: assetFace.boundingBoxY2,
          sourceType: assetFace.sourceType,
        }),
        type: 'AssetFaceV2',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV2]);
  });

  it('should detect and sync a deleted asset face', async () => {
    const { auth, ctx } = await setup();
    const personRepo = ctx.get(PersonRepository);
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
    await personRepo.deleteAssetFace(assetFace.id);

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV2]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          assetFaceId: assetFace.id,
        },
        type: 'AssetFaceDeleteV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV2]);
  });

  it('should not sync an asset face or asset face delete for an unrelated user', async () => {
    const { auth, ctx } = await setup();
    const personRepo = ctx.get(PersonRepository);
    const { user: user2 } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user2.id });
    const { asset } = await ctx.newAsset({ ownerId: user2.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
    const auth2 = factory.auth({ session, user: user2 });

    expect(await ctx.syncStream(auth2, [SyncRequestType.AssetFacesV2])).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetFaceV2 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV2]);

    await personRepo.deleteAssetFace(assetFace.id);

    expect(await ctx.syncStream(auth2, [SyncRequestType.AssetFacesV2])).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetFaceDeleteV1 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV2]);
  });
});

describe(SyncEntityType.AssetFaceV2, () => {
  it('should detect and sync the first asset face', async () => {
    const { auth, ctx } = await setup();
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
    const { person } = await ctx.newPerson({ ownerId: auth.user.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV2]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({
          id: assetFace.id,
          assetId: asset.id,
          personId: person.personGroupId,
          imageWidth: assetFace.imageWidth,
          imageHeight: assetFace.imageHeight,
          boundingBoxX1: assetFace.boundingBoxX1,
          boundingBoxY1: assetFace.boundingBoxY1,
          boundingBoxX2: assetFace.boundingBoxX2,
          boundingBoxY2: assetFace.boundingBoxY2,
          sourceType: assetFace.sourceType,
        }),
        type: 'AssetFaceV2',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV2]);
  });

  it('should detect and sync a deleted asset face', async () => {
    const { auth, ctx } = await setup();
    const personRepo = ctx.get(PersonRepository);
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
    await personRepo.deleteAssetFace(assetFace.id);

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV2]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          assetFaceId: assetFace.id,
        },
        type: 'AssetFaceDeleteV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV2]);
  });

  it('should not sync an asset face or asset face delete for an unrelated user', async () => {
    const { auth, ctx } = await setup();
    const personRepo = ctx.get(PersonRepository);
    const { user: user2 } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user2.id });
    const { asset } = await ctx.newAsset({ ownerId: user2.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
    const auth2 = factory.auth({ session, user: user2 });

    expect(await ctx.syncStream(auth2, [SyncRequestType.AssetFacesV2])).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetFaceV2 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV2]);

    await personRepo.deleteAssetFace(assetFace.id);

    expect(await ctx.syncStream(auth2, [SyncRequestType.AssetFacesV2])).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetFaceDeleteV1 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV2]);
  });

  it('should contain the deletedAt and isVisible fields in AssetFaceV2', async () => {
    const { auth, ctx } = await setup();
    const personRepo = ctx.get(PersonRepository);
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
    const { person } = await ctx.newPerson({ ownerId: auth.user.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

    let response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV2]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({
          id: assetFace.id,
          assetId: asset.id,
          personId: person.personGroupId,
          imageWidth: assetFace.imageWidth,
          imageHeight: assetFace.imageHeight,
          boundingBoxX1: assetFace.boundingBoxX1,
          boundingBoxY1: assetFace.boundingBoxY1,
          boundingBoxX2: assetFace.boundingBoxX2,
          boundingBoxY2: assetFace.boundingBoxY2,
          sourceType: assetFace.sourceType,
          deletedAt: null,
          isVisible: true,
        }),
        type: 'AssetFaceV2',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV2]);

    await personRepo.deleteAssetFace(assetFace.id);

    response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV2]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          assetFaceId: assetFace.id,
        },
        type: 'AssetFaceDeleteV1',
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV2]);
  });
});

describe(SyncEntityType.AssetFaceV3, () => {
  it('should detect and sync the first asset face', async () => {
    const { auth, ctx } = await setup();
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
    const { person } = await ctx.newPerson({ ownerId: auth.user.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          id: assetFace.id,
          assetId: asset.id,
          personId: person.personGroupId,
          imageWidth: assetFace.imageWidth,
          imageHeight: assetFace.imageHeight,
          boundingBoxX1: assetFace.boundingBoxX1,
          boundingBoxY1: assetFace.boundingBoxY1,
          boundingBoxX2: assetFace.boundingBoxX2,
          boundingBoxY2: assetFace.boundingBoxY2,
          sourceType: assetFace.sourceType,
          deletedAt: null,
          isVisible: true,
        },
        type: SyncEntityType.AssetFaceV3,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV3]);
  });

  it('should sync an asset face without a person', async () => {
    const { auth, ctx } = await setup();
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({ id: assetFace.id, assetId: asset.id, personId: null }),
        type: SyncEntityType.AssetFaceV3,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });

  it('should sync an asset face belonging to another user in the same cluster group', async () => {
    const { auth, user, ctx } = await setup();
    const { user: user2 } = await ctx.newUser({ clusterGroupId: user.clusterGroupId });
    const { asset } = await ctx.newAsset({ ownerId: user2.id });
    const { person } = await ctx.newPerson({ ownerId: user2.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({ id: assetFace.id, assetId: asset.id, personId: person.personGroupId }),
        type: SyncEntityType.AssetFaceV3,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV3]);
  });

  it('should detect and sync an updated asset face for another user in the same cluster group', async () => {
    const { auth, user, ctx } = await setup();
    const personRepo = ctx.get(PersonRepository);
    const { user: user2 } = await ctx.newUser({ clusterGroupId: user.clusterGroupId });
    const { asset } = await ctx.newAsset({ ownerId: user2.id });
    const { person } = await ctx.newPerson({ ownerId: user2.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(response).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetFaceV3 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV3]);

    await personRepo.softDeleteAssetFaces(assetFace.id);

    expect(await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3])).toEqual([
      {
        ack: expect.any(String),
        data: expect.objectContaining({ id: assetFace.id, deletedAt: expect.any(String) }),
        type: SyncEntityType.AssetFaceV3,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });

  it('should detect and sync a deleted asset face', async () => {
    const { auth, ctx } = await setup();
    const personRepo = ctx.get(PersonRepository);
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
    const { person } = await ctx.newPerson({ ownerId: auth.user.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    await personRepo.deleteAssetFace(assetFace.id);

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          assetFaceId: assetFace.id,
        },
        type: SyncEntityType.AssetFaceDeleteV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);

    await ctx.syncAckAll(auth, response);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV3]);
  });

  it('should detect and sync a deleted asset face belonging to another user in the same cluster group', async () => {
    const { auth, user, ctx } = await setup();
    const personRepo = ctx.get(PersonRepository);
    const { user: user2 } = await ctx.newUser({ clusterGroupId: user.clusterGroupId });
    const { asset } = await ctx.newAsset({ ownerId: user2.id });
    const { person } = await ctx.newPerson({ ownerId: user2.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    await personRepo.deleteAssetFace(assetFace.id);

    const response = await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3]);
    expect(response).toEqual([
      {
        ack: expect.any(String),
        data: {
          assetFaceId: assetFace.id,
        },
        type: SyncEntityType.AssetFaceDeleteV1,
      },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });

  it('should not sync an asset face or asset face delete for a user in a different cluster group', async () => {
    const { auth, ctx } = await setup();
    const personRepo = ctx.get(PersonRepository);
    const { user: user2 } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user2.id });
    const { asset } = await ctx.newAsset({ ownerId: user2.id });
    const { person } = await ctx.newPerson({ ownerId: user2.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    const auth2 = factory.auth({ session, user: user2 });

    expect(await ctx.syncStream(auth2, [SyncRequestType.AssetFacesV3])).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetFaceV3 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV3]);

    await personRepo.deleteAssetFace(assetFace.id);

    expect(await ctx.syncStream(auth2, [SyncRequestType.AssetFacesV3])).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetFaceDeleteV1 }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV3]);
  });

  it('should detect and sync a deleted asset face without a person', async () => {
    const { auth, ctx } = await setup();
    const personRepo = ctx.get(PersonRepository);
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
    await personRepo.deleteAssetFace(assetFace.id);

    expect(await ctx.syncStream(auth, [SyncRequestType.AssetFacesV3])).toEqual([
      { ack: expect.any(String), data: { assetFaceId: assetFace.id }, type: SyncEntityType.AssetFaceDeleteV1 },
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
  });
});

describe.each([
  { request: SyncRequestType.AssetFacesV2, entity: SyncEntityType.AssetFaceV2, shared: false },
  { request: SyncRequestType.AssetFacesV3, entity: SyncEntityType.AssetFaceV3, shared: false },
  { request: SyncRequestType.AssetFacesV3, entity: SyncEntityType.AssetFaceV3, shared: true },
])('fork face privacy ($request, shared=$shared)', ({ request, entity, shared }) => {
  it('filters NSFW upserts and deletes while retaining safe faces and elevated access', async () => {
    const { auth, user, ctx } = await setup();
    const { user: owner } = shared ? await ctx.newUser({ clusterGroupId: user.clusterGroupId }) : { user };
    const ownerId = owner.id;
    const { asset: hidden } = await ctx.newAsset({ ownerId, is_nsfw: true });
    const { asset: safe } = await ctx.newAsset({ ownerId, is_nsfw: false });
    const { assetFace: hiddenFace } = await ctx.newAssetFace({ assetId: hidden.id });
    const { assetFace: safeFace } = await ctx.newAssetFace({ assetId: safe.id });
    const restricted = { ...auth, hideNsfwAssets: true };

    expect(await ctx.syncStream(restricted, [request])).toEqual([
      expect.objectContaining({ type: entity, data: expect.objectContaining({ id: safeFace.id }) }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    const elevated = { ...auth, session: { ...auth.session!, hasElevatedPermission: true } };
    const elevatedUpserts = await ctx.syncStream(elevated, [request]);
    // Faces created in the same millisecond need not have update IDs in insertion order.
    expect(elevatedUpserts).toHaveLength(3);
    expect(elevatedUpserts.slice(0, -1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: entity, data: expect.objectContaining({ id: hiddenFace.id }) }),
        expect.objectContaining({ type: entity, data: expect.objectContaining({ id: safeFace.id }) }),
      ]),
    );
    expect(elevatedUpserts.at(-1)).toEqual(expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }));

    await ctx.get(PersonRepository).deleteAssetFace(hiddenFace.id);
    await ctx.get(PersonRepository).deleteAssetFace(safeFace.id);
    expect(await ctx.syncStream(restricted, [request])).toEqual([
      expect.objectContaining({ type: SyncEntityType.AssetFaceDeleteV1, data: { assetFaceId: safeFace.id } }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    const elevatedDeletes = await ctx.syncStream(elevated, [request]);
    expect(elevatedDeletes).toHaveLength(3);
    expect(elevatedDeletes.slice(0, -1)).toEqual(
      expect.arrayContaining([
        expect.objectContaining({ type: SyncEntityType.AssetFaceDeleteV1, data: { assetFaceId: hiddenFace.id } }),
        expect.objectContaining({ type: SyncEntityType.AssetFaceDeleteV1, data: { assetFaceId: safeFace.id } }),
      ]),
    );
    expect(elevatedDeletes.at(-1)).toEqual(expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }));
  });

  it('honors tag suppression for upserts and deletes', async () => {
    const { auth, user, ctx } = await setup();
    const { user: owner } = shared ? await ctx.newUser({ clusterGroupId: user.clusterGroupId }) : { user };
    const ownerId = owner.id;
    const { asset } = await ctx.newAsset({ ownerId });
    const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
    const { tag } = await ctx.newTag({ userId: ownerId, value: 'suppressed' });
    await ctx.newTagAsset({ tagIds: [tag.id!], assetIds: [asset.id] });
    const restricted = {
      ...auth,
      hiddenContent: {
        userId: user.id,
        includeNsfw: false,
        tagIds: [tag.id!],
        personIds: [],
        petIds: [],
        scope: 'visible' as const,
      },
    };

    await ctx.assertSyncIsComplete(restricted, [request]);
    expect(await ctx.syncStream(auth, [request])).toEqual([
      expect.objectContaining({ type: entity, data: expect.objectContaining({ id: assetFace.id }) }),
      expect.objectContaining({ type: SyncEntityType.SyncCompleteV1 }),
    ]);
    await ctx.get(PersonRepository).deleteAssetFace(assetFace.id);
    await ctx.assertSyncIsComplete(restricted, [request]);
  });
});

describe('cluster face visibility', () => {
  it.each([AssetVisibility.Hidden, AssetVisibility.Locked])(
    'does not expose %s faces to cluster members',
    async (visibility) => {
      const { auth, user, ctx } = await setup();
      const { user: owner } = await ctx.newUser({ clusterGroupId: user.clusterGroupId });
      const { asset } = await ctx.newAsset({ ownerId: owner.id, visibility });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id });
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV3]);
      await ctx.get(PersonRepository).deleteAssetFace(assetFace.id);
      await ctx.assertSyncIsComplete(auth, [SyncRequestType.AssetFacesV3]);
    },
  );
});
