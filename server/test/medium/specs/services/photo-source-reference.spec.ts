import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import request from 'supertest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { PhotoSourceController } from 'src/controllers/photo-source.controller.js';
import { AssetLockReason, AssetStatus, AssetType, AssetVisibility, JobName, QueueName } from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoSourceRepository } from 'src/repositories/photo-source.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SourceResourceCacheRepository } from 'src/repositories/source-resource-cache.repository.js';
import { SourceResourceReadRepository } from 'src/repositories/source-resource-read.repository.js';
import { SourceResourceRepository } from 'src/repositories/source-resource.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { PhotoSourceService } from 'src/services/photo-source.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { controllerSetup, getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db?.destroy());

async function setup(mode: 'copy' | 'reference' = 'reference', kind: 'folder' | 'apple-photos' = 'folder') {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const session = await new SessionRepository(db).create({ userId: user.id, token: Buffer.alloc(32, 7) });
  const device = (await new DesktopDeviceRepository(db).enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: Buffer.alloc(32, 7).toString('base64'),
    name: 'Reference fixture',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'awaiting-approval',
  }))!;
  const auth = { user, session: { ...session, hasElevatedPermission: false } } as AuthDto;
  const authority = { ownerId: user.id, sessionId: session.id };
  const repository = new PhotoSourceRepository(db);
  const source = await repository.create(authority, {
    id: randomUUID(),
    deviceId: device.id,
    kind,
    mode,
    name: 'Reference originals',
    scopeFingerprint: 'a'.repeat(64),
  });
  const run = await repository.run(authority, source.id, { id: randomUUID(), maxItems: 2, maxBytes: 100 });
  const itemInput = {
    id: randomUUID(),
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256: 'd'.repeat(64),
    bytes: 5,
  };
  const item = await repository.plan(authority, source.id, run.id, itemInput);
  const jobs = {
    queueInTransaction: vi.fn(async (tx, job) => {
      await new SqlQueueStore(tx).enqueue([
        {
          name: job.name,
          data: job.data,
          queue: QueueName.MetadataExtraction,
          safeToRetry: true,
          sensitive: false,
          deadlineMs: 60_000,
        },
      ]);
    }),
  };
  const service = new PhotoSourceService(
    repository,
    new AccessRepository(db),
    {} as never,
    {} as never,
    new SystemMetadataRepository(db),
    {} as never,
    LoggingRepository.create(),
    jobs as never,
  );
  const http = await controllerSetup(PhotoSourceController, [{ provide: PhotoSourceService, useValue: service }]);
  http.authenticate.mockResolvedValue(auth);
  const input = {
    assetId: randomUUID(),
    type: AssetType.Image,
    originalFileName: 'original.jpg',
    fileCreatedAt: '2026-10-01T12:00:00.000Z',
    fileModifiedAt: '2026-10-02T12:00:00.000Z',
  };
  const publish = (body: object = input, runId = run.id, itemId = item.id) =>
    request(http.getHttpServer())
      .post(`/photo-sources/${source.id}/runs/${runId}/items/${itemId}/reference`)
      .send(body);
  return {
    ctx,
    user,
    device,
    session,
    authority,
    auth,
    repository,
    source,
    run,
    item,
    itemInput,
    jobs,
    http,
    input,
    publish,
  };
}

it.each(['folder', 'apple-photos'] as const)(
  'publishes a path-free %s reference binding and metadata job atomically without copying or charging original bytes',
  async (kind) => {
    const f = await setup('reference', kind);
    try {
      const response = await f.publish();
      expect(response.status).toBe(200);
      expect(response.headers['cache-control']).toBe('private, no-store');
      expect(response.body).toMatchObject({
        sourceId: f.source.id,
        runId: f.run.id,
        itemId: f.item.id,
        resourceId: f.item.id,
        assetId: f.input.assetId,
        ownerId: f.user.id,
        version: f.item.version,
        sha256: 'd'.repeat(64),
        bytes: 5,
        storage: 'reference',
      });
      expect(response.body.uploadResourceId).toBeUndefined();
      const library = await db
        .selectFrom('library')
        .selectAll()
        .where('id', '=', f.source.id)
        .executeTakeFirstOrThrow();
      expect(library).toMatchObject({
        ownerId: f.user.id,
        readOnly: true,
        importPaths: [],
        exclusionPatterns: [],
        deletedAt: null,
      });
      const asset = await db
        .selectFrom('asset')
        .selectAll()
        .where('id', '=', f.input.assetId)
        .executeTakeFirstOrThrow();
      const locator = `frameleaf-source://${f.source.id}/${f.item.resourceKey}`;
      expect(asset).toMatchObject({
        ownerId: f.user.id,
        libraryId: library.id,
        originalPath: locator,
        originalFileName: 'original.jpg',
        isExternal: true,
        physicalOriginalFileId: null,
        checksum: createHash('sha1').update(locator).digest(),
        checksumAlgorithm: 'sha1-path',
      });
      expect(
        await db.selectFrom('source_original').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow(),
      ).toEqual({
        assetId: asset.id,
        resourceId: f.item.id,
        scopeFingerprint: f.source.scopeFingerprint,
        authorizationEpoch: f.device.authorizationEpoch,
      });
      expect(
        (await db.selectFrom('user').select('quotaUsageInBytes').where('id', '=', f.user.id).executeTakeFirstOrThrow())
          .quotaUsageInBytes,
      ).toBe(f.user.quotaUsageInBytes);
      expect(f.jobs.queueInTransaction).toHaveBeenCalledOnce();
      expect(f.jobs.queueInTransaction.mock.calls[0][1]).toEqual({
        name: JobName.AssetExtractMetadata,
        data: { id: asset.id, source: 'upload' },
      });
      expect(
        await db
          .selectFrom('job')
          .select(['name', 'queue'])
          .where(sql<boolean>`data->>'id'=${asset.id}`)
          .execute(),
      ).toEqual([{ name: JobName.AssetExtractMetadata, queue: QueueName.MetadataExtraction }]);
      const reads = new SourceResourceReadRepository(
        db,
        new SourceResourceRepository(db),
        new SourceResourceCacheRepository(db),
      );
      const read = await reads.enqueue(asset.id, 5);
      expect(read).toBeDefined();
      expect(
        await db
          .selectFrom('source_resource_read')
          .select(['sourceId', 'resourceId', 'state'])
          .where('id', '=', read!.id)
          .executeTakeFirstOrThrow(),
      ).toEqual({ sourceId: f.source.id, resourceId: f.item.id, state: 'pending' });
    } finally {
      await f.http.close();
    }
  },
);

it('concurrent replay and later identical inventories retain one asset and one metadata admission', async () => {
  const f = await setup();
  try {
    const responses = await Promise.all([f.publish(), f.publish()]);
    expect(responses.map((r) => r.status)).toEqual([200, 200]);
    expect(responses[0].body).toEqual(responses[1].body);
    const next = await f.repository.run(f.authority, f.source.id, { id: randomUUID(), maxItems: 2, maxBytes: 100 });
    const item = await f.repository.plan(f.authority, f.source.id, next.id, { ...f.itemInput, id: randomUUID() });
    const response = await f.publish(f.input, next.id, item.id);
    expect(response.status).toBe(200);
    expect(response.body.resourceId).toBe(f.item.id);
    expect(f.jobs.queueInTransaction).toHaveBeenCalledOnce();
    expect((await f.publish({ ...f.input, assetId: randomUUID() })).status).toBe(409);
    expect(await db.selectFrom('asset').select('id').where('ownerId', '=', f.user.id).execute()).toEqual([
      { id: f.input.assetId },
    ]);
  } finally {
    await f.http.close();
  }
});

it('rolls the library, asset and resource back when metadata admission fails', async () => {
  const f = await setup();
  try {
    f.jobs.queueInTransaction.mockRejectedValueOnce(new Error('synthetic queue failure'));
    expect((await f.publish()).status).toBe(500);
    expect(await db.selectFrom('library').select('id').where('id', '=', f.source.id).execute()).toEqual([]);
    expect(await db.selectFrom('asset').select('id').where('id', '=', f.input.assetId).execute()).toEqual([]);
    expect(
      (
        await db
          .selectFrom('photo_source_resource')
          .select('state')
          .where('id', '=', f.item.id)
          .executeTakeFirstOrThrow()
      ).state,
    ).toBe('planned');
    expect((await f.publish()).status).toBe(200);
  } finally {
    await f.http.close();
  }
});

it('returns an identical receipt after a completed run without admitting new work', async () => {
  const f = await setup();
  try {
    const first = await f.publish();
    expect(first.status).toBe(200);
    await f.repository.setState(f.authority, f.source.id, f.run.id, { state: 'complete', inventoryComplete: true });
    const replay = await f.publish();
    expect(replay.status).toBe(200);
    expect(replay.body).toEqual(first.body);
    expect(f.jobs.queueInTransaction).toHaveBeenCalledOnce();
  } finally {
    await f.http.close();
  }
});

it.each(['trashed', 'deleted', 'library-deleted'])('never resurrects %s references on replay', async (removed) => {
  const f = await setup();
  try {
    expect((await f.publish()).status).toBe(200);
    switch (removed) {
      case 'trashed': {
        await db
          .updateTable('asset')
          .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
          .where('id', '=', f.input.assetId)
          .execute();
        break;
      }
      case 'deleted': {
        await db.deleteFrom('asset').where('id', '=', f.input.assetId).execute();
        break;
      }
      case 'library-deleted': {
        await db.deleteFrom('library').where('id', '=', f.source.id).execute();
        break;
      }
    }
    expect((await f.publish()).status).toBe(409);
    const next = await f.repository.run(f.authority, f.source.id, { id: randomUUID(), maxItems: 2, maxBytes: 100 });
    const item = await f.repository.plan(f.authority, f.source.id, next.id, { ...f.itemInput, id: randomUUID() });
    expect((await f.publish(f.input, next.id, item.id)).status).toBe(409);
    expect(f.jobs.queueInTransaction).toHaveBeenCalledOnce();
  } finally {
    await f.http.close();
  }
});

it('refuses copy-mode publication, paused runs and foreign sessions', async () => {
  const f = await setup('copy');
  try {
    expect((await f.publish()).status).toBe(409);
  } finally {
    await f.http.close();
  }
  const g = await setup();
  try {
    await g.repository.setState(g.authority, g.source.id, g.run.id, { state: 'paused', inventoryComplete: false });
    expect((await g.publish()).status).toBe(409);
    g.http.authenticate.mockResolvedValue(f.auth);
    expect((await g.publish()).status).toBe(404);
  } finally {
    await g.http.close();
  }
});

it('refuses a new version instead of silently replacing existing pixels or accepting a different asset identity', async () => {
  const f = await setup();
  try {
    expect((await f.publish()).status).toBe(200);
    const item = await f.repository.plan(f.authority, f.source.id, f.run.id, {
      ...f.itemInput,
      id: randomUUID(),
      version: 'e'.repeat(64),
    });
    expect((await f.publish(f.input, f.run.id, item.id)).status).toBe(409);
    expect(
      (
        await db
          .selectFrom('source_original')
          .select('resourceId')
          .where('assetId', '=', f.input.assetId)
          .executeTakeFirstOrThrow()
      ).resourceId,
    ).toBe(f.item.id);
    expect(f.jobs.queueInTransaction).toHaveBeenCalledOnce();
  } finally {
    await f.http.close();
  }
});

it.each(['foreign', 'writable', 'paths', 'soft-deleted', 'unrelated-readonly'])(
  'refuses an existing %s library instead of taking it over',
  async (kind) => {
    const f = await setup();
    try {
      const other = kind === 'foreign' ? (await f.ctx.newUser()).user.id : f.user.id;
      await db
        .insertInto('library')
        .values({
          id: f.source.id,
          ownerId: other,
          name: 'Existing',
          readOnly: kind !== 'writable',
          importPaths: kind === 'paths' ? ['/private'] : [],
          exclusionPatterns: [],
          deletedAt: kind === 'soft-deleted' ? new Date() : null,
        })
        .execute();
      expect((await f.publish()).status).toBe(409);
      expect(await db.selectFrom('asset').select('id').where('id', '=', f.input.assetId).execute()).toEqual([]);
    } finally {
      await f.http.close();
    }
  },
);

it('does not recreate a deleted source library for a different resource key', async () => {
  const f = await setup();
  try {
    expect((await f.publish()).status).toBe(200);
    await db.deleteFrom('library').where('id', '=', f.source.id).execute();
    const item = await f.repository.plan(f.authority, f.source.id, f.run.id, {
      ...f.itemInput,
      id: randomUUID(),
      resourceKey: 'e'.repeat(64),
    });
    expect((await f.publish({ ...f.input, assetId: randomUUID() }, f.run.id, item.id)).status).toBe(409);
    expect(await db.selectFrom('library').select('id').where('id', '=', f.source.id).execute()).toEqual([]);
  } finally {
    await f.http.close();
  }
});

it('session expiration during admission rolls back the job and every publication row', async () => {
  const f = await setup();
  try {
    const enqueue = f.jobs.queueInTransaction.getMockImplementation()!;
    f.jobs.queueInTransaction.mockImplementationOnce(async (tx, job) => {
      await enqueue(tx, job);
      await tx
        .updateTable('session')
        .set({ expiresAt: new Date(0) })
        .where('id', '=', f.session.id)
        .execute();
    });
    expect((await f.publish()).status).toBe(404);
    expect(await db.selectFrom('asset').select('id').where('id', '=', f.input.assetId).execute()).toEqual([]);
    expect(
      await db
        .selectFrom('job')
        .select('id')
        .where(sql<boolean>`data->>'id'=${f.input.assetId}`)
        .execute(),
    ).toEqual([]);
    expect((await f.publish()).status).toBe(200);
  } finally {
    await f.http.close();
  }
});

it.each(['hidden', 'locked'])('replay respects %s asset privacy and never changes it', async (privacy) => {
  const f = await setup();
  try {
    expect((await f.publish()).status).toBe(200);
    if (privacy === 'hidden')
      await db
        .updateTable('asset')
        .set({ visibility: AssetVisibility.Hidden })
        .where('id', '=', f.input.assetId)
        .execute();
    else
      await db
        .insertInto('asset_lock')
        .values({
          assetId: f.input.assetId,
          reason: AssetLockReason.Marked,
          lockedBy: f.user.id,
          previousVisibility: null,
        })
        .execute();
    expect((await f.publish()).status).toBe(409);
    await db
      .updateTable('session')
      .set({ pinExpiresAt: new Date(Date.now() + 60_000) })
      .where('id', '=', f.session.id)
      .execute();
    expect((await f.publish()).status).toBe(200);
    expect(f.jobs.queueInTransaction).toHaveBeenCalledOnce();
  } finally {
    await f.http.close();
  }
});

it('refuses private replay when PIN elevation expires while waiting for the asset lock', async () => {
  const f = await setup();
  try {
    expect((await f.publish()).status).toBe(200);
    const next = await f.repository.run(f.authority, f.source.id, { id: randomUUID(), maxItems: 2, maxBytes: 100 });
    const item = await f.repository.plan(f.authority, f.source.id, next.id, { ...f.itemInput, id: randomUUID() });
    await db
      .updateTable('asset')
      .set({ visibility: AssetVisibility.Hidden })
      .where('id', '=', f.input.assetId)
      .execute();
    const pinExpiresAt = new Date(Date.now() + 1500);
    await db.updateTable('session').set({ pinExpiresAt }).where('id', '=', f.session.id).execute();
    let pending: Promise<{ status: number }> | undefined;
    await db.transaction().execute(async (tx) => {
      const {
        rows: [locker],
      } = await sql<{ pid: number }>`SELECT pg_backend_pid() AS pid`.execute(tx);
      await tx.selectFrom('asset').select('id').where('id', '=', f.input.assetId).forUpdate().execute();
      pending = f.publish(f.input, next.id, item.id).then((response) => response);
      const deadline = Date.now() + 3000;
      while (true) {
        const {
          rows: [row],
        } = await sql<{ blocked: boolean }>`SELECT EXISTS (
          SELECT 1 FROM pg_stat_activity WHERE ${locker.pid}=ANY(pg_blocking_pids(pid))
        ) AS blocked`.execute(db);
        if (row.blocked) break;
        if (Date.now() >= deadline) throw new Error('Reference replay did not wait on the owned asset lock');
        await new Promise((resolve) => setTimeout(resolve, 50));
      }
      expect(pinExpiresAt.getTime()).toBeGreaterThan(Date.now());
      await new Promise((resolve) => setTimeout(resolve, pinExpiresAt.getTime() - Date.now() + 30));
    });
    expect((await pending!).status).toBe(409);
    expect(
      (await db.selectFrom('photo_source_resource').select('state').where('id', '=', item.id).executeTakeFirstOrThrow())
        .state,
    ).toBe('planned');
  } finally {
    await f.http.close();
  }
});

it('validates filenames, dates and exact request shape without accepting any provider or server path', async () => {
  const f = await setup();
  try {
    for (const change of [
      { originalFileName: '../one.jpg' },
      { originalFileName: String.raw`C:\private\one.jpg` },
      { originalFileName: '..' },
      { originalFileName: 'a\0.jpg' },
      { originalFileName: '' },
      { fileCreatedAt: 'yesterday' },
      { type: 'AUDIO' },
      { originalPath: '/private' },
      { sha256: 'e'.repeat(64) },
    ]) {
      expect((await f.publish({ ...f.input, ...change })).status).toBe(400);
    }
    expect(f.jobs.queueInTransaction).not.toHaveBeenCalled();
  } finally {
    await f.http.close();
  }
});
