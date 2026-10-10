import { Kysely } from 'kysely';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import {
  AssetOriginField,
  PartnerBackfillState,
  PartnerOriginRepository,
} from 'src/repositories/partner-origin.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-326: partner copy origins and backfill cursors (fork migration 0000000000220). */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(PartnerOriginRepository) };
};

it('installs feature tables in the real canonical baseline', async () => {
  await expectCanonicalTables(db, ['album_origin', 'asset_origin', 'person_origin']);
});

describe(PartnerOriginRepository.name, () => {
  it('records a copy, finds its followers and marks overridden fields', async () => {
    const { ctx, sut } = setup();
    const { user: alice } = await ctx.newUser();
    const { user: bob } = await ctx.newUser();
    const { asset: source } = await ctx.newAsset({ ownerId: alice.id });
    const { asset: copy } = await ctx.newAsset({ ownerId: bob.id });

    await sut.createAssetOrigin({
      id: copy.id,
      sourceId: source.id,
      ownerId: bob.id,
      rootOwnerId: alice.id,
      partnerSharedById: alice.id,
    });

    await expect(sut.getOrigin('asset', copy.id)).resolves.toEqual({
      id: copy.id,
      sourceId: source.id,
      ownerId: bob.id,
      rootOwnerId: alice.id,
      partnerSharedById: alice.id,
      overriddenFields: [],
      following: true,
    });
    await expect(sut.getFollowers('asset', source.id)).resolves.toHaveLength(1);
    await expect(sut.getCopyId('asset', source.id, bob.id)).resolves.toBe(copy.id);
    await expect(sut.getCopyId('asset', source.id, alice.id)).resolves.toBeUndefined();

    await sut.markOverridden('asset', [copy.id, source.id], [AssetOriginField.Description]);
    await sut.markOverridden('asset', copy.id, [AssetOriginField.Description, AssetOriginField.Rating]);
    // another user's edit never changes bob's copy
    await sut.markOverridden('asset', copy.id, [AssetOriginField.Location], alice.id);
    await expect(sut.getOrigin('asset', copy.id)).resolves.toMatchObject({
      overriddenFields: [AssetOriginField.Description, AssetOriginField.Rating],
    });
    // a source is never a copy
    await expect(sut.getOrigin('asset', source.id)).resolves.toBeUndefined();
  });

  it('stops following when the partnership ends, keeping the copies', async () => {
    const { ctx, sut } = setup();
    const { user: alice } = await ctx.newUser();
    const { user: bob } = await ctx.newUser();
    const { user: carol } = await ctx.newUser();
    const { asset: source } = await ctx.newAsset({ ownerId: alice.id });
    const { asset: bobCopy } = await ctx.newAsset({ ownerId: bob.id });
    const { asset: carolCopy } = await ctx.newAsset({ ownerId: carol.id });
    const base = { sourceId: source.id, rootOwnerId: alice.id, partnerSharedById: alice.id };
    await sut.createAssetOrigin({ ...base, id: bobCopy.id, ownerId: bob.id });
    await sut.createAssetOrigin({ ...base, id: carolCopy.id, ownerId: carol.id });

    await sut.stopFollowing(alice.id, bob.id);

    await expect(sut.getOrigin('asset', bobCopy.id)).resolves.toMatchObject({ following: false });
    const followers = await sut.getFollowers('asset', source.id);
    expect(followers.map(({ id }) => id)).toEqual([carolCopy.id]);
  });

  it('never returns a copy that is gone', async () => {
    const { ctx, sut } = setup();
    const { user: alice } = await ctx.newUser();
    const { user: bob } = await ctx.newUser();
    const { asset: source } = await ctx.newAsset({ ownerId: alice.id });
    const { asset: copy } = await ctx.newAsset({ ownerId: bob.id });
    await sut.createAssetOrigin({
      id: copy.id,
      sourceId: source.id,
      ownerId: bob.id,
      rootOwnerId: alice.id,
      partnerSharedById: alice.id,
    });
    await db.deleteFrom('asset').where('id', '=', copy.id).execute();

    await expect(sut.getFollowers('asset', source.id)).resolves.toEqual([]);
    await expect(sut.getCopyId('asset', source.id, bob.id)).resolves.toBeUndefined();
  });

  it('maps a source person to the copy a library holds, keyed by owner and person group', async () => {
    const { ctx, sut } = setup();
    const { user: alice } = await ctx.newUser();
    const { user: bob } = await ctx.newUser();
    const { person: source } = await ctx.newPerson({ ownerId: alice.id });
    const { person: copy } = await ctx.newPerson({ ownerId: bob.id });
    const row = {
      ownerId: bob.id,
      personGroupId: copy.personGroupId,
      sourceOwnerId: alice.id,
      sourcePersonGroupId: source.personGroupId,
      rootOwnerId: alice.id,
      partnerSharedById: alice.id,
    };
    await sut.createPersonOrigin(row);

    await expect(sut.getPersonMapping(bob.id, source.personGroupId)).resolves.toEqual({
      ...row,
      overriddenFields: [],
      following: true,
    });
    await expect(sut.getPersonMapping(alice.id, source.personGroupId)).resolves.toBeUndefined();
    await sut.markPersonOverridden(bob.id, [copy.personGroupId], ['name']);
    await sut.stopFollowing(alice.id, bob.id);
    await expect(sut.getPersonMapping(bob.id, source.personGroupId)).resolves.toMatchObject({
      overriddenFields: ['name'],
      following: false,
    });
    await expect(sut.getPersonFollowers(alice.id, source.personGroupId)).resolves.toEqual([]);
  });

  it('tells whether a library holds content, live or trashed', async () => {
    const { ctx, sut } = setup();
    const { user: bob } = await ctx.newUser();
    const { asset: live } = await ctx.newAsset({ ownerId: bob.id });
    const { asset: trashed } = await ctx.newAsset({ ownerId: bob.id, deletedAt: new Date() });
    const { user: other } = await ctx.newUser();

    await expect(sut.libraryHasChecksum(bob.id, live.checksum)).resolves.toBe(true);
    await expect(sut.libraryHasChecksum(bob.id, trashed.checksum)).resolves.toBe(true);
    await expect(sut.libraryHasChecksum(other.id, live.checksum)).resolves.toBe(false);
  });

  it('keeps a backfill cursor that only moves forward', async () => {
    const { ctx, sut } = setup();
    const { user: alice } = await ctx.newUser();
    const { user: bob } = await ctx.newUser();
    await ctx.newPartner({ sharedById: alice.id, sharedWithId: bob.id });

    await sut.startBackfill(alice.id, bob.id, 3);
    const later = 'ffffffff-ffff-4fff-bfff-ffffffffffff';
    const earlier = '00000000-0000-4000-8000-000000000001';
    await sut.advanceBackfill(alice.id, bob.id, { cursor: later, processed: 2, state: PartnerBackfillState.Running });
    // a replayed earlier batch never moves the cursor back
    await sut.advanceBackfill(alice.id, bob.id, { cursor: earlier, processed: 2, state: PartnerBackfillState.Running });
    await expect(sut.getBackfill(alice.id, bob.id)).resolves.toEqual({
      sharedById: alice.id,
      sharedWithId: bob.id,
      state: PartnerBackfillState.Running,
      cursor: later,
      total: 3,
      done: 2,
    });

    await sut.stopBackfill(alice.id, bob.id);
    await sut.advanceBackfill(alice.id, bob.id, { cursor: null, processed: 1, state: PartnerBackfillState.Done });
    await expect(sut.getBackfill(alice.id, bob.id)).resolves.toMatchObject({ state: PartnerBackfillState.Stopped });
  });
});
