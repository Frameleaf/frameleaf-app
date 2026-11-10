import { Kysely } from 'kysely';
import {
  AssetVisibility,
  MediaOperationDestination,
  PetObservationState,
  StudioExportVersionState,
  UserMetadataKey,
} from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PreservationRepository } from 'src/repositories/preservation.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { newUuid } from 'test/small.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;

beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new PreservationRepository(db) };
};

const setLockedRules = (
  userId: string,
  suppression: { tagIds?: string[]; personIds?: string[]; petIds?: string[] },
) => {
  const value = { privacy: { suppression } };
  return db
    .insertInto('user_metadata')
    .values({ userId, key: UserMetadataKey.Preferences, value } as never)
    .onConflict((oc) => oc.columns(['userId', 'key']).doUpdateSet({ value } as never))
    .execute();
};

const createExport = async (
  sut: PreservationRepository,
  ownerId: string,
  assetIds: string[],
  includeLocked = false,
) => {
  const result = await sut.createExport(
    {
      ownerId,
      origin: 'export',
      name: 'Locked rule coverage',
      format: 'directory',
      includeLocked,
      includeMetadata: false,
      scope: {},
    },
    (id) => `/exports/${id}`,
    { assetIds },
    includeLocked,
    100,
  );
  expect(result).not.toBeNull();
  return result!.package.id;
};

const itemLocks = async (sut: PreservationRepository, packageId: string) => {
  const { items } = await sut.listItems(packageId, { take: 100, skip: 0 });
  return Object.fromEntries(items.map((item) => [item.assetId!, item.locked]));
};

/** Associations exist before the rule is enabled; none of these assets has an explicit asset_lock. */
const ruleFixture = async () => {
  const { ctx, sut } = setup();
  const { user: owner } = await ctx.newUser();
  const asset = async () => {
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    await ctx.newExif({ assetId: asset.id, fileSizeInByte: 100 });
    return asset.id;
  };
  const items = {
    plain: await asset(),
    tagged: await asset(),
    faced: await asset(),
    petted: await asset(),
    invisibleFace: await asset(),
    deletedFace: await asset(),
    rejectedPet: await asset(),
  };
  const { tag: parent } = await ctx.newTag({ userId: owner.id, value: 'Private' });
  const { tag: child } = await ctx.newTag({ userId: owner.id, value: 'Private/Child', parentId: parent.id });
  await ctx.newTagAsset({ tagIds: [child.id], assetIds: [items.tagged] });
  const { person } = await ctx.newPerson({ ownerId: owner.id });
  await ctx.newAssetFace({ assetId: items.faced, personGroupId: person.personGroupId });
  await ctx.newAssetFace({ assetId: items.invisibleFace, personGroupId: person.personGroupId, isVisible: false });
  await ctx.newAssetFace({ assetId: items.deletedFace, personGroupId: person.personGroupId, deletedAt: new Date() });
  const pet = await db
    .insertInto('pet')
    .values({ ownerId: owner.id, name: 'Private pet', birthDate: null, featuredAssetId: null })
    .returning('id')
    .executeTakeFirstOrThrow();
  for (const [assetId, state] of [
    [items.petted, PetObservationState.Confirmed],
    [items.rejectedPet, PetObservationState.Rejected],
  ] as const) {
    await db
      .insertInto('pet_observation')
      .values({
        assetId,
        petId: pet.id,
        state,
        boundingBoxX1: null,
        boundingBoxX2: null,
        boundingBoxY1: null,
        boundingBoxY2: null,
        imageWidth: null,
        imageHeight: null,
      })
      .execute();
  }
  const rules = { tagIds: [parent.id], personIds: [person.personGroupId], petIds: [pet.id] };
  const privateIds = [items.tagged, items.faced, items.petted];
  const publicIds = [items.plain, items.invisibleFace, items.deletedFace, items.rejectedPet];
  return { ctx, sut, owner, items, rules, privateIds, publicIds, assetIds: Object.values(items) };
};

const exportOf = async (
  ownerId: string,
  resultAssetId: string,
  source: { assetId: string; ownerId: string },
  state = StudioExportVersionState.Published,
) => {
  const version = await db
    .insertInto('studio_export_version')
    .values({
      ownerId,
      resultAssetId,
      revision: 1,
      revisionDigest: 'digest',
      state,
      destination: MediaOperationDestination.Local,
      settings: {},
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('studio_export_version_source')
    .values({
      versionId: version.id,
      key: 'source',
      kind: 'asset',
      resourceId: source.assetId,
      assetId: source.assetId,
      ownerId: source.ownerId,
      checksum: null,
      sourceAccess: 'owner',
    })
    .execute();
};

describe('preservation respects current owner Locked rules (FL-1344)', () => {
  it('splits previews and freezes tag descendants, visible people and confirmed pets only with includeLocked', async () => {
    const { sut, owner, rules, assetIds, privateIds, publicIds } = await ruleFixture();
    await setLockedRules(owner.id, rules);

    expect(await sut.previewSelection(owner.id, { assetIds }, false)).toEqual({
      items: 4,
      bytes: 400,
      lockedItems: 3,
      lockedBytes: 300,
    });
    const ordinary = await createExport(sut, owner.id, assetIds);
    expect(await itemLocks(sut, ordinary)).toEqual(Object.fromEntries(publicIds.map((id) => [id, false])));

    const elevated = await createExport(sut, owner.id, assetIds, true);
    expect(await itemLocks(sut, elevated)).toEqual({
      ...Object.fromEntries(publicIds.map((id) => [id, false])),
      ...Object.fromEntries(privateIds.map((id) => [id, true])),
    });
    await expect(sut.restrictedPackageIds([ordinary, elevated])).resolves.toEqual(new Set([elevated]));
  });

  it.each(['copied', 'listed'] as const)(
    'rechecks rules after admission for %s items and retains the private snapshot after rules are cleared',
    async (state) => {
      const { sut, owner, rules, assetIds, privateIds, publicIds } = await ruleFixture();
      const packageId = await createExport(sut, owner.id, assetIds);
      const { items } = await sut.listItems(packageId, { take: 100, skip: 0 });
      expect(items).toHaveLength(7);
      expect(items.every((item) => !item.locked)).toBe(true);
      await expect(sut.lockedItemIds(items)).resolves.toEqual(new Set());

      for (const item of items) {
        await sut.finishItem(item.id, {
          state,
          entry: { sourceAssetId: item.sourceAssetId, original: { bytes: 100 } },
        });
      }
      await expect(sut.hasLockedItems(packageId)).resolves.toBe(false);
      await expect(sut.restrictedPackageIds([packageId])).resolves.toEqual(new Set());
      await setLockedRules(owner.id, rules);
      for (const id of assetIds) {
        expect(await sut.getExportAsset(id)).toMatchObject({ id, isLocked: privateIds.includes(id) });
      }
      const expectedPrivate = new Set(
        items.filter((item) => privateIds.includes(item.assetId!)).map((item) => item.id),
      );
      await expect(sut.lockedItemIds(items)).resolves.toEqual(expectedPrivate);
      await expect(sut.hasLockedItems(packageId)).resolves.toBe(true);
      await expect(sut.restrictedPackageIds([packageId])).resolves.toEqual(new Set([packageId]));
      const ordinary = await sut.listItems(packageId, { take: 100, skip: 0, excludeLocked: true });
      expect(ordinary.total).toBe(4);
      expect(new Set(ordinary.items.map((item) => item.assetId))).toEqual(new Set(publicIds));
      expect((await sut.countItems([packageId])).get(packageId)).toEqual({
        states: { [state]: 7 },
        locked: 3,
        bytes: 700,
        unavailable: 0,
      });
      expect((await sut.countItems([packageId], { excludeLocked: true })).get(packageId)).toEqual({
        states: { [state]: 4 },
        locked: 0,
        bytes: 400,
        unavailable: 0,
      });

      // An export admitted while private keeps that snapshot, even if the owner removes the rule later.
      const privatePackage = await createExport(sut, owner.id, privateIds, true);
      const { items: privateItems } = await sut.listItems(privatePackage, { take: 100, skip: 0 });
      for (const item of privateItems) {
        await sut.finishItem(item.id, { state });
      }
      await setLockedRules(owner.id, {});
      await expect(sut.lockedItemIds(items)).resolves.toEqual(new Set());
      await expect(sut.hasLockedItems(packageId)).resolves.toBe(false);
      expect((await sut.listItems(packageId, { take: 100, skip: 0, excludeLocked: true })).total).toBe(7);
      expect((await sut.countItems([packageId], { excludeLocked: true })).get(packageId)).toMatchObject({
        states: { [state]: 7 },
        locked: 0,
        bytes: 700,
      });
      for (const id of privateIds) {
        expect(await sut.getExportAsset(id)).toMatchObject({ isLocked: false });
      }
      await expect(sut.hasLockedItems(privatePackage)).resolves.toBe(true);
      await expect(sut.restrictedPackageIds([packageId, privatePackage])).resolves.toEqual(new Set([privatePackage]));
      await expect(sut.lockedItemIds(privateItems)).resolves.toEqual(new Set(privateItems.map((item) => item.id)));
      expect((await sut.listItems(privatePackage, { take: 100, skip: 0, excludeLocked: true })).total).toBe(0);
    },
  );

  it('hides matched restoration items from lists, counts and the decision guard when rules change', async () => {
    const { sut, owner, rules, assetIds, privateIds, publicIds } = await ruleFixture();
    // Its own exported item stays public; only the restoration matches can restrict this package.
    const packageId = await createExport(sut, owner.id, [publicIds[0]]);
    const restore = await sut.createRestore({
      ownerId: owner.id,
      packageId,
      name: 'Rule-aware restore',
      status: 'ready',
      options: {},
    });
    await sut.addRestoreItems(
      restore.id,
      assetIds.map((id) => ({ sourceAssetId: id, locked: false, entry: { sourceAssetId: id } })),
    );
    const { items } = await sut.listRestoreItems(restore.id, { take: 100, skip: 0 });
    for (const item of items) {
      await sut.updateRestoreItem(item.id, {
        state: 'ready',
        match: 'existing',
        assetId: item.sourceAssetId,
        conflicts: [{ field: 'description', library: 'Current description', package: 'Archived description' }],
        findings: ['metadata_changed'],
      });
    }
    const itemIds = items.map((item) => item.id);
    expect(await sut.lockedRestoreItemIds(restore.id, itemIds)).toEqual([]);
    await expect(sut.restrictedPackageIds([packageId])).resolves.toEqual(new Set());

    await setLockedRules(owner.id, rules);
    const hiddenIds = items.filter((item) => privateIds.includes(item.sourceAssetId)).map((item) => item.id);
    expect(new Set(await sut.lockedRestoreItemIds(restore.id, itemIds))).toEqual(new Set(hiddenIds));
    await expect(sut.restrictedPackageIds([packageId])).resolves.toEqual(new Set([packageId]));
    const ordinary = await sut.listRestoreItems(restore.id, { take: 100, skip: 0, excludeLocked: true });
    expect(ordinary.total).toBe(4);
    expect(new Set(ordinary.items.map((item) => item.assetId))).toEqual(new Set(publicIds));
    expect(await sut.countRestoreItems(restore.id)).toMatchObject({
      total: 7,
      ready: 7,
      existing: 7,
      locked: 3,
      conflicts: 7,
      findings: 7,
    });
    expect(await sut.countRestoreItems(restore.id, { excludeLocked: true })).toMatchObject({
      total: 4,
      ready: 4,
      existing: 4,
      locked: 0,
      conflicts: 4,
      findings: 4,
    });
    await setLockedRules(owner.id, {});
    expect(await sut.lockedRestoreItemIds(restore.id, itemIds)).toEqual([]);
    await expect(sut.restrictedPackageIds([packageId])).resolves.toEqual(new Set());
    expect((await sut.listRestoreItems(restore.id, { take: 100, skip: 0, excludeLocked: true })).total).toBe(7);

    const privateSource = newUuid();
    await sut.addRestoreItems(restore.id, [
      { sourceAssetId: privateSource, locked: true, entry: { sourceAssetId: privateSource } },
    ]);
    const { items: withSnapshot } = await sut.listRestoreItems(restore.id, { take: 100, skip: 0 });
    const snapshotId = withSnapshot.find((item) => item.sourceAssetId === privateSource)!.id;
    expect(await sut.lockedRestoreItemIds(restore.id, [...itemIds, snapshotId])).toEqual([snapshotId]);
    await expect(sut.restrictedPackageIds([packageId])).resolves.toEqual(new Set([packageId]));
  });

  it('applies the motion asset’s current rule when adding a Live Photo companion', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset: privateMotion } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Hidden });
    const { asset: plainMotion } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Hidden });
    const { asset: privateStill } = await ctx.newAsset({ ownerId: owner.id, livePhotoVideoId: privateMotion.id });
    const { asset: plainStill } = await ctx.newAsset({ ownerId: owner.id, livePhotoVideoId: plainMotion.id });
    const { tag } = await ctx.newTag({ userId: owner.id, value: 'Private motion' });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [privateMotion.id] });
    await setLockedRules(owner.id, { tagIds: [tag.id] });

    const selected = [privateStill.id, plainStill.id];
    const expectedPublic = { [privateStill.id]: false, [plainStill.id]: false, [plainMotion.id]: false };
    expect(await itemLocks(sut, await createExport(sut, owner.id, selected))).toEqual(expectedPublic);
    expect(await itemLocks(sut, await createExport(sut, owner.id, selected, true))).toEqual({
      ...expectedPublic,
      [privateMotion.id]: true,
    });
  });

  it('inherits current rules through published Studio source lineage, including another source owner', async () => {
    const { ctx, sut, owner: sourceOwner, items, rules } = await ruleFixture();
    const { user: maker } = await ctx.newUser();
    const { asset: exported } = await ctx.newAsset({ ownerId: maker.id });
    const { asset: reexported } = await ctx.newAsset({ ownerId: maker.id });
    const { asset: staged } = await ctx.newAsset({ ownerId: maker.id });
    const source = { assetId: items.tagged, ownerId: sourceOwner.id };
    await exportOf(maker.id, exported.id, source);
    await exportOf(maker.id, reexported.id, { assetId: exported.id, ownerId: maker.id });
    await exportOf(maker.id, staged.id, source, StudioExportVersionState.Staged);
    await setLockedRules(sourceOwner.id, rules);

    const selected = [exported.id, reexported.id, staged.id];
    expect(await sut.previewSelection(maker.id, { assetIds: selected }, false)).toMatchObject({
      items: 1,
      lockedItems: 2,
    });
    expect(await itemLocks(sut, await createExport(sut, maker.id, selected))).toEqual({ [staged.id]: false });
    expect(await itemLocks(sut, await createExport(sut, maker.id, selected, true))).toEqual({
      [exported.id]: true,
      [reexported.id]: true,
      [staged.id]: false,
    });
    expect(await sut.getExportAsset(reexported.id)).toMatchObject({ isLocked: true });
    await setLockedRules(sourceOwner.id, {});
    expect(await sut.getExportAsset(reexported.id)).toMatchObject({ isLocked: false });
  });
});
