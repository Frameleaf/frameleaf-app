import { ForbiddenException, UnauthorizedException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { createHmac, randomUUID } from 'node:crypto';
import {
  AssetLockReason,
  AssetVisibility,
  MediaOperationDestination,
  MediaOperationKind,
  Permission,
  PetObservationState,
  PushPlatform,
  UserMetadataKey,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ApiKeyRepository } from 'src/repositories/api-key.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { ItemShareRepository } from 'src/repositories/item-share.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { PushDeviceRepository } from 'src/repositories/push-device.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { CastService } from 'src/services/cast.service.js';
import { CastMediaKind } from 'src/utils/cast-media.js';
import { HiddenContentFilter } from 'src/utils/hidden-content.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const tokenOf = (path: string) => path.replace('/api/cast/', '');
const setup = () => {
  const { ctx, sut } = newMediumService(CastService, {
    database: db,
    real: [AccessRepository, AssetRepository, UserRepository, SessionRepository, ApiKeyRepository],
    mock: [LoggingRepository, CryptoRepository, ConfigRepository],
  });
  ctx
    .getMock(ConfigRepository)
    .getEnv.mockReturnValue({ frameleafCloud: { identityDir: '/tmp/cast-test-identity' } } as never);
  ctx
    .getMock(CryptoRepository)
    .serverKeyedHash.mockImplementation((_directory, purpose, value) =>
      Promise.resolve(createHmac('sha256', 'synthetic-cast-key').update(`${purpose}\0${value}`).digest('base64url')),
    );
  return { ctx, sut, assets: ctx.get(AssetRepository) };
};

describe('Cast media database privacy and live authority', () => {
  it('allows the owner, denies unrelated users, and rechecks album and item share revocation at read', async () => {
    const { ctx, sut, assets } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: viewer } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { session: ownerSession } = await ctx.newSession({ userId: owner.id });
    const { session } = await ctx.newSession({ userId: viewer.id });
    const auth = factory.auth({ user: viewer, session });
    await expect(assets.isCastable(asset.id)).resolves.toBe(true);
    await expect(
      sut.createMediaUrl(factory.auth({ user: owner, session: ownerSession }), asset.id, {
        kind: CastMediaKind.Preview,
      }),
    ).resolves.toMatchObject({ assetId: asset.id });
    await expect(sut.createMediaUrl(auth, asset.id, { kind: CastMediaKind.Preview })).rejects.toThrow();
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
    await ctx.newAlbumUser({ albumId: album.id, userId: viewer.id });
    const albumLink = await sut.createMediaUrl(auth, asset.id, { kind: CastMediaKind.Preview });
    await expect(sut.resolveMediaUrl(tokenOf(albumLink.path))).resolves.toMatchObject({ assetId: asset.id });
    await db.deleteFrom('album_user').where('albumId', '=', album.id).where('userId', '=', viewer.id).execute();
    await expect(sut.resolveMediaUrl(tokenOf(albumLink.path))).rejects.toThrow();
    const shares = new ItemShareRepository(db);
    await shares.add(owner.id, [asset.id], [viewer.id]);
    const itemLink = await sut.createMediaUrl(auth, asset.id, { kind: CastMediaKind.Preview });
    await expect(sut.resolveMediaUrl(tokenOf(itemLink.path))).resolves.toMatchObject({ assetId: asset.id });
    await shares.remove(owner.id, [asset.id], [viewer.id]);
    await expect(sut.resolveMediaUrl(tokenOf(itemLink.path))).rejects.toThrow();
  });

  it('refuses explicit visibility, persisted rule locks, trash and missing rows, including after issue', async () => {
    const { ctx, sut, assets } = setup();
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    const auth = factory.auth({ user, session });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const link = await sut.createMediaUrl(auth, asset.id, { kind: CastMediaKind.Preview });
    await db.updateTable('asset').set({ visibility: AssetVisibility.Locked }).where('id', '=', asset.id).execute();
    await expect(assets.isCastable(asset.id)).resolves.toBe(false);
    await db.updateTable('asset').set({ visibility: AssetVisibility.Timeline }).where('id', '=', asset.id).execute();
    await db
      .insertInto('asset_lock')
      .values({ assetId: asset.id, reason: AssetLockReason.Detected, lockedBy: null, previousVisibility: null })
      .execute();
    await expect(assets.isCastable(asset.id)).resolves.toBe(false);
    await expect(sut.resolveMediaUrl(tokenOf(link.path))).rejects.toThrow();
    await db.deleteFrom('asset_lock').where('assetId', '=', asset.id).execute();
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();
    await expect(assets.isCastable(asset.id)).resolves.toBe(false);
    await expect(sut.resolveMediaUrl(tokenOf(link.path))).rejects.toThrow();
    await expect(assets.isCastable(randomUUID())).resolves.toBe(false);
  });

  it('applies caller person, pet and nested-tag suppression with owned and visible scope', async () => {
    const { ctx, assets } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const own = (await ctx.newAsset({ ownerId: user.id })).asset;
    const shared = (await ctx.newAsset({ ownerId: other.id })).asset;
    const { person } = await ctx.newPerson({ ownerId: user.id });
    for (const asset of [own, shared])
      await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    const filter: HiddenContentFilter = {
      userId: user.id,
      includeNsfw: false,
      scope: 'owned',
      personIds: [person.personGroupId],
      petIds: [],
      tagIds: [],
    };
    await expect(assets.isCastable(own.id, filter)).resolves.toBe(false);
    await expect(assets.isCastable(shared.id, filter)).resolves.toBe(true);
    await expect(assets.isCastable(shared.id, { ...filter, scope: 'visible' })).resolves.toBe(false);
    await db.updateTable('asset_face').set({ isVisible: false }).where('assetId', '=', own.id).execute();
    await expect(assets.isCastable(own.id, filter)).resolves.toBe(true);
    const pet = await db
      .insertInto('pet')
      .values({ ownerId: user.id, name: 'Synthetic pet', birthDate: null, featuredAssetId: null })
      .returningAll()
      .executeTakeFirstOrThrow();
    await db
      .insertInto('pet_observation')
      .values({
        petId: pet.id,
        assetId: own.id,
        state: PetObservationState.Confirmed,
        boundingBoxX1: null,
        boundingBoxX2: null,
        boundingBoxY1: null,
        boundingBoxY2: null,
        imageWidth: null,
        imageHeight: null,
      })
      .execute();
    await expect(assets.isCastable(own.id, { ...filter, personIds: [], petIds: [pet.id] })).resolves.toBe(false);
    await expect(
      assets.isCastable(own.id, { ...filter, userId: other.id, scope: 'visible', personIds: [], petIds: [pet.id] }),
    ).resolves.toBe(true);
    await db
      .updateTable('pet_observation')
      .set({ state: PetObservationState.Rejected })
      .where('petId', '=', pet.id)
      .execute();
    await expect(assets.isCastable(own.id, { ...filter, personIds: [], petIds: [pet.id] })).resolves.toBe(true);
    const { tag: parent } = await ctx.newTag({ userId: user.id, value: 'cast-parent', parentId: null, color: null });
    const { tag: child } = await ctx.newTag({
      userId: user.id,
      value: 'cast-parent/child',
      parentId: parent.id,
      color: null,
    });
    await ctx.newTagAsset({ tagIds: [child.id], assetIds: [own.id, shared.id] });
    const tags = { ...filter, personIds: [], tagIds: [parent.id] };
    await expect(assets.isCastable(own.id, tags)).resolves.toBe(false);
    await expect(assets.isCastable(shared.id, tags)).resolves.toBe(true);
    await expect(assets.isCastable(shared.id, { ...tags, scope: 'visible' })).resolves.toBe(false);
  });

  it('rechecks newly hidden content, session expiry and API-key permissions/revocation', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const auth = factory.auth({ user, session });
    const link = await sut.createMediaUrl(auth, asset.id, { kind: CastMediaKind.Preview });
    const { person } = await ctx.newPerson({ ownerId: user.id });
    await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
    await ctx.get(UserRepository).upsertMetadata(user.id, {
      key: UserMetadataKey.Preferences,
      value: {
        privacy: { suppression: { personIds: [person.personGroupId], petIds: [], tagIds: [], scope: 'owned' } },
      },
    });
    await expect(sut.resolveMediaUrl(tokenOf(link.path))).rejects.toThrow();
    await ctx.get(UserRepository).upsertMetadata(user.id, { key: UserMetadataKey.Preferences, value: {} });
    await db
      .updateTable('session')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', session.id)
      .execute();
    await expect(sut.resolveMediaUrl(tokenOf(link.path))).rejects.toBeInstanceOf(UnauthorizedException);
    const keys = ctx.get(ApiKeyRepository);
    const key = await keys.create({
      userId: user.id,
      name: 'Cast fixture',
      key: Buffer.alloc(32, 1),
      permissions: [Permission.AssetView],
    });
    const keyAuth = factory.auth({ user, apiKey: { id: key.id, permissions: key.permissions } });
    await expect(sut.createMediaUrl(keyAuth, asset.id, { kind: CastMediaKind.Original })).rejects.toBeInstanceOf(
      ForbiddenException,
    );
    const keyLink = await sut.createMediaUrl(keyAuth, asset.id, { kind: CastMediaKind.Preview });
    await expect(sut.resolveMediaUrl(tokenOf(keyLink.path))).resolves.toMatchObject({ assetId: asset.id });
    await keys.update(user.id, key.id, { permissions: [] });
    await expect(sut.resolveMediaUrl(tokenOf(keyLink.path))).rejects.toBeInstanceOf(ForbiddenException);
    await keys.delete(user.id, key.id);
    await expect(sut.resolveMediaUrl(tokenOf(keyLink.path))).rejects.toBeInstanceOf(UnauthorizedException);
  });

  it('persists only owned Studio render bindings and fails closed for legacy or invalid bindings', async () => {
    const { ctx } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    const devices = new PushDeviceRepository(db);
    const device = await devices.upsert({
      userId: user.id,
      sessionId: session.id,
      platform: PushPlatform.Ios,
      pushToken: 'fixture-device-token',
      pushToStartToken: null,
      apnsEnvironment: null,
      publicKey: Buffer.alloc(32, 1).toString('base64url'),
      backupDeviceKey: null,
      disabledEvents: [],
    });
    const operations = new MediaOperationRepository(db);
    const owned = await operations.create({
      ownerId: user.id,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.Local,
      label: 'Render',
      snapshot: {},
      settings: {},
    });
    const next = await operations.create({
      ownerId: user.id,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.Local,
      label: 'Next render',
      snapshot: {},
      settings: {},
    });
    const foreign = await operations.create({
      ownerId: other.id,
      kind: MediaOperationKind.StudioExport,
      destination: MediaOperationDestination.Local,
      label: 'Other render',
      snapshot: {},
      settings: {},
    });
    await expect(
      devices.setActivity(device.id, { activityId: 'unbound', kind: 'studio-render', token: 'fixture' }),
    ).rejects.toBeInstanceOf(Error);
    await expect(
      devices.setActivity(device.id, {
        activityId: 'foreign',
        kind: 'studio-render',
        token: 'fixture',
        operationId: foreign.id,
      }),
    ).rejects.toBeInstanceOf(Error);
    await devices.setActivity(device.id, {
      activityId: 'owned',
      kind: 'studio-render',
      token: 'fixture',
      operationId: owned.id,
    });
    await expect(
      devices.setActivity(device.id, {
        activityId: 'owned',
        kind: 'studio-render',
        token: 'fixture',
        operationId: next.id,
      }),
    ).rejects.toBeInstanceOf(Error);
    await db
      .insertInto('push_device_activity')
      .values({ deviceId: device.id, activityId: 'legacy', kind: 'studio-render', token: 'fixture', operationId: null })
      .execute();
    expect((await devices.getDeliveryTargets([user.id]))[0].activities.map(({ activityId }) => activityId)).toEqual([
      'owned',
    ]);
    await db.deleteFrom('media_operation').where('id', '=', owned.id).execute();
    expect((await devices.getDeliveryTargets([user.id]))[0].activities).toEqual([]);
  });
});
