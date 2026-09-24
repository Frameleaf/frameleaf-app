import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { AssetVisibility } from 'src/enum.js';
import { ArchiveOperationRepository } from 'src/repositories/archive-operation.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetService } from 'src/services/asset.service.js';
import { MediumTestContext } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * Transactional archive (FL-32), ported from PR #133's `archive-operation` and `archive-preparation`
 * medium specs and adapted to the durable bulk job doing the work: the repository freezes the set,
 * publishes one batch per transaction and undoes only what nothing has changed since.
 */
describe(ArchiveOperationRepository.name, () => {
  let db: Kysely<DB>;
  let repo: ArchiveOperationRepository;
  let context: MediumTestContext<typeof AssetService>;
  let auth: AuthDto;
  const archiveJob = '0195e2a0-0000-7000-8000-0000000000a1';
  const undoJob = '0195e2a0-0000-7000-8000-0000000000a2';

  beforeAll(async () => {
    db = await getKyselyDB();
    repo = new ArchiveOperationRepository(db);
    context = new MediumTestContext(AssetService, { database: db, real: [], mock: [LoggingRepository] });
    await sql`UPDATE immich_fork.state SET phase = 'dual-write' WHERE id = 1`.execute(db);
  });

  beforeEach(async () => {
    const { result: user } = await context.newUser();
    const { result: session } = await context.newSession({ userId: user.id });
    auth = { user, session: { id: session.id, hasElevatedPermission: false } } as AuthDto;
  });

  afterAll(async () => {
    await db?.destroy();
  });

  const asset = async (overrides: Record<string, unknown> = {}) => {
    const { result } = await context.newAsset({ ownerId: auth.user.id, ...overrides });
    await context.newExif({ assetId: result.id, make: 'Canon' });
    return result.id;
  };

  const visibility = async (id: string) =>
    (await db.selectFrom('asset').select('visibility').where('id', '=', id).executeTakeFirstOrThrow()).visibility;

  /** The owner's own view of the counts (an unlocked reader sees every item). */
  const owner = { elevated: true };

  const confirmSelected = async (ids: string[], requestKey = randomUUID()) => {
    const id = await repo.createSelected(auth, requestKey, ids);
    await repo.startJob(auth.user.id, id, 'archive', () => Promise.resolve(archiveJob));
    return id;
  };

  /** A real bulk job row, so job status and retry lineage are what the queries read. */
  const job = async (status: string, retryOfId: string | null = null) => {
    const row = await db
      .insertInto('media_operation')
      .values({
        ownerId: auth.user.id,
        kind: 'bulk',
        status,
        destination: 'local',
        label: 'Archive',
        retryOfId,
        snapshot: sql`${JSON.stringify({ action: 'archive' })}::text::jsonb`,
        settings: sql`'{}'::jsonb`,
      } as never)
      .returning('id')
      .executeTakeFirstOrThrow();
    return row.id as string;
  };

  it('freezes and deduplicates a selection in order, and binds it to its request key', async () => {
    const [first, second] = [await asset(), await asset()];
    const key = randomUUID();

    const id = await repo.createSelected(auth, key, [second, first, second]);

    expect(await repo.createSelected(auth, key, [second, first])).toBe(id);
    await expect(repo.createSelected(auth, key, [first])).rejects.toThrow('different selection');
    expect(await repo.orderedAssetIds(id)).toEqual([second, first]);
    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ count: 2, pending: 2, prepared: false });
  });

  it('publishes a batch, recording the published update, and answers a repeated batch the same way', async () => {
    const [kept, moved] = [await asset(), await asset()];
    const id = await confirmSelected([kept, moved]);
    await db.updateTable('asset').set({ visibility: AssetVisibility.Hidden }).where('id', '=', moved).execute();

    const first = await repo.publish(auth.user.id, id, archiveJob, [kept, moved]);
    const again = await repo.publish(auth.user.id, id, archiveJob, [kept, moved]);

    expect(Object.fromEntries(first)).toEqual({ [kept]: 'archived', [moved]: 'skipped' });
    expect(Object.fromEntries(again)).toEqual(Object.fromEntries(first));
    expect(await visibility(kept)).toBe(AssetVisibility.Archive);
    expect(await visibility(moved)).toBe(AssetVisibility.Hidden);
    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ archived: 1, skipped: 1, pending: 0 });
  });

  it('refuses a job that is not the operation’s own, and another owner', async () => {
    const selected = await asset();
    const id = await confirmSelected([selected]);

    const foreignJob = await repo.publish(auth.user.id, id, undoJob, [selected]);
    const foreignOwner = await repo.publish(randomUUID(), id, archiveJob, [selected]);

    expect(foreignJob.get(selected)).toBe('missing');
    expect(foreignOwner.get(selected)).toBe('missing');
    expect(await visibility(selected)).toBe(AssetVisibility.Timeline);
  });

  it('undoes only items nothing has changed since, and never archives an unreached item afterwards', async () => {
    const [restored, changed, unreached] = [await asset(), await asset(), await asset()];
    const id = await confirmSelected([restored, changed, unreached]);
    await repo.publish(auth.user.id, id, archiveJob, [restored, changed]);
    // a newer change after the archive: the undo must leave it alone
    await db.updateTable('asset').set({ isFavorite: true }).where('id', '=', changed).execute();

    await repo.startJob(auth.user.id, id, 'undo', () => Promise.resolve(undoJob));
    const answers = await repo.restore(auth.user.id, id, undoJob, [restored, changed, unreached]);
    // the cancelled archive's last batch lands after the undo
    const late = await repo.publish(auth.user.id, id, archiveJob, [unreached]);

    expect(Object.fromEntries(answers)).toEqual({
      [restored]: 'undone',
      [changed]: 'conflict',
      [unreached]: 'cancelled',
    });
    expect(late.get(unreached)).toBe('skipped');
    expect(await visibility(restored)).toBe(AssetVisibility.Timeline);
    expect(await visibility(changed)).toBe(AssetVisibility.Archive);
    expect(await visibility(unreached)).toBe(AssetVisibility.Timeline);
    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ undone: 1, conflict: 1, skipped: 1, archived: 0 });
  });

  it('freezes exactly the owned, visible Timeline representatives and holds them until confirmed', async () => {
    const normal = await asset();
    const primary = await asset();
    const secondary = await asset();
    await context.newStack({ ownerId: auth.user.id }, [primary, secondary]);
    await asset({ visibility: AssetVisibility.Archive });
    await asset({ visibility: AssetVisibility.Locked });
    await asset({ deletedAt: new Date() });
    const { result: other } = await context.newUser();
    await context.newAsset({ ownerId: other.id });
    const key = randomUUID();

    const id = await repo.prepareMatching(auth, key);

    expect(new Set(await repo.orderedAssetIds(id))).toEqual(new Set([normal, primary]));
    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ prepared: true, count: 2 });
    expect(await repo.prepareMatching(auth, key)).toBe(id);
    const nothing = await repo.publish(auth.user.id, id, archiveJob, [normal]);
    expect(nothing.get(normal)).toBe('missing');

    await expect(repo.confirm(auth, id, randomUUID())).rejects.toThrow('does not identify');
    await repo.confirm(auth, id, key);

    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ prepared: false });
  });

  it('refuses a prepared selection after it expired, or without the unlock it was prepared under', async () => {
    await asset();
    const expiredKey = randomUUID();
    const expired = await repo.prepareMatching(auth, expiredKey);
    await sql`UPDATE immich_fork.archive_operation SET "expiresAt" = now() - interval '1 minute' WHERE id = ${expired}::uuid`.execute(
      db,
    );
    await expect(repo.confirm(auth, expired, expiredKey)).rejects.toThrow('expired');

    const elevated = { ...auth, session: { id: auth.session!.id, hasElevatedPermission: true } };
    const unlockedKey = randomUUID();
    const unlocked = await repo.prepareMatching(elevated, unlockedKey);
    await expect(repo.confirm(auth, unlocked, unlockedKey)).rejects.toThrow('Unlock again');
  });

  it('writes nothing while the fork schema is inactive (a handoff to official Immich)', async () => {
    await sql`UPDATE immich_fork.state SET phase = 'inactive' WHERE id = 1`.execute(db);
    try {
      await expect(repo.createSelected(auth, randomUUID(), [await asset()])).rejects.toThrow('handoff');
    } finally {
      await sql`UPDATE immich_fork.state SET phase = 'dual-write' WHERE id = 1`.execute(db);
    }
  });
  it('leaves out unreached items that are Locked now, and nothing else', async () => {
    const [open, locked] = [await asset(), await asset()];
    const key = randomUUID();
    const id = await repo.prepareMatching(auth, key);
    await context.newAsset({ ownerId: auth.user.id }); // not part of the frozen set
    await db
      .insertInto('asset_lock')
      .values({ assetId: locked, reason: 'marked' } as never)
      .execute();

    expect(await repo.skipLocked(auth.user.id, id)).toBe(1);
    expect(await repo.pendingAssetIds(id)).toEqual([open]);
    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ skipped: 1, pending: 1, count: 2 });
  });

  it('prunes expired selections and old operations whose jobs finished, keeping the rest', async () => {
    await asset();
    const expired = await repo.prepareMatching(auth, randomUUID());
    await sql`UPDATE immich_fork.archive_operation SET "expiresAt" = now() - interval '1 minute' WHERE id = ${expired}::uuid`.execute(
      db,
    );
    const old = await confirmSelected([await asset()]);
    await sql`UPDATE immich_fork.archive_operation SET "createdAt" = now() - interval '40 days' WHERE id = ${old}::uuid`.execute(
      db,
    );
    const recent = await confirmSelected([await asset()]);

    expect(await repo.prune(30)).toBeGreaterThanOrEqual(2);

    expect(await repo.get(auth.user.id, owner, expired)).toBeUndefined();
    expect(await repo.get(auth.user.id, owner, old)).toBeUndefined();
    expect(await repo.get(auth.user.id, owner, recent)).toBeDefined();
  });
  it('records unreached items a job left alone as skipped, only for its own job, keeping archived ones', async () => {
    const [archived, unreached] = [await asset(), await asset()];
    const id = await confirmSelected([archived, unreached]);
    await repo.publish(auth.user.id, id, archiveJob, [archived]);

    expect(await repo.skipUnreached(auth.user.id, id, undoJob, [unreached])).toBe(0);
    expect(await repo.skipUnreached(auth.user.id, id, archiveJob, [archived, unreached])).toBe(1);

    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ archived: 1, skipped: 1, pending: 0 });
  });

  it('leaves Locked items out of what an undo without the PIN may touch', async () => {
    const [open, locked] = [await asset(), await asset()];
    const id = await confirmSelected([open, locked]);
    await repo.publish(auth.user.id, id, archiveJob, [open, locked]);
    await db
      .insertInto('asset_lock')
      .values({ assetId: locked, reason: 'marked' } as never)
      .execute();

    expect(await repo.undoAssetIds(auth.user.id, id, false)).toEqual([open]);
    expect(await repo.undoAssetIds(auth.user.id, id, true)).toEqual([open, locked]);

    await repo.startJob(auth.user.id, id, 'undo', () => Promise.resolve(undoJob));
    await repo.restore(auth.user.id, id, undoJob, [open]);
    expect(await visibility(open)).toBe(AssetVisibility.Timeline);
    expect(await visibility(locked)).toBe(AssetVisibility.Archive);
    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ undone: 1, archived: 1 });
  });
  it('lets a retry of the linked job publish and takes the link over from it (P2-1)', async () => {
    const [first, second] = [await asset(), await asset()];
    const original = await job('cancelled');
    const retry = await job('queued', original);
    const id = await repo.createSelected(auth, randomUUID(), [first, second]);
    await repo.startJob(auth.user.id, id, 'archive', () => Promise.resolve(original));

    // a worker claims the retry before Activity's relink ran
    expect((await repo.publish(auth.user.id, id, retry, [first])).get(first)).toBe('archived');
    // the job it replaced can never publish again
    expect((await repo.publish(auth.user.id, id, original, [second])).get(second)).toBe('missing');
    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ archiveJobId: retry, archived: 1, pending: 1 });

    // a job outside the lineage is refused
    const stranger = await job('queued');
    expect((await repo.publish(auth.user.id, id, stranger, [second])).get(second)).toBe('missing');
  });

  it('moves the link to a retry when Activity creates it (P2-1)', async () => {
    const original = await job('failed');
    const retry = await job('queued', original);
    const id = await repo.createSelected(auth, randomUUID(), [await asset()]);
    await repo.startJob(auth.user.id, id, 'archive', () => Promise.resolve(original));

    await repo.relinkJob(id, original, retry);

    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ archiveJobId: retry, archiveJobStatus: 'queued' });
  });

  it('counts unreached items as skipped once their job has ended, and as pending while it runs', async () => {
    const running = await job('rendering');
    const id = await repo.createSelected(auth, randomUUID(), [await asset(), await asset()]);
    await repo.startJob(auth.user.id, id, 'archive', () => Promise.resolve(running));
    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ pending: 2, skipped: 0 });

    await db
      .updateTable('media_operation')
      .set({ status: 'cancelled' } as never)
      .where('id', '=', running)
      .execute();

    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ pending: 0, skipped: 2, count: 2 });
  });

  it('freezes foreign and missing ids as skipped, so the job never reaches them', async () => {
    const mine = await asset();
    const { result: other } = await context.newUser();
    const { result: theirs } = await context.newAsset({ ownerId: other.id });

    const id = await repo.createSelected(auth, randomUUID(), [mine, theirs.id, randomUUID()]);

    expect(await repo.pendingAssetIds(id)).toEqual([mine]);
    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ count: 3, pending: 1, skipped: 2 });
  });

  it('never counts Locked items for a session without the PIN (P2-4)', async () => {
    const [open, locked] = [await asset(), await asset()];
    const id = await repo.createSelected(auth, randomUUID(), [open, locked]);
    await db
      .insertInto('asset_lock')
      .values({ assetId: locked, reason: 'marked' } as never)
      .execute();

    expect(await repo.get(auth.user.id, { elevated: false }, id)).toMatchObject({ count: 1, pending: 1 });
    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ count: 2, pending: 2 });
  });

  it('counts another user’s ids the same whether or not they are Locked', async () => {
    const { result: other } = await context.newUser();
    const { result: theirOpen } = await context.newAsset({ ownerId: other.id });
    const { result: theirLocked } = await context.newAsset({ ownerId: other.id });
    await db
      .insertInto('asset_lock')
      .values({ assetId: theirLocked.id, reason: 'marked' } as never)
      .execute();

    const open = await repo.createSelected(auth, randomUUID(), [theirOpen.id]);
    const locked = await repo.createSelected(auth, randomUUID(), [theirLocked.id]);

    const reader = { elevated: false };
    expect(await repo.get(auth.user.id, reader, open)).toMatchObject({ count: 1, skipped: 1 });
    expect(await repo.get(auth.user.id, reader, locked)).toMatchObject({ count: 1, skipped: 1 });
  });

  it('starts a job once: a second start waits for the lock and sees the first link (P2-6)', async () => {
    const id = await repo.createSelected(auth, randomUUID(), [await asset()]);
    let started = 0;
    const start = async (operation: { archiveJobId: string | null }) => {
      if (operation.archiveJobId) {
        return null;
      }
      started++;
      await new Promise((resolve) => setTimeout(resolve, 50));
      return archiveJob;
    };

    await Promise.all([
      repo.startJob(auth.user.id, id, 'archive', start),
      repo.startJob(auth.user.id, id, 'archive', start),
    ]);

    expect(started).toBe(1);
    expect(await repo.get(auth.user.id, owner, id)).toMatchObject({ archiveJobId: archiveJob });
  });

  it('lists only the newest operations', async () => {
    for (let index = 0; index < 22; index++) {
      await repo.createSelected(auth, randomUUID(), [await asset()]);
    }
    expect(await repo.list(auth.user.id, owner)).toHaveLength(20);
  });
});
