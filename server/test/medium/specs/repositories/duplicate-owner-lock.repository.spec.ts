import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { JobStatus } from 'src/enum.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { AssetJobRepository } from 'src/repositories/asset-job.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { DuplicateDecisionRepository } from 'src/repositories/duplicate-decision.repository.js';
import { DuplicateRepository, lockDuplicateOwner } from 'src/repositories/duplicate.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MachineLearningRepository } from 'src/repositories/machine-learning.repository.js';
import { DB } from 'src/schema/index.js';
import { DuplicateService } from 'src/services/duplicate.service.js';
import { MediumTestContext, newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

// FL-1601: one per-owner advisory lock replaces row-locking every photo the owner has.

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const modelKey = `clip:${'d'.repeat(64)}`;
// unit vectors in one plane: 0° and 45° (and 45° and 90°) are look-alikes at 0.5, 0° and 90° are not
const embedding = (degrees: number) => {
  const radians = (degrees * Math.PI) / 180;
  return JSON.stringify([Math.cos(radians), Math.sin(radians), ...Array.from({ length: 766 }, () => 0)]);
};

const setup = async () => {
  const { sut, ctx } = newMediumService(DuplicateService, {
    database: db,
    real: [AssetJobRepository, AssetRepository, CryptoRepository, DuplicateRepository],
    mock: [JobRepository, LoggingRepository, MachineLearningRepository],
  });
  ctx.getMock(MachineLearningRepository).captureClipRead.mockResolvedValue({
    assertCurrent: () => Promise.resolve(),
    publish: <T>(write: () => Promise<T>) => write(),
  } as never);
  vi.spyOn(sut as unknown as { getConfig: () => Promise<unknown> }, 'getConfig').mockResolvedValue({
    machineLearning: {
      enabled: true,
      clip: { enabled: true },
      duplicateDetection: { enabled: true, maxDistance: 0.5, enhancedVideo: { enabled: false } },
    },
    libraryCare: { duplicateReview: true },
  });
  const { user } = await ctx.newUser();
  return { sut, ctx, ownerId: user.id };
};

const newPhoto = async (ctx: MediumTestContext, ownerId: string, degrees: number, duplicateId?: string) => {
  const { asset } = await ctx.newAsset({ ownerId, duplicateId });
  await db
    .insertInto('smart_search')
    .values({ assetId: asset.id, embedding: embedding(degrees), producerModelKey: modelKey })
    .execute();
  return asset.id;
};

/** Runs a detection job the way the queue publishes it: inside one accepted-claim transaction. */
const detect = (sut: DuplicateService, id: string) =>
  db.transaction().execute((tx) => publicationTransaction.run(tx, () => sut.handleSearchDuplicates({ id })));

const holdOwnerLock = async (
  ownerId: string,
  work?: (tx: Parameters<typeof lockDuplicateOwner>[0]) => Promise<void>,
) => {
  const { promise: held, resolve: entered } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const committed = db.transaction().execute(async (tx) => {
    await lockDuplicateOwner(tx, ownerId);
    await work?.(tx);
    entered();
    await gate;
  });
  await held;
  return { release, committed };
};

const waitersOnOwnerLock = async () => {
  const { rows } = await sql<{ count: number }>`SELECT count(*)::int AS count FROM pg_locks
    WHERE locktype = 'advisory' AND classid = (-1601)::oid AND NOT granted`.execute(db);
  return rows[0].count;
};

const groupOf = async (ids: string[]) => {
  const rows = await db.selectFrom('asset').select(['id', 'duplicateId']).where('id', 'in', ids).execute();
  return Object.fromEntries(rows.map(({ id, duplicateId }) => [id, duplicateId]));
};

it("detection does not wait on a row lock held on another of the owner's photos", async () => {
  const { sut, ctx, ownerId } = await setup();
  const a = await newPhoto(ctx, ownerId, 0);
  const b = await newPhoto(ctx, ownerId, 0);
  const unrelated = await newPhoto(ctx, ownerId, 90);
  const { promise: held, resolve: entered } = Promise.withResolvers<void>();
  const { promise: gate, resolve: release } = Promise.withResolvers<void>();
  const editing = db.transaction().execute(async (tx) => {
    await tx.selectFrom('asset').select('id').where('id', '=', unrelated).forUpdate().execute();
    entered();
    await gate;
  });
  await held;
  try {
    // the owner-wide FOR UPDATE this replaced would block here until the edit committed
    const status = await db.transaction().execute(async (tx) => {
      await sql`SET LOCAL lock_timeout = '2s'`.execute(tx);
      return publicationTransaction.run(tx, () => sut.handleSearchDuplicates({ id: a }));
    });
    expect(status).toBe(JobStatus.Success);
  } finally {
    release();
  }
  await editing;
  const groups = await groupOf([a, b, unrelated]);
  expect(groups[a]).toEqual(expect.any(String));
  expect(groups[b]).toBe(groups[a]);
  expect(groups[unrelated]).toBeNull();
});

it('two detection jobs for one owner join one group instead of splitting a shared look-alike', async () => {
  const { sut, ctx, ownerId } = await setup();
  // 0° and 90° are not alike, but both look like 45°; run concurrently without the lock, each would
  // see 45° ungrouped and start its own group, leaving one of them apart from its match
  const left = await newPhoto(ctx, ownerId, 0);
  const middle = await newPhoto(ctx, ownerId, 45);
  const right = await newPhoto(ctx, ownerId, 90);
  const { release, committed } = await holdOwnerLock(ownerId);
  const jobs = [detect(sut, left), detect(sut, right)];
  try {
    await expect.poll(waitersOnOwnerLock).toBe(2);
  } finally {
    release();
  }
  await committed;
  expect(await Promise.all(jobs)).toEqual([JobStatus.Success, JobStatus.Success]);
  const groups = await groupOf([left, middle, right]);
  expect(groups[left]).toEqual(expect.any(String));
  expect(groups[middle]).toBe(groups[left]);
  expect(groups[right]).toBe(groups[left]);
});

it('a resolution racing a detection job waits for it to commit', async () => {
  const { ctx, ownerId } = await setup();
  const duplicateId = randomUUID();
  const kept = await newPhoto(ctx, ownerId, 0, duplicateId);
  await newPhoto(ctx, ownerId, 0, duplicateId);
  const joining = await newPhoto(ctx, ownerId, 0);
  const events: string[] = [];
  // a detection publication: holds the owner lock while it adds a photo to the group
  const { release, committed } = await holdOwnerLock(ownerId, async (tx) => {
    await tx.updateTable('asset').set({ duplicateId }).where('id', '=', joining).execute();
  });
  const resolution = new DuplicateRepository(db).withResolutionLock(duplicateId, async () => {
    events.push('resolution');
    await new AssetRepository(db).updateAll([kept], { isFavorite: true });
  });
  try {
    await expect.poll(waitersOnOwnerLock).toBe(1);
    expect(events).toEqual([]);
  } finally {
    events.push('detection');
    release();
  }
  await committed;
  await resolution;
  expect(events).toEqual(['detection', 'resolution']);
  expect(await groupOf([joining])).toEqual({ [joining]: duplicateId });
});

it('a keep-all or undo waits for a detection job on the same owner', async () => {
  const { ctx, ownerId } = await setup();
  const decisions = new DuplicateDecisionRepository(db);
  const duplicateId = randomUUID();
  const a = await newPhoto(ctx, ownerId, 0, duplicateId);
  const b = await newPhoto(ctx, ownerId, 0, duplicateId);
  const { release, committed } = await holdOwnerLock(ownerId);
  const unlink = decisions.unlink(ownerId, [a, b], duplicateId);
  try {
    await expect.poll(waitersOnOwnerLock).toBe(1);
    expect(await groupOf([a, b])).toEqual({ [a]: duplicateId, [b]: duplicateId });
  } finally {
    release();
  }
  await committed;
  await unlink;
  expect(await groupOf([a, b])).toEqual({ [a]: null, [b]: null });
  await decisions.relink(ownerId, [a, b], duplicateId);
  expect(await groupOf([a, b])).toEqual({ [a]: duplicateId, [b]: duplicateId });
});
