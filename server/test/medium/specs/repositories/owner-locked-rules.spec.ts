import { Kysely, sql } from 'kysely';
import {
  AlbumUserRole,
  MediaOperationDestination,
  PetObservationState,
  StudioExportVersionState,
  UserMetadataKey,
} from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotographyWorkflowRepository } from 'src/repositories/photography-workflow.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { hiddenFromOthers } from 'src/utils/database.js';
import { everyOwnersRules } from 'src/utils/hidden-content.js';
import { getOwnerHiddenShareIds } from 'src/utils/item-share.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-446 (owner decision, October 17, 2026: "hidden items are only shared with partner sharing, they're
 * never shared any other way"): an item matching its owner's Locked rules — a tag, person or pet the
 * owner marked Locked — is hidden from everyone else, read from the owner's own stored rules, while
 * the owner's own media is left to their own session.
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, albums: ctx.get(AlbumRepository), assets: ctx.get(AssetRepository) };
};

type Context = ReturnType<typeof setup>['ctx'];

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

const observePet = (petId: string, assetId: string, state: PetObservationState) =>
  db
    .insertInto('pet_observation')
    .values({
      petId,
      assetId,
      state,
      boundingBoxX1: null,
      boundingBoxX2: null,
      boundingBoxY1: null,
      boundingBoxY2: null,
      imageWidth: null,
      imageHeight: null,
    })
    .execute();

/** An owner's album shared with a member: one item per kind of Locked-rule match, and one of the member's own. */
const sharedAlbum = async (ctx: Context) => {
  const { user: owner } = await ctx.newUser();
  const { user: member } = await ctx.newUser();
  const asset = async (ownerId = owner.id) => (await ctx.newAsset({ ownerId })).asset.id;
  const items = {
    plain: await asset(),
    tagged: await asset(),
    faced: await asset(),
    petted: await asset(),
    rejectedPet: await asset(),
    membersOwn: await asset(member.id),
  };

  const { tag } = await ctx.newTag({ userId: owner.id, value: 'Private' });
  // the owner's tag on the member's own item: only the member's rules ever apply to it
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [items.tagged, items.membersOwn] });
  const { person } = await ctx.newPerson({ ownerId: owner.id });
  await ctx.newAssetFace({ assetId: items.faced, personGroupId: person.personGroupId });
  const pet = await db
    .insertInto('pet')
    .values({ ownerId: owner.id, name: 'Synthetic pet', birthDate: null, featuredAssetId: null })
    .returningAll()
    .executeTakeFirstOrThrow();
  await observePet(pet.id, items.petted, PetObservationState.Confirmed);
  // a rejected observation never suppresses anything
  await observePet(pet.id, items.rejectedPet, PetObservationState.Rejected);
  await setLockedRules(owner.id, { tagIds: [tag.id], personIds: [person.personGroupId], petIds: [pet.id] });

  const { album } = await ctx.newAlbum({ ownerId: owner.id }, Object.values(items));
  await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });

  return { owner, member, album, items, tag };
};

/** A published Studio library export: `resultAssetId` made from `sources` (FL-106 provenance). */
const exportOf = async (
  ownerId: string,
  resultAssetId: string,
  sources: Array<{ assetId: string; ownerId: string }>,
  state = StudioExportVersionState.Published,
) => {
  const version = await db
    .insertInto('studio_export_version')
    .values({
      ownerId,
      revision: 1,
      revisionDigest: 'digest',
      state,
      destination: MediaOperationDestination.Local,
      settings: {},
      resultAssetId,
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
        resourceId: source.assetId,
        assetId: source.assetId,
        ownerId: source.ownerId,
        checksum: null,
        sourceAccess: 'owner',
      })),
    )
    .execute();
};

const visibleTo = async (viewerId: string | undefined, ids: string[]) => {
  const rows = await db
    .selectFrom('asset')
    .select('asset.id')
    .where('asset.id', 'in', ids)
    .where(sql<boolean>`not ${hiddenFromOthers(viewerId, 'asset')}`)
    .execute();
  return new Set(rows.map(({ id }) => id));
};

describe('owner Locked rules across sharing (FL-446)', () => {
  it("hides every kind of match from another viewer, by its owner's rules, and none from the owner", async () => {
    const { ctx } = setup();
    const { owner, member, items } = await sharedAlbum(ctx);
    const ids = Object.values(items);

    await expect(visibleTo(member.id, ids)).resolves.toEqual(
      new Set([items.plain, items.rejectedPet, items.membersOwn]),
    );
    // without a viewer (a read every member sees alike) every owner's rules apply
    await expect(visibleTo(undefined, ids)).resolves.toEqual(
      new Set([items.plain, items.rejectedPet, items.membersOwn]),
    );
    // the owner's own media is left to their own session filter
    await expect(visibleTo(owner.id, ids)).resolves.toEqual(new Set(ids));
  });

  it('hides a Studio export of a matching source wherever the source is hidden, through exports of exports (FL-447)', async () => {
    const { ctx } = setup();
    const { owner, member, items } = await sharedAlbum(ctx);
    const asset = async () => (await ctx.newAsset({ ownerId: owner.id })).asset.id;
    const fromTagged = await asset();
    const fromThatExport = await asset();
    const fromPlain = await asset();
    const unpublished = await asset();
    await exportOf(owner.id, fromTagged, [
      { assetId: items.plain, ownerId: owner.id },
      { assetId: items.tagged, ownerId: owner.id },
    ]);
    await exportOf(owner.id, fromThatExport, [{ assetId: fromTagged, ownerId: owner.id }]);
    await exportOf(owner.id, fromPlain, [{ assetId: items.plain, ownerId: owner.id }]);
    await exportOf(
      owner.id,
      unpublished,
      [{ assetId: items.tagged, ownerId: owner.id }],
      StudioExportVersionState.Staged,
    );
    const exports = [fromTagged, fromThatExport, fromPlain, unpublished];

    await expect(visibleTo(member.id, exports)).resolves.toEqual(new Set([fromPlain, unpublished]));
    await expect(visibleTo(undefined, exports)).resolves.toEqual(new Set([fromPlain, unpublished]));
    await expect(visibleTo(owner.id, exports)).resolves.toEqual(new Set(exports));

    // the lineage is read with the rules as they stand: lifting the rule shows the exports again
    await setLockedRules(owner.id, {});
    await expect(visibleTo(member.id, exports)).resolves.toEqual(new Set(exports));
  });

  it("judges an export by its source owner's rules, whoever made the export (FL-447)", async () => {
    const { ctx } = setup();
    const { owner, member, items } = await sharedAlbum(ctx);
    const { user: maker } = await ctx.newUser();
    const { asset: made } = await ctx.newAsset({ ownerId: maker.id });
    await exportOf(maker.id, made.id, [{ assetId: items.faced, ownerId: owner.id }]);

    await expect(visibleTo(member.id, [made.id])).resolves.toEqual(new Set());
    // the maker's own media is left to the maker's own session
    await expect(visibleTo(maker.id, [made.id])).resolves.toEqual(new Set([made.id]));
  });

  it("follows the owner's current rules: lifting one shows its items again", async () => {
    const { ctx } = setup();
    const { owner, member, items } = await sharedAlbum(ctx);

    await setLockedRules(owner.id, {});

    await expect(visibleTo(member.id, Object.values(items))).resolves.toEqual(new Set(Object.values(items)));
  });

  it("counts an album for a member without the owner's rule matches, and in full for the owner", async () => {
    const { ctx, albums } = setup();
    const { owner, member, album } = await sharedAlbum(ctx);

    const [forMember] = await albums.getMetadataForIds([album.id], { othersRulesViewerId: member.id });
    const [forOwner] = await albums.getMetadataForIds([album.id], { othersRulesViewerId: owner.id });

    expect(forMember.assetCount).toBe(3);
    expect(forOwner.assetCount).toBe(6);
  });

  it('names the rule matches among a set of ids, for covers and notifications', async () => {
    const { ctx, assets } = setup();
    const { member, items } = await sharedAlbum(ctx);
    const ids = Object.values(items);
    const hidden = new Set([items.tagged, items.faced, items.petted]);

    await expect(assets.getHiddenContentAssetIds(ids, { othersRulesViewerId: member.id })).resolves.toEqual(hidden);
    await expect(assets.getHiddenContentAssetIds(ids, everyOwnersRules)).resolves.toEqual(hidden);
    await expect(assets.getHiddenContentAssetIds(ids, {})).resolves.toEqual(new Set());
  });

  it("leaves the owner's rule matches, and exports of them, out of a photography gallery", async () => {
    const { ctx } = setup();
    const { owner, album, items } = await sharedAlbum(ctx);
    const { asset: exported } = await ctx.newAsset({ ownerId: owner.id });
    await exportOf(owner.id, exported.id, [{ assetId: items.tagged, ownerId: owner.id }]);
    await db.insertInto('album_asset').values({ albumId: album.id, assetId: exported.id }).execute();

    const rows = await new PhotographyWorkflowRepository(db).assets(owner.id, album.id);

    expect(new Set(rows.map(({ id }) => id))).toEqual(new Set([items.plain, items.rejectedPet]));
  });

  it('withholds an item share of a Studio export made from a matching source (FL-447)', async () => {
    const { ctx } = setup();
    const { owner, items } = await sharedAlbum(ctx);
    const { asset: exported } = await ctx.newAsset({ ownerId: owner.id });
    await exportOf(owner.id, exported.id, [{ assetId: items.tagged, ownerId: owner.id }]);
    const shared = [exported.id, items.tagged, items.plain].map((id) => ({ id, ownerId: owner.id }));

    await expect(getOwnerHiddenShareIds(db, shared)).resolves.toEqual(new Set([exported.id, items.tagged]));
  });
});
