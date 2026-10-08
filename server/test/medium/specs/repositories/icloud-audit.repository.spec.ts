import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { AuthDto } from 'src/dtos/auth.dto.js';
import { ICloudVerifyDto } from 'src/dtos/icloud-identity.dto.js';
import { ICloudConfigSchema } from 'src/dtos/icloud-sync.dto.js';
import { AssetType, ChecksumAlgorithm, MediaOperationKind, UserMetadataKey } from 'src/enum.js';
import {
  AuditAuthority,
  ICloudAuditRepository,
  lockAuditOwner,
  manualAuditClaimHolder,
  publishAudit,
} from 'src/repositories/icloud-audit.repository.js';
import { ICloudIdentityRepository, recordSyncIdentity } from 'src/repositories/icloud-identity.repository.js';
import { lockICloudItemClaims } from 'src/repositories/icloud-item-claim-lock.js';
import { ICloudResource, ICloudSyncRepository } from 'src/repositories/icloud-sync.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { MediaRecoveryRepository, VerifiedMedia } from 'src/repositories/media-recovery.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

const ASSET = '32A01DD9-75DF-41B2-8773-80C153D73A5A';
const MASTER = 'AQohY6yKZR0+tXlMi9FUQ82zySGo';
const bytes = Buffer.from('fresh source bytes');
const verified: VerifiedMedia = {
  status: 'healthy',
  reason: 'verified',
  sizeInBytes: bytes.length,
  sha256: createHash('sha256').update(bytes).digest(),
  sha1: createHash('sha1').update(bytes).digest(),
  identity: { dev: 1, ino: 2, size: bytes.length, mtimeMs: 3, ctimeMs: 4 },
};

/** Real PostgreSQL transactions and CAS predicates; no mock of audit publication or cleanup. */
describe(ICloudAuditRepository.name, () => {
  let db: Kysely<DB>;
  let sut: ICloudAuditRepository;
  let sync: ICloudSyncRepository;
  let identities: ICloudIdentityRepository;
  let operations: MediaOperationRepository;
  const fixtureConnections = new Set<string>();

  beforeAll(async () => {
    db = await getKyselyDB();
    await expectCanonicalTables(db, ['icloud_identity_audit']);

    sut = new ICloudAuditRepository(db);
    sync = new ICloudSyncRepository(db);
    identities = new ICloudIdentityRepository(db);
    operations = new MediaOperationRepository(db);
  });
  afterAll(async () => {
    await db.destroy();
  });
  afterEach(async () => {
    // Real audit leases count against the global cap; retire only this test's owned connections.
    if (fixtureConnections.size === 0) {
      return;
    }
    await sql`DELETE FROM public.icloud_connection WHERE id=ANY(${[...fixtureConnections]}::uuid[])`.execute(db);
    fixtureConnections.clear();
  });

  async function arrange() {
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { session } = await ctx.newSession({ userId: user.id });
    const { asset } = await ctx.newAsset({
      ownerId: user.id,
      checksum: verified.sha256,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
      originalPath: `/managed/${randomUUID()}.jpg`,
    });
    const auth = { user, session: { ...session, hasElevatedPermission: false } } as AuthDto;
    const connection = (await sync.create(user.id, 'Photos', ICloudConfigSchema.parse({})))!;
    fixtureConnections.add(connection.id);
    await sync.update(connection.id, user.id, { state: 'connected', encryptedSession: 'fixture-session' });
    const field = (value: unknown) => ({ value });
    await sync.savePage(
      connection.id,
      'assets:library',
      'library',
      [
        {
          recordName: MASTER,
          recordType: 'CPLMaster',
          recordChangeTag: 'master-1',
          fields: {
            filenameEnc: field('source.jpg'),
            itemType: field('public.jpeg'),
            resOriginalRes: field({ size: bytes.length, fileChecksum: MASTER }),
          },
        },
        {
          recordName: ASSET,
          recordType: 'CPLAsset',
          recordChangeTag: 'asset-1',
          fields: { masterRef: field({ recordName: MASTER }) },
        },
      ],
      null,
      true,
    );
    await sync.materialize(connection, 'library', { area: 'private', zoneID: { zoneName: 'PrimarySync' } });
    const {
      rows: [source],
    } = await sql<ICloudResource>`UPDATE public.icloud_resource
      SET status='finalized',"assetId"=${asset.id}::uuid,sha256=${verified.sha256}
      WHERE "connectionId"=${connection.id}::uuid AND role='original' RETURNING *`.execute(db);
    await recordSyncIdentity(db, source.id);
    const dto: ICloudVerifyDto = {
      connectionId: connection.id,
      requestKey: randomUUID(),
      items: [
        {
          id: 'original',
          assetId: asset.id,
          cloudIdentifier: `${ASSET}:001:${MASTER}`,
          role: 'original',
          editVersion: '',
        },
      ],
    };
    return { auth, connection, source, asset, dto };
  }

  async function claimed(locked = false) {
    const fixture = await arrange();
    if (locked) {
      fixture.auth.session!.hasElevatedPermission = true;
      await sql`UPDATE session SET "pinExpiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${fixture.auth.session!.id}::uuid`.execute(
        db,
      );
      await sql`INSERT INTO asset_lock ("assetId",reason) VALUES (${fixture.asset.id}::uuid,'marked')`.execute(db);
    }
    const response = await sut.submit(fixture.auth, fixture.dto, operations);
    const {
      rows: [request],
    } = await sql<{ id: string }>`SELECT id FROM public.icloud_identity_audit
      WHERE "operationId"=${response.operationId}::uuid`.execute(db);
    expect(response.items).toEqual([{ id: 'original', state: 'queued' }]);
    const token = randomUUID();
    await sql`UPDATE media_operation SET status='rendering',"claimToken"=${token}::uuid,
      "claimExpiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${response.operationId}::uuid`.execute(db);
    const authority: AuditAuthority = {
      auditRequestId: request.id,
      operationId: response.operationId,
      operationClaimToken: token,
    };
    const [claim] = await identities.claim(
      fixture.auth.user.id,
      [ASSET],
      manualAuditClaimHolder(fixture.auth.user.id, authority),
      1800,
    );
    await sut.setItemClaim(request.id, fixture.auth.user.id, claim.id);
    const resource = (await sut.allocate(authority, fixture.auth.user.id))!;
    expect(resource.id).not.toBe(fixture.source.id);
    await sql`UPDATE public.icloud_resource SET "stagingPath"=${`/private-stage/${resource.id}/complete`}
      WHERE id=${resource.id}::uuid`.execute(db);
    resource.stagingPath = `/private-stage/${resource.id}/complete`;
    return { ...fixture, authority, resource, claim };
  }

  it('does not let an obsolete audit worker release the replacement worker live item claim', async () => {
    const fixture = await claimed();
    const replacementToken = randomUUID();
    // The independently renewed item lease is live when the operation has a replacement incarnation.
    await sql`UPDATE media_operation SET "claimToken"=${replacementToken}::uuid WHERE id=${fixture.authority.operationId}::uuid`.execute(
      db,
    );
    const holder = manualAuditClaimHolder(fixture.auth.user.id, fixture.authority);
    const replacementHolder = manualAuditClaimHolder(fixture.auth.user.id, {
      ...fixture.authority,
      operationClaimToken: replacementToken,
    });
    // A replacement must back off a live old holder rather than inherit its cleanup authority.
    const [busy] = await identities.claim(fixture.auth.user.id, [ASSET], replacementHolder, 1800);
    expect(busy).toMatchObject({ id: fixture.claim.id, holder });
    await sql`UPDATE icloud_claim SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=${fixture.claim.id}::uuid`.execute(
      db,
    );
    const [replacementClaim] = await identities.claim(fixture.auth.user.id, [ASSET], replacementHolder, 1800);
    expect(replacementClaim).toBeDefined();
    expect(replacementClaim.holder).toBe(replacementHolder);
    expect(replacementClaim.id).not.toBe(fixture.claim.id);
    expect(
      await sut.stopState(fixture.authority.operationId, fixture.auth.user.id, fixture.authority.operationClaimToken),
    ).toMatchObject({ live: false });
    // Retain the original causal stale-cleanup assertion, now with real incarnation ownership.
    expect(await identities.release(fixture.auth.user.id, [fixture.claim.id], holder)).toEqual([]);
    expect(await identities.release(fixture.auth.user.id, [replacementClaim.id], holder)).toEqual([]);
    expect(await identities.renew(fixture.auth.user.id, [replacementClaim.id], holder, 1800)).toEqual([]);
    expect(await identities.renew(fixture.auth.user.id, [replacementClaim.id], replacementHolder, 1800)).toHaveLength(
      1,
    );
  });

  it('preserves same-incarnation renewal and the four-hour ceiling, but never inherits an expired claim ID', async () => {
    const fixture = await claimed();
    const holder = manualAuditClaimHolder(fixture.auth.user.id, fixture.authority);
    const [same] = await identities.claim(fixture.auth.user.id, [ASSET], holder, 1800);
    expect(same.id).toBe(fixture.claim.id);
    expect(await identities.renew(fixture.auth.user.id, [same.id], holder, 4 * 3600)).toHaveLength(1);
    const bounds = (
      await sql<{
        bounded: boolean;
      }>`SELECT "expiresAt"<="createdAt"+interval '4 hours' AS bounded FROM icloud_claim WHERE id=${same.id}::uuid`.execute(
        db,
      )
    ).rows[0];
    expect(bounds.bounded).toBe(true);
    await sql`UPDATE icloud_claim SET "expiresAt"=clock_timestamp()-interval '1 second' WHERE id=${same.id}::uuid`.execute(
      db,
    );
    const [fresh] = await identities.claim(fixture.auth.user.id, [ASSET], holder, 1800);
    expect(fresh.id).not.toBe(same.id);
    // Even an unchanged tuple/holder cannot use the old ID to renew or remove its new incarnation.
    expect(await identities.renew(fixture.auth.user.id, [same.id], holder, 1800)).toEqual([]);
    expect(await identities.release(fixture.auth.user.id, [same.id], holder)).toEqual([]);
    expect(await identities.renew(fixture.auth.user.id, [fresh.id], holder, 1800)).toHaveLength(1);
    expect(await identities.release(fixture.auth.user.id, [fresh.id], holder)).toEqual([fresh.id]);
    const [releasedReplacement] = await identities.claim(fixture.auth.user.id, [ASSET], holder, 1800);
    expect(releasedReplacement.id).not.toBe(fresh.id);
  });

  it('refuses legacy operation-only holders at manual publication without publishing an identity proof', async () => {
    const fixture = await claimed();
    await sql`UPDATE icloud_claim SET holder=${`icloud-sync:audit:${fixture.authority.operationId}`} WHERE id=${fixture.claim.id}::uuid`.execute(
      db,
    );
    expect(await sut.check(fixture.authority, fixture.auth.user.id)).toBeUndefined();
    expect(await sut.publishMatch(fixture.authority, fixture.resource, verified, () => Promise.resolve(verified))).toBe(
      false,
    );
    await expect(
      db
        .transaction()
        .execute((trx) =>
          publishAudit(
            trx,
            fixture.authority,
            fixture.auth.user.id,
            'mismatch',
            { id: fixture.resource.id, leaseToken: fixture.resource.leaseToken! },
            fixture.asset.id,
          ),
        ),
    ).rejects.toThrow('audit_authority_changed');
    expect((await identities.identities(fixture.auth.user.id, [ASSET]))[0]).toMatchObject({
      lastAuditResult: null,
      lastVerifiedAt: null,
    });
  });

  it.each(['claim', 'allocation'])(
    'cancels while the actual %s admission waits, then fences the failed capacity requeue',
    async (phase) => {
      const fixture = await claimed();
      // Retire this fixture's earlier lease; the new admission has not acquired a resource.
      await sync.finish(fixture.resource, 'retry', 'audit_retry');
      await sql`UPDATE icloud_resource SET "nextAttemptAt"=NULL WHERE id=${fixture.resource.id}::uuid`.execute(db);
      const oldHolder = manualAuditClaimHolder(fixture.auth.user.id, fixture.authority);
      const token = phase === 'claim' ? randomUUID() : fixture.authority.operationClaimToken;
      const authority = { ...fixture.authority, operationClaimToken: token };
      if (phase === 'claim')
        await sql`UPDATE media_operation SET "claimToken"=${token}::uuid WHERE id=${authority.operationId}::uuid`.execute(
          db,
        );
      else expect(await sut.check(authority, fixture.auth.user.id)).toBeDefined();
      const holder = manualAuditClaimHolder(fixture.auth.user.id, authority);
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const blocker = db.connection().execute((connection) =>
        connection.transaction().execute(async (trx) => {
          if (phase === 'claim') await lockICloudItemClaims(trx, fixture.auth.user.id, [ASSET]);
          else await trx.selectFrom('user').select('id').where('id', '=', fixture.auth.user.id).forUpdate().execute();
          entered.resolve();
          await release.promise;
        }),
      );
      await entered.promise;
      let pid = 0;
      const admission = db.connection().execute(async (connection) => {
        pid = (await sql<{ pid: number }>`SELECT pg_backend_pid()::int AS pid`.execute(connection)).rows[0].pid;
        if (phase === 'claim') {
          const [busy] = await new ICloudIdentityRepository(connection).claim(
            fixture.auth.user.id,
            [ASSET],
            holder,
            1800,
          );
          expect(busy).toMatchObject({ id: fixture.claim.id, holder: oldHolder });
        } else
          expect(await new ICloudAuditRepository(connection).allocate(authority, fixture.auth.user.id)).toBeUndefined();
      });
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          if (pid)
            blocked = (
              await sql<{ blocked: boolean }>`SELECT cardinality(pg_blocking_pids(${pid}))>0 AS blocked`.execute(db)
            ).rows[0].blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        expect(await operations.requestCancel(authority.operationId, fixture.auth.user.id)).toMatchObject({
          status: 'cancelling',
        });
      } finally {
        release.resolve();
      }
      await blocker;
      await admission;
      if (phase === 'allocation')
        expect(await identities.release(fixture.auth.user.id, [fixture.claim.id], holder)).toEqual([fixture.claim.id]);
      else expect(await identities.renew(fixture.auth.user.id, [fixture.claim.id], oldHolder, 1800)).toHaveLength(1);
      expect(
        await operations.requeue(authority.operationId, token, {
          delayMs: 60_000,
          returnAttempt: true,
          requireActiveClaim: true,
        }),
      ).toBe(false);
      expect(
        await operations.acknowledgeCancel(authority.operationId, token, { released: true, requireActiveClaim: true }),
      ).toBe(true);
      expect(await operations.getForWorker(authority.operationId)).toMatchObject({
        status: 'cancelled',
        errorCode: null,
        autoRetries: 0,
        remoteReleasedAt: expect.any(Date),
      });
    },
  );

  it('holds an on-demand pause without proof or retry consumption, and preserves a fresh resume', async () => {
    const fixture = await claimed();
    const { operationId, operationClaimToken } = fixture.authority;
    await operations.requestPause(operationId, fixture.auth.user.id, [MediaOperationKind.ICloudSync]);
    expect(await sut.stopState(operationId, fixture.auth.user.id, operationClaimToken)).toMatchObject({
      live: true,
      pauseRequestedAt: expect.any(Date),
    });
    expect(await sut.check(fixture.authority, fixture.auth.user.id)).toBeUndefined();
    expect(await sut.stopState(operationId, randomUUID(), operationClaimToken)).toBeUndefined();
    await sync.finish(fixture.resource, 'retry', 'audit_retry');
    await identities.release(
      fixture.auth.user.id,
      [fixture.claim.id],
      manualAuditClaimHolder(fixture.auth.user.id, fixture.authority),
    );
    expect(
      await operations.requeue(operationId, operationClaimToken, {
        delayMs: 0,
        returnAttempt: true,
        requireActiveClaim: true,
      }),
    ).toBe(true);
    expect(await operations.getForWorker(operationId)).toMatchObject({
      status: 'paused',
      autoRetries: 0,
      errorCode: null,
      claimToken: null,
    });
    expect((await identities.identities(fixture.auth.user.id, [ASSET]))[0]).toMatchObject({
      lastAuditResult: null,
      lastVerifiedAt: null,
    });
    expect((await sut.get(fixture.authority.auditRequestId, fixture.auth.user.id))?.result).toBe('running');
    await operations.resume(operationId, fixture.auth.user.id);
    expect(await operations.getForWorker(operationId)).toMatchObject({
      status: 'queued',
      pauseRequestedAt: null,
      autoRetries: 0,
    });
    // The old token cannot complete or publish after a resume; fresh bytes require a new claim.
    expect(await operations.complete(operationId, operationClaimToken, { resultAssetId: null }, undefined, true)).toBe(
      false,
    );
    expect(await sut.publishMatch(fixture.authority, fixture.resource, verified, () => Promise.resolve(verified))).toBe(
      false,
    );
  });

  it.each(['resume', 'cancel', 'replace'])(
    'rechecks a concurrent %s at actual interrupted settlement',
    async (change) => {
      const fixture = await claimed();
      const { operationId, operationClaimToken } = fixture.authority;
      await operations.requestPause(operationId, fixture.auth.user.id, [MediaOperationKind.ICloudSync]);
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const replacement = randomUUID();
      const blocker = db.connection().execute((connection) =>
        connection.transaction().execute(async (trx) => {
          await trx.selectFrom('media_operation').select('id').where('id', '=', operationId).forUpdate().execute();
          switch (change) {
            case 'resume': {
              await sql`UPDATE media_operation SET "pauseRequestedAt"=NULL WHERE id=${operationId}::uuid`.execute(trx);
              break;
            }
            case 'cancel': {
              await sql`UPDATE media_operation SET status='cancelling',"cancelRequestedAt"=clock_timestamp() WHERE id=${operationId}::uuid`.execute(
                trx,
              );
              break;
            }
            case 'replace': {
              await sql`UPDATE media_operation SET "claimToken"=${replacement}::uuid WHERE id=${operationId}::uuid`.execute(
                trx,
              );
              break;
            }
          }
          entered.resolve();
          await release.promise;
        }),
      );
      await entered.promise;
      let pid = 0;
      const settling = db.connection().execute(async (connection) => {
        pid = (await sql<{ pid: number }>`SELECT pg_backend_pid()::int AS pid`.execute(connection)).rows[0].pid;
        return new MediaOperationRepository(connection).requeue(operationId, operationClaimToken, {
          delayMs: 0,
          returnAttempt: true,
          requireActiveClaim: true,
        });
      });
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          if (pid)
            blocked = (
              await sql<{ blocked: boolean }>`SELECT cardinality(pg_blocking_pids(${pid}))>0 AS blocked`.execute(db)
            ).rows[0].blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
      } finally {
        release.resolve();
      }
      await blocker;
      expect(await settling).toBe(change === 'resume');
      switch (change) {
        case 'resume': {
          expect(await operations.getForWorker(operationId)).toMatchObject({
            status: 'queued',
            pauseRequestedAt: null,
            autoRetries: 0,
          });
          break;
        }
        case 'replace': {
          expect(await operations.getForWorker(operationId)).toMatchObject({
            status: 'rendering',
            claimToken: replacement,
            autoRetries: 0,
          });
          break;
        }
        case 'cancel': {
          expect(
            await operations.fail(
              operationId,
              operationClaimToken,
              { error: 'failed', errorCode: 'audit_failed' },
              { requireActiveClaim: true },
            ),
          ).toBe(false);
          expect(
            await operations.acknowledgeCancel(operationId, operationClaimToken, {
              released: true,
              requireActiveClaim: true,
            }),
          ).toBe(true);
          expect(await operations.getForWorker(operationId)).toMatchObject({
            status: 'cancelled',
            autoRetries: 0,
            errorCode: null,
            remoteReleasedAt: expect.any(Date),
          });
          break;
        }
      }
    },
  );

  it.each(['pause', 'failure', 'cancel'])(
    'refuses late %s settlement after the claim expires at a real row-lock wait',
    async (action) => {
      const fixture = await claimed();
      const { operationId, operationClaimToken } = fixture.authority;
      if (action === 'cancel') await operations.requestCancel(operationId, fixture.auth.user.id);
      else await operations.requestPause(operationId, fixture.auth.user.id, [MediaOperationKind.ICloudSync]);
      const deadline = (
        await sql<{
          deadline: Date;
        }>`UPDATE media_operation SET "claimExpiresAt"=clock_timestamp()+interval '2 seconds' WHERE id=${operationId}::uuid RETURNING "claimExpiresAt" AS deadline`.execute(
          db,
        )
      ).rows[0].deadline;
      const before = await operations.getForWorker(operationId);
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const blocker = db.connection().execute((connection) =>
        connection.transaction().execute(async (trx) => {
          await trx.selectFrom('media_operation').select('id').where('id', '=', operationId).forUpdate().execute();
          entered.resolve();
          await release.promise;
        }),
      );
      await entered.promise;
      let pid = 0;
      const settling = db.connection().execute(async (connection) => {
        pid = (await sql<{ pid: number }>`SELECT pg_backend_pid()::int AS pid`.execute(connection)).rows[0].pid;
        const repo = new MediaOperationRepository(connection);
        if (action === 'cancel')
          return repo.acknowledgeCancel(operationId, operationClaimToken, { released: true, requireActiveClaim: true });
        if (action === 'failure')
          return repo.fail(
            operationId,
            operationClaimToken,
            { error: 'failed', errorCode: 'audit_failed' },
            { requireActiveClaim: true },
          );
        return repo.requeue(operationId, operationClaimToken, {
          delayMs: 0,
          returnAttempt: true,
          requireActiveClaim: true,
        });
      });
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          if (pid)
            blocked = (
              await sql<{ blocked: boolean }>`SELECT cardinality(pg_blocking_pids(${pid}))>0 AS blocked`.execute(db)
            ).rows[0].blocked;
          if (!blocked) await new Promise((resolve) => setTimeout(resolve, 10));
        }
        expect(blocked).toBe(true);
        await sql`SELECT pg_sleep(GREATEST(0,extract(epoch FROM (${deadline}::timestamptz-clock_timestamp())))+0.05)`.execute(
          db,
        );
      } finally {
        release.resolve();
      }
      await blocker;
      expect(await settling).toBe(false);
      expect(await operations.getForWorker(operationId)).toEqual(before);
    },
  );

  it('replays the canonical input and unavailable outcomes, rejects altered batches, and queues no unresolved descriptor', async () => {
    const fixture = await arrange();
    fixture.dto.items.push({ ...fixture.dto.items[0], id: 'unavailable', assetId: randomUUID() });
    const first = await sut.submit(fixture.auth, fixture.dto, operations);
    expect(first.items).toEqual([
      { id: 'original', state: 'queued' },
      { id: 'unavailable', state: 'unavailable' },
    ]);
    const reordered = { ...fixture.dto, items: fixture.dto.items.toReversed() };
    expect(await sut.submit(fixture.auth, reordered, operations)).toEqual(first);
    await expect(
      sut.submit(fixture.auth, { ...fixture.dto, items: [fixture.dto.items[0]] }, operations),
    ).rejects.toThrow('icloud_audit_request_key_conflict');
    const requests =
      await sql`SELECT id FROM public.icloud_identity_audit WHERE "operationId"=${first.operationId}::uuid`.execute(db);
    expect(requests.rows).toHaveLength(1);
  });

  it('retains all-unavailable batches as a completed no-work receipt and refuses API keys/shared links', async () => {
    const fixture = await arrange();
    fixture.dto.items[0].assetId = randomUUID();
    const response = await sut.submit(fixture.auth, fixture.dto, operations);
    expect(response.items[0].state).toBe('unavailable');
    expect(
      (
        await db
          .selectFrom('media_operation')
          .select('status')
          .where('id', '=', response.operationId)
          .executeTakeFirstOrThrow()
      ).status,
    ).toBe('completed');
    await expect(sut.submit({ ...fixture.auth, session: undefined }, fixture.dto, operations)).rejects.toThrow(
      'icloud_audit_session_required',
    );
    await expect(sut.submit({ ...fixture.auth, apiKey: {} as never }, fixture.dto, operations)).rejects.toThrow(
      'icloud_audit_session_required',
    );
    await expect(sut.submit({ ...fixture.auth, sharedLink: {} as never }, fixture.dto, operations)).rejects.toThrow(
      'icloud_audit_session_required',
    );
  });

  it('keeps normal descriptor uniqueness and excludes audit copies from normal claims and identity backfill', async () => {
    const { auth, source, resource, authority } = await claimed();
    expect(resource.auditRequestId).toBe(authority.auditRequestId);
    const rows =
      await sql`SELECT id FROM public.icloud_resource WHERE "connectionId"=${source.connectionId}::uuid`.execute(db);
    expect(rows.rows).toHaveLength(2);
    expect(await sync.hasPending(source.connectionId)).toBe(false);
    await sql`UPDATE public.icloud_resource SET "leaseExpiresAt"=clock_timestamp()-interval '1 second'
      WHERE id=${resource.id}::uuid`.execute(db);
    expect(await sync.claim(source.connectionId, 100 * 1024 ** 3)).toBeUndefined();
    await sql`UPDATE public.icloud_resource SET status='committed',"assetId"=${source.assetId}::uuid,sha256=${verified.sha256}
      WHERE id=${resource.id}::uuid`.execute(db);
    expect(await identities.backfill()).toBe(0);
    expect(await identities.identities(auth.user.id, [ASSET])).toHaveLength(1);
  });

  it.each([
    'cancel',
    'claim',
    'source',
    'source-deleted',
    'digest',
    'session',
    'session-expired',
    'disconnect',
    'config',
    'locked',
  ] as const)('cannot publish after %s changes before final CAS', async (change) => {
    const fixture = await claimed();
    switch (change) {
      case 'cancel': {
        await sql`UPDATE media_operation SET "cancelRequestedAt"=clock_timestamp()
          WHERE id=${fixture.authority.operationId}::uuid`.execute(db);
        break;
      }
      case 'claim': {
        await sql`UPDATE media_operation SET "claimToken"=gen_random_uuid()
          WHERE id=${fixture.authority.operationId}::uuid`.execute(db);
        break;
      }
      case 'source': {
        await sql`UPDATE public.icloud_record SET revision='asset-2'
          WHERE "connectionId"=${fixture.connection.id}::uuid AND "recordId"=${ASSET}`.execute(db);
        break;
      }
      case 'source-deleted': {
        await sql`UPDATE public.icloud_record SET deleted=true
          WHERE "connectionId"=${fixture.connection.id}::uuid AND "recordId"=${ASSET}`.execute(db);
        break;
      }
      case 'digest': {
        await db
          .updateTable('asset')
          .set({ checksum: Buffer.alloc(32, 9) })
          .where('id', '=', fixture.asset.id)
          .execute();
        break;
      }
      case 'session': {
        await db.deleteFrom('session').where('id', '=', fixture.auth.session!.id).execute();
        break;
      }
      case 'session-expired': {
        await sql`UPDATE session SET "expiresAt"=clock_timestamp()-interval '1 second'
          WHERE id=${fixture.auth.session!.id}::uuid`.execute(db);
        break;
      }
      case 'disconnect': {
        await sync.update(fixture.connection.id, fixture.auth.user.id, {
          state: 'disconnected',
          encryptedSession: null,
        });
        break;
      }
      case 'config': {
        await sync.update(fixture.connection.id, fixture.auth.user.id, {
          config: ICloudConfigSchema.parse({ libraries: ['other'] }),
        });
        break;
      }
      case 'locked': {
        await sql`INSERT INTO asset_lock ("assetId",reason) VALUES (${fixture.asset.id}::uuid,'marked')`.execute(db);
        break;
      }
    }
    const validate = vi.fn().mockResolvedValue(verified);
    expect(await sut.publishMatch(fixture.authority, fixture.resource, verified, validate)).toBe(false);
    expect(validate).not.toHaveBeenCalled();
    const proof = await sql<{
      lastVerifiedAt: Date | null;
    }>`SELECT "lastVerifiedAt" FROM public.icloud_source_identity
        WHERE "assetId"=${fixture.asset.id}::uuid`.execute(db);
    expect(proof.rows[0].lastVerifiedAt).toBeNull();
  });

  it('expires a resource lease during final validation without certifying its bytes', async () => {
    const fixture = await claimed();
    await sql`UPDATE public.icloud_resource SET "leaseExpiresAt"=clock_timestamp()+interval '1 second'
      WHERE id=${fixture.resource.id}::uuid`.execute(db);
    expect(
      await sut.publishMatch(fixture.authority, fixture.resource, verified, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        return verified;
      }),
    ).toBe(false);
    const request = await sut.get(fixture.authority.auditRequestId, fixture.auth.user.id);
    expect(request?.result).toBe('running');
    expect((await identities.identities(fixture.auth.user.id, [ASSET]))[0].lastVerifiedAt).toBeNull();
  });

  it('reconstructs newly saved suppression rules rather than using the request AuthDto', async () => {
    const fixture = await claimed();
    const tagId = randomUUID();
    await sql`INSERT INTO tag (id,"userId",value) VALUES (${tagId}::uuid,${fixture.auth.user.id}::uuid,'audit-private-fixture')`.execute(
      db,
    );
    await sql`INSERT INTO tag_closure (id_ancestor,id_descendant) VALUES (${tagId}::uuid,${tagId}::uuid)`.execute(db);
    await sql`INSERT INTO tag_asset ("assetId","tagId") VALUES (${fixture.asset.id}::uuid,${tagId}::uuid)`.execute(db);
    const value = { privacy: { suppression: { tagIds: [tagId], personIds: [], petIds: [], scope: 'owned' as const } } };
    await db
      .insertInto('user_metadata')
      .values({ userId: fixture.auth.user.id, key: UserMetadataKey.Preferences, value })
      .onConflict((conflict) => conflict.columns(['userId', 'key']).doUpdateSet({ value }))
      .execute();
    expect(await sut.publishMatch(fixture.authority, fixture.resource, verified, () => Promise.resolve(verified))).toBe(
      false,
    );
    expect((await sut.get(fixture.authority.auditRequestId, fixture.auth.user.id))?.result).toBe('running');
  });

  it.each(['cancel', 'disconnect'] as const)(
    'serializes a concurrent %s writer behind an already acquired publication authority',
    async (change) => {
      const fixture = await claimed();
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const publishing = sut.publishMatch(fixture.authority, fixture.resource, verified, async () => {
        entered.resolve();
        await release.promise;
        return verified;
      });
      await entered.promise;
      let changed = false;
      const writing = db.connection().execute(async (writer) => {
        if (change === 'cancel') {
          await sql`UPDATE media_operation SET "cancelRequestedAt"=clock_timestamp() WHERE id=${fixture.authority.operationId}::uuid`.execute(
            writer,
          );
        } else {
          await sql`UPDATE public.icloud_connection SET state='disconnected',"encryptedSession"=NULL
          WHERE id=${fixture.connection.id}::uuid`.execute(writer);
        }
        changed = true;
      });
      try {
        await new Promise((resolve) => setImmediate(resolve));
        expect(changed).toBe(false);
      } finally {
        release.resolve();
      }
      expect(await publishing).toBe(true);
      await writing;
      expect(changed).toBe(true);
      expect((await sut.get(fixture.authority.auditRequestId, fixture.auth.user.id))?.result).toBe('match');
      expect(await sut.check(fixture.authority, fixture.auth.user.id)).toBeUndefined();
    },
  );

  it('rechecks PIN expiry for a Locked original after final validation', async () => {
    const fixture = await claimed(true);
    await sql`UPDATE session SET "pinExpiresAt"=clock_timestamp()+interval '1 second'
      WHERE id=${fixture.auth.session!.id}::uuid`.execute(db);
    expect(
      await sut.publishMatch(fixture.authority, fixture.resource, verified, async () => {
        await new Promise((resolve) => setTimeout(resolve, 1100));
        return verified;
      }),
    ).toBe(false);
    expect((await sut.get(fixture.authority.auditRequestId, fixture.auth.user.id))?.result).toBe('running');
  });

  it('does not import staged bytes that returned to the expected digest between worker comparison and recovery', async () => {
    const fixture = await claimed();
    const recovery = new MediaRecoveryRepository(db);
    expect(
      await recovery.reserve({
        resourceId: fixture.resource.id,
        ownerId: fixture.auth.user.id,
        leaseToken: fixture.resource.leaseToken!,
        includeHidden: false,
        audit: fixture.authority,
        verified,
        outcome: 'imported',
        proposedPath: '/managed/.icloud-recovery/should-not-publish.jpg',
      }),
    ).toBeUndefined();
    expect(await sync.resource(fixture.resource.id)).toMatchObject({ assetId: null, promotedPath: null });
  });

  it('protects a mismatch copy using suppression saved after the worker precheck and reservation', async () => {
    const fixture = await claimed();
    await sql`UPDATE session SET "pinExpiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${fixture.auth.session!.id}::uuid`.execute(
      db,
    );
    expect((await sut.check(fixture.authority, fixture.auth.user.id))?.private).toBe(false);
    const differing = {
      ...verified,
      sha256: createHash('sha256').update(Buffer.alloc(bytes.length, 8)).digest(),
      sha1: createHash('sha1').update(Buffer.alloc(bytes.length, 8)).digest(),
    };
    const recovery = new MediaRecoveryRepository(db);
    const input = {
      resourceId: fixture.resource.id,
      ownerId: fixture.auth.user.id,
      leaseToken: fixture.resource.leaseToken!,
      includeHidden: false,
      sourceHidden: false,
      audit: fixture.authority,
    };
    const reservation = (await recovery.reserve({
      ...input,
      verified: differing,
      outcome: 'imported',
      proposedPath: `/managed/.icloud-recovery/${fixture.resource.id}.jpg`,
    }))!;
    const tagId = randomUUID();
    await sql`INSERT INTO tag (id,"userId",value) VALUES (${tagId}::uuid,${fixture.auth.user.id}::uuid,'late-private')`.execute(
      db,
    );
    await sql`INSERT INTO tag_closure (id_ancestor,id_descendant) VALUES (${tagId}::uuid,${tagId}::uuid)`.execute(db);
    await sql`INSERT INTO tag_asset ("assetId","tagId") VALUES (${fixture.asset.id}::uuid,${tagId}::uuid)`.execute(db);
    const value = { privacy: { suppression: { tagIds: [tagId], personIds: [], petIds: [], scope: 'owned' as const } } };
    await db
      .insertInto('user_metadata')
      .values({ userId: fixture.auth.user.id, key: UserMetadataKey.Preferences, value })
      .onConflict((conflict) => conflict.columns(['userId', 'key']).doUpdateSet({ value }))
      .execute();
    const committed = await recovery.commit({
      ...input,
      reservation,
      verified: differing,
      originalFileName: 'private-copy.jpg',
      type: AssetType.Image,
      verifyFinal: () => Promise.resolve(differing),
    });
    expect(committed.outcome).toBe('imported');
    expect(committed.assetId).not.toBe(fixture.asset.id);
    expect(
      await db.selectFrom('asset_lock').select('assetId').where('assetId', '=', committed.assetId!).executeTakeFirst(),
    ).toEqual({ assetId: committed.assetId });
    expect(
      await db.selectFrom('asset_lock').select('assetId').where('assetId', '=', fixture.asset.id).executeTakeFirst(),
    ).toBeUndefined();
    expect((await identities.identities(fixture.auth.user.id, [ASSET]))[0]).toMatchObject({
      sha256: verified.sha256,
      lastAuditResult: 'mismatch',
      lastVerifiedAt: null,
    });
  });

  it.each(
    (['match', 'mismatch'] as const).flatMap((result) =>
      (['pin', 'session', 'operation', 'item', 'resource'] as const).map((expiry) => ({ result, expiry })),
    ),
  )(
    'refuses $result proof after $expiry expires while the final guard waits on the original asset',
    async ({ result, expiry }) => {
      const fixture = await claimed(true);
      const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
      const differing = createHash('sha256').update('different').digest();
      const { asset: copy } = await ctx.newAsset({
        ownerId: fixture.auth.user.id,
        checksum: differing,
        checksumAlgorithm: ChecksumAlgorithm.sha256File,
      });
      await sql`INSERT INTO asset_lock ("assetId",reason) VALUES (${copy.id}::uuid,'marked')`.execute(db);
      const entered = Promise.withResolvers<void>(),
        release = Promise.withResolvers<void>();
      const blocker = db.connection().execute((connection) =>
        connection.transaction().execute(async (trx) => {
          await trx.selectFrom('asset').select('id').where('id', '=', fixture.asset.id).forUpdate().execute();
          entered.resolve();
          await release.promise;
        }),
      );
      await entered.promise;
      let deadline: Date;
      switch (expiry) {
        case 'pin':
        case 'session': {
          const column = expiry === 'pin' ? 'pinExpiresAt' : 'expiresAt';
          deadline = (
            await sql<{ deadline: Date }>`UPDATE session SET ${sql.id(column)}=clock_timestamp()+interval '2 seconds'
          WHERE id=${fixture.auth.session!.id}::uuid RETURNING ${sql.id(column)} AS deadline`.execute(db)
          ).rows[0].deadline;
          break;
        }
        case 'operation': {
          deadline = (
            await sql<{
              deadline: Date;
            }>`UPDATE media_operation SET "claimExpiresAt"=clock_timestamp()+interval '2 seconds'
          WHERE id=${fixture.authority.operationId}::uuid RETURNING "claimExpiresAt" AS deadline`.execute(db)
          ).rows[0].deadline;
          break;
        }
        case 'item': {
          deadline = (
            await sql<{
              deadline: Date;
            }>`UPDATE public.icloud_claim SET "expiresAt"=clock_timestamp()+interval '2 seconds'
          WHERE id=${fixture.claim.id}::uuid RETURNING "expiresAt" AS deadline`.execute(db)
          ).rows[0].deadline;
          break;
        }
        case 'resource': {
          deadline = (
            await sql<{
              deadline: Date;
            }>`UPDATE public.icloud_resource SET "leaseExpiresAt"=clock_timestamp()+interval '2 seconds'
          WHERE id=${fixture.resource.id}::uuid RETURNING "leaseExpiresAt" AS deadline`.execute(db)
          ).rows[0].deadline;
        }
      }
      let pid = 0;
      const publishing = db.connection().execute(async (connection) => {
        pid = (await sql<{ pid: number }>`SELECT pg_backend_pid()::int AS pid`.execute(connection)).rows[0].pid;
        return connection.transaction().execute(async (trx) => {
          await lockAuditOwner(trx, fixture.auth.user.id, verified.sha256);
          if (result === 'mismatch') {
            await sql`UPDATE public.icloud_resource SET status='committed',"assetId"=${copy.id}::uuid,sha256=${differing}
            WHERE id=${fixture.resource.id}::uuid`.execute(trx);
          }
          await publishAudit(
            trx,
            fixture.authority,
            fixture.auth.user.id,
            result,
            { id: fixture.resource.id, leaseToken: fixture.resource.leaseToken! },
            result === 'mismatch' ? copy.id : undefined,
          );
        });
      });
      // Observe the actual blocked original-asset lock: the final guard has already
      // reconstructed live elevation, but cannot prevent its deadline passing.
      const rejected = expect(publishing).rejects.toThrow('audit_authority_expired');
      try {
        let blocked = false;
        for (let attempt = 0; attempt < 100 && !blocked; attempt++) {
          if (pid) {
            blocked = (
              await sql<{ blocked: boolean }>`SELECT cardinality(pg_blocking_pids(${pid}))>0 AS blocked`.execute(db)
            ).rows[0].blocked;
          }
          if (!blocked) {
            await new Promise((resolve) => setTimeout(resolve, 10));
          }
        }
        expect(blocked).toBe(true);
        await sql`SELECT pg_sleep(GREATEST(0,extract(epoch FROM (${deadline}::timestamptz-clock_timestamp())))+0.05)`.execute(
          db,
        );
      } finally {
        release.resolve();
      }
      await blocker;
      await rejected;
      expect((await sut.get(fixture.authority.auditRequestId, fixture.auth.user.id))?.result).toBe('running');
      expect((await identities.identities(fixture.auth.user.id, [ASSET]))[0]).toMatchObject({
        lastAuditResult: null,
        lastVerifiedAt: null,
      });
      expect(await sync.resource(fixture.resource.id)).toMatchObject({ assetId: null, status: 'pending' });
    },
  );

  it('refuses a reserved ordinary reuse destination when the source becomes suppressed after precheck', async () => {
    const fixture = await claimed();
    await sql`UPDATE session SET "pinExpiresAt"=clock_timestamp()+interval '1 hour' WHERE id=${fixture.auth.session!.id}::uuid`.execute(
      db,
    );
    const differing = {
      ...verified,
      sha256: createHash('sha256').update(Buffer.alloc(bytes.length, 9)).digest(),
      sha1: createHash('sha1').update(Buffer.alloc(bytes.length, 9)).digest(),
    };
    const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
    const { asset: copy } = await ctx.newAsset({
      ownerId: fixture.auth.user.id,
      checksum: differing.sha256,
      checksumAlgorithm: ChecksumAlgorithm.sha256File,
    });
    const recovery = new MediaRecoveryRepository(db);
    const input = {
      resourceId: fixture.resource.id,
      ownerId: fixture.auth.user.id,
      leaseToken: fixture.resource.leaseToken!,
      includeHidden: false,
      sourceHidden: false,
      audit: fixture.authority,
    };
    const candidate = (await recovery.findCandidates(fixture.auth.user.id, differing)).find(
      ({ id }) => id === copy.id,
    )!;
    expect(candidate.hidden).toBe(false);
    const reservation = (await recovery.reserve({
      ...input,
      verified: differing,
      candidate,
      outcome: 'reused',
      proposedPath: copy.originalPath,
    }))!;
    expect(reservation).toBeDefined();
    const tagId = randomUUID();
    await sql`INSERT INTO tag (id,"userId",value) VALUES (${tagId}::uuid,${fixture.auth.user.id}::uuid,'late-reuse-private')`.execute(
      db,
    );
    await sql`INSERT INTO tag_closure (id_ancestor,id_descendant) VALUES (${tagId}::uuid,${tagId}::uuid)`.execute(db);
    await sql`INSERT INTO tag_asset ("assetId","tagId") VALUES (${fixture.asset.id}::uuid,${tagId}::uuid)`.execute(db);
    const value = { privacy: { suppression: { tagIds: [tagId], personIds: [], petIds: [], scope: 'owned' as const } } };
    await db
      .insertInto('user_metadata')
      .values({ userId: fixture.auth.user.id, key: UserMetadataKey.Preferences, value })
      .onConflict((conflict) => conflict.columns(['userId', 'key']).doUpdateSet({ value }))
      .execute();
    expect(
      await recovery.commit({
        ...input,
        reservation,
        verified: differing,
        originalFileName: 'ordinary.jpg',
        type: AssetType.Image,
        verifyFinal: () => Promise.resolve(differing),
      }),
    ).toMatchObject({ outcome: 'retry', reason: 'target_changed' });
    expect((await sut.get(fixture.authority.auditRequestId, fixture.auth.user.id))?.result).toBe('running');
    expect(await sync.resource(fixture.resource.id)).toMatchObject({ assetId: null });
    expect(
      await db.selectFrom('asset_lock').select('assetId').where('assetId', '=', copy.id).executeTakeFirst(),
    ).toBeUndefined();
  });

  it('commits differing bytes as a separate resource, preserves the original identity, and finishes its outbox after authority loss', async () => {
    const fixture = await claimed();
    const differentBytes = Buffer.alloc(bytes.length, 7);
    const differing: VerifiedMedia = {
      ...verified,
      sha256: createHash('sha256').update(differentBytes).digest(),
      sha1: createHash('sha1').update(differentBytes).digest(),
    };
    const recovery = new MediaRecoveryRepository(db);
    const input = {
      resourceId: fixture.resource.id,
      ownerId: fixture.auth.user.id,
      leaseToken: fixture.resource.leaseToken!,
      includeHidden: false,
      audit: fixture.authority,
    };
    const before = await db
      .selectFrom('asset')
      .selectAll()
      .where('id', '=', fixture.asset.id)
      .executeTakeFirstOrThrow();
    const reservation = (await recovery.reserve({
      ...input,
      verified: differing,
      outcome: 'imported',
      proposedPath: `/managed/.icloud-recovery/${fixture.resource.id}.jpg`,
    }))!;
    expect(reservation).toBeDefined();
    const committed = await recovery.commit({
      ...input,
      reservation,
      verified: differing,
      originalFileName: 'separate.jpg',
      type: AssetType.Image,
      verifyFinal: () => Promise.resolve(differing),
    });
    expect(committed.outcome).toBe('imported');
    expect(committed.assetId).not.toBe(fixture.asset.id);
    expect(
      await db.selectFrom('asset').selectAll().where('id', '=', fixture.asset.id).executeTakeFirstOrThrow(),
    ).toEqual(before);
    const proof = (await identities.identities(fixture.auth.user.id, [ASSET]))[0];
    expect(proof.sha256).toEqual(verified.sha256);
    expect(proof.lastAuditResult).toBe('mismatch');
    expect(proof.lastVerifiedAt).toBeNull();
    await db.deleteFrom('session').where('id', '=', fixture.auth.session!.id).execute();
    await sync.update(fixture.connection.id, fixture.auth.user.id, { state: 'disconnected', encryptedSession: null });
    const outbox = vi.fn().mockRejectedValueOnce(new Error('fixture_outbox_failure')).mockResolvedValue(undefined);
    await sut.housekeeping(outbox);
    expect(await sync.resource(fixture.resource.id)).toMatchObject({ status: 'committed', assetId: committed.assetId });
    await sql`UPDATE public.icloud_resource SET "nextAttemptAt"=NULL WHERE id=${fixture.resource.id}::uuid`.execute(db);
    await new ICloudAuditRepository(db).housekeeping(outbox);
    expect(outbox).toHaveBeenCalledTimes(2);
    expect(await sync.resource(fixture.resource.id)).toMatchObject({
      status: 'finalized',
      reservedBytes: 0,
      assetId: committed.assetId,
    });
    expect((await identities.identities(fixture.auth.user.id, [ASSET]))[0]).toEqual(proof);
  });

  it('cleans the durable match receipt after a crash, revoked session and disconnect without re-certifying', async () => {
    const fixture = await claimed();
    expect(await sut.publishMatch(fixture.authority, fixture.resource, verified, () => Promise.resolve(verified))).toBe(
      true,
    );
    const before = (await identities.identities(fixture.auth.user.id, [ASSET]))[0];
    const cleanup = vi.fn().mockRejectedValueOnce(new Error('fixture_cleanup_failure')).mockResolvedValue(undefined);
    await sut.housekeeping(cleanup);
    await db.deleteFrom('session').where('id', '=', fixture.auth.session!.id).execute();
    await sync.update(fixture.connection.id, fixture.auth.user.id, { state: 'disconnected', encryptedSession: null });
    await sql`UPDATE public.icloud_resource SET "nextAttemptAt"=NULL WHERE id=${fixture.resource.id}::uuid`.execute(db);
    await new ICloudAuditRepository(db).housekeeping(cleanup);
    expect(cleanup).toHaveBeenCalledTimes(2);
    expect(await sync.resource(fixture.resource.id)).toMatchObject({ status: 'finalized', reservedBytes: 0 });
    expect((await identities.identities(fixture.auth.user.id, [ASSET]))[0]).toEqual(before);
    expect(
      (await db.selectFrom('asset').select('originalPath').where('id', '=', fixture.asset.id).executeTakeFirstOrThrow())
        .originalPath,
    ).toBe(fixture.asset.originalPath);
  });

  it('will not clean staging when a committed receipt digest no longer matches its resource', async () => {
    const fixture = await claimed();
    expect(await sut.publishMatch(fixture.authority, fixture.resource, verified, () => Promise.resolve(verified))).toBe(
      true,
    );
    await sql`UPDATE public.icloud_resource SET sha256=${Buffer.alloc(32, 9)} WHERE id=${fixture.resource.id}::uuid`.execute(
      db,
    );
    const cleanup = vi.fn();
    await sut.housekeeping(cleanup);
    expect(cleanup).not.toHaveBeenCalled();
    expect(await sync.resource(fixture.resource.id)).toMatchObject({ status: 'committed' });
  });
});
