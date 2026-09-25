import { randomBytes, randomUUID } from 'node:crypto';
import { describe, expect, it } from 'vitest';
import {
  api,
  authHeaders,
  canonical,
  digest,
  downloadAsset,
  loadState,
  phase,
  saveState,
  uploadAsset,
  withDatabase,
} from './fork-schema-certification';

/**
 * FL-44 (FN-304): official v3.1.0 → fork → official v3.1.0 → fork on one isolated volume set.
 *
 * The fork leg seeds Frameleaf's public-schema rows (a media operation with a render checkpoint, a
 * Takeout import, a Studio project an editor holds, a preservation package, a render worker with a
 * live and an expired session) and a physically deduplicated original two owners share. Each later
 * leg checks that every portable row survives unchanged, that the handoff released the transient
 * leases (the live render-worker session is revoked, the Studio editor lease is gone), and that both
 * owners still read the same original bytes.
 */
const lane = 'official-v3.1.0-to-fork-to-official-v3.1.0-to-fork';
const originLane = 'origin-v3.1.0-to-fork';

type OriginState = { admin: { accessToken: string; userId: string }; assetId: string };
type ChainState = {
  adminToken: string;
  copyOwner: { accessToken: string; userId: string };
  retainedAssetId: string;
  copyAssetId: string;
  physicalFileId: string;
  originalDigest: string;
  operationId: string;
  checkpointId: string;
  takeoutImportId: string;
  studioProjectId: string;
  preservationPackageId: string;
  renderWorkerId: string;
  liveSessionId: string;
  expiredSessionId: string;
  portable: unknown;
};

/** The rows that must cross every handoff unchanged. Lease and audit columns are checked apart. */
const portableRows = (state: Omit<ChainState, 'portable' | 'originalDigest'>) =>
  withDatabase(async (client) => {
    const select = async (statement: string, values: unknown[]) => {
      const result = await client.query(statement, values);
      return canonical(result.rows);
    };
    return {
      operation: await select(
        `SELECT id::text, "ownerId"::text, kind, destination, label, snapshot, settings, status,
                "claimToken"::text AS "claimToken"
         FROM public.media_operation WHERE id = $1`,
        [state.operationId],
      ),
      checkpoint: await select(
        `SELECT id::text, "operationId"::text, sequence, state, "chunkKey", "outputPath", "claimToken"::text AS "claimToken"
         FROM public.media_operation_checkpoint WHERE id = $1`,
        [state.checkpointId],
      ),
      takeout: await select(
        `SELECT id::text, "ownerId"::text, name, phase, options, "runOperationId"::text AS "runOperationId"
         FROM public.takeout_import WHERE id = $1`,
        [state.takeoutImportId],
      ),
      studio: await select(
        `SELECT id::text, "ownerId"::text, name, "currentRevision", "deletedAt"::text AS "deletedAt", "archivedAt"::text AS "archivedAt"
         FROM public.studio_project WHERE id = $1`,
        [state.studioProjectId],
      ),
      preservation: await select(
        `SELECT id::text, "ownerId"::text, origin, name, status, format, path, "removedAt"::text AS "removedAt"
         FROM public.preservation_package WHERE id = $1`,
        [state.preservationPackageId],
      ),
      renderWorker: await select(
        `SELECT id::text, name, destination, kinds, status FROM public.render_worker WHERE id = $1`,
        [state.renderWorkerId],
      ),
      renderWorkerSessions: await select(
        `SELECT id::text, "workerId"::text, scopes, "expiresAt"::text AS "expiresAt" FROM public.render_worker_session
         WHERE id = ANY($1::uuid[]) ORDER BY id::text`,
        [[state.liveSessionId, state.expiredSessionId]],
      ),
      physicalFile: await select(
        `SELECT id::text, type, path, "canonicalAssetId"::text AS "canonicalAssetId"
         FROM public.physical_file WHERE id = $1`,
        [state.physicalFileId],
      ),
      owners: await select(
        `SELECT id::text, "ownerId"::text FROM public.asset WHERE id = ANY($1::uuid[]) ORDER BY id::text`,
        [[state.retainedAssetId, state.copyAssetId]],
      ),
    };
  });

/** The fork's storage mapping of both owners' assets: the same physical file behind each. */
const sharedMappings = (state: ChainState) =>
  withDatabase(async (client) => {
    const { rows } = await client.query<{ assetId: string; physicalFileId: string | null }>(
      `SELECT "assetId"::text AS "assetId", "physicalFileId"::text AS "physicalFileId"
       FROM immich_fork.asset_physical_file WHERE "assetId" = ANY($1::uuid[]) ORDER BY "assetId"::text`,
      [[state.retainedAssetId, state.copyAssetId]],
    );
    return rows;
  });

const leases = (state: ChainState) =>
  withDatabase(async (client) => {
    const sessions = await client.query<{ id: string; revoked: boolean }>(
      `SELECT id::text, "revokedAt" IS NOT NULL AS revoked FROM public.render_worker_session
       WHERE id = ANY($1::uuid[])`,
      [[state.liveSessionId, state.expiredSessionId]],
    );
    const studio = await client.query<{ leaseHolderId: string | null; leaseClientId: string | null }>(
      `SELECT "leaseHolderId"::text AS "leaseHolderId", "leaseClientId" FROM public.studio_project WHERE id = $1`,
      [state.studioProjectId],
    );
    return {
      liveSessionRevoked: sessions.rows.find(({ id }) => id === state.liveSessionId)?.revoked,
      expiredSessionRevoked: sessions.rows.find(({ id }) => id === state.expiredSessionId)?.revoked,
      studioLease: studio.rows[0],
    };
  });

const expectSharedOriginal = async (state: ChainState) => {
  const retained = await downloadAsset(state.adminToken, state.retainedAssetId);
  const copy = await downloadAsset(state.copyOwner.accessToken, state.copyAssetId);
  expect(digest(retained)).toBe(state.originalDigest);
  expect(digest(copy)).toBe(state.originalDigest);
};

const waitForQuiescence = async (token: string) => {
  let stable = 0;
  for (let attempt = 0; attempt < 600 && stable < 5; attempt++) {
    const queues = await api<Record<string, { jobCounts: { active: number; delayed: number; waiting: number } }>>(
      '/jobs',
      { headers: authHeaders(token) },
    );
    const busy = Object.values(queues).some(
      ({ jobCounts }) => jobCounts.active > 0 || jobCounts.delayed > 0 || jobCounts.waiting > 0,
    );
    stable = busy ? 0 : stable + 1;
    if (stable < 5) {
      await new Promise((resolve) => setTimeout(resolve, 100));
    }
  }
  expect(stable).toBe(5);
};

describe.runIf(phase === 'chain-fork-seed')(`${lane}: fork leg seeds Frameleaf rows`, () => {
  it('seeds public Frameleaf rows and a deduplicated original two owners share', async () => {
    const origin = await loadState<OriginState>(originLane);
    const adminToken = origin.admin.accessToken;
    const headers = { ...authHeaders(adminToken), 'content-type': 'application/json' };
    const credentials = { email: 'certification-copy-owner@example.test', password: 'Certification123!' };
    await api('/admin/users', {
      body: JSON.stringify({ ...credentials, name: 'Certification Copy Owner' }),
      headers,
      method: 'POST',
    });
    const copyOwner = await api<{ accessToken: string; userId: string }>('/auth/login', {
      body: JSON.stringify(credentials),
      headers: { 'content-type': 'application/json' },
      method: 'POST',
    });
    const copy = await uploadAsset(copyOwner.accessToken, 'chained-dedup-copy.png');
    const originalDigest = digest(await downloadAsset(adminToken, origin.assetId));

    const seeded = await withDatabase(async (client) => {
      // The copy owner's asset becomes a deduplicated reference to the retained original.
      const { rows: physical } = await client.query<{ id: string }>(
        `INSERT INTO public.physical_file (type, checksum, "sizeInBytes", path, "canonicalAssetId")
         SELECT 'original', asset.checksum, exif."fileSizeInByte", asset."originalPath", asset.id
         FROM public.asset asset JOIN public.asset_exif exif ON exif."assetId" = asset.id
         WHERE asset.id = $1
         ON CONFLICT (path) DO UPDATE SET "canonicalAssetId" = EXCLUDED."canonicalAssetId"
         RETURNING id::text`,
        [origin.assetId],
      );
      const physicalFileId = physical[0]!.id;
      await client.query(`UPDATE public.asset SET "physicalOriginalFileId" = $2 WHERE id = $1`, [
        origin.assetId,
        physicalFileId,
      ]);
      await client.query(
        `UPDATE public.asset copy
         SET "originalPath" = retained."originalPath", checksum = retained.checksum,
             "checksumAlgorithm" = retained."checksumAlgorithm", "physicalOriginalFileId" = $3
         FROM public.asset retained WHERE copy.id = $1 AND retained.id = $2`,
        [copy.id, origin.assetId, physicalFileId],
      );
      await client.query(
        `UPDATE public.asset_exif copy SET "fileSizeInByte" = retained."fileSizeInByte"
         FROM public.asset_exif retained WHERE copy."assetId" = $1 AND retained."assetId" = $2`,
        [copy.id, origin.assetId],
      );

      // A paused job (no claim; nothing requeues it) with a chunk its last claim rendered.
      const operationId = randomUUID();
      await client.query(
        `INSERT INTO public.media_operation
           (id, "ownerId", kind, destination, label, snapshot, settings, status, "pauseRequestedAt")
         VALUES ($1, $2, 'takeout_import', 'local', 'Chained import', '{"source":"certification"}',
                 '{"albums":true}', 'paused', now())`,
        [operationId, origin.admin.userId],
      );
      const checkpointId = randomUUID();
      await client.query(
        `INSERT INTO public.media_operation_checkpoint
           (id, "operationId", sequence, state, "chunkKey", "inputDigest", "historyDigest", "configDigest", timebase,
            "startTicks", "endTicks", "outputPath", "claimToken")
         VALUES ($1, $2, 0, 'completed', $3, 'input', 'history', 'config', '30000/1001', 0, 1001,
                 '/data/encoded-video/chained-chunk-0.mkv', $4)`,
        [checkpointId, operationId, randomUUID(), randomUUID()],
      );
      const takeoutImportId = randomUUID();
      await client.query(
        `INSERT INTO public.takeout_import (id, "ownerId", name, options, "runOperationId")
         VALUES ($1, $2, 'Chained import', '{"albums":true}', $3)`,
        [takeoutImportId, origin.admin.userId, operationId],
      );
      // An editor tab holds this project's write lease well past the handoff.
      const studioProjectId = randomUUID();
      await client.query(
        `INSERT INTO public.studio_project (id, "ownerId", name, "leaseHolderId", "leaseClientId", "leaseExpiresAt")
         VALUES ($1, $2, 'Chained cut', $2, 'chained-tab', now() + interval '1 day')`,
        [studioProjectId, origin.admin.userId],
      );
      const preservationPackageId = randomUUID();
      await client.query(
        `INSERT INTO public.preservation_package (id, "ownerId", origin, name, status, format, path)
         VALUES ($1, $2, 'export', 'Chained package', 'ready', 'zip', '/data/exports/chained-package.zip')`,
        [preservationPackageId, origin.admin.userId],
      );
      const renderWorkerId = randomUUID();
      await client.query(
        `INSERT INTO public.render_worker (id, name, destination, "enrolmentSecret", kinds)
         VALUES ($1, 'Chained render worker', 'lan', $2, ARRAY['studio_export'])`,
        [renderWorkerId, randomBytes(32)],
      );
      const liveSessionId = randomUUID();
      const expiredSessionId = randomUUID();
      await client.query(
        `INSERT INTO public.render_worker_session (id, "workerId", token, scopes, "conformanceReportedAt", "expiresAt")
         VALUES ($1, $3, $4, ARRAY['studio_export'], now(), now() + interval '1 day'),
                ($2, $3, $5, ARRAY['studio_export'], now(), now() - interval '1 hour')`,
        [liveSessionId, expiredSessionId, renderWorkerId, randomBytes(32), randomBytes(32)],
      );
      return {
        physicalFileId,
        operationId,
        checkpointId,
        takeoutImportId,
        studioProjectId,
        preservationPackageId,
        renderWorkerId,
        liveSessionId,
        expiredSessionId,
      };
    });

    const ids = {
      adminToken,
      copyOwner,
      retainedAssetId: origin.assetId,
      copyAssetId: copy.id,
      ...seeded,
    };
    const state: ChainState = { ...ids, originalDigest, portable: await portableRows(ids) };
    await expectSharedOriginal(state);
    await expect(leases(state)).resolves.toEqual({
      liveSessionRevoked: false,
      expiredSessionRevoked: false,
      studioLease: { leaseHolderId: origin.admin.userId, leaseClientId: 'chained-tab' },
    });
    await saveState(lane, state);
    await waitForQuiescence(adminToken);
  }, 180_000);
});

describe.runIf(phase === 'chain-fork-handed-over')(`${lane}: fork leg after the locked cutover`, () => {
  it('released the transient leases and kept every portable row and both storage mappings', async () => {
    const state = await loadState<ChainState>(lane);
    await expect(portableRows(state)).resolves.toEqual(state.portable);
    await expect(leases(state)).resolves.toEqual({
      liveSessionRevoked: true,
      expiredSessionRevoked: false,
      studioLease: { leaseHolderId: null, leaseClientId: null },
    });
    await expect(sharedMappings(state)).resolves.toEqual(
      [state.retainedAssetId, state.copyAssetId]
        .toSorted((left, right) => left.localeCompare(right))
        .map((assetId) => ({ assetId, physicalFileId: state.physicalFileId })),
    );
    await withDatabase(async (client) => {
      const live = await client.query<{ count: number }>(
        `SELECT count(*)::int AS count FROM public.media_operation
         WHERE "claimToken" IS NOT NULL AND "claimExpiresAt" > now()`,
      );
      expect(live.rows[0]!.count).toBe(0);
    });
  });
});

describe.runIf(phase === 'chain-official')(`${lane}: official leg`, () => {
  it('serves both owners the shared original and leaves the Frameleaf rows alone', async () => {
    const state = await loadState<ChainState>(lane);
    await expect(api('/server/about', { headers: authHeaders(state.adminToken) })).resolves.toEqual(
      expect.objectContaining({ version: expect.any(String) }),
    );
    await expectSharedOriginal(state);
    await expect(portableRows(state)).resolves.toEqual(state.portable);
  }, 120_000);
});

describe.runIf(phase === 'chain-fork-return')(`${lane}: fork leg after the return`, () => {
  it('keeps every Frameleaf row, the cleared leases and the deduplicated reference across the round trip', async () => {
    const state = await loadState<ChainState>(lane);
    await expect(api('/server/about', { headers: authHeaders(state.adminToken) })).resolves.toEqual(
      expect.objectContaining({ version: expect.any(String) }),
    );
    await expect(portableRows(state)).resolves.toEqual(state.portable);
    await expect(leases(state)).resolves.toEqual({
      liveSessionRevoked: true,
      expiredSessionRevoked: false,
      studioLease: { leaseHolderId: null, leaseClientId: null },
    });
    await expect(sharedMappings(state)).resolves.toEqual(
      [state.retainedAssetId, state.copyAssetId]
        .toSorted((left, right) => left.localeCompare(right))
        .map((assetId) => ({ assetId, physicalFileId: state.physicalFileId })),
    );
    await expectSharedOriginal(state);
    await withDatabase(async (client) => {
      const fork = await client.query('SELECT active, phase FROM immich_fork.state WHERE id = 1');
      expect(fork.rows[0]).toEqual({ active: true, phase: 'active' });
    });
  }, 120_000);
});
