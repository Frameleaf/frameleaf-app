import { Kysely, sql } from 'kysely';
import { randomUUID } from 'node:crypto';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import { StorageCore } from 'src/cores/storage.core.js';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { AssetType, MediaOperationKind, MediaOperationStatus, UserMetadataKey } from 'src/enum.js';
import { ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { ICloudWeeklyRepository } from 'src/repositories/icloud-weekly.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { ICloudStagingService } from 'src/services/icloud-staging.service.js';
import { decryptICloudSession, encryptICloudSession } from 'src/utils/icloud-sync.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

describe('weekly consent foundation, never execution authority', () => {
  let db: Kysely<DB>;
  let sut: ICloudWeeklyRepository;
  let sync: ICloudSyncRepository;
  beforeAll(async () => {
    db = await getKyselyDB();
    await expectCanonicalTables(db, ['icloud_identity_audit', 'icloud_weekly_grant']);

    sut = new ICloudWeeklyRepository(db);
    sync = new ICloudSyncRepository(db);
  });
  afterAll(async () => db.destroy());

  // Schema fixtures represent frozen, unexecuted future obligations, not producer/audit evidence.
  const freezeFixture = async (f: Awaited<ReturnType<typeof arrange>>, previousWeeks = 0) => {
    const cohortId = randomUUID();
    const receiptId = randomUUID();
    await sql`INSERT INTO public.icloud_weekly_cohort
      (id,"ownerId","connectionId","weekStart","grantId","grantGeneration","configFingerprint",
        "privacyFingerprint",seed,"manifestDigest","populationCount","staleCount","selectedCount")
      SELECT ${cohortId}::uuid,"ownerId","connectionId",date_trunc('week',clock_timestamp() AT TIME ZONE 'UTC')::date-${previousWeeks * 7}::int,
        id,generation,"configFingerprint","privacyFingerprint",${Buffer.alloc(32, 1)},${Buffer.alloc(32, 2)},1,0,1
      FROM public.icloud_weekly_grant WHERE "connectionId"=${f.connection.id}::uuid`.execute(db);
    await sql`INSERT INTO public.icloud_weekly_member
      ("cohortId","ownerId","connectionId","receiptId","resourceRoleKey",ordinal,rank,selected,"batchOrdinal",
        "grantId","grantGeneration","expectedSha256",bindings,"technicalEligibility")
      SELECT id,"ownerId","connectionId",${receiptId}::uuid,'ordinary-original',0,${Buffer.alloc(32, 3)},true,0,
        "grantId","grantGeneration",${Buffer.alloc(32, 4)},
        ${{ receipt: { id: receiptId }, source: { revision: 'frozen' }, identity: { revision: 'frozen' }, original: { revision: 'frozen' } }}::jsonb,'current'
      FROM public.icloud_weekly_cohort WHERE id=${cohortId}::uuid`.execute(db);
    return cohortId;
  };

  const arrange = async (protectedScope = false) => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser({ pinCode: protectedScope ? 'fixture-private-pin-binding' : null });
    const { session } = await ctx.newSession({ userId: user.id });
    await sql`UPDATE public.session SET "pinExpiresAt"=clock_timestamp()+interval '1 hour'
      WHERE id=${session.id}::uuid`.execute(db);
    const auth = factory.auth({ user, session });
    const connection = (await sync.create(user.id, 'Photos', ICloudConfigSchema.parse({})))!;
    await sync.update(connection.id, user.id, { state: 'connected', encryptedSession: 'fixture-only' });
    const input = { enabled: true, includeProtected: protectedScope, requestKey: randomUUID() };
    return { user, session, auth, connection, input };
  };

  it('discovers a new UTC week without replacing an old frozen obligation, including after retirement', async () => {
    const f = await arrange();
    const candidates = async () =>
      (await sut.scheduleCandidates()).filter((row) => row.connectionId === f.connection.id);
    expect(await candidates()).toEqual([]);
    await sut.setAuthority(f.auth, f.connection.id, f.input);
    const old = await freezeFixture(f, 1);
    expect(await candidates()).toEqual([
      { ownerId: f.user.id, connectionId: f.connection.id, cohortId: old },
      { ownerId: f.user.id, connectionId: f.connection.id, cohortId: null },
    ]);
    await sut.setAuthority(f.auth, f.connection.id, { ...f.input, enabled: false, requestKey: randomUUID() });
    expect(await candidates()).toEqual([{ ownerId: f.user.id, connectionId: f.connection.id, cohortId: old }]);
    expect(await sut.createNextBatch(old, new MediaOperationRepository(db))).toBeNull();
    expect(await candidates()).toEqual([]);
    expect(
      (
        await sql`SELECT status,"nextBatch","performedCount","unavailableCount" FROM public.icloud_weekly_cohort
        WHERE id=${old}::uuid`.execute(db)
      ).rows[0],
    ).toMatchObject({ status: 'settled', nextBatch: 0, performedCount: '0', unavailableCount: '1' });
  });

  it('does not consume the automatic weekly freeze when current consent is unavailable', async () => {
    const f = await arrange();
    await expect(sut.freezeCohort(f.user.id, f.connection.id, true)).rejects.toThrow('Weekly authority unavailable');
    expect(
      (await sql`SELECT 1 FROM public.icloud_weekly_cohort WHERE "connectionId"=${f.connection.id}::uuid`.execute(db))
        .rows,
    ).toEqual([]);
    await sut.setAuthority(f.auth, f.connection.id, f.input);
    const current = await sut.freezeCohort(f.user.id, f.connection.id, true);
    expect(await sut.freezeCohort(f.user.id, f.connection.id, true)).toEqual(current);
    expect((await sut.scheduleCandidates()).filter((row) => row.connectionId === f.connection.id)).toEqual([]);
  });

  it.each([MediaOperationStatus.Queued, MediaOperationStatus.Paused])(
    'does not advance the frozen cursor or create audit bindings while the connection has %s work',
    async (status) => {
      const f = await arrange();
      await sut.setAuthority(f.auth, f.connection.id, f.input);
      const cohortId = await freezeFixture(f);
      const queued = await sync.queueOperation(f.connection.id, f.user.id, { trigger: 'schedule' });
      if (!('operation' in queued)) {
        throw new Error('Fixture operation was not admitted');
      }
      const operation = queued.operation;
      await db.updateTable('media_operation').set({ status }).where('id', '=', operation.id).execute();
      expect(await sut.createNextBatch(cohortId, new MediaOperationRepository(db))).toBeNull();
      expect(
        (await sql`SELECT status,"nextBatch" FROM public.icloud_weekly_cohort WHERE id=${cohortId}::uuid`.execute(db))
          .rows,
      ).toEqual([{ status: 'frozen', nextBatch: 0 }]);
      expect(
        (
          await sql`SELECT outcome,"auditRequestId" FROM public.icloud_weekly_member WHERE "cohortId"=${cohortId}::uuid`.execute(
            db,
          )
        ).rows,
      ).toEqual([{ outcome: 'pending', auditRequestId: null }]);
      expect(
        (await sql`SELECT 1 FROM public.icloud_identity_audit WHERE "cohortId"=${cohortId}::uuid`.execute(db)).rows,
      ).toEqual([]);
      expect(
        (
          await sql`SELECT id FROM public.media_operation WHERE "ownerId"=${f.user.id}::uuid
          AND kind=${MediaOperationKind.ICloudSync}`.execute(db)
        ).rows,
      ).toEqual([{ id: operation.id }]);
    },
  );

  it('defaults off, never creates work, and requires individual current owner consent', async () => {
    const f = await arrange();
    expect(await sut.status(f.connection.id, f.user.id)).toEqual({
      enabled: false,
      includeProtected: false,
      available: false,
      regrantRequired: false,
      executionAvailable: false,
    });
    const granted = await sut.setAuthority(f.auth, f.connection.id, f.input);
    expect(granted).toMatchObject({ enabled: true, available: true, executionAvailable: false });
    expect(await sut.setAuthority(f.auth, f.connection.id, f.input)).toEqual(granted);
    expect(
      await sut.setAuthority(f.auth, f.connection.id, { ...f.input, requestKey: f.input.requestKey.toUpperCase() }),
    ).toEqual(granted);
    for (const table of ['icloud_weekly_cohort', 'icloud_weekly_member']) {
      const rows = await sql`SELECT 1 FROM ${sql.table(`public.${table}`)} WHERE "ownerId"=${f.user.id}::uuid`.execute(
        db,
      );
      expect(rows.rows).toEqual([]);
    }
    expect(JSON.stringify(granted)).not.toMatch(/generation|pinBinding|grantId|sessionId|requestKey/);
  });

  it('refuses missing/foreign/sessionless authority and protected consent without a real PIN', async () => {
    const f = await arrange();
    await expect(sut.setAuthority({ ...f.auth, session: undefined }, f.connection.id, f.input)).rejects.toThrow();
    await expect(sut.setAuthority({ ...f.auth, apiKey: {} as never }, f.connection.id, f.input)).rejects.toThrow();
    await expect(sut.setAuthority({ ...f.auth, sharedLink: {} as never }, f.connection.id, f.input)).rejects.toThrow();
    await expect(sut.setAuthority(f.auth, randomUUID(), f.input)).rejects.toThrow();
    await expect(sut.setAuthority(f.auth, f.connection.id, { ...f.input, includeProtected: true })).rejects.toThrow();
    const other = await arrange();
    await expect(sut.setAuthority(other.auth, f.connection.id, f.input)).rejects.toThrow();
    expect((await sut.status(f.connection.id, f.user.id)).enabled).toBe(false);
  });

  it.each(['expiresAt', 'pinExpiresAt'] as const)(
    'uses database clock for %s rather than serialized elevation',
    async (column) => {
      const f = await arrange(true);
      await sql`UPDATE public.session SET ${sql.id(column)}=clock_timestamp()-interval '1 second'
      WHERE id=${f.session.id}::uuid`.execute(db);
      f.auth.session!.hasElevatedPermission = true;
      await expect(sut.setAuthority(f.auth, f.connection.id, f.input)).rejects.toThrow();
      expect((await sut.status(f.connection.id, f.user.id)).enabled).toBe(false);
    },
  );

  it('preserves consent across unrelated ordinary preferences without broadening its scope', async () => {
    const f = await arrange();
    await sut.setAuthority(f.auth, f.connection.id, f.input);
    await db
      .updateTable('user_metadata')
      .set({ value: { download: { includeEmbeddedVideos: true } } })
      .where('userId', '=', f.user.id)
      .where('key', '=', UserMetadataKey.Preferences)
      .execute();
    expect(await sut.status(f.connection.id, f.user.id)).toMatchObject({
      enabled: true,
      includeProtected: false,
      available: true,
      executionAvailable: false,
    });
  });

  it.each(['expiresAt', 'pinExpiresAt'] as const)(
    'refuses %s expiring while the actual connection lock is awaited',
    async (column) => {
      const f = await arrange(true);
      await sql`UPDATE public.session SET ${sql.id(column)}=clock_timestamp()+interval '2 seconds'
      WHERE id=${f.session.id}::uuid`.execute(db);
      const held = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const blocker = db.transaction().execute(async (transaction) => {
        await sql`SELECT id FROM public.icloud_connection WHERE id=${f.connection.id}::uuid FOR UPDATE`.execute(
          transaction,
        );
        const pid = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(transaction);
        held.resolve(pid.rows[0].pid);
        await release.promise;
      });
      let submission: Promise<unknown> | undefined;
      try {
        const pid = await Promise.race([
          held.promise,
          blocker.then(() => {
            throw new Error('Connection did not pause');
          }),
        ]);
        // Capture rejection immediately; finally always settles both real transactions.
        submission = sut
          .setAuthority(f.auth, f.connection.id, f.input)
          .then(() => ({ accepted: true }))
          .catch((error: unknown) => ({ accepted: false, error }));
        await expect
          .poll(
            async () => {
              const observed = await sql<{ blocked: boolean }>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE datname=current_database()
          AND wait_event_type='Lock' AND ${pid}=ANY(pg_blocking_pids(pid))) AS blocked`.execute(db);
              return observed.rows[0].blocked;
            },
            { interval: 10, timeout: 1000 },
          )
          .toBe(true);
        await sql`SELECT pg_sleep(greatest(0,extract(epoch FROM (${sql.id(column)}-clock_timestamp()))+0.01))
        FROM public.session WHERE id=${f.session.id}::uuid`.execute(db);
        release.resolve();
        expect(await submission).toMatchObject({ accepted: false });
        expect((await sut.status(f.connection.id, f.user.id)).enabled).toBe(false);
        expect(
          (
            await sql`SELECT 1 FROM public.icloud_weekly_grant
        WHERE "connectionId"=${f.connection.id}::uuid`.execute(db)
          ).rows,
        ).toEqual([]);
      } finally {
        release.resolve();
        await Promise.allSettled([blocker, ...(submission ? [submission] : [])]);
      }
    },
  );

  it.each(['config', 'privacy', 'pin', 'disconnect'] as const)(
    'durably retires on %s change/restoration and cannot revive by replay or regrant',
    async (kind) => {
      const f = await arrange(true);
      await sut.setAuthority(f.auth, f.connection.id, f.input);
      const before = await sql<{ generation: number }>`SELECT generation FROM public.icloud_weekly_grant
        WHERE "connectionId"=${f.connection.id}::uuid`.execute(db);
      switch (kind) {
        case 'config': {
          await sync.update(f.connection.id, f.user.id, { config: { ...f.connection.config, intervalHours: 48 } });
          await sync.update(f.connection.id, f.user.id, { config: f.connection.config });
          break;
        }
        case 'privacy': {
          await db
            .insertInto('user_metadata')
            .values({
              userId: f.user.id,
              key: UserMetadataKey.Preferences,
              value: { privacy: { suppression: { tagIds: [randomUUID()] } } },
            })
            .onConflict((oc) =>
              oc
                .columns(['userId', 'key'])
                .doUpdateSet({ value: { privacy: { suppression: { tagIds: [randomUUID()] } } } }),
            )
            .execute();
          await db
            .deleteFrom('user_metadata')
            .where('userId', '=', f.user.id)
            .where('key', '=', UserMetadataKey.Preferences)
            .execute();
          break;
        }
        case 'pin': {
          await db.updateTable('user').set({ pinCode: 'changed-private-pin' }).where('id', '=', f.user.id).execute();
          await db.updateTable('user').set({ pinCode: f.user.pinCode }).where('id', '=', f.user.id).execute();
          break;
        }
        case 'disconnect': {
          await sync.disconnect(f.connection.id, f.user.id);
          await sync.update(f.connection.id, f.user.id, { state: 'connected', encryptedSession: 'fixture-only' });
          break;
        }
      }
      expect(await sut.status(f.connection.id, f.user.id)).toMatchObject({ enabled: false, regrantRequired: true });
      await expect(sut.setAuthority(f.auth, f.connection.id, f.input)).rejects.toThrow();
      await sut.setAuthority(f.auth, f.connection.id, { ...f.input, requestKey: randomUUID() });
      await expect(sut.setAuthority(f.auth, f.connection.id, f.input)).rejects.toThrow();
      const after = await sql<{ generation: number }>`SELECT generation FROM public.icloud_weekly_grant
        WHERE "connectionId"=${f.connection.id}::uuid`.execute(db);
      expect(after.rows[0].generation).toBeGreaterThan(before.rows[0].generation);
    },
  );

  it.each(['pin', 'privacy', 'config', 'disconnect', 'remove'] as const)(
    'rolls back %s and trigger retirement atomically without touching another owner',
    async (kind) => {
      const f = await arrange(true);
      const other = await arrange(true);
      await sut.setAuthority(f.auth, f.connection.id, f.input);
      await sut.setAuthority(other.auth, other.connection.id, other.input);
      const before =
        await sql`SELECT * FROM public.icloud_weekly_grant WHERE "connectionId"=${f.connection.id}::uuid`.execute(db);
      await expect(
        db.transaction().execute(async (transaction) => {
          switch (kind) {
            case 'pin': {
              await transaction
                .updateTable('user')
                .set({ pinCode: 'rollback-pin' })
                .where('id', '=', f.user.id)
                .execute();
              break;
            }
            case 'privacy': {
              await transaction
                .updateTable('user_metadata')
                .set({ value: { privacy: { suppression: { tagIds: [randomUUID()] } } } })
                .where('userId', '=', f.user.id)
                .where('key', '=', UserMetadataKey.Preferences)
                .execute();
              break;
            }
            case 'config': {
              await sql`UPDATE public.icloud_connection SET config=config || '{"intervalHours":48}'::jsonb
            WHERE id=${f.connection.id}::uuid`.execute(transaction);
              break;
            }
            case 'disconnect': {
              await sql`UPDATE public.icloud_connection SET state='disconnected',"encryptedSession"=NULL
            WHERE id=${f.connection.id}::uuid`.execute(transaction);
              break;
            }
            case 'remove': {
              await transaction.deleteFrom('user').where('id', '=', f.user.id).execute();
              break;
            }
          }
          const retired = await sql<{ enabled: boolean }>`SELECT enabled FROM public.icloud_weekly_grant
        WHERE "connectionId"=${f.connection.id}::uuid`.execute(transaction);
          expect(retired.rows[0].enabled).toBe(false);
          throw new Error('rollback authority probe');
        }),
      ).rejects.toThrow('rollback authority probe');
      expect(
        (await sql`SELECT * FROM public.icloud_weekly_grant WHERE "connectionId"=${f.connection.id}::uuid`.execute(db))
          .rows,
      ).toEqual(before.rows);
      expect((await sut.status(other.connection.id, other.user.id)).available).toBe(true);
      expect((await sut.status(f.connection.id, f.user.id)).available).toBe(true);
    },
  );

  it('never retokens, resamples or revives an old frozen obligation on revoke/regrant', async () => {
    const f = await arrange(true);
    await sut.setAuthority(f.auth, f.connection.id, f.input);
    const id = await freezeFixture(f);
    const before = await sql`SELECT * FROM public.icloud_weekly_cohort WHERE id=${id}::uuid`.execute(db);
    const members = await sql`SELECT * FROM public.icloud_weekly_member WHERE "cohortId"=${id}::uuid`.execute(db);
    await sut.setAuthority(f.auth, f.connection.id, {
      enabled: false,
      includeProtected: false,
      requestKey: randomUUID(),
    });
    await sut.setAuthority(f.auth, f.connection.id, { ...f.input, requestKey: randomUUID() });
    expect((await sql`SELECT * FROM public.icloud_weekly_cohort WHERE id=${id}::uuid`.execute(db)).rows).toEqual(
      before.rows,
    );
    expect(
      (await sql`SELECT * FROM public.icloud_weekly_member WHERE "cohortId"=${id}::uuid`.execute(db)).rows,
    ).toEqual(members.rows);
    await expect(
      sql`UPDATE public.icloud_weekly_cohort SET "grantGeneration"="grantGeneration"+1
      WHERE id=${id}::uuid`.execute(db),
    ).rejects.toThrow('icloud_weekly_cohort_frozen');
    await expect(
      sql`UPDATE public.icloud_weekly_member SET rank=${Buffer.alloc(32, 5)}
      WHERE "cohortId"=${id}::uuid`.execute(db),
    ).rejects.toThrow('icloud_weekly_member_frozen');
    expect(members.rows[0]).toMatchObject({ outcome: 'pending', auditRequestId: null });
    await expect(
      sql`UPDATE public.icloud_weekly_cohort SET status='settled' WHERE id=${id}::uuid`.execute(db),
    ).rejects.toMatchObject({ code: '23514' });
    await sql`UPDATE public.icloud_weekly_member SET outcome='unavailable' WHERE "cohortId"=${id}::uuid`.execute(db);
    await expect(
      sql`UPDATE public.icloud_weekly_member SET outcome='pending' WHERE "cohortId"=${id}::uuid`.execute(db),
    ).rejects.toThrow('icloud_weekly_outcome_frozen');
  });

  it('enforces persisted purpose and exact scheduled member binding, not session-null elevation', async () => {
    const f = await arrange();
    await sut.setAuthority(f.auth, f.connection.id, f.input);
    const cohortId = await freezeFixture(f);
    const insert = (purpose: string, sessionId: string | null, scheduled: boolean, ordinal = 0) =>
      sql`
      INSERT INTO public.icloud_identity_audit
        (id,"ownerId","connectionId","sessionId","identityId","originalAssetId","sourceResourceId",
          "expectedSha256",snapshot,purpose,"grantId","grantGeneration","cohortId","memberOrdinal","batchOrdinal")
      SELECT ${randomUUID()}::uuid,"ownerId","connectionId",${sessionId}::uuid,
        ${randomUUID()}::uuid,${randomUUID()}::uuid,${randomUUID()}::uuid,${Buffer.alloc(32, 1)},'{}'::jsonb,${purpose},
        CASE WHEN ${scheduled} THEN "grantId" ELSE NULL END,
        CASE WHEN ${scheduled} THEN "grantGeneration" ELSE NULL END,
        CASE WHEN ${scheduled} THEN id ELSE NULL END,
        CASE WHEN ${scheduled} THEN ${ordinal}::bigint ELSE NULL END,
        CASE WHEN ${scheduled} THEN 0 ELSE NULL END
      FROM public.icloud_weekly_cohort WHERE id=${cohortId}::uuid`.execute(db);
    await insert('manual-session', f.session.id, false);
    await expect(insert('manual-session', null, false)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('scheduled-weekly', f.session.id, true)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('unknown', null, true)).rejects.toMatchObject({ code: '23514' });
    await expect(insert('scheduled-weekly', null, true, 1)).rejects.toMatchObject({ code: '23503' });
    await insert('scheduled-weekly', null, true);
    const rows = await sql<{
      purpose: string;
      verifiedAt: Date | null;
      result: string;
    }>`SELECT purpose,"verifiedAt",result
      FROM public.icloud_identity_audit WHERE "connectionId"=${f.connection.id}::uuid`.execute(db);
    expect(rows.rows).toHaveLength(2);
    expect(rows.rows.every((row) => row.verifiedAt === null && row.result === 'queued')).toBe(true);
  });

  it('retains grant and generation through an actual download and randomized normal session refresh', async () => {
    const f = await arrange(true);
    const key = Buffer.alloc(32, 7);
    const providerSession = { account: 'fixture-account', credential: 'fixture-credential' };
    const encrypted = encryptICloudSession(key, f.connection.id, providerSession);
    await sync.update(f.connection.id, f.user.id, { encryptedSession: encrypted });
    await sut.setAuthority(f.auth, f.connection.id, f.input);
    const before = await sql`SELECT * FROM public.icloud_weekly_grant
      WHERE "connectionId"=${f.connection.id}::uuid`.execute(db);
    const bytes = Buffer.from('owned test transport bytes');
    const resourceId = randomUUID();
    await sql`INSERT INTO public.icloud_resource
      (id,"connectionId","ownerId","libraryKey",library,"sourceAssetId","recordId","resourceKey",role,
        fingerprint,source,"expectedSize")
      VALUES (${resourceId}::uuid,${f.connection.id}::uuid,${f.user.id}::uuid,'fixture-library','{}'::jsonb,
        'fixture-source','fixture-record','original','original','fixture-fingerprint',
        ${{ type: AssetType.Image, originalFileName: 'fixture.jpg', current: true }}::jsonb,${bytes.length})`.execute(
      db,
    );
    const resource = (await sync.claim(f.connection.id, f.connection.config.stagingBytes))!;
    expect(resource.id).toBe(resourceId);
    const download = vi.fn(() =>
      Promise.resolve({
        stream: Readable.from([bytes]),
        fingerprint: resource.fingerprint,
        size: bytes.length,
        session: providerSession,
      }),
    );
    const transport = {
      decodeSession: (id: string, value: string) => decryptICloudSession(key, id, value),
      encodeSession: (id: string, value: unknown) => encryptICloudSession(key, id, value),
      download,
    };
    const root = await realpath(await mkdtemp(join(tmpdir(), 'fl296-weekly-refresh-staging-')));
    const mediaRoot = await realpath(await mkdtemp(join(tmpdir(), 'fl296-weekly-refresh-media-')));
    const priorRoot = process.env.FRAMELEAF_ICLOUD_STAGING_PATH;
    let priorMediaLocation: string | undefined;
    try {
      priorMediaLocation = StorageCore.getMediaLocation();
    } catch {
      priorMediaLocation = undefined;
    }
    process.env.FRAMELEAF_ICLOUD_STAGING_PATH = root;
    StorageCore.setMediaLocation(mediaRoot);
    try {
      const staging = new ICloudStagingService(
        sync,
        transport as never,
        { getAll: () => Promise.resolve([]) } as never,
      );
      const connection = (await sync.get(f.connection.id, f.user.id))!;
      const staged = await staging.download(connection, resource);
      expect(await readFile(staged)).toEqual(bytes);
      expect(download).toHaveBeenCalledOnce();
      const refreshed = (await sync.get(f.connection.id, f.user.id))!;
      expect(refreshed.encryptedSession).not.toBe(encrypted);
      expect(decryptICloudSession(key, f.connection.id, refreshed.encryptedSession!)).toEqual(providerSession);
      expect(
        (
          await sql`SELECT * FROM public.icloud_weekly_grant
        WHERE "connectionId"=${f.connection.id}::uuid`.execute(db)
        ).rows,
      ).toEqual(before.rows);
      expect(await sut.status(f.connection.id, f.user.id)).toMatchObject({
        available: true,
        executionAvailable: false,
      });
    } finally {
      if (priorRoot === undefined) {
        delete process.env.FRAMELEAF_ICLOUD_STAGING_PATH;
      } else {
        process.env.FRAMELEAF_ICLOUD_STAGING_PATH = priorRoot;
      }
      StorageCore.reset();
      if (priorMediaLocation) {
        StorageCore.setMediaLocation(priorMediaLocation);
      }
      await rm(root, { recursive: true, force: true });
      await rm(mediaRoot, { recursive: true, force: true });
    }
  });

  it.each(['explicit-replacement', 'authenticate', 'credential-loss'] as const)(
    'irrevocably retires existing authority on %s, including restoration',
    async (kind) => {
      const f = await arrange(true);
      await sut.setAuthority(f.auth, f.connection.id, f.input);
      const before = await sql<{ generation: number }>`SELECT generation FROM public.icloud_weekly_grant
        WHERE "connectionId"=${f.connection.id}::uuid`.execute(db);
      if (kind === 'explicit-replacement') {
        await sync.update(f.connection.id, f.user.id, { encryptedSession: 'explicit-replacement' });
        await sync.update(f.connection.id, f.user.id, { encryptedSession: 'fixture-only' });
      } else if (kind === 'authenticate') {
        await sync.update(f.connection.id, f.user.id, { state: 'authenticating' });
        await sync.withSession(f.connection.id, f.user.id, () =>
          Promise.resolve({
            value: undefined,
            state: 'connected',
            encryptedSession: 'new-auth',
          }),
        );
      } else {
        await sql`UPDATE public.icloud_connection SET "encryptedSession"=NULL
          WHERE id=${f.connection.id}::uuid`.execute(db);
        await sync.update(f.connection.id, f.user.id, { encryptedSession: 'fixture-only' });
      }
      expect(await sut.status(f.connection.id, f.user.id)).toMatchObject({
        enabled: false,
        available: false,
        regrantRequired: true,
      });
      const retired = await sql<{ generation: number }>`SELECT generation FROM public.icloud_weekly_grant
        WHERE "connectionId"=${f.connection.id}::uuid`.execute(db);
      expect(retired.rows[0].generation).toBeGreaterThan(before.rows[0].generation);
      await expect(sut.setAuthority(f.auth, f.connection.id, f.input)).rejects.toThrow();
    },
  );

  it.each(['mutation-first', 'elevation-first'] as const)(
    'serializes real PIN mutation and elevation: %s',
    async (order) => {
      const f = await arrange(true);
      await sut.setAuthority(f.auth, f.connection.id, f.input);
      const users = new UserRepository(db);
      const sessions = new SessionRepository(db);
      const checked = await users.getForPinCode(f.user.id);
      await sessions.update(f.session.id, { pinExpiresAt: null });
      const held = Promise.withResolvers<number>();
      const release = Promise.withResolvers<void>();
      const blocker = db.transaction().execute(async (transaction) => {
        await transaction.selectFrom('session').select('id').where('id', '=', f.session.id).forUpdate().execute();
        held.resolve((await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(transaction)).rows[0].pid);
        await release.promise;
      });
      let first: Promise<boolean> | undefined;
      let second: Promise<unknown> | undefined;
      try {
        const blockerPid = await Promise.race([
          held.promise,
          blocker.then(() => {
            throw new Error('Session did not pause');
          }),
        ]);
        first =
          order === 'mutation-first'
            ? users.setPinCodeAndLockSessions(f.user.id, checked, 'new-checked-pin')
            : sessions.elevate(f.session.id, f.user.id, checked, new Date(Date.now() + 3_600_000));
        // Catch immediately while preserving the assertion's eventual result.
        const firstResult = first.then((accepted) => ({ accepted })).catch((error: unknown) => ({ error }));
        let firstPid = 0;
        await expect
          .poll(
            async () => {
              const observed = await sql<{ pid: number }>`SELECT pid FROM pg_stat_activity
            WHERE datname=current_database() AND wait_event_type='Lock'
              AND ${blockerPid}=ANY(pg_blocking_pids(pid))`.execute(db);
              firstPid = observed.rows[0]?.pid ?? 0;
              return firstPid > 0;
            },
            { interval: 10, timeout: 1000 },
          )
          .toBe(true);
        second =
          order === 'mutation-first'
            ? sut.setAuthority(f.auth, f.connection.id, { ...f.input, requestKey: randomUUID() })
            : users.setPinCodeAndLockSessions(f.user.id, checked, 'new-checked-pin');
        const secondResult = second.then((result) => ({ result })).catch((error: unknown) => ({ error }));
        await expect
          .poll(
            async () => {
              const observed = await sql<{ blocked: boolean }>`SELECT EXISTS (
            SELECT 1 FROM pg_stat_activity WHERE datname=current_database() AND wait_event_type='Lock'
              AND ${firstPid}=ANY(pg_blocking_pids(pid))) AS blocked`.execute(db);
              return observed.rows[0].blocked;
            },
            { interval: 10, timeout: 1000 },
          )
          .toBe(true);
        release.resolve();
        expect(await firstResult).toEqual({ accepted: true });
        if (order === 'mutation-first') {
          expect(await secondResult).toHaveProperty('error');
        } else {
          expect(await secondResult).toEqual({ result: true });
        }
        expect((await sessions.get(f.session.id))?.pinExpiresAt).toBeNull();
        expect(await sessions.elevate(f.session.id, f.user.id, checked, new Date(Date.now() + 3_600_000))).toBe(false);
        expect(await sessions.refreshPinExpiry(f.session.id, new Date(Date.now() + 3_600_000))).toBe(false);
        expect(await sut.status(f.connection.id, f.user.id)).toMatchObject({ enabled: false, available: false });
        await expect(sut.setAuthority(f.auth, f.connection.id, f.input)).rejects.toThrow();
      } finally {
        release.resolve();
        await Promise.allSettled([blocker, ...(first ? [first] : []), ...(second ? [second] : [])]);
      }
    },
  );

  it.each(['setup', 'reset', 'change'] as const)('refuses concurrent stale %s checked credentials', async (kind) => {
    const f = await arrange(kind !== 'setup');
    const users = new UserRepository(db);
    const checked = await users.getForPinCode(f.user.id);
    const next = kind === 'reset' ? null : 'first-new-pin';
    const results = await Promise.all([
      users.setPinCodeAndLockSessions(f.user.id, checked, next),
      users.setPinCodeAndLockSessions(f.user.id, checked, 'stale-second-pin'),
    ]);
    expect(results.filter(Boolean)).toHaveLength(1);
    const current = await users.getForPinCode(f.user.id);
    expect([next, 'stale-second-pin']).toContain(current.pinCode);
    expect(await users.setPinCodeAndLockSessions(f.user.id, checked, 'late-third-pin')).toBe(false);
    expect(await new SessionRepository(db).refreshPinExpiry(f.session.id, new Date(Date.now() + 3_600_000))).toBe(
      false,
    );
    // Exact password identity, including nullable credentials, remains part of admission.
    expect(
      await users.setPinCodeAndLockSessions(
        f.user.id,
        { ...current, password: 'stale-password' },
        'wrong-password-pin',
      ),
    ).toBe(false);
  });

  it('binds explicit null setup credentials and refuses deleted owners', async () => {
    const f = await arrange();
    const users = new UserRepository(db);
    await users.update(f.user.id, { password: null });
    const checked = await users.getForPinCode(f.user.id);
    expect(checked).toEqual({ pinCode: null, password: null });
    expect(await users.setPinCodeAndLockSessions(f.user.id, checked, 'new-setup-pin')).toBe(true);
    expect(await users.setPinCodeAndLockSessions(f.user.id, checked, 'stale-setup-pin')).toBe(false);
    const current = await users.getForPinCode(f.user.id);
    await db.updateTable('user').set({ deletedAt: new Date() }).where('id', '=', f.user.id).execute();
    expect(await users.setPinCodeAndLockSessions(f.user.id, current, null)).toBe(false);
  });

  it('rolls back PIN, all session elevations, and grant retirement together', async () => {
    const f = await arrange(true);
    await sut.setAuthority(f.auth, f.connection.id, f.input);
    const users = new UserRepository(db);
    const checked = await users.getForPinCode(f.user.id);
    const beforeSession = await new SessionRepository(db).get(f.session.id);
    const other = await arrange(true);
    const beforeGrant = await sql`SELECT * FROM public.icloud_weekly_grant
      WHERE "connectionId"=${f.connection.id}::uuid`.execute(db);
    await db
      .updateTable('session')
      .set({ deviceOS: 'weekly-rollback-sentinel' })
      .where('id', '=', f.session.id)
      .execute();
    await sql`CREATE FUNCTION public.weekly_test_refuse_session_clear() RETURNS trigger LANGUAGE plpgsql AS $$
      BEGIN
        IF NEW."deviceOS"='weekly-rollback-sentinel' AND NEW."pinExpiresAt" IS NULL THEN
          RAISE EXCEPTION 'weekly_test_pin_rollback';
        END IF;
        RETURN NEW;
      END $$`.execute(db);
    try {
      await sql`CREATE TRIGGER weekly_test_refuse_session_clear BEFORE UPDATE ON public.session
        FOR EACH ROW EXECUTE FUNCTION public.weekly_test_refuse_session_clear()`.execute(db);
      await expect(users.setPinCodeAndLockSessions(f.user.id, checked, 'rolled-back-pin')).rejects.toThrow(
        'weekly_test_pin_rollback',
      );
      expect(await users.getForPinCode(f.user.id)).toEqual(checked);
      expect((await new SessionRepository(db).get(f.session.id))?.pinExpiresAt).toEqual(beforeSession?.pinExpiresAt);
      expect(
        (
          await sql`SELECT * FROM public.icloud_weekly_grant
        WHERE "connectionId"=${f.connection.id}::uuid`.execute(db)
        ).rows,
      ).toEqual(beforeGrant.rows);
      expect((await new SessionRepository(db).get(other.session.id))?.pinExpiresAt).not.toBeNull();
      expect(await sut.setAuthority(f.auth, f.connection.id, f.input)).toMatchObject({ available: true });
    } finally {
      await sql`DROP TRIGGER IF EXISTS weekly_test_refuse_session_clear ON public.session`.execute(db);
      await sql`DROP FUNCTION public.weekly_test_refuse_session_clear()`.execute(db);
    }
  });

  it('preserves connection cascade and retained disabled owner-removal history without erasing other owners', async () => {
    const f = await arrange();
    const other = await arrange();
    await sut.setAuthority(f.auth, f.connection.id, f.input);
    await sut.setAuthority(other.auth, other.connection.id, other.input);
    await freezeFixture(f);
    await sql`DELETE FROM public.icloud_connection WHERE id=${f.connection.id}::uuid
      AND "ownerId"=${f.user.id}::uuid`.execute(db);
    for (const table of ['icloud_weekly_grant', 'icloud_weekly_cohort', 'icloud_weekly_member']) {
      expect(
        (await sql`SELECT 1 FROM ${sql.table(`public.${table}`)} WHERE "ownerId"=${f.user.id}::uuid`.execute(db)).rows,
      ).toEqual([]);
    }
    expect((await sut.status(other.connection.id, other.user.id)).available).toBe(true);
    await db.deleteFrom('user').where('id', '=', other.user.id).execute();
    const retained = await sql<{ enabled: boolean }>`SELECT enabled FROM public.icloud_weekly_grant
      WHERE "ownerId"=${other.user.id}::uuid`.execute(db);
    expect(retained.rows).toEqual([{ enabled: false }]);
  });
});
