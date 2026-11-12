import { Kysely } from 'kysely';
import { randomBytes } from 'node:crypto';
import { AssetVisibility, ChecksumAlgorithm } from 'src/enum.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-813: the skip list is the owner's own permanent deletions since they turned the option on, minus what
 * they allowed again and what the library holds again.
 */
let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [AssetRepository], mock: [LoggingRepository] });
  const sut = ctx.get(AssetRepository);
  const { user } = await ctx.newUser();
  const { user: partner } = await ctx.newUser();
  /** An asset with these bytes, permanently deleted: its row goes, and the deletion is recorded. */
  const deleted = async (ownerId: string, checksum = randomBytes(32), locked = false) => {
    const { asset } = await ctx.newAsset({
      ownerId,
      checksum,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      ...(locked && { visibility: AssetVisibility.Locked }),
    });
    await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    return checksum;
  };
  const turnedOn = new Date(Date.now() - 60_000);
  return { ctx, sut, user, partner, deleted, turnedOn };
};

it('holds what the owner deleted since the option was turned on, and nothing deleted before', async () => {
  const { sut, user, deleted, turnedOn } = await setup();
  const checksum = await deleted(user.id);
  const never = randomBytes(32);

  await expect(sut.getUploadSkipped(user.id, [checksum, never], turnedOn)).resolves.toEqual([checksum]);
  // turned on only after the deletion: it does not reach back
  await expect(sut.getUploadSkipped(user.id, [checksum], new Date(Date.now() + 60_000))).resolves.toEqual([]);
  await expect(sut.getUploadSkipped(user.id, [], turnedOn)).resolves.toEqual([]);
});

it("never holds a partner's upload of the same bytes against the owner's deletion", async () => {
  const { sut, user, partner, deleted, turnedOn } = await setup();
  const checksum = await deleted(user.id);

  await expect(sut.getUploadSkipped(partner.id, [checksum], turnedOn)).resolves.toEqual([]);
  await expect(
    sut.getUploadSkipList(partner.id, turnedOn, { limit: 50, offset: 0, includeLocked: true }),
  ).resolves.toEqual({ items: [], total: 0 });
  await expect(sut.allowUploadSkips(partner.id, [checksum], turnedOn, { includeLocked: true })).resolves.toBe(0);
  await expect(sut.getUploadSkipped(user.id, [checksum], turnedOn)).resolves.toEqual([checksum]);
});

it('lets an item through after "Allow again", and holds it again once it is deleted again', async () => {
  const { sut, user, deleted, turnedOn } = await setup();
  const checksum = await deleted(user.id);
  const other = await deleted(user.id);

  await expect(
    sut.allowUploadSkips(user.id, [checksum, randomBytes(32)], turnedOn, { includeLocked: true }),
  ).resolves.toBe(1);
  await expect(sut.getUploadSkipped(user.id, [checksum, other], turnedOn)).resolves.toEqual([other]);
  // allowing it twice changes nothing
  await expect(sut.allowUploadSkips(user.id, [checksum], turnedOn, { includeLocked: true })).resolves.toBe(0);

  // uploaded again and deleted again: the newer deletion counts
  await deleted(user.id, checksum);
  await expect(sut.getUploadSkipped(user.id, [checksum], turnedOn)).resolves.toEqual([checksum]);
  await expect(sut.allowUploadSkips(user.id, [checksum], turnedOn, { includeLocked: true })).resolves.toBe(1);
  await expect(sut.getUploadSkipped(user.id, [checksum], turnedOn)).resolves.toEqual([]);
});

it('leaves bytes the library holds again to the duplicate and Trash answers', async () => {
  const { ctx, sut, user, deleted, turnedOn } = await setup();
  const checksum = await deleted(user.id);
  // the same bytes are back (an import, or an upload made while the option was off), here in the Trash
  await ctx.newAsset({ ownerId: user.id, checksum, deletedAt: new Date() });

  await expect(sut.getUploadSkipped(user.id, [checksum], turnedOn)).resolves.toEqual([]);
  await expect(
    sut.getUploadSkipList(user.id, turnedOn, { limit: 50, offset: 0, includeLocked: true }),
  ).resolves.toEqual({
    items: [],
    total: 0,
  });
});

it('lists one row per file, latest deletion first, and items deleted while Locked only when asked', async () => {
  const { sut, user, deleted, turnedOn } = await setup();
  const first = await deleted(user.id);
  const locked = await deleted(user.id, randomBytes(32), true);
  const last = await deleted(user.id);

  const all = await sut.getUploadSkipList(user.id, turnedOn, { limit: 50, offset: 0, includeLocked: true });
  expect(all.total).toBe(3);
  expect(all.items.map(({ checksum, wasLocked }) => ({ checksum, wasLocked }))).toEqual([
    { checksum: last, wasLocked: false },
    { checksum: locked, wasLocked: true },
    { checksum: first, wasLocked: false },
  ]);
  expect(all.items.every(({ deletedAt }) => deletedAt instanceof Date && deletedAt >= turnedOn)).toBe(true);

  const page = await sut.getUploadSkipList(user.id, turnedOn, { limit: 1, offset: 1, includeLocked: true });
  expect(page.total).toBe(3);
  expect(page.items.map(({ checksum }) => checksum)).toEqual([locked]);

  const unlocked = await sut.getUploadSkipList(user.id, turnedOn, { limit: 50, offset: 0, includeLocked: false });
  expect(unlocked.total).toBe(2);
  expect(unlocked.items.map(({ checksum }) => checksum)).toEqual([last, first]);

  // the Locked item is still refused, and a session that cannot see it cannot allow it
  await expect(sut.getUploadSkipped(user.id, [locked], turnedOn)).resolves.toEqual([locked]);
  await expect(sut.allowUploadSkips(user.id, [locked], turnedOn, { includeLocked: false })).resolves.toBe(0);
  await expect(sut.allowUploadSkips(user.id, [locked], turnedOn, { includeLocked: true })).resolves.toBe(1);
});
