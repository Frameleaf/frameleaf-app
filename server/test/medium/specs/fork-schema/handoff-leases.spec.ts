import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { getLiveHandoffLeases, releaseTransientHandoffLeases } from 'src/repositories/fork-handoff-leases.js';
import { ForkSchemaRepository } from 'src/repositories/fork-schema.repository.js';
import { DB } from 'src/schema/index.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-44 (FN-304): transient leases never cross an official handoff. Real PostgreSQL: live claims
 * refuse handoff preparation, render-worker sessions are revoked and Studio editor leases released,
 * and every portable row stays as it was.
 */
describe('official handoff leases (FL-44)', () => {
  let db: Kysely<DB>;
  let ownerId: string;

  beforeAll(async () => {
    db = await getKyselyDB();
    const user = await mediumFactory.userWithClusterGroup(db);
    await db.insertInto('user').values(user).execute();
    ownerId = user.id;
  });

  afterAll(async () => {
    await db.destroy();
  });

  beforeEach(async () => {
    await sql`DELETE FROM public.media_operation`.execute(db);
    await sql`DELETE FROM public.render_worker`.execute(db);
    await sql`DELETE FROM public.studio_project`.execute(db);
    await sql`DELETE FROM immich_fork.migration_audit WHERE name = 'official-handoff-preparation'`.execute(db);
    await sql`UPDATE immich_fork.state SET phase = 'ready', active = false WHERE id = 1`.execute(db);
  });

  const seedOperation = async (claim: 'live' | 'expired' | 'none', kind = 'takeout_import') => {
    const claimToken = claim === 'none' ? null : randomUUID();
    const { rows } = await sql<{ id: string }>`
      INSERT INTO public.media_operation
        ("ownerId", kind, destination, label, snapshot, settings, status, "claimToken", "claimedBy", "claimExpiresAt")
      VALUES (
        ${ownerId}::uuid, ${kind}, 'local', 'Import', '{"source":"takeout"}'::jsonb, '{"quality":"high"}'::jsonb,
        ${claim === 'none' ? 'queued' : 'rendering'},
        ${claimToken}::uuid, ${claim === 'none' ? null : 'worker-1'},
        ${claim === 'live' ? sql`now() + interval '5 minutes'` : claim === 'expired' ? sql`now() - interval '5 minutes'` : null}
      )
      RETURNING id::text AS id
    `.execute(db);
    const id = rows[0]!.id;
    await sql`
      INSERT INTO public.media_operation_checkpoint
        ("operationId", sequence, "chunkKey", "inputDigest", "historyDigest", "configDigest", timebase,
         "startTicks", "endTicks", "claimToken")
      VALUES (${id}::uuid, 0, ${randomUUID()}, 'in', 'history', 'config', '30000/1001', 0, 1001, ${claimToken}::uuid)
    `.execute(db);
    return id;
  };

  const seedSession = async () => {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO public.render_worker (name, destination, "enrolmentSecret", kinds)
      VALUES ('Studio box', 'lan', ${randomBytes(32)}, ARRAY['studio_export'])
      RETURNING id::text AS id
    `.execute(db);
    await sql`
      INSERT INTO public.render_worker_session (id, "workerId", token, scopes, "conformanceReportedAt", "expiresAt")
      VALUES (${randomUUID()}::uuid, ${rows[0]!.id}::uuid, ${randomBytes(32)}, ARRAY['studio_export'], now(),
        now() + interval '1 hour')
    `.execute(db);
  };

  const seedStudioLease = async () => {
    const { rows } = await sql<{ id: string }>`
      INSERT INTO public.studio_project ("ownerId", name, "leaseHolderId", "leaseClientId", "leaseExpiresAt")
      VALUES (${ownerId}::uuid, 'Summer cut', ${ownerId}::uuid, 'tab-1', now() + interval '90 seconds')
      RETURNING id::text AS id
    `.execute(db);
    return rows[0]!.id;
  };

  it('counts only live claims, their chunks, live sessions and live editor leases', async () => {
    await seedOperation('live');
    await seedOperation('expired');
    await seedOperation('none');
    await seedSession();
    await seedStudioLease();

    await expect(getLiveHandoffLeases(db)).resolves.toEqual({
      operations: [{ kind: 'takeout_import', count: 1 }],
      checkpoints: 1,
      renderWorkerSessions: 1,
      studioLeases: 1,
      lapsesAt: expect.any(Date),
    });
  });

  it('revokes sessions and releases editor leases, keeping every portable row', async () => {
    const expired = await seedOperation('expired');
    await seedSession();
    const projectId = await seedStudioLease();

    await expect(releaseTransientHandoffLeases(db)).resolves.toEqual({ renderWorkerSessions: 1, studioLeases: 1 });

    await expect(getLiveHandoffLeases(db)).resolves.toMatchObject({ renderWorkerSessions: 0, studioLeases: 0 });
    const project = await sql<{ name: string; leaseHolderId: string | null; ownerId: string }>`
      SELECT name, "leaseHolderId", "ownerId"::text AS "ownerId" FROM public.studio_project WHERE id = ${projectId}::uuid
    `.execute(db);
    expect(project.rows).toEqual([{ name: 'Summer cut', leaseHolderId: null, ownerId }]);
    // an expired claim is portable as it is: the media-operation sweep requeues it after the return
    const operation = await sql<{ status: string; claimToken: string | null; settings: unknown }>`
      SELECT status, "claimToken"::text AS "claimToken", settings FROM public.media_operation WHERE id = ${expired}::uuid
    `.execute(db);
    expect(operation.rows[0]).toMatchObject({ status: 'rendering', settings: { quality: 'high' } });
    expect(operation.rows[0]!.claimToken).not.toBeNull();
    const sessions = await sql<{ count: number }>`
      SELECT count(*)::int AS count FROM public.render_worker_session WHERE "revokedAt" IS NOT NULL
    `.execute(db);
    expect(sessions.rows[0]!.count).toBe(1);
  });

  it('refuses handoff preparation while a worker holds a live claim, and changes nothing', async () => {
    await seedOperation('live');
    await seedSession();
    await seedStudioLease();
    const repository = new ForkSchemaRepository(db);

    await expect(repository.beginOrResumeOfficialHandoffPreparation()).rejects.toThrow(
      /Official handoff refused: 1 job is still claimed by a worker \(takeout_import x1, 1 render chunk in flight\)/,
    );

    const audit = await sql`
      SELECT 1 FROM immich_fork.migration_audit WHERE name = 'official-handoff-preparation'
    `.execute(db);
    expect(audit.rows).toHaveLength(0);
    // the transaction rolled back: the session and the editor lease are still there
    await expect(getLiveHandoffLeases(db)).resolves.toMatchObject({ renderWorkerSessions: 1, studioLeases: 1 });
  });

  it('starts handoff preparation once only expired claims remain, releasing sessions and editor leases', async () => {
    await seedOperation('expired');
    await seedSession();
    await seedStudioLease();
    const repository = new ForkSchemaRepository(db);

    await repository.beginOrResumeOfficialHandoffPreparation();

    const audit = await sql<{ status: string }>`
      SELECT status FROM immich_fork.migration_audit WHERE name = 'official-handoff-preparation'
    `.execute(db);
    expect(audit.rows).toEqual([{ status: 'running' }]);
    await expect(getLiveHandoffLeases(db)).resolves.toEqual({
      operations: [],
      checkpoints: 0,
      renderWorkerSessions: 0,
      studioLeases: 0,
      lapsesAt: null,
    });
  });
});
