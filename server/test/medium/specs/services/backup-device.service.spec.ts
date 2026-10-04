import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AssetLockReason, ChecksumAlgorithm } from 'src/enum.js';
import { BackupDeviceRepository } from 'src/repositories/backup-device.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BackupDeviceService } from 'src/services/backup-device.service.js';
import { BaseService } from 'src/services/base.service.js';
import { bucketInventory } from 'src/utils/backup-reconciliation.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
const a = '01' + 'a'.repeat(62),
  b = '01' + 'b'.repeat(62);
const report = (deviceKey = randomUUID()) => ({
  deviceKey,
  displayName: 'Personal phone',
  model: 'Phone',
  platform: 'ios',
  appVersion: '1',
  lastSuccessfulBackupAt: null,
  pendingCount: 2,
});
const page = { limit: 100, offset: 0 };
const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new BackupDeviceService(new BackupDeviceRepository(db), { emit: vi.fn() } as never) };
};
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
describe('backup device registry and measured inventory reconciliation', () => {
  it('records an identical set audit with actual snapshot time and exact checked count', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
    await ctx.newAsset({
      ownerId: user.id,
      checksum: Buffer.from(a, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const device = await sut.register(auth, report());
    const run = await sut.start(auth, device.id, { buckets: bucketInventory([a]) });
    expect(run).toMatchObject({ itemsChecked: 1, itemsMissing: 0, differingBuckets: [], pendingBuckets: [] });
    expect(run.completedAt).not.toBeNull();
    expect(new Date(run.checkedAt).getTime()).toBeLessThanOrEqual(new Date(run.completedAt!).getTime());
    expect((await sut.history(auth, device.id, page)).runs).toHaveLength(1);
  });
  it('a device subset of a larger server library completes with zero missing hashes', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
    for (const hash of [a, b])
      await ctx.newAsset({
        ownerId: user.id,
        checksum: Buffer.from(hash, 'hex'),
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
      });
    const device = await sut.register(auth, report());
    const run = await sut.start(auth, device.id, { buckets: bucketInventory([a]) });
    expect(run.completedAt).toBeNull();
    expect(run.differingBuckets).toEqual([1]);
    const done = await sut.submit(auth, device.id, run.id, { bucket: 1, hashes: [a] });
    expect(done).toMatchObject({ itemsChecked: 1, itemsMissing: 0, missingHashes: [], pendingBuckets: [] });
    expect(done.completedAt).not.toBeNull();
    expect(await sut.submit(auth, device.id, run.id, { bucket: 1, hashes: [a] })).toEqual(done);
  });
  it('models older restored inventory and measures the missing hash exactly', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
    await ctx.newAsset({
      ownerId: user.id,
      checksum: Buffer.from(a, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const { asset: lost } = await ctx.newAsset({
      ownerId: user.id,
      checksum: Buffer.from(b, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    await db.deleteFrom('asset').where('id', '=', lost.id).execute();
    const device = await sut.register(auth, report());
    const run = await sut.start(auth, device.id, { buckets: bucketInventory([a, b]) });
    const done = await sut.submit(auth, device.id, run.id, { bucket: 1, hashes: [b, a] });
    expect(done).toMatchObject({ itemsChecked: 2, itemsMissing: 1, missingHashes: [b] });
  });
  it('refuses changed inventory and invalid hash lists without completing or fabricating counts', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
    const device = await sut.register(auth, report());
    const run = await sut.start(auth, device.id, { buckets: bucketInventory([a]) });
    await expect(sut.submit(auth, device.id, run.id, { bucket: 1, hashes: [a, a] })).rejects.toThrow();
    await expect(sut.submit(auth, device.id, run.id, { bucket: 1, hashes: [b] })).rejects.toThrow();
    await ctx.newAsset({
      ownerId: user.id,
      checksum: Buffer.from(a, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    await expect(sut.submit(auth, device.id, run.id, { bucket: 1, hashes: [a] })).rejects.toThrow('inventory changed');
    const row = await db
      .selectFrom('backup_reconciliation')
      .selectAll()
      .where('id', '=', run.id)
      .executeTakeFirstOrThrow();
    expect(row).toMatchObject({ completedAt: null, itemsChecked: 0, itemsMissing: 0 });
  });
  it('keeps two devices independent, idempotently updates reports and removes no assets', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const dto = report();
    const first = await sut.register(auth, dto);
    const second = await sut.register(auth, report());
    const updated = await sut.register(auth, {
      ...dto,
      displayName: 'Renamed',
      pendingCount: 0,
      lastSuccessfulBackupAt: new Date(Date.now() - 3 * 86_400_000).toISOString(),
    });
    expect(updated).toMatchObject({ id: first.id, displayName: 'Renamed', pendingCount: 0, quietForDays: 3 });
    expect((await sut.list(auth, page)).devices.map((d) => d.id).sort()).toEqual([first.id, second.id].sort());
    await sut.remove(auth, first.id);
    expect((await sut.list(auth, page)).devices).toHaveLength(1);
    expect(await db.selectFrom('asset').select('id').where('id', '=', asset.id).executeTakeFirst()).toEqual({
      id: asset.id,
    });
  });
  it('admin metadata access never grants foreign registry mutation or hash reconciliation', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const owner = factory.auth({ user, session: { hasElevatedPermission: true } });
    const admin = factory.auth({ user: { ...other, isAdmin: true }, session: { hasElevatedPermission: true } });
    const device = await sut.register(owner, report());
    expect((await sut.list(admin, page)).devices).toEqual([]);
    expect((await sut.list(admin, { limit: 200, offset: 0 }, true)).devices.some((d) => d.id === device.id)).toBe(true);
    await expect(sut.remove(admin, device.id)).rejects.toThrow('not found');
    await expect(sut.start(admin, device.id, { buckets: bucketInventory([]) })).rejects.toThrow('not found');
  });
  it('refuses private-filtered checks rather than recording Locked originals missing; elevated check includes them', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      checksum: Buffer.from(a, 'hex'),
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    await db
      .insertInto('asset_lock')
      .values({ assetId: asset.id, reason: AssetLockReason.Marked, lockedBy: null })
      .execute();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
    const device = await sut.register(auth, report());
    await expect(sut.start(factory.auth({ user }), device.id, { buckets: bucketInventory([a]) })).rejects.toThrow(
      'elevated',
    );
    await expect(
      sut.start({ ...auth, hideNsfwAssets: true }, device.id, { buckets: bucketInventory([a]) }),
    ).rejects.toThrow();
    expect((await sut.history(auth, device.id, page)).runs).toEqual([]);
    expect(await sut.start(auth, device.id, { buckets: bucketInventory([a]) })).toMatchObject({
      itemsChecked: 1,
      itemsMissing: 0,
    });
  });
  it('resumes independent differing buckets without completing a partial audit', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
    const other = '02' + 'c'.repeat(62);
    const device = await sut.register(auth, report());
    const run = await sut.start(auth, device.id, { buckets: bucketInventory([a, other]) });
    const partial = await sut.submit(auth, device.id, run.id, { bucket: 1, hashes: [a] });
    expect(partial).toMatchObject({ completedAt: null, itemsChecked: 1, itemsMissing: 1, pendingBuckets: [2] });
    const done = await sut.submit(auth, device.id, run.id, { bucket: 2, hashes: [other] });
    expect(done).toMatchObject({ itemsChecked: 2, itemsMissing: 2, pendingBuckets: [] });
    expect(done.completedAt).not.toBeNull();
  });
  it('concurrent followups never double-count and snapshot conflicts are retryable', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user, session: { hasElevatedPermission: true } });
    const device = await sut.register(auth, report());
    const run = await sut.start(auth, device.id, { buckets: bucketInventory([a]) });
    const outcomes = await Promise.allSettled([
      sut.submit(auth, device.id, run.id, { bucket: 1, hashes: [a] }),
      sut.submit(auth, device.id, run.id, { bucket: 1, hashes: [a] }),
    ]);
    expect(outcomes.some((result) => result.status === 'fulfilled')).toBe(true);
    for (const outcome of outcomes) if (outcome.status === 'rejected') expect(outcome.reason.getStatus()).toBe(409);
    expect(await sut.submit(auth, device.id, run.id, { bucket: 1, hashes: [a] })).toMatchObject({
      itemsChecked: 1,
      itemsMissing: 1,
    });
  });
});
