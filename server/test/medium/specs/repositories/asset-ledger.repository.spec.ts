import { Kysely, sql } from 'kysely';
import { AdminAuditAction, AssetLockReason, AssetStatus } from 'src/enum.js';
import { AdminAuditRepository } from 'src/repositories/admin-audit.repository.js';
import {
  AssetLedgerRepository,
  recordLedgerMerged,
  recordLedgerUnmerged,
} from 'src/repositories/asset-ledger.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-921: the nothing-lost ledger against a real database: every way a photo is added or removed moves
 * its row, a row deleted behind the server's back turns up as missing, and each account reads its own.
 */

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: new AssetLedgerRepository(defaultDatabase), assets: ctx.get(AssetRepository) };
};

const ledgerOf = async (assetId: string) => {
  const row = await defaultDatabase
    .selectFrom('asset_ledger')
    .selectAll()
    .where('assetId', '=', assetId)
    .executeTakeFirst();
  return row && { state: row.state, stateBy: row.stateBy, reason: row.reason, addedVia: row.addedVia };
};

const setStatus = (assetId: string, status: AssetStatus) =>
  defaultDatabase
    .updateTable('asset')
    .set({ status, deletedAt: status === AssetStatus.Active ? null : new Date() })
    .where('id', '=', assetId)
    .execute();

/** Walks the whole ledger the way the nightly pass does, in small pages. */
const reconcileAll = async (sut: AssetLedgerRepository, take = 3) => {
  const totals = { missing: 0, corrected: 0 };
  for (let after: string | null = null; ;) {
    const page = await sut.reconcilePage(after, take);
    totals.missing += page.missing;
    totals.corrected += page.corrected;
    if (!page.last) {
      return totals;
    }
    after = page.last;
  }
};

const backfillAll = async (sut: AssetLedgerRepository, take: number) => {
  let added = 0;
  for (let after: string | null = null; ;) {
    const page = await sut.backfillPage(after, take);
    added += page.added;
    if (!page.last) {
      return added;
    }
    after = page.last;
  }
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(AssetLedgerRepository.name, () => {
  it('writes a row with the asset: an upload by its owner, a library scan by nobody', async () => {
    const { ctx, assets } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'IMG_0001.jpg' });

    const row = await defaultDatabase
      .selectFrom('asset_ledger')
      .selectAll()
      .where('assetId', '=', asset.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({
      ownerId: user.id,
      originalFileName: 'IMG_0001.jpg',
      addedVia: 'upload',
      state: 'kept',
      stateBy: user.id,
      reason: null,
    });
    expect(Buffer.from(row.checksum).equals(Buffer.from(asset.checksum))).toBe(true);

    const library = await defaultDatabase
      .insertInto('library')
      .values({ ownerId: user.id, name: 'Photos', importPaths: [], exclusionPatterns: [] })
      .returning('id')
      .executeTakeFirstOrThrow();
    const { asset: first } = await ctx.newAsset({ ownerId: user.id });
    const { asset: second } = await ctx.newAsset({ ownerId: user.id });
    await defaultDatabase.deleteFrom('asset').where('id', 'in', [first.id, second.id]).execute();
    await defaultDatabase.deleteFrom('asset_ledger').where('assetId', 'in', [first.id, second.id]).execute();
    const scanned = await assets.createAll([
      { ...first, libraryId: library.id },
      { ...second, libraryId: library.id },
    ]);
    expect(scanned).toHaveLength(2);
    for (const id of scanned) {
      await expect(ledgerOf(id)).resolves.toEqual({
        state: 'kept',
        stateBy: null,
        reason: null,
        addedVia: 'library-scan',
      });
    }
  });

  it('follows trash, restore and a deletion somebody asked for, with the actor', async () => {
    const { ctx, sut, assets } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { asset: other } = await ctx.newAsset({ ownerId: user.id });

    await sut.trashed([asset.id, other.id], user.id);
    await expect(ledgerOf(asset.id)).resolves.toMatchObject({ state: 'trashed', stateBy: user.id, reason: null });

    await sut.restored([other.id], user.id);
    await expect(ledgerOf(other.id)).resolves.toMatchObject({ state: 'kept', stateBy: user.id });
    // a restore of something that is not in the Trash changes nothing
    await sut.restored([other.id], null);
    await expect(ledgerOf(other.id)).resolves.toMatchObject({ state: 'kept', stateBy: user.id });

    // emptying the Trash: recorded when asked, kept when the deletion job removes the row
    await sut.removed([asset.id], { by: user.id, reason: 'deleted' });
    await setStatus(asset.id, AssetStatus.Deleted);
    await assets.remove({ id: asset.id });
    await expect(ledgerOf(asset.id)).resolves.toMatchObject({ state: 'removed', stateBy: user.id, reason: 'deleted' });
    await expect(reconcileAll(sut)).resolves.toMatchObject({ missing: 0 });
    await expect(ledgerOf(asset.id)).resolves.toMatchObject({ state: 'removed', stateBy: user.id, reason: 'deleted' });
  });

  it('says the Trash ran out of time when nobody asked for the removal', async () => {
    const { ctx, sut, assets } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await setStatus(asset.id, AssetStatus.Trashed);
    await sut.trashed([asset.id], user.id);

    await assets.remove({ id: asset.id });

    await expect(ledgerOf(asset.id)).resolves.toEqual({
      state: 'removed',
      stateBy: null,
      reason: 'trash-expired',
      addedVia: 'upload',
    });
  });

  it('marks a photo that shares an identical file merged, and kept again once that is undone', async () => {
    const { ctx, sut } = setup();
    const { user: admin } = await ctx.newUser({ isAdmin: true });
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });

    await recordLedgerMerged(defaultDatabase, asset.id, admin.id);
    await expect(ledgerOf(asset.id)).resolves.toMatchObject({
      state: 'merged',
      stateBy: admin.id,
      reason: 'identical-file',
    });
    // the photo is still there: the nightly pass leaves a merged row alone
    await reconcileAll(sut);
    await expect(ledgerOf(asset.id)).resolves.toMatchObject({ state: 'merged' });

    await recordLedgerUnmerged(defaultDatabase, asset.id);
    await expect(ledgerOf(asset.id)).resolves.toMatchObject({ state: 'kept', stateBy: null, reason: null });
  });

  it('removes an account’s rows with the account, naming the administrator who deleted it', async () => {
    const { ctx, assets } = setup();
    const { user: admin } = await ctx.newUser({ isAdmin: true });
    const { user } = await ctx.newUser();
    const { user: bystander } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { asset: trashed } = await ctx.newAsset({ ownerId: user.id });
    const { asset: untouched } = await ctx.newAsset({ ownerId: bystander.id });
    await setStatus(trashed.id, AssetStatus.Trashed);
    await ctx
      .get(AdminAuditRepository)
      .create([{ userId: user.id, actorId: admin.id, action: AdminAuditAction.AccountDeleted, subject: 'A' }]);

    await assets.deleteAll(user.id);

    for (const id of [asset.id, trashed.id]) {
      await expect(ledgerOf(id)).resolves.toMatchObject({
        state: 'removed',
        stateBy: admin.id,
        reason: 'account-removed',
      });
    }
    await expect(ledgerOf(untouched.id)).resolves.toMatchObject({ state: 'kept' });
  });

  it('finds a row deleted directly in SQL missing in the nightly pass, and found again if it returns', async () => {
    const { ctx, sut, assets } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { asset: kept } = await ctx.newAsset({ ownerId: user.id });

    await sql`delete from asset where id = ${asset.id}::uuid`.execute(defaultDatabase);
    await expect(ledgerOf(asset.id)).resolves.toMatchObject({ state: 'kept' });

    const first = await reconcileAll(sut);
    expect(first.missing).toBeGreaterThanOrEqual(1);
    await expect(ledgerOf(asset.id)).resolves.toMatchObject({ state: 'missing', stateBy: null, reason: 'not-found' });
    await expect(ledgerOf(kept.id)).resolves.toMatchObject({ state: 'kept' });
    // the next night does not report it again
    await expect(reconcileAll(sut)).resolves.toMatchObject({ missing: 0 });

    const missing = await sut.missingByOwner();
    expect(missing.find(({ ownerId }) => ownerId === user.id)).toMatchObject({ count: 1 });
    await expect(sut.counts(user.id)).resolves.toMatchObject({ kept: 1, missing: 1 });

    // put back (a database restore): the row is the photo's again
    await assets.create(asset);
    await reconcileAll(sut);
    await expect(ledgerOf(asset.id)).resolves.toMatchObject({ state: 'kept', reason: 'found' });
  });

  it('brings rows in line with photos that were trashed or restored without telling anybody', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset: quietlyTrashed } = await ctx.newAsset({ ownerId: user.id });
    const { asset: quietlyRestored } = await ctx.newAsset({ ownerId: user.id });
    const { asset: neverDeleted } = await ctx.newAsset({ ownerId: user.id });
    await setStatus(quietlyTrashed.id, AssetStatus.Trashed);
    await sut.trashed([quietlyRestored.id], user.id);
    await sut.removed([neverDeleted.id], { by: user.id, reason: 'deleted' });

    await reconcileAll(sut);

    await expect(ledgerOf(quietlyTrashed.id)).resolves.toMatchObject({ state: 'trashed', stateBy: null });
    await expect(ledgerOf(quietlyRestored.id)).resolves.toMatchObject({ state: 'kept', stateBy: null });
    await expect(ledgerOf(neverDeleted.id)).resolves.toMatchObject({ state: 'kept', stateBy: null });
  });

  it('treats photos that went with a deleted account as removed, not lost', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });

    // the account row deleted behind the server's back takes its photos with it
    await sql`delete from "user" where id = ${user.id}::uuid`.execute(defaultDatabase);
    const result = await reconcileAll(sut);

    await expect(ledgerOf(asset.id)).resolves.toMatchObject({ state: 'removed', reason: 'account-removed' });
    expect(result.missing).toBe(0);
  });

  it('lists each account its own originals: a partner’s copy is the partner’s row, counted once', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id, originalFileName: 'shared.jpg' });
    const { asset: copy } = await ctx.newAsset({ ownerId: partner.id, originalFileName: 'shared.jpg' });

    const mine = await sut.list(owner.id, { take: 10, hideLocked: false });
    const theirs = await sut.list(partner.id, { take: 10, hideLocked: false });

    expect(mine.map(({ assetId }) => assetId)).toEqual([asset.id]);
    expect(theirs.map(({ assetId }) => assetId)).toEqual([copy.id]);
    await expect(sut.counts(owner.id)).resolves.toMatchObject({ kept: 1 });
    await expect(sut.counts(partner.id)).resolves.toMatchObject({ kept: 1 });
  });

  it('pages newest change first, filters by state and hides locked photos from a session without them', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const created = [];
    for (let index = 0; index < 5; index++) {
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      created.push(asset.id);
    }
    const { asset: locked } = await ctx.newAsset({ ownerId: user.id });
    await defaultDatabase
      .insertInto('asset_lock')
      .values({ assetId: locked.id, reason: AssetLockReason.Marked, lockedBy: user.id })
      .execute();
    await sut.trashed([created[0], created[1]], user.id);

    const seen: string[] = [];
    let before: { at: string; assetId: string } | undefined;
    for (;;) {
      const page = await sut.list(user.id, { take: 2, before, hideLocked: false });
      seen.push(...page.map(({ assetId }) => assetId));
      if (page.length < 2) {
        break;
      }
      const last = page.at(-1)!;
      before = { at: last.cursorAt, assetId: last.assetId };
    }
    expect(seen).toHaveLength(6);
    expect(new Set(seen)).toEqual(new Set([...created, locked.id]));
    // the two that were just trashed changed last
    expect(new Set(seen.slice(0, 2))).toEqual(new Set([created[0], created[1]]));

    const trashed = await sut.list(user.id, { state: 'trashed', take: 10, hideLocked: false });
    expect(new Set(trashed.map(({ assetId }) => assetId))).toEqual(new Set([created[0], created[1]]));

    const ordinary = await sut.list(user.id, { take: 10, hideLocked: true });
    expect(ordinary.map(({ assetId }) => assetId)).not.toContain(locked.id);
    expect(ordinary).toHaveLength(5);
  });

  it('gives 100,000 photos without rows their rows in well under a minute', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    await sql`
      insert into asset
        ("ownerId", type, "originalPath", "fileCreatedAt", "fileModifiedAt", "localDateTime", checksum,
          "checksumAlgorithm", "originalFileName", status, "deletedAt")
      select ${user.id}::uuid, 'IMAGE', '/data/library/bulk/' || n, now(), now(), now(), sha256(convert_to(n::text, 'UTF8')),
        'sha256'::asset_checksum_algorithm_enum, 'bulk-' || n || '.jpg',
        (case when n % 50 = 0 then 'trashed' else 'active' end)::assets_status_enum,
        case when n % 50 = 0 then now() end
      from generate_series(1, 100000) n
    `.execute(defaultDatabase);
    await expect(sut.counts(user.id)).resolves.toMatchObject({ kept: 0, trashed: 0 });

    const started = Date.now();
    const added = await backfillAll(sut, 20_000);
    const seconds = (Date.now() - started) / 1000;

    expect(added).toBeGreaterThanOrEqual(100_000);
    expect(seconds).toBeLessThan(60);
    await expect(sut.counts(user.id)).resolves.toMatchObject({ kept: 98_000, trashed: 2000 });
    const sample = await defaultDatabase
      .selectFrom('asset_ledger')
      .select(['addedVia', 'stateBy'])
      .where('ownerId', '=', user.id)
      .limit(1)
      .executeTakeFirstOrThrow();
    expect(sample).toEqual({ addedVia: 'unknown', stateBy: null });
    // a second pass has nothing to add
    await expect(backfillAll(sut, 20_000)).resolves.toBe(0);
  }, 120_000);
});
