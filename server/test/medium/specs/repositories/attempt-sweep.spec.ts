import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, realpath, rm, utimes, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { pruneQueueHistory } from 'src/queue/retention.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { QueueClaim } from 'src/queue/types.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { PhysicalFileRepository, lockFilePath } from 'src/repositories/physical-file.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { ATTEMPT_EVIDENCE_PREFIX, pruneWorkerStopEvidence, recordStoppedAttempt } from 'src/utils/attempt-evidence.js';
import { closeAttemptSweep } from 'src/utils/attempt-sweep.js';
import { ATTEMPT_GRACE_MS } from 'src/utils/attempt-tree.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** Real PG references and filesystem files. Media bytes are tiny scheduling fixtures. */
describe('attempt output retention and cleanup', () => {
  let db: Kysely<DB>;
  let store: SqlQueueStore;
  let root: string;
  let queue: string;
  let worker: string;
  const setup = () => {
    const { ctx } = newMediumService(BaseService, {
      database: db,
      real: [AssetRepository, PersonRepository],
      mock: [LoggingRepository],
    });
    return { ctx, files: ctx.get(PhysicalFileRepository) };
  };
  const claim = async (complete = true) => {
    await store.enqueue([
      { queue, name: 'fixture', data: {}, safeToRetry: true, sensitive: false, deadlineMs: 600_000 },
    ]);
    const [claimed] = await store.claim(queue, worker);
    if (complete) expect(await store.complete(claimed, [])).toBe(true);
    // Advance only the fixture clock; outcomes are produced by the real queue transition.
    await sql`UPDATE job_attempt SET "finishedAt"=clock_timestamp()-interval '2 days' WHERE token=${claimed.token}::uuid AND "finishedAt" IS NOT NULL`.execute(
      db,
    );
    return claimed;
  };
  const file = async (claimed: Pick<QueueClaim, 'id' | 'token'>, name: string) => {
    const path = join(root, '.attempts', claimed.id, claimed.token, name);
    await mkdir(dirname(path), { recursive: true });
    await writeFile(path, 'generated fixture');
    const old = new Date(Date.now() - 2 * ATTEMPT_GRACE_MS);
    await utimes(path, old, old);
    return path;
  };
  beforeAll(async () => {
    db = await getKyselyDB();
    store = new SqlQueueStore(db);
  });
  beforeEach(async () => {
    root = await mkdtemp(join(await realpath(tmpdir()), 'attempt-pg-'));
    queue = `attempt-${randomUUID()}`;
    worker = randomUUID();
    await store.initialize([queue], worker);
  });
  afterEach(async () => {
    await rm(root, { force: true, recursive: true });
  });

  it('keeps profile references, Buddy pins, active expired claims and unknown history; removes a settled orphan', async () => {
    const { ctx, files } = setup();
    const { user } = await ctx.newUser();
    const settled = await claim();
    const orphan = await file(settled, 'orphan.jpeg');
    const referenced = await file(settled, 'profile.jpeg');
    const pinned = await file(settled, 'pinned.jpeg');
    await db.updateTable('user').set({ profileImagePath: referenced }).where('id', '=', user.id).execute();
    await sql`INSERT INTO buddy_backup_reference ("runId",path) VALUES (${randomUUID()}::uuid,${pinned})`.execute(db);
    const active = await claim(false);
    const inFlight = await file(active, 'active.jpeg');
    await sql`UPDATE job SET "leaseExpiresAt"=clock_timestamp()-interval '1 day' WHERE id=${active.id}::uuid`.execute(
      db,
    );
    const unknown = await file({ id: randomUUID(), token: randomUUID() }, 'unknown.jpeg');
    const result = await files.sweepAttempts([root]);
    expect(result?.deleted).toBe(1);
    const { rows: states } = await sql`SELECT jsonb_typeof(value) AS type, value->'roots' AS roots,
      jsonb_typeof(value->'cursor') AS "cursorType", jsonb_typeof(value->'pass') AS "passType",
      jsonb_typeof(value->'owner') AS "ownerType", value->'expires' AS expires FROM system_metadata
      WHERE key='frameleaf-attempt-cleanup-v1'`.execute(db);
    expect(states).toEqual([
      { type: 'object', roots: [root], cursorType: 'object', passType: 'object', ownerType: 'null', expires: 0 },
    ]);
    await expect(readFile(orphan)).rejects.toMatchObject({ code: 'ENOENT' });
    for (const path of [referenced, pinned, inFlight, unknown])
      expect(await readFile(path, 'utf8')).toBe('generated fixture');
    await db.updateTable('user').set({ profileImagePath: '' }).where('id', '=', user.id).execute();
    await sql`UPDATE buddy_backup_reference SET released=true WHERE path=${pinned}`.execute(db);
    await files.sweepAttempts([root]); // bounded evidence-pruning phase between complete traversals
    expect((await files.sweepAttempts([root]))?.deleted).toBe(2);
  });

  it('continues from persisted bounded slices after a repository restart and honors another live owner', async () => {
    const { files } = setup();
    const settled = await claim();
    for (let index = 0; index < 120; index++) await file(settled, `${index}.jpeg`);
    await sql`UPDATE job SET "finishedAt"=clock_timestamp()-interval '8 days' WHERE id=${settled.id}::uuid`.execute(db);
    await pruneQueueHistory(db);
    let deleted = 0;
    let done = false;
    for (let slice = 0; slice < 20 && !done; slice++) {
      await closeAttemptSweep(); // discard process-local directory streams, preserve only the SQL cursor
      const restarted = slice === 0 ? files : new PhysicalFileRepository(db);
      const result = await restarted.sweepAttempts([root]);
      expect(result).toBeDefined();
      expect(result!.examined).toBeLessThanOrEqual(100);
      expect(result!.visited).toBeLessThanOrEqual(1000);
      deleted += result!.deleted;
      done = result!.done;
    }
    expect(done).toBe(true);
    expect(deleted).toBe(120);
    await sql`UPDATE system_metadata SET value=jsonb_set(jsonb_set(value,'{owner}',to_jsonb(${randomUUID()}::text)),
      '{expires}',to_jsonb(extract(epoch FROM clock_timestamp())*1000+60000)) WHERE key='frameleaf-attempt-cleanup-v1'`.execute(
      db,
    );
    try {
      expect(await files.sweepAttempts([root])).toBeUndefined();
    } finally {
      await sql`UPDATE system_metadata SET value=jsonb_set(value,'{expires}','0'::jsonb) WHERE key='frameleaf-attempt-cleanup-v1'`.execute(
        db,
      );
    }
  }, 30_000);

  it('never races a job publication, and a path-locked reference writer wins against deletion', async () => {
    const { ctx, files } = setup();
    const { user } = await ctx.newUser();
    const settled = await claim();
    const path = await file(settled, 'publishing.jpeg');
    const { promise: ready, resolve: locked } = Promise.withResolvers<void>();
    const { promise: wait, resolve: release } = Promise.withResolvers<void>();
    const publication = db.transaction().execute(async (tx) => {
      await sql`SELECT id FROM job WHERE id=${settled.id}::uuid FOR UPDATE`.execute(tx);
      await lockFilePath(tx, path);
      locked();
      await wait;
      await tx.updateTable('user').set({ profileImagePath: path }).where('id', '=', user.id).execute();
    });
    try {
      await ready;
      // The sweep skips the locked job rather than waiting for the publisher's work.
      expect((await files.sweepAttempts([root]))?.deleted).toBe(0);
      expect(await readFile(path, 'utf8')).toBe('generated fixture');
    } finally {
      release();
      await publication;
    }
    const unlink = vi.fn().mockResolvedValue(undefined);
    expect((await files.deleteUnreferencedPath(path, unlink)).deleted).toBe(false);
    expect(unlink).not.toHaveBeenCalled();
  });

  it('retains compact proof after SQL history pruning, preserves recent files, then releases proof after a later complete pass', async () => {
    const { files } = setup();
    const settled = await claim();
    const path = await file(settled, 'recent.jpeg');
    await utimes(path, new Date(), new Date());
    await sql`UPDATE job SET "finishedAt"=clock_timestamp()-interval '8 days' WHERE id=${settled.id}::uuid`.execute(db);
    await pruneQueueHistory(db);
    expect((await sql`SELECT id FROM job WHERE id=${settled.id}::uuid`.execute(db)).rows).toHaveLength(0);
    const evidence = () =>
      sql`SELECT value FROM system_metadata WHERE key=${ATTEMPT_EVIDENCE_PREFIX + settled.token}`.execute(db);
    expect((await evidence()).rows).toHaveLength(1);
    expect((await files.sweepAttempts([root]))?.deleted).toBe(0);
    await files.sweepAttempts([root]); // first complete pass prunes no seen evidence
    expect((await evidence()).rows).toHaveLength(1);
    const old = new Date(Date.now() - ATTEMPT_GRACE_MS * 2);
    await utimes(path, old, old);
    expect((await files.sweepAttempts([root]))?.deleted).toBe(1);
    await files.sweepAttempts([root]); // deletion pass still saw the file
    expect((await evidence()).rows).toHaveLength(1);
    // Empty claim directories also keep their proof until their own grace period ends.
    await utimes(dirname(path), old, old);
    for (let slice = 0; slice < 8 && (await evidence()).rows.length > 0; slice++) await files.sweepAttempts([root]);
    expect((await evidence()).rows).toHaveLength(0);
  });

  it('releases unseen stopped proof after a complete pass when the application clock is behind PostgreSQL', async () => {
    const {
      rows: [clockRow],
    } = await sql<{ millisecond: number }>`SELECT
      floor(extract(epoch FROM clock_timestamp()) * 1000)::bigint AS millisecond`.execute(db);
    const { millisecond } = clockRow;
    // Control only the sweep's two clock projections; their result types still pass through
    // the real driver. The pass starts between two proofs in the same millisecond.
    const clockDb = db.withPlugin({
      transformQuery({ node }) {
        if (node.kind !== 'RawNode') return node;
        return {
          ...node,
          sqlFragments: node.sqlFragments.map((fragment) =>
            fragment.includes(' AS now')
              ? fragment.replace(
                  'clock_timestamp()',
                  () =>
                    `(to_timestamp(${millisecond}::double precision / 1000) + interval '750 microseconds')`,
                )
              : fragment,
          ),
        };
      },
      transformResult: ({ result }) => Promise.resolve(result),
    });
    const files = new PhysicalFileRepository(clockDb);
    const token = randomUUID();
    const laterToken = randomUUID();
    await recordStoppedAttempt(db, randomUUID(), token);
    await recordStoppedAttempt(db, randomUUID(), laterToken);
    await sql`UPDATE system_metadata SET value=jsonb_set(value,'{recordedAt}',
      to_jsonb(${millisecond}::numeric + CASE WHEN key=${ATTEMPT_EVIDENCE_PREFIX + token} THEN 0.25 ELSE 0.875 END))
      WHERE key IN (${ATTEMPT_EVIDENCE_PREFIX + token},${ATTEMPT_EVIDENCE_PREFIX + laterToken})`.execute(db);
    await sql`DELETE FROM system_metadata WHERE key='frameleaf-attempt-cleanup-v1'`.execute(db);
    const now = Date.now;
    const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() - 60 * 60 * 1000);
    try {
      expect((await files.sweepAttempts([root]))?.done).toBe(true);
      await files.sweepAttempts([root]);
      expect(
        (await sql`SELECT value FROM system_metadata WHERE key=${ATTEMPT_EVIDENCE_PREFIX + token}`.execute(db)).rows,
      ).toHaveLength(0);
      expect(
        (await sql`SELECT value FROM system_metadata WHERE key=${ATTEMPT_EVIDENCE_PREFIX + laterToken}`.execute(db))
          .rows,
      ).toHaveLength(1);
    } finally {
      clock.mockRestore();
    }
  });

  it('restarts a saved traversal with an unknown clock before pruning proof for an unseen output', async () => {
    const { files } = setup();
    expect((await files.sweepAttempts([root]))?.done).toBe(true);
    const stopped = { id: randomUUID(), token: randomUUID() };
    const path = await file(stopped, 'late.jpeg');
    await recordStoppedAttempt(db, stopped.id, stopped.token);
    await sql`UPDATE system_metadata SET value=jsonb_set(
      jsonb_set(value #- '{pass,clock}', '{pass,startedAt}',to_jsonb(extract(epoch FROM clock_timestamp())*1000+3600000)),
      '{cursor}',jsonb_build_object('root',1,'stack','[]'::jsonb)) WHERE key='frameleaf-attempt-cleanup-v1'`.execute(
      db,
    );

    expect(await files.sweepAttempts([root])).toMatchObject({ done: true, deleted: 0, incomplete: false });
    await files.sweepAttempts([root]);

    expect(await readFile(path, 'utf8')).toBe('generated fixture');
    expect(
      (await sql`SELECT value FROM system_metadata WHERE key=${ATTEMPT_EVIDENCE_PREFIX + stopped.token}`.execute(db))
        .rows,
    ).toHaveLength(1);
  });

  it('prunes only worker-stop proof without a registered worker and leaves neighboring metadata alone', async () => {
    const orphan = randomUUID();
    const keys = [
      `frameleaf-worker-stopped:${orphan}`,
      `frameleaf-worker-stopped:${worker}`,
      `frameleaf-worker-stopped-extra:${orphan}`,
    ];
    await sql`INSERT INTO system_metadata (key,value) VALUES
      (${keys[0]},jsonb_build_object('workerId',${orphan}::text)),
      (${keys[1]},jsonb_build_object('workerId',${worker}::text)),
      (${keys[2]},jsonb_build_object('workerId',${orphan}::text))`.execute(db);

    await pruneWorkerStopEvidence(db);

    expect(
      (await sql<{ key: string }>`SELECT key FROM system_metadata WHERE key=ANY(${keys}::text[])`.execute(db)).rows
        .map(({ key }) => key)
        .sort(),
    ).toEqual(keys.slice(1).sort());
  });

  it('retains compact proof while its exact attempt token remains in SQL history', async () => {
    const { files } = setup();
    const settled = await claim();
    await recordStoppedAttempt(db, settled.id, settled.token);
    const evidence = () =>
      sql`SELECT value FROM system_metadata WHERE key=${ATTEMPT_EVIDENCE_PREFIX + settled.token}`.execute(db);

    expect((await files.sweepAttempts([root]))?.done).toBe(true);
    await files.sweepAttempts([root]);
    expect((await evidence()).rows).toHaveLength(1);

    await sql`DELETE FROM job WHERE id=${settled.id}::uuid`.execute(db);
    expect((await files.sweepAttempts([root]))?.done).toBe(true);
    await files.sweepAttempts([root]);
    expect((await evidence()).rows).toHaveLength(0);
  });

  it.each(['initial', 'completed', 'incomplete'] as const)(
    'retains evidence recorded after the %s pass begins when the application clock is ahead',
    async (previous) => {
      const { files } = setup();
      const token = randomUUID();
      const missing = join(root, 'missing');
      const roots = previous === 'incomplete' ? [root, missing] : [root];
      await sql`DELETE FROM system_metadata WHERE key='frameleaf-attempt-cleanup-v1'`.execute(db);
      const now = Date.now;
      const clock = vi.spyOn(Date, 'now').mockImplementation(() => now() + 60 * 60 * 1000);
      try {
        const first = await files.sweepAttempts(roots);
        expect(first).toMatchObject({ done: true, incomplete: previous === 'incomplete' });
        if (previous === 'completed') await files.sweepAttempts(roots);
        else if (previous === 'incomplete') await mkdir(missing);

        // The producer stops only after this traversal's boundary. Its proof must survive
        // until another full pass can account for any outputs it left behind the cursor.
        await recordStoppedAttempt(db, randomUUID(), token);
        if (previous !== 'initial') expect((await files.sweepAttempts(roots))?.done).toBe(true);
        await files.sweepAttempts(roots);
        expect(
          (await sql`SELECT value FROM system_metadata WHERE key=${ATTEMPT_EVIDENCE_PREFIX + token}`.execute(db)).rows,
        ).toHaveLength(1);

        expect((await files.sweepAttempts(roots))?.done).toBe(true);
        await files.sweepAttempts(roots);
        expect(
          (await sql`SELECT value FROM system_metadata WHERE key=${ATTEMPT_EVIDENCE_PREFIX + token}`.execute(db)).rows,
        ).toHaveLength(0);
      } finally {
        clock.mockRestore();
      }
    },
  );

  it('retains stopped proof until a missing subtree is included in a complete traversal', async () => {
    const { files } = setup();
    const token = randomUUID();
    const missing = join(root, 'missing');
    await recordStoppedAttempt(db, randomUUID(), token);
    for (let pass = 0; pass < 2; pass++) {
      expect(await files.sweepAttempts([root, missing])).toMatchObject({ done: true, incomplete: true });
      expect(
        (await sql`SELECT value FROM system_metadata WHERE key=${ATTEMPT_EVIDENCE_PREFIX + token}`.execute(db)).rows,
      ).toHaveLength(1);
    }
    await mkdir(missing);
    expect(await files.sweepAttempts([root, missing])).toMatchObject({ done: true, incomplete: false });
    await files.sweepAttempts([root, missing]);
    expect(
      (await sql`SELECT value FROM system_metadata WHERE key=${ATTEMPT_EVIDENCE_PREFIX + token}`.execute(db)).rows,
    ).toHaveLength(0);
  });

  it('does not equate lease recovery with stopped execution, but accepts the parent worker-stop proof', async () => {
    const { files } = setup();
    const first = await claim(false);
    const path = await file(first, 'expired.jpeg');
    await store.fail(first, 'Worker lease expired');
    await sql`UPDATE job SET "availableAt"=clock_timestamp() WHERE id=${first.id}::uuid`.execute(db);
    const [second] = await store.claim(queue, worker);
    await store.fail(second, 'Worker lease expired');
    await sql`UPDATE job SET "finishedAt"=clock_timestamp()-interval '31 days' WHERE id=${first.id}::uuid`.execute(db);
    await sql`UPDATE job_attempt SET "finishedAt"=clock_timestamp()-interval '31 days' WHERE "jobId"=${first.id}::uuid`.execute(
      db,
    );
    await pruneQueueHistory(db);
    expect((await sql`SELECT id FROM job WHERE id=${first.id}::uuid`.execute(db)).rows).toHaveLength(1);
    expect((await files.sweepAttempts([root]))?.deleted).toBe(0);
    expect(await readFile(path, 'utf8')).toBe('generated fixture');
    // This is the parent supervisor's contract, emitted only after executor/child exit.
    // Actual process termination is exercised by the dedicated supervisor fault tests.
    await sql`INSERT INTO system_metadata (key,value) VALUES (${`frameleaf-worker-stopped:${worker}`},
      jsonb_build_object('workerId',${worker}::text,'stoppedAt',extract(epoch FROM clock_timestamp()-interval '2 days')*1000))`.execute(
      db,
    );
    await pruneQueueHistory(db);
    expect((await sql`SELECT id FROM job WHERE id=${first.id}::uuid`.execute(db)).rows).toHaveLength(0);
    await files.sweepAttempts([root]);
    expect((await files.sweepAttempts([root]))?.deleted).toBe(1);
  });

  it('counts current and historical generated references before any unlink, including edited master sidecars', async () => {
    const { ctx, files } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const paths = Object.fromEntries(
      [
        'photo-master',
        'photo-preview',
        'person',
        'duplicate',
        'moment',
        'video-master',
        'video-proxy',
        'video-thumb',
        'standalone-master',
      ].map((name) => [name, join(root, name)]),
    );
    await sql`INSERT INTO asset_develop_revision ("assetId","ownerId",revision,recipe,"masterPath","previewPath","isCurrent")
      VALUES (${asset.id}::uuid,${user.id}::uuid,1,'{}',${paths['photo-master']},${paths['photo-preview']},false)`.execute(
      db,
    );
    const { person } = await ctx.newPerson({ ownerId: user.id, thumbnailPath: paths.person });
    await sql`INSERT INTO asset_video_duplicate_frame ("assetId","frameIndex","timestampMs",path,embedding)
      VALUES (${asset.id}::uuid,0,0,${paths.duplicate},${`[${Array.from({ length: 512 }, () => 0).join(',')}]`}::vector)`.execute(
      db,
    );
    await sql`INSERT INTO video_moment_frame ("assetId","frameIndex","timestampMs",path,score,rank)
      VALUES (${asset.id}::uuid,0,0,${paths.moment},1,1)`.execute(db);
    await sql`INSERT INTO video_edit_version ("assetId","ownerId","sourcePath","sourceChecksum",recipe,purpose,status,"masterPath","proxyPath",files)
      VALUES (${asset.id}::uuid,${user.id}::uuid,${asset.originalPath},${asset.checksum},'[]','save','ready',${paths['video-master']},${paths['video-proxy']},
        ${JSON.stringify([{ path: paths['video-thumb'] }])}::text::jsonb)`.execute(db);
    await sql`INSERT INTO asset_file ("assetId",type,path,"isEdited") VALUES (${asset.id}::uuid,'encoded_video',${paths['standalone-master']},true)`.execute(
      db,
    );
    const unlink = vi.fn().mockResolvedValue(undefined);
    const guarded = [
      ...Object.values(paths),
      `${paths['video-master']}.lineage.json`,
      `${paths['standalone-master']}.lineage.json`,
    ];
    for (const path of guarded) expect((await files.deleteUnreferencedPath(path, unlink)).deleted).toBe(false);
    expect(unlink).not.toHaveBeenCalled();
    await sql`DELETE FROM asset_develop_revision WHERE "assetId"=${asset.id}::uuid`.execute(db);
    await db
      .updateTable('person')
      .set({ thumbnailPath: '' })
      .where('ownerId', '=', user.id)
      .where('personGroupId', '=', person.personGroupId)
      .execute();
    await sql`DELETE FROM asset_video_duplicate_frame WHERE "assetId"=${asset.id}::uuid`.execute(db);
    await sql`DELETE FROM video_moment_frame WHERE "assetId"=${asset.id}::uuid`.execute(db);
    await sql`DELETE FROM video_edit_version WHERE "assetId"=${asset.id}::uuid`.execute(db);
    await sql`DELETE FROM asset_file WHERE "assetId"=${asset.id}::uuid`.execute(db);
    for (const path of guarded) expect((await files.deleteUnreferencedPath(path, unlink)).deleted).toBe(true);
    expect(unlink).toHaveBeenCalledTimes(guarded.length);
  });
});
