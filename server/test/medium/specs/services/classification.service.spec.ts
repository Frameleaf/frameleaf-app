import { Kysely, sql } from 'kysely';
import {
  AlbumUserRole,
  AssetType,
  AssetVisibility,
  ClassificationMatchDecision,
  ClassificationMediaType,
  ClassificationRuleAction,
} from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumUserRepository } from 'src/repositories/album-user.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { ConfigRepository } from 'src/repositories/config.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { TagRepository } from 'src/repositories/tag.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { BaseService } from 'src/services/base.service.js';
import { ClassificationService } from 'src/services/classification.service.js';
import { clearConfigCache } from 'src/utils/config.js';
import { upsertTags } from 'src/utils/tag.js';
import { MediumTestContext, mediumFactory, newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

// Unit vectors: cosine similarity is 1 for the same index and 0 otherwise; `mix` sits in between.
const DIMENSIONS = 512;
const unitVector = (index: number) =>
  `[${Array.from({ length: DIMENSIONS }, (_, i) => (i === index ? 1 : 0)).join(',')}]`;
const mix = (index: number, other: number, weight: number) => {
  const values = Array.from({ length: DIMENSIONS }, () => 0);
  values[index] = weight;
  values[other] = Math.sqrt(1 - weight * weight);
  return `[${values.join(',')}]`;
};

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(ClassificationService, {
    database: db || defaultDatabase,
    real: [
      AccessRepository,
      AlbumRepository,
      AlbumUserRepository,
      AssetRepository,
      ClassificationRepository,
      ConfigRepository,
      PersonRepository,
      PartnerRepository,
      SearchRepository,
      SmartAlbumRepository,
      SystemMetadataRepository,
      TagRepository,
      UserRepository,
    ],
    mock: [EventRepository, LoggingRepository, MachineLearningRepository],
  });
  // Visual phrases are encoded by the (mocked) machine-learning repository; routing is not under test.
  vi.spyOn(
    sut as unknown as { selectRoutedMlDestination: () => Promise<unknown> },
    'selectRoutedMlDestination',
  ).mockResolvedValue({});
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  return { sut, ctx, albums: BaseService.create(AlbumService, sut) };
};

const enableVisualSearch = async (ctx: MediumTestContext, modelName: string) => {
  const config = await ctx.getConfig({ withCache: false });
  config.machineLearning.enabled = true;
  config.machineLearning.clip.enabled = true;
  config.machineLearning.clip.modelName = modelName;
  config.smartAlbums.rules.visualCategories = true;
  await ctx.updateConfig(config);
  clearConfigCache();
};

const newOwner = async (ctx: MediumTestContext) => {
  const { user } = await ctx.newUser();
  return { user, auth: factory.auth({ user: { id: user.id } }) };
};

const tagOf = async (ctx: MediumTestContext, userId: string, name: string) => {
  const [tag] = await upsertTags(ctx.get(TagRepository), { userId, tags: [name] });
  return tag;
};

const tagAsset = (ctx: MediumTestContext, tagId: string, assetId: string) =>
  ctx.database.insertInto('tag_asset').values({ tagId, assetId }).execute();

const tagIdsOf = async (ctx: MediumTestContext, assetId: string) =>
  (await ctx.database.selectFrom('tag_asset').select('tagId').where('assetId', '=', assetId).execute()).map(
    ({ tagId }) => tagId,
  );

const albumAssetIds = async (ctx: MediumTestContext, albumId: string) =>
  (await ctx.database.selectFrom('album_asset').select('assetId').where('albumId', '=', albumId).execute()).map(
    ({ assetId }) => assetId,
  );

const visibilityOf = async (ctx: MediumTestContext, assetId: string) =>
  (await ctx.database.selectFrom('asset').select('visibility').where('id', '=', assetId).executeTakeFirstOrThrow())
    .visibility;

const decisionOf = async (ctx: MediumTestContext, ruleId: string, assetId: string) =>
  (
    await ctx.database
      .selectFrom('classification_match')
      .select('decision')
      .where('ruleId', '=', ruleId)
      .where('assetId', '=', assetId)
      .executeTakeFirst()
  )?.decision;

const countRows = async (ctx: MediumTestContext) => {
  const [matches, albumAssets, tagAssets] = await Promise.all([
    ctx.database
      .selectFrom('classification_match')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst(),
    ctx.database
      .selectFrom('album_asset')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst(),
    ctx.database
      .selectFrom('tag_asset')
      .select((eb) => eb.fn.countAll<number>().as('n'))
      .executeTakeFirst(),
  ]);
  return { matches: Number(matches?.n), albumAssets: Number(albumAssets?.n), tagAssets: Number(tagAssets?.n) };
};

/** Pause the asset-lock query at a reproducible interleaving of two classification writes. */
const pauseAssetLocks = (repo: ClassificationRepository) => {
  const original = Reflect.get(repo, 'liveAssets') as (...args: unknown[]) => Promise<unknown>;
  const releases: Array<() => void> = [];
  const waiters = new Map<number, () => void>();
  const spy = vi
    .spyOn(repo as unknown as { liveAssets: (...args: unknown[]) => Promise<unknown> }, 'liveAssets')
    .mockImplementation(async (...args) => {
      const { promise: held, resolve: release } = Promise.withResolvers<void>();
      releases.push(release);
      waiters.get(releases.length)?.();
      await held;
      return original.apply(repo, args);
    });
  return {
    waitFor: (count: number) =>
      releases.length >= count
        ? Promise.resolve()
        : new Promise<void>((resolve) => {
            waiters.set(count, resolve);
          }),
    release: (index: number) => releases[index - 1]?.(),
    restore: () => spy.mockRestore(),
  };
};

/** Plan the rule and apply every change the plan names, as the web client does for a small plan. */
const reevaluate = async (sut: ClassificationService, auth: ReturnType<typeof factory.auth>, ruleId: string) => {
  const plan = await sut.plan(auth, ruleId);
  if (plan.assetIds.length === 0) {
    return { plan, result: undefined };
  }
  const result = await sut.apply(auth, ruleId, { assetIds: plan.assetIds });
  return { plan, result };
};

const baseRule = {
  personIds: [],
  tagIds: [],
  takenAfter: null,
  takenBefore: null,
  mediaType: ClassificationMediaType.Any,
  visualQueries: [],
  threshold: 0.25,
  archive: false,
  enabled: true,
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

beforeEach(async () => {
  await sql`UPDATE immich_fork.state SET phase = 'legacy', active = true WHERE id = 1`.execute(defaultDatabase);
  clearConfigCache();
});

describe(ClassificationService.name, () => {
  describe('preview', () => {
    it('counts the whole library for a rule without visual phrases and writes nothing', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset: a } = await ctx.newAsset({ ownerId: user.id });
      const { asset: b } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, a.id);
      await tagAsset(ctx, lake.id, b.id);
      const before = await countRows(ctx);

      const preview = await sut.preview(auth, { ...baseRule, tagIds: [lake.id], sampleSize: 500 });

      expect(preview).toMatchObject({ exact: true, sampled: 3, matched: 2, visualSearchAvailable: true });
      expect(preview.items.map(({ assetId }) => assetId).toSorted()).toEqual([a.id, b.id].toSorted());
      expect(await countRows(ctx)).toEqual(before);
    });

    it('reads only a bounded sample for visual phrases, and a changed threshold changes the count', async () => {
      const { sut, ctx } = setup();
      await enableVisualSearch(ctx, 'fl60-preview-threshold');
      const { user, auth } = await newOwner(ctx);
      const strong = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: new Date('2026-09-03') });
      const weak = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: new Date('2026-09-02') });
      const old = await ctx.newAsset({ ownerId: user.id, fileCreatedAt: new Date('2020-01-01') });
      await ctx.get(SearchRepository).upsert(strong.asset.id, unitVector(0));
      await ctx.get(SearchRepository).upsert(weak.asset.id, mix(0, 1, 0.3));
      await ctx.get(SearchRepository).upsert(old.asset.id, unitVector(0));
      ctx.getMock(MachineLearningRepository).encodeText.mockResolvedValue(unitVector(0));
      const before = await countRows(ctx);

      const loose = await sut.preview(auth, { ...baseRule, visualQueries: ['lake'], threshold: 0.2, sampleSize: 2 });
      const strict = await sut.preview(auth, { ...baseRule, visualQueries: ['lake'], threshold: 0.9, sampleSize: 2 });

      expect(loose).toMatchObject({ exact: false, sampled: 2, matched: 2 });
      expect(loose.items[0]).toMatchObject({ assetId: strong.asset.id });
      expect(strict).toMatchObject({ exact: false, sampled: 2, matched: 1 });
      expect(await countRows(ctx)).toEqual(before);
    });

    it('never previews another account’s media or people', async () => {
      const { sut, ctx } = setup();
      const { auth } = await newOwner(ctx);
      const { user: other } = await newOwner(ctx);
      const { person } = await ctx.newPerson({ ownerId: other.id });
      const { asset } = await ctx.newAsset({ ownerId: other.id });
      const theirs = await tagOf(ctx, other.id, 'theirs');
      await tagAsset(ctx, theirs.id, asset.id);

      await expect(
        sut.preview(auth, { ...baseRule, personIds: [person.personGroupId], sampleSize: 10 }),
      ).rejects.toThrow();
      await expect(sut.preview(auth, { ...baseRule, tagIds: [theirs.id], sampleSize: 10 })).rejects.toThrow();
    });
  });

  describe('create and archive consent', () => {
    it('refuses to archive matches without explicit consent, and records the consent when given', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');

      await expect(
        sut.createRule(auth, { ...baseRule, albumName: 'Lake', tagIds: [lake.id], archive: true }),
      ).rejects.toThrow('explicit consent');
      const albums = await ctx.database.selectFrom('album').select('id').where('albumName', '=', 'Lake').execute();
      expect(albums).toHaveLength(0);

      const rule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        archive: true,
        archiveConsent: true,
      });
      expect(rule.archive).toBe(true);
      expect(rule.archiveConsentAt).not.toBeNull();

      await expect(sut.updateRule(auth, rule.id, { archive: false })).resolves.toMatchObject({
        archive: false,
        archiveConsentAt: null,
      });
      await expect(sut.updateRule(auth, rule.id, { archive: true })).rejects.toThrow('explicit consent');
    });

    it('answers another account’s rule like a missing one', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const { auth: otherAuth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const rule = await sut.createRule(auth, { ...baseRule, albumName: 'Lake', tagIds: [lake.id] });

      await expect(sut.getRule(otherAuth, rule.id)).rejects.toThrow('Rule not found');
      await expect(sut.plan(otherAuth, rule.id)).rejects.toThrow('Rule not found');
      await expect(sut.updateRule(otherAuth, rule.id, { enabled: false })).rejects.toThrow('Rule not found');
    });
  });

  describe('tagging rules', () => {
    it('adds matches to the album with the rule-owned tag, and shows which rule contributed them', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, asset.id);

      const rule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake days',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Lake days',
      });
      const { plan, result } = await reevaluate(sut, auth, rule.id);

      expect(plan).toMatchObject({ matched: 1, added: 1, removed: 0, durable: false });
      expect(result).toMatchObject({ added: 1 });
      expect(await albumAssetIds(ctx, rule.albumId)).toEqual([asset.id]);
      expect(await tagIdsOf(ctx, asset.id)).toContain(rule.tag!.id);
      await expect(sut.getContributions(auth, asset.id)).resolves.toEqual([
        expect.objectContaining({ ruleId: rule.id, albumName: 'Lake days', tag: rule.tag, archived: false }),
      ]);
    });

    it('never removes a tag it did not add, or one another rule still holds', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const water = await tagOf(ctx, user.id, 'water');
      const { asset: both } = await ctx.newAsset({ ownerId: user.id });
      const { asset: mine } = await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, both.id);
      await tagAsset(ctx, water.id, both.id);
      await tagAsset(ctx, lake.id, mine.id);
      const shared = await tagOf(ctx, user.id, 'Outdoors');
      // The person tagged this item Outdoors themselves before any rule existed.
      await tagAsset(ctx, shared.id, mine.id);

      const lakeRule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Outdoors',
      });
      const waterRule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Water',
        tagIds: [water.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Outdoors',
      });
      await reevaluate(sut, auth, lakeRule.id);
      await reevaluate(sut, auth, waterRule.id);

      // The lake rule stops matching everything.
      const unused = await tagOf(ctx, user.id, 'unused');
      await sut.updateRule(auth, lakeRule.id, { tagIds: [unused.id] });
      const { plan } = await reevaluate(sut, auth, lakeRule.id);

      expect(plan.removed).toBe(2);
      expect(await albumAssetIds(ctx, lakeRule.albumId)).toEqual([]);
      // Still held by the water rule.
      expect(await tagIdsOf(ctx, both.id)).toContain(shared.id);
      // The person's own tag stays.
      expect(await tagIdsOf(ctx, mine.id)).toContain(shared.id);

      // Once the water rule lets go too, the tag it (alone) holds goes.
      await sut.updateRule(auth, waterRule.id, { tagIds: [unused.id] });
      await reevaluate(sut, auth, waterRule.id);
      expect(await tagIdsOf(ctx, both.id)).not.toContain(shared.id);
      expect(await tagIdsOf(ctx, mine.id)).toContain(shared.id);
    });

    it('keeps a manual removal from the album across reprocessing', async () => {
      const { sut, ctx, albums } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, asset.id);
      const rule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Lake album',
      });
      await reevaluate(sut, auth, rule.id);

      await albums.removeAssets(auth, rule.albumId, { ids: [asset.id] });

      expect(await decisionOf(ctx, rule.id, asset.id)).toBe(ClassificationMatchDecision.Rejected);
      expect(await tagIdsOf(ctx, asset.id)).not.toContain(rule.tag!.id);
      const { plan } = await reevaluate(sut, auth, rule.id);
      expect(plan.added).toBe(0);
      await sut.evaluateAsset(asset.id, user.id);
      expect(await albumAssetIds(ctx, rule.albumId)).toEqual([]);
    });

    it('lets a partner editor remove membership without rejecting the owner rule or taking its tag', async () => {
      const { sut, ctx, albums } = setup();
      const { user, auth } = await newOwner(ctx);
      const { user: editor, auth: editorAuth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, asset.id);
      const rule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Lake album',
      });
      await reevaluate(sut, auth, rule.id);
      await ctx.newAlbumUser({ albumId: rule.albumId, userId: editor.id, role: AlbumUserRole.Editor });
      await ctx.newPartner({ sharedById: user.id, sharedWithId: editor.id });

      await expect(albums.removeAssets(editorAuth, rule.albumId, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: true },
      ]);
      expect(await albumAssetIds(ctx, rule.albumId)).toEqual([]);
      expect(await decisionOf(ctx, rule.id, asset.id)).toBe(ClassificationMatchDecision.Matched);
      expect(await tagIdsOf(ctx, asset.id)).toContain(rule.tag!.id);

      await sut.evaluateAsset(asset.id, user.id);
      expect(await decisionOf(ctx, rule.id, asset.id)).toBe(ClassificationMatchDecision.Matched);
      expect(await tagIdsOf(ctx, asset.id)).toContain(rule.tag!.id);
      expect(await albumAssetIds(ctx, rule.albumId)).toEqual([asset.id]);

      await albums.removeAssets(editorAuth, rule.albumId, { ids: [asset.id] });
      await expect(albums.addAssets(editorAuth, rule.albumId, { ids: [asset.id] })).resolves.toEqual([
        { id: asset.id, success: true },
      ]);
      expect(await decisionOf(ctx, rule.id, asset.id)).toBe(ClassificationMatchDecision.Matched);
    });

    it('keeps a manual addition across reprocessing even when it does not match', async () => {
      const { sut, ctx, albums } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const rule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Lake album',
      });

      await albums.addAssets(auth, rule.albumId, { ids: [asset.id] });
      await reevaluate(sut, auth, rule.id);

      expect(await decisionOf(ctx, rule.id, asset.id)).toBe(ClassificationMatchDecision.Accepted);
      expect(await albumAssetIds(ctx, rule.albumId)).toEqual([asset.id]);
    });

    it('treats a rule-owned tag removed by hand as a rejection', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, asset.id);
      const rule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Lake album',
      });
      await reevaluate(sut, auth, rule.id);

      await ctx.database.deleteFrom('tag_asset').where('tagId', '=', rule.tag!.id).execute();
      await sut.evaluateAsset(asset.id, user.id);

      expect(await decisionOf(ctx, rule.id, asset.id)).toBe(ClassificationMatchDecision.Rejected);
      expect(await tagIdsOf(ctx, asset.id)).not.toContain(rule.tag!.id);
      expect(await albumAssetIds(ctx, rule.albumId)).toEqual([]);
    });
  });

  describe('review rules', () => {
    it('suggests without changing anything until the owner accepts or rejects', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset: keep } = await ctx.newAsset({ ownerId: user.id });
      const { asset: drop } = await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, keep.id);
      await tagAsset(ctx, lake.id, drop.id);
      const rule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Review,
      });

      const { result } = await reevaluate(sut, auth, rule.id);
      expect(result).toMatchObject({ added: 0, suggested: 2 });
      expect(await albumAssetIds(ctx, rule.albumId)).toEqual([]);
      const page = await sut.getMatches(auth, rule.id, {
        decision: ClassificationMatchDecision.Suggested,
        page: 1,
        size: 100,
      });
      expect(page.total).toBe(2);

      await sut.decide(auth, rule.id, { assetIds: [keep.id], decision: ClassificationMatchDecision.Accepted });
      await sut.decide(auth, rule.id, { assetIds: [drop.id], decision: ClassificationMatchDecision.Rejected });
      expect(await albumAssetIds(ctx, rule.albumId)).toEqual([keep.id]);

      // Neither decision is overturned, even after the item stops matching.
      await ctx.database.deleteFrom('tag_asset').where('tagId', '=', lake.id).execute();
      await reevaluate(sut, auth, rule.id);
      expect(await albumAssetIds(ctx, rule.albumId)).toEqual([keep.id]);
      expect(await decisionOf(ctx, rule.id, drop.id)).toBe(ClassificationMatchDecision.Rejected);
    });
  });

  describe('archiving', () => {
    it('archives only with consent and restores only what the rule archived', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const receipts = await tagOf(ctx, user.id, 'receipt');
      const { asset: fresh } = await ctx.newAsset({ ownerId: user.id });
      const { asset: already } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Archive });
      await tagAsset(ctx, receipts.id, fresh.id);
      await tagAsset(ctx, receipts.id, already.id);
      const rule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Receipts',
        tagIds: [receipts.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Receipts',
        archive: true,
        archiveConsent: true,
      });
      await reevaluate(sut, auth, rule.id);
      expect(await visibilityOf(ctx, fresh.id)).toBe(AssetVisibility.Archive);

      await ctx.database.deleteFrom('tag_asset').where('tagId', '=', receipts.id).execute();
      await reevaluate(sut, auth, rule.id);

      expect(await visibilityOf(ctx, fresh.id)).toBe(AssetVisibility.Timeline);
      // It was archived before the rule: the rule never un-archives it.
      expect(await visibilityOf(ctx, already.id)).toBe(AssetVisibility.Archive);
    });

    it('shares an archive created by another rule until both stop matching', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const water = await tagOf(ctx, user.id, 'water');
      const unused = await tagOf(ctx, user.id, 'unused');
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, asset.id);
      await tagAsset(ctx, water.id, asset.id);
      const makeRule = (tagId: string, name: string) =>
        sut.createRule(auth, {
          ...baseRule,
          albumName: name,
          tagIds: [tagId],
          action: ClassificationRuleAction.Tag,
          tagName: name,
          archive: true,
          archiveConsent: true,
        });
      const first = await makeRule(lake.id, 'Lake archive');
      const second = await makeRule(water.id, 'Water archive');
      await reevaluate(sut, auth, first.id);
      await reevaluate(sut, auth, second.id);

      await sut.updateRule(auth, first.id, { tagIds: [unused.id] });
      await reevaluate(sut, auth, first.id);
      expect(await visibilityOf(ctx, asset.id)).toBe(AssetVisibility.Archive);
      await sut.updateRule(auth, second.id, { tagIds: [unused.id] });
      await reevaluate(sut, auth, second.id);
      expect(await visibilityOf(ctx, asset.id)).toBe(AssetVisibility.Timeline);
    });
  });

  describe('concurrent application', () => {
    it('keeps tag and archive provenance on two concurrent first applies', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, asset.id);
      const created = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Lake album',
        archive: true,
        archiveConsent: true,
      });
      const repo = ctx.get(ClassificationRepository);
      const rule = await repo.getRule(created.id);
      expect(rule).toBeDefined();
      const matches = new Map([[asset.id, null]]);
      const gates = pauseAssetLocks(repo);
      try {
        const first = repo.apply(rule!, [asset.id], matches);
        await gates.waitFor(1);
        const second = repo.apply(rule!, [asset.id], matches);
        // The second run waits on the first run's rule lock before it can read match rows.
        gates.release(1);
        await first;
        await gates.waitFor(2);
        gates.release(2);
        await second;
        const row = await ctx.database
          .selectFrom('classification_match')
          .select(['tagContributed', 'archiveContributed', 'decision'])
          .where('ruleId', '=', created.id)
          .where('assetId', '=', asset.id)
          .executeTakeFirstOrThrow();
        expect(row).toEqual({
          tagContributed: true,
          archiveContributed: true,
          decision: ClassificationMatchDecision.Matched,
        });
        expect(await tagIdsOf(ctx, asset.id)).toContain(created.tag!.id);
        expect(await visibilityOf(ctx, asset.id)).toBe(AssetVisibility.Archive);
      } finally {
        gates.release(1);
        gates.release(2);
        gates.restore();
      }
    });

    it('keeps an owner acceptance made while first apply is waiting', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, asset.id);
      const created = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Lake album',
      });
      const repo = ctx.get(ClassificationRepository);
      const rule = await repo.getRule(created.id);
      expect(rule).toBeDefined();
      await ctx.database.insertInto('album_asset').values({ albumId: created.albumId, assetId: asset.id }).execute();
      const gates = pauseAssetLocks(repo);
      try {
        const applying = repo.apply(rule!, [asset.id], new Map([[asset.id, null]]));
        await gates.waitFor(1);
        const accepting = repo.recordAlbumAdditions(created.albumId, [asset.id], user.id);
        await gates.waitFor(2);
        gates.release(2);
        await accepting;
        gates.release(1);
        await applying;
        expect(await decisionOf(ctx, created.id, asset.id)).toBe(ClassificationMatchDecision.Accepted);
      } finally {
        gates.release(1);
        gates.release(2);
        gates.restore();
      }
    });
  });

  describe('disabled rules and locked media', () => {
    it('does not apply a disabled rule, and keeps what it applied', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: later } = await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, asset.id);
      const rule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Lake album',
      });
      await reevaluate(sut, auth, rule.id);

      await sut.updateRule(auth, rule.id, { enabled: false });
      await tagAsset(ctx, lake.id, later.id);
      await sut.evaluateAsset(later.id, user.id);

      await expect(sut.apply(auth, rule.id, { assetIds: [later.id] })).rejects.toThrow('Turn the rule on');
      expect(await albumAssetIds(ctx, rule.albumId)).toEqual([asset.id]);
    });

    it('never matches, changes or un-matches locked media', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      await tagAsset(ctx, lake.id, locked.id);
      const rule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Lake album',
      });

      const preview = await sut.preview(auth, { ...baseRule, tagIds: [lake.id], sampleSize: 10 });
      expect(preview.matched).toBe(0);
      await sut.evaluateAsset(locked.id, user.id);
      await sut.apply(auth, rule.id, { assetIds: [locked.id] });
      expect(await albumAssetIds(ctx, rule.albumId)).toEqual([]);
      expect(await decisionOf(ctx, rule.id, locked.id)).toBeUndefined();
    });

    it('excludes a previously matched Locked asset from rule counts', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, asset.id);
      const rule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Lake album',
      });
      await reevaluate(sut, auth, rule.id);
      expect((await sut.getRule(auth, rule.id)).counts.matched).toBe(1);
      await ctx.database
        .updateTable('asset')
        .set({ visibility: AssetVisibility.Locked })
        .where('id', '=', asset.id)
        .execute();
      expect((await sut.getRule(auth, rule.id)).counts.matched).toBe(0);
    });

    it.each([
      { change: { enabled: false }, label: 'disabling' },
      { change: { action: ClassificationRuleAction.Review }, label: 'changing the action' },
      { change: { archive: false }, label: 'withdrawing archive consent' },
    ])('does not apply stale inference after $label a rule', async ({ change }) => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      await tagAsset(ctx, lake.id, asset.id);
      const rule = await sut.createRule(auth, {
        ...baseRule,
        albumName: 'Lake',
        tagIds: [lake.id],
        action: ClassificationRuleAction.Tag,
        tagName: 'Lake album',
        archive: true,
        archiveConsent: true,
      });
      const repo = ctx.get(ClassificationRepository);
      const findMatches = repo.findMatches.bind(repo);
      const { promise: waiting, resolve: entered } = Promise.withResolvers<void>();
      const { promise: held, resolve: release } = Promise.withResolvers<void>();
      const spy = vi.spyOn(repo, 'findMatches').mockImplementation(async (...args) => {
        entered();
        await held;
        return findMatches(...args);
      });

      try {
        const applying = sut.apply(auth, rule.id, { assetIds: [asset.id] });
        await waiting;
        await sut.updateRule(auth, rule.id, change);
        release();
        await expect(applying).rejects.toThrow('Classification rule changed while matching');
        expect(await decisionOf(ctx, rule.id, asset.id)).toBeUndefined();
        expect(await albumAssetIds(ctx, rule.albumId)).toEqual([]);
        expect(await tagIdsOf(ctx, asset.id)).not.toContain(rule.tag!.id);
        expect(await visibilityOf(ctx, asset.id)).toBe(AssetVisibility.Timeline);
      } finally {
        release();
        spy.mockRestore();
      }
    });

    it('never grants the album’s members anything: a rule only reaches its owner’s media', async () => {
      const { sut, ctx } = setup();
      const { user, auth } = await newOwner(ctx);
      const { user: other } = await newOwner(ctx);
      const lake = await tagOf(ctx, user.id, 'lake');
      const { asset: theirs } = await ctx.newAsset({ ownerId: other.id });
      const rule = await sut.createRule(auth, { ...baseRule, albumName: 'Lake', tagIds: [lake.id] });

      const result = await sut.apply(auth, rule.id, { assetIds: [theirs.id] });
      expect(result).toMatchObject({ added: 0, suggested: 0, unchanged: 1 });
      expect(await albumAssetIds(ctx, rule.albumId)).toEqual([]);
      const members = await ctx.database
        .selectFrom('album_user')
        .select('userId')
        .where('albumId', '=', rule.albumId)
        .execute();
      expect(members).toEqual([{ userId: user.id }]);
    });
  });

  describe('built-in smart album exclusions', () => {
    it('excludes an item taken out of a built-in smart album by hand', async () => {
      const { ctx, albums } = setup();
      const { user, auth } = await newOwner(ctx);
      const repo = ctx.get(SmartAlbumRepository);
      await repo.ensureForUser(user.id, [{ kind: 'food', name: 'Food' }]);
      const smartId = (await repo.getSmartAlbumIdForOwnerAndKind(user.id, 'food')) as string;
      const { asset } = await ctx.newAsset({ ownerId: user.id, type: AssetType.Image });
      await repo.addAssetToSmartAlbum(smartId, asset.id, 'tag');
      const { albumId } = await ctx.database
        .selectFrom('smart_album')
        .select('albumId')
        .where('id', '=', smartId)
        .executeTakeFirstOrThrow();

      await albums.removeAssets(auth, albumId, { ids: [asset.id] });

      expect(await repo.isExcluded(smartId, asset.id)).toBe(true);
    });
  });

  it('matches people by the owner’s person', async () => {
    const { sut, ctx } = setup();
    const { user, auth } = await newOwner(ctx);
    const { person } = await ctx.newPerson({ ownerId: user.id });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.database
      .insertInto('asset_face')
      .values(mediumFactory.assetFaceInsert({ assetId: asset.id, personGroupId: person.personGroupId }))
      .execute();

    const preview = await sut.preview(auth, { ...baseRule, personIds: [person.personGroupId], sampleSize: 10 });
    expect(preview.matched).toBe(1);
  });
});
