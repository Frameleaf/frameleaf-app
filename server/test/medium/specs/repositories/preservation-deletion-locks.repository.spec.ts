import { Kysely } from 'kysely';
import { AssetLockReason, MediaOperationDestination, StudioExportVersionState, UserMetadataKey } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PreservationRepository } from 'src/repositories/preservation.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
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
  return { ctx, assets: ctx.get(AssetRepository), preservation: new PreservationRepository(db) };
};

const setTagRules = (userId: string, tagIds: string[]) => {
  const value = { privacy: { suppression: { tagIds } } };
  return db
    .insertInto('user_metadata')
    .values({ userId, key: UserMetadataKey.Preferences, value } as never)
    .onConflict((oc) => oc.columns(['userId', 'key']).doUpdateSet({ value } as never))
    .execute();
};

/** Both an already copied package and a matched restore predate the new privacy rule. */
const retainCopies = async (sut: PreservationRepository, ownerId: string, assetIds: string[]) => {
  const result = await sut.createExport(
    {
      ownerId,
      origin: 'export',
      name: 'Retained copy',
      format: 'directory',
      includeLocked: false,
      includeMetadata: false,
      scope: {},
    },
    (id) => `/exports/${id}`,
    { assetIds },
    false,
    100,
  );
  const packageId = result!.package.id;
  const { items } = await sut.listItems(packageId, { take: 100, skip: 0 });
  expect(items).toHaveLength(assetIds.length);
  expect(items.every((item) => !item.locked)).toBe(true);
  for (const item of items) {
    await sut.finishItem(item.id, {
      state: 'copied',
      entry: { sourceAssetId: item.sourceAssetId, original: { bytes: 100 } },
    });
  }
  const restore = await sut.createRestore({ ownerId, packageId, name: 'Matched copy', status: 'ready', options: {} });
  await sut.addRestoreItems(
    restore.id,
    assetIds.map((sourceAssetId) => ({ sourceAssetId, locked: false, entry: { sourceAssetId } })),
  );
  const { items: restoreItems } = await sut.listRestoreItems(restore.id, { take: 100, skip: 0 });
  for (const item of restoreItems) {
    await sut.updateRestoreItem(item.id, { assetId: item.sourceAssetId, state: 'ready', match: 'existing' });
  }
  return { packageId, restoreId: restore.id };
};

const storedLocks = async (packageId: string, restoreId: string) => {
  const exports = await db
    .selectFrom('preservation_item')
    .select(['sourceAssetId', 'assetId', 'locked'])
    .where('packageId', '=', packageId)
    .execute();
  const restores = await db
    .selectFrom('preservation_restore_item')
    .select(['sourceAssetId', 'assetId', 'locked'])
    .where('restoreId', '=', restoreId)
    .execute();
  return [exports, restores].map((items) =>
    Object.fromEntries(items.map(({ sourceAssetId, assetId, locked }) => [sourceAssetId, { assetId, locked }])),
  );
};

const removeAssets = async (sut: AssetRepository, mode: 'remove' | 'deleteAll', ownerId: string, ids: string[]) => {
  if (mode === 'deleteAll') {
    await sut.deleteAll(ownerId);
  } else {
    for (const id of ids) {
      await sut.remove({ id });
    }
  }
};

const exportedFrom = async (
  ownerId: string,
  resultAssetId: string,
  sources: { id: string; ownerId: string }[],
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
    .values(
      sources.map((source, index) => ({
        versionId: version.id,
        key: `source-${index}`,
        kind: 'asset',
        resourceId: source.id,
        assetId: source.id,
        ownerId: source.ownerId,
        checksum: null,
        sourceAccess: 'owner',
      })),
    )
    .execute();
};

describe('preservation retains privacy when source assets are deleted (FL-1344)', () => {
  it.each(['remove', 'deleteAll'] as const)(
    '%s snapshots effective rules and explicit locks before cascading metadata',
    async (mode) => {
      const { ctx, assets, preservation } = setup();
      const { user: owner } = await ctx.newUser();
      const { asset: tagged } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: marked } = await ctx.newAsset({ ownerId: owner.id });
      const { asset: plain } = await ctx.newAsset({ ownerId: owner.id });
      const { tag } = await ctx.newTag({ userId: owner.id, value: 'Private' });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [tagged.id] });
      const ids = [tagged.id, marked.id, plain.id];
      const { packageId, restoreId } = await retainCopies(preservation, owner.id, ids);
      await setTagRules(owner.id, [tag.id]);
      await db
        .insertInto('asset_lock')
        .values({ assetId: marked.id, reason: AssetLockReason.Marked, lockedBy: null })
        .execute();
      await expect(preservation.hasLockedItems(packageId)).resolves.toBe(true);

      await removeAssets(assets, mode, owner.id, ids);

      const expected = {
        [tagged.id]: { assetId: null, locked: true },
        [marked.id]: { assetId: null, locked: true },
        [plain.id]: { assetId: null, locked: false },
      };
      expect(await storedLocks(packageId, restoreId)).toEqual([expected, expected]);
      // Workers that read before the rule/removal must not replace the newer retained lock.
      const { items } = await preservation.listItems(packageId, { take: 100, skip: 0 });
      for (const item of items) {
        await preservation.finishItem(item.id, { state: 'copied', locked: false });
      }
      expect(await storedLocks(packageId, restoreId)).toEqual([expected, expected]);
      await expect(preservation.hasLockedItems(packageId)).resolves.toBe(true);
      await preservation.upsertListedItems(
        packageId,
        ids.map((sourceAssetId) => ({ sourceAssetId, locked: false, entry: { sourceAssetId } })),
      );
      expect(await storedLocks(packageId, restoreId)).toEqual([expected, expected]);
      await expect(preservation.hasLockedItems(packageId)).resolves.toBe(true);
      await expect(preservation.restrictedPackageIds([packageId])).resolves.toEqual(new Set([packageId]));
      const ordinary = await preservation.listItems(packageId, { take: 100, skip: 0, excludeLocked: true });
      expect(ordinary.items.map((item) => item.sourceAssetId)).toEqual([plain.id]);
      const restore = await preservation.listRestoreItems(restoreId, { take: 100, skip: 0, excludeLocked: true });
      expect(restore.items.map((item) => item.sourceAssetId)).toEqual([plain.id]);

      // A later restoration rereads the original public index, but the retained privacy still applies.
      const later = await preservation.createRestore({
        ownerId: owner.id,
        packageId,
        name: 'Later restore',
        options: {},
      });
      await preservation.addRestoreItems(
        later.id,
        ids.map((sourceAssetId) => ({ sourceAssetId, locked: false, entry: { sourceAssetId, locked: false } })),
      );
      const review = await preservation.reviewWork(later.id, null, 100);
      expect(Object.fromEntries(review.map((item) => [item.sourceAssetId, item.locked]))).toEqual({
        [tagged.id]: true,
        [marked.id]: true,
        [plain.id]: false,
      });
      for (const item of review) await preservation.updateRestoreItem(item.id, { state: 'ready', match: 'new' });
      const work = await preservation.restoreWork(later.id, null, 100, 3);
      expect(Object.fromEntries(work.map((item) => [item.sourceAssetId, item.locked]))).toEqual({
        [tagged.id]: true,
        [marked.id]: true,
        [plain.id]: false,
      });
      expect(work.every((item) => item.entry?.locked === false)).toBe(true);
    },
  );

  it.each(['remove', 'deleteAll'] as const)('%s does not freeze a rule cleared before removal', async (mode) => {
    const { ctx, assets, preservation } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { tag } = await ctx.newTag({ userId: owner.id, value: 'Formerly private' });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
    const { packageId, restoreId } = await retainCopies(preservation, owner.id, [asset.id]);
    await setTagRules(owner.id, [tag.id]);
    await expect(preservation.hasLockedItems(packageId)).resolves.toBe(true);
    await setTagRules(owner.id, []);

    await removeAssets(assets, mode, owner.id, [asset.id]);

    const expected = { [asset.id]: { assetId: null, locked: false } };
    expect(await storedLocks(packageId, restoreId)).toEqual([expected, expected]);
    await expect(preservation.hasLockedItems(packageId)).resolves.toBe(false);
    await expect(preservation.restrictedPackageIds([packageId])).resolves.toEqual(new Set());
  });

  it('rolls back the snapshot with an unsuccessful removal', async () => {
    const { ctx, assets, preservation } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { tag } = await ctx.newTag({ userId: owner.id, value: 'Private' });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
    const { packageId, restoreId } = await retainCopies(preservation, owner.id, [asset.id]);
    await setTagRules(owner.id, [tag.id]);

    await expect(
      assets.remove(asset, {
        files: ({ originalPath }) => [originalPath],
        queue: () => Promise.reject(new Error('queue unavailable')),
      }),
    ).rejects.toThrow('queue unavailable');

    const expected = { [asset.id]: { assetId: asset.id, locked: false } };
    expect(await storedLocks(packageId, restoreId)).toEqual([expected, expected]);
    await setTagRules(owner.id, []);
    await expect(preservation.hasLockedItems(packageId)).resolves.toBe(false);
    await expect(preservation.restrictedPackageIds([packageId])).resolves.toEqual(new Set());
  });

  it.each(['remove', 'deleteAll'] as const)(
    '%s retains private copies of published Studio descendants owned by another account',
    async (mode) => {
      const { ctx, assets, preservation } = setup();
      const { user: donor } = await ctx.newUser();
      const { user: editor } = await ctx.newUser();
      const { asset: source } = await ctx.newAsset({ ownerId: donor.id });
      const { asset: first } = await ctx.newAsset({ ownerId: editor.id });
      const { asset: second } = await ctx.newAsset({ ownerId: editor.id });
      const { asset: staged } = await ctx.newAsset({ ownerId: editor.id });
      await exportedFrom(editor.id, first.id, [source]);
      await exportedFrom(editor.id, second.id, [first]);
      await exportedFrom(editor.id, staged.id, [source], StudioExportVersionState.Staged);
      const { tag } = await ctx.newTag({ userId: donor.id, value: 'Private donor' });
      await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [source.id] });
      const { packageId, restoreId } = await retainCopies(preservation, editor.id, [first.id, second.id, staged.id]);
      await setTagRules(donor.id, [tag.id]);
      await expect(preservation.hasLockedItems(packageId)).resolves.toBe(true);

      await removeAssets(assets, mode, donor.id, [source.id]);

      const expected = {
        [first.id]: { assetId: first.id, locked: true },
        [second.id]: { assetId: second.id, locked: true },
        [staged.id]: { assetId: staged.id, locked: false },
      };
      expect(await storedLocks(packageId, restoreId)).toEqual([expected, expected]);
      await expect(preservation.hasLockedItems(packageId)).resolves.toBe(true);
      await expect(preservation.restrictedPackageIds([packageId])).resolves.toEqual(new Set([packageId]));
      expect(
        (await preservation.listItems(packageId, { take: 100, skip: 0, excludeLocked: true })).items.map(
          (item) => item.assetId,
        ),
      ).toEqual([staged.id]);
      expect(
        (await preservation.listRestoreItems(restoreId, { take: 100, skip: 0, excludeLocked: true })).items.map(
          (item) => item.assetId,
        ),
      ).toEqual([staged.id]);
    },
  );

  it('does not freeze a separate donor rule when the removed Studio donor is public', async () => {
    const { ctx, assets, preservation } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset: privateDonor } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: publicDonor } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: result } = await ctx.newAsset({ ownerId: owner.id });
    await exportedFrom(owner.id, result.id, [privateDonor, publicDonor]);
    const { tag } = await ctx.newTag({ userId: owner.id, value: 'Private donor' });
    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [privateDonor.id] });
    const { packageId, restoreId } = await retainCopies(preservation, owner.id, [result.id]);
    await setTagRules(owner.id, [tag.id]);

    await assets.remove(publicDonor);

    const expected = { [result.id]: { assetId: result.id, locked: false } };
    expect(await storedLocks(packageId, restoreId)).toEqual([expected, expected]);
    await expect(preservation.hasLockedItems(packageId)).resolves.toBe(true);
    await setTagRules(owner.id, []);
    await expect(preservation.hasLockedItems(packageId)).resolves.toBe(false);
    await expect(preservation.restrictedPackageIds([packageId])).resolves.toEqual(new Set());
  });
});
