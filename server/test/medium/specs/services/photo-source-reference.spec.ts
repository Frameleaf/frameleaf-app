import { ServiceUnavailableException } from '@nestjs/common';
import { json } from 'body-parser';
import { Kysely, sql } from 'kysely';
import { type ChildProcess, execFile, spawn } from 'node:child_process';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { readFileSync } from 'node:fs';
import { mkdtemp, realpath, rm } from 'node:fs/promises';
import { createServer } from 'node:https';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { createInterface } from 'node:readline';
import { promisify } from 'node:util';
import request from 'supertest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { DesktopDeviceController } from 'src/controllers/desktop-device.controller.js';
import { PhotoSourceController } from 'src/controllers/photo-source.controller.js';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import {
  AssetFileType,
  AssetLockReason,
  AssetStatus,
  AssetType,
  AssetVisibility,
  DocumentEditAction,
  JobName,
  PetSpecies,
  QueueName,
  SourceType,
  VideoMomentSource,
} from 'src/enum.js';
import { SqlQueueStore } from 'src/queue/store.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { DocumentRepository } from 'src/repositories/document.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoSourceRepository } from 'src/repositories/photo-source.repository.js';
import { PhysicalFileRepository } from 'src/repositories/physical-file.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SourceResourceCacheRepository } from 'src/repositories/source-resource-cache.repository.js';
import { SourceResourceReadRepository } from 'src/repositories/source-resource-read.repository.js';
import { SourceResourceRepository } from 'src/repositories/source-resource.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { DesktopAssistancePolicyService } from 'src/services/desktop-assistance-policy.service.js';
import { DesktopDeviceService } from 'src/services/desktop-device.service.js';
import { DesktopWorkerAuthService } from 'src/services/desktop-worker-auth.service.js';
import { PhotoSourceService } from 'src/services/photo-source.service.js';
import { assertAssetSource, readAssetSource } from 'src/utils/asset-source-authority.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { developSourceVersion } from 'src/utils/develop-source-binding.js';
import { newMediumService } from 'test/medium.factory.js';
import { newEmbedding } from 'test/small.factory.js';
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
          queue: job.name === JobName.FileDelete ? QueueName.BackgroundTask : QueueName.MetadataExtraction,
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
    service,
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

it('requires the previous-resource fence before replacing existing pixels', async () => {
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

it('replaces the exact current reference atomically, retaining the logical asset and owner metadata', async () => {
  const f = await setup();
  try {
    expect((await f.publish()).status).toBe(200);
    const assetId = f.input.assetId;
    await db
      .updateTable('asset')
      .set({ isFavorite: true, is_nsfw: true, isEdited: true, width: 400, height: 200 })
      .where('id', '=', assetId)
      .execute();
    await db
      .insertInto('asset_file')
      .values({ assetId, type: AssetFileType.Preview, path: '/synthetic/' + assetId + '.jpg' })
      .execute();
    await db
      .insertInto('asset_exif')
      .values({
        assetId,
        description: 'Owner caption',
        rating: 5,
        make: 'Old camera',
        lockedProperties: ['description', 'rating'],
      })
      .execute();
    await db
      .insertInto('asset_metadata')
      .values([
        { assetId, key: 'mobile-app', value: { owner: true } },
        {
          assetId,
          key: 'ml-enrichment',
          value: { description: { status: 'success', result: { description: 'Old pixels' } } },
        },
      ])
      .execute();
    const item = await f.repository.plan(f.authority, f.source.id, f.run.id, {
      ...f.itemInput,
      id: randomUUID(),
      version: 'e'.repeat(64),
      sha256: 'f'.repeat(64),
      bytes: 6,
    });
    const previous = { resourceId: f.item.id, version: f.item.version, sha256: 'd'.repeat(64) };
    const response = await f.publish({ ...f.input, previous }, f.run.id, item.id);
    expect(response.status).toBe(200);
    expect(response.body).toMatchObject({
      assetId,
      resourceId: item.id,
      version: item.version,
      sha256: 'f'.repeat(64),
      bytes: 6,
    });
    expect(
      await db
        .selectFrom('source_original')
        .select('resourceId')
        .where('assetId', '=', assetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ resourceId: item.id });
    expect(
      await db
        .selectFrom('photo_source_resource')
        .select(['version', 'assetId'])
        .where('id', '=', f.item.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ version: previous.version, assetId });
    expect(
      await db
        .selectFrom('asset')
        .select(['isFavorite', 'is_nsfw', 'isEdited', 'width', 'height'])
        .where('id', '=', assetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ isFavorite: true, is_nsfw: true, isEdited: false, width: null, height: null });
    expect(
      await db
        .selectFrom('asset_exif')
        .select(['description', 'rating', 'make'])
        .where('assetId', '=', assetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ description: 'Owner caption', rating: 5, make: null });
    expect(await db.selectFrom('asset_file').select('id').where('assetId', '=', assetId).execute()).toEqual([]);
    expect(
      await db
        .selectFrom('asset_metadata')
        .select('value')
        .where('assetId', '=', assetId)
        .where('key', '=', 'mobile-app')
        .executeTakeFirstOrThrow(),
    ).toEqual({ value: { owner: true } });
    expect(
      await db
        .selectFrom('asset_metadata')
        .select('value')
        .where('assetId', '=', assetId)
        .where('key', '=', 'ml-enrichment')
        .execute(),
    ).toEqual([]);
    expect(
      f.jobs.queueInTransaction.mock.calls.filter(([, job]) => job.name === JobName.AssetExtractMetadata),
    ).toHaveLength(2);
    expect(f.jobs.queueInTransaction).toHaveBeenCalledWith(expect.anything(), {
      name: JobName.FileDelete,
      data: { files: ['/synthetic/' + assetId + '.jpg'] },
    });
    // Committed retries return the desired current version without replaying invalidation or jobs.
    expect((await f.publish({ ...f.input, previous }, f.run.id, item.id)).status).toBe(200);
    expect(f.jobs.queueInTransaction).toHaveBeenCalledTimes(3);
  } finally {
    await f.http.close();
  }
});

it.each(['resourceId', 'version', 'sha256'] as const)(
  'refuses a stale previous %s without changing the source',
  async (field) => {
    const f = await setup();
    try {
      expect((await f.publish()).status).toBe(200);
      const item = await f.repository.plan(f.authority, f.source.id, f.run.id, {
        ...f.itemInput,
        id: randomUUID(),
        version: 'e'.repeat(64),
      });
      const previous = {
        resourceId: f.item.id,
        version: f.item.version,
        sha256: 'd'.repeat(64),
        [field]: field === 'resourceId' ? randomUUID() : 'f'.repeat(64),
      };
      expect((await f.publish({ ...f.input, previous }, f.run.id, item.id)).status).toBe(409);
      expect(
        await db
          .selectFrom('source_original')
          .select('resourceId')
          .where('assetId', '=', f.input.assetId)
          .executeTakeFirstOrThrow(),
      ).toEqual({ resourceId: f.item.id });
      expect(f.jobs.queueInTransaction).toHaveBeenCalledOnce();
    } finally {
      await f.http.close();
    }
  },
);

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

it('rolls back binding, current files, document history and queued deletions when admission fails', async () => {
  const f = await setup();
  try {
    expect((await f.publish()).status).toBe(200);
    const assetId = f.input.assetId;
    const path = '/synthetic/' + assetId + '.jpg';
    await db.insertInto('asset_file').values({ assetId, type: AssetFileType.Preview, path }).execute();
    const document = await new DocumentRepository(db).create({
      assetId,
      key: 'field:total',
      action: DocumentEditAction.Correct,
      value: 'Owner total',
      sourceText: 'Old total',
      editedById: f.user.id,
    });
    const item = await f.repository.plan(f.authority, f.source.id, f.run.id, {
      ...f.itemInput,
      id: randomUUID(),
      version: 'e'.repeat(64),
    });
    const admit = f.jobs.queueInTransaction.getMockImplementation()!;
    f.jobs.queueInTransaction.mockImplementationOnce(async (tx, job) => {
      await admit(tx, job);
      throw new Error('synthetic admission failure');
    });
    const response = await f.publish(
      { ...f.input, previous: { resourceId: f.item.id, version: f.item.version, sha256: 'd'.repeat(64) } },
      f.run.id,
      item.id,
    );
    expect(response.status).toBe(500);
    expect(
      await db
        .selectFrom('source_original')
        .select('resourceId')
        .where('assetId', '=', assetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ resourceId: f.item.id });
    expect(await new DocumentRepository(db).getEdits(assetId)).toEqual([document]);
    expect(await db.selectFrom('asset_file').select('path').where('assetId', '=', assetId).execute()).toEqual([
      { path },
    ]);
    expect(
      await db
        .selectFrom('photo_source_resource')
        .select(['state', 'assetId'])
        .where('id', '=', item.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ state: 'planned', assetId: null });
    expect(
      await db
        .selectFrom('job')
        .select('id')
        .where('name', '=', JobName.FileDelete)
        .where(sql<boolean>`data->'files' @> ${JSON.stringify([path])}::text::jsonb`)
        .execute(),
    ).toEqual([]);
  } finally {
    await f.http.close();
  }
});

it('admits only one of two replacements using the same previous resource', async () => {
  const f = await setup();
  try {
    expect((await f.publish()).status).toBe(200);
    const second = await f.repository.run(f.authority, f.source.id, { id: randomUUID(), maxItems: 2, maxBytes: 100 });
    const a = await f.repository.plan(f.authority, f.source.id, f.run.id, {
      ...f.itemInput,
      id: randomUUID(),
      version: 'e'.repeat(64),
    });
    const b = await f.repository.plan(f.authority, f.source.id, second.id, {
      ...f.itemInput,
      id: randomUUID(),
      version: 'f'.repeat(64),
    });
    const body = { ...f.input, previous: { resourceId: f.item.id, version: f.item.version, sha256: 'd'.repeat(64) } };
    const results = await Promise.all([f.publish(body, f.run.id, a.id), f.publish(body, second.id, b.id)]);
    expect(results.map((r) => r.status).sort((a, b) => a - b)).toEqual([200, 409]);
    expect(f.jobs.queueInTransaction).toHaveBeenCalledTimes(2);
  } finally {
    await f.http.close();
  }
});

it('rejects old verified-item replay and never revives its source grant when content returns in a fresh item', async () => {
  const f = await setup();
  try {
    expect((await f.publish()).status).toBe(200);
    const old = (await readAssetSource(db, f.input.assetId, false))!;
    const item = await f.repository.plan(f.authority, f.source.id, f.run.id, {
      ...f.itemInput,
      id: randomUUID(),
      version: 'e'.repeat(64),
    });
    expect(
      (
        await f.publish(
          { ...f.input, previous: { resourceId: f.item.id, version: f.item.version, sha256: 'd'.repeat(64) } },
          f.run.id,
          item.id,
        )
      ).status,
    ).toBe(200);
    const previous = { resourceId: item.id, version: item.version, sha256: 'd'.repeat(64) };
    expect((await f.publish({ ...f.input, previous })).status).toBe(409);
    const run = await f.repository.run(f.authority, f.source.id, { id: randomUUID(), maxItems: 2, maxBytes: 100 });
    const fresh = await f.repository.plan(f.authority, f.source.id, run.id, { ...f.itemInput, id: randomUUID() });
    const response = await f.publish({ ...f.input, previous }, run.id, fresh.id);
    expect(response.status).toBe(200);
    expect(response.body.resourceId).toBe(fresh.id);
    await expect(assertAssetSource(db, old)).rejects.toThrow('Asset inputs changed before publication');
  } finally {
    await f.http.close();
  }
});

it.each(['sha256', 'bytes'] as const)(
  'rejects inconsistent declarations of the same provider version: %s',
  async (field) => {
    const f = await setup();
    try {
      expect((await f.publish()).status).toBe(200);
      const run = await f.repository.run(f.authority, f.source.id, { id: randomUUID(), maxItems: 2, maxBytes: 100 });
      const item = await f.repository.plan(f.authority, f.source.id, run.id, {
        ...f.itemInput,
        id: randomUUID(),
        [field]: field === 'sha256' ? 'f'.repeat(64) : 6,
      });
      expect(
        (
          await f.publish(
            { ...f.input, previous: { resourceId: f.item.id, version: f.item.version, sha256: 'd'.repeat(64) } },
            run.id,
            item.id,
          )
        ).status,
      ).toBe(409);
      expect(f.jobs.queueInTransaction).toHaveBeenCalledOnce();
    } finally {
      await f.http.close();
    }
  },
);

it('retires generated analysis while preserving manual tags, captions, document, face and pet decisions', async () => {
  const f = await setup();
  try {
    expect((await f.publish()).status).toBe(200);
    const assetId = f.input.assetId;
    const { result: manual } = await f.ctx.newTag({ userId: f.user.id, value: 'Owner label' });
    const { result: generated } = await f.ctx.newTag({ userId: f.user.id, value: 'Generated label' });
    await f.ctx.newTagAsset({ tagIds: [manual.id, generated.id], assetIds: [assetId] });
    await db
      .insertInto('asset_exif')
      .values({
        assetId,
        description: 'Owner caption\n\nAI description: Old generated caption',
        rating: 5,
        lockedProperties: ['description', 'rating', 'tags'],
        tags: ['Owner label', 'Generated label'],
      })
      .execute();
    await db
      .insertInto('asset_metadata')
      .values({
        assetId,
        key: 'ml-enrichment',
        value: {
          description: {
            status: 'success',
            appliedDescriptionHash: 'fixture',
            appliedTagValues: ['Generated label'],
            result: { description: 'Old generated caption' },
          },
          nsfwDetection: { status: 'success', review: { isNsfw: false }, result: { isNsfw: false } },
        },
      })
      .execute();
    const document = await new DocumentRepository(db).create({
      assetId,
      key: 'field:total',
      action: DocumentEditAction.Correct,
      value: 'Owner total',
      sourceText: 'Old total',
      editedById: f.user.id,
    });
    const correctedAt = new Date();
    const { assetFace } = await f.ctx.newAssetFace({ assetId, sourceType: SourceType.Manual, correctedAt });
    await db.insertInto('face_search').values({ faceId: assetFace.id, embedding: newEmbedding() }).execute();
    const pet = await db
      .insertInto('pet')
      .values({ ownerId: f.user.id, species: PetSpecies.Cat, name: 'Owner cat' })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.insertInto('pet_observation').values({ petId: pet.id, assetId }).execute();
    await db.insertInto('pet_detection').values({ assetId, modelName: 'fixture', modelRevision: 'old' }).execute();
    await db.insertInto('asset_job_status').values({ assetId, ocrAt: new Date() }).execute();
    await db.insertInto('ocr_search').values({ assetId, text: 'Old recognized text' }).execute();
    await db
      .insertInto('smart_search')
      .values({ assetId, embedding: newEmbedding(768) })
      .execute();
    await db
      .insertInto('smart_search_description')
      .values({ assetId, embedding: newEmbedding(768) })
      .execute();
    const item = await f.repository.plan(f.authority, f.source.id, f.run.id, {
      ...f.itemInput,
      id: randomUUID(),
      version: 'e'.repeat(64),
    });
    expect(
      (
        await f.publish(
          { ...f.input, previous: { resourceId: f.item.id, version: f.item.version, sha256: 'd'.repeat(64) } },
          f.run.id,
          item.id,
        )
      ).status,
    ).toBe(200);
    expect(
      await db
        .selectFrom('asset_exif')
        .select(['description', 'rating', 'tags'])
        .where('assetId', '=', assetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ description: 'Owner caption', rating: 5, tags: ['Owner label'] });
    expect(await db.selectFrom('tag_asset').select('tagId').where('assetId', '=', assetId).execute()).toEqual([
      { tagId: manual.id },
    ]);
    expect(await new DocumentRepository(db).getEdits(assetId)).toEqual([]);
    expect(
      await db
        .selectFrom('asset_document_edit')
        .select(['value', 'sourceText'])
        .where('id', '=', document.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ value: document.value, sourceText: document.sourceText });
    expect(
      await db
        .selectFrom('asset_face')
        .select(['sourceType', 'correctedAt', 'deletedAt'])
        .where('id', '=', assetFace.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ sourceType: SourceType.Manual, correctedAt, deletedAt: expect.any(Date) });
    expect(
      await db
        .selectFrom('pet_observation')
        .select(['petId', 'staleAt'])
        .where('assetId', '=', assetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ petId: pet.id, staleAt: expect.any(Date) });
    for (const table of [
      'pet_detection',
      'asset_job_status',
      'ocr_search',
      'smart_search',
      'smart_search_description',
    ] as const)
      expect(await db.selectFrom(table).select('assetId').where('assetId', '=', assetId).execute()).toEqual([]);
    expect(await db.selectFrom('face_search').select('faceId').where('faceId', '=', assetFace.id).execute()).toEqual(
      [],
    );
    expect(
      await db
        .selectFrom('asset_metadata')
        .select('value')
        .where('assetId', '=', assetId)
        .where('key', 'like', 'ml-enrichment:source-version:%')
        .execute(),
    ).toHaveLength(1);
  } finally {
    await f.http.close();
  }
});

it('clears current restoration selection while retaining its independent output and history', async () => {
  const f = await setup();
  try {
    expect((await f.publish()).status).toBe(200);
    const assetId = f.input.assetId;
    const path = `/synthetic/${assetId}-restoration.jpeg`;
    const asset = await db.selectFrom('asset').select('checksum').where('id', '=', assetId).executeTakeFirstOrThrow();
    const restoration = await db
      .insertInto('asset_restoration')
      .values({
        assetId,
        ownerId: f.user.id,
        revision: 1,
        status: 'restored',
        mode: 'faithful',
        workload: 'restoration-faithful',
        destinationKind: 'local',
        destinationName: 'Local',
        sourceType: 'image',
        sourceChecksum: asset.checksum,
        sourceWidth: 32,
        sourceHeight: 32,
        previewRegion: {},
        resultPath: path,
        isCurrent: true,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db.insertInto('asset_file').values({ assetId, path, type: AssetFileType.Preview }).execute();
    const item = await f.repository.plan(f.authority, f.source.id, f.run.id, {
      ...f.itemInput,
      id: randomUUID(),
      version: 'e'.repeat(64),
    });
    expect(
      (
        await f.publish(
          { ...f.input, previous: { resourceId: f.item.id, version: f.item.version, sha256: 'd'.repeat(64) } },
          f.run.id,
          item.id,
        )
      ).status,
    ).toBe(200);
    expect(
      await db
        .selectFrom('asset_restoration')
        .select(['isCurrent', 'resultPath', 'status'])
        .where('id', '=', restoration.id)
        .executeTakeFirstOrThrow(),
    ).toEqual({ isCurrent: false, resultPath: path, status: 'restored' });
    const unlink = vi.fn();
    expect((await f.ctx.get(PhysicalFileRepository).deleteUnreferencedPath(path, unlink)).deleted).toBe(false);
    expect(unlink).not.toHaveBeenCalled();
  } finally {
    await f.http.close();
  }
});

it('replaces a video reference and retires dependent current key frames while keeping manual moments and saved render bytes', async () => {
  const f = await setup();
  try {
    const input = { ...f.input, type: AssetType.Video };
    expect((await f.publish(input)).status).toBe(200);
    const assetId = input.assetId;
    const framePath = `/synthetic/${assetId}-moment.jpeg`;
    await db
      .insertInto('video_moment_index')
      .values({ assetId, sourceFingerprint: 'old', extractorVersion: 'fixture', frameCount: 1, coverTimestampMs: 50 })
      .execute();
    const frame = await db
      .insertInto('video_moment_frame')
      .values({ assetId, frameIndex: 0, timestampMs: 50, path: framePath, score: 1, rank: 1 })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .insertInto('video_moment')
      .values([
        {
          assetId,
          timestampMs: 50,
          frameId: frame.id,
          source: VideoMomentSource.Manual,
          caption: 'Owner moment',
          transcript: 'Owner transcript',
          createdById: f.user.id,
        },
        {
          assetId,
          timestampMs: 50,
          frameId: frame.id,
          source: VideoMomentSource.Generated,
          caption: 'Generated caption',
        },
      ])
      .execute();
    const { asset: parent } = await f.ctx.newAsset({ ownerId: f.user.id, livePhotoVideoId: assetId });
    const develop = new AssetDevelopRepository(db);
    const recipe = { ...defaultDevelopRecipe(), keyFrame: { timeMs: 50 } };
    const saved = await develop.create({
      assetId: parent.id,
      ownerId: f.user.id,
      recipe,
      recipeVersion: 1,
      label: 'Owner key frame',
      status: AssetDevelopRevisionStatus.Saved,
      expectedSourceVersion: developSourceVersion(await develop.getSourceBinding(parent.id, f.user.id, recipe)),
    });
    await develop.setCurrent(parent.id, saved.id);
    const path = `/synthetic/${parent.id}-render.jpeg`;
    await sql`UPDATE asset_develop_revision SET "masterPath"=${path} WHERE id=${saved.id}::uuid`.execute(db);
    await db
      .insertInto('asset_file')
      .values({ assetId: parent.id, path, type: AssetFileType.Preview, isEdited: true })
      .execute();
    await db.updateTable('asset').set({ isEdited: true }).where('id', '=', parent.id).execute();
    const item = await f.repository.plan(f.authority, f.source.id, f.run.id, {
      ...f.itemInput,
      id: randomUUID(),
      version: 'e'.repeat(64),
    });
    expect(
      (
        await f.publish(
          { ...input, previous: { resourceId: f.item.id, version: f.item.version, sha256: 'd'.repeat(64) } },
          f.run.id,
          item.id,
        )
      ).status,
    ).toBe(200);
    expect(await develop.get(saved.id)).toMatchObject({ isCurrent: false, masterPath: path, recipe: saved.recipe });
    expect(
      await db
        .selectFrom('video_moment')
        .select(['source', 'frameId', 'caption', 'transcript'])
        .where('assetId', '=', assetId)
        .execute(),
    ).toEqual([
      { source: VideoMomentSource.Manual, frameId: null, caption: 'Owner moment', transcript: 'Owner transcript' },
    ]);
    expect(
      await db
        .selectFrom('video_moment_index')
        .select(['frameCount', 'coverTimestampMs'])
        .where('assetId', '=', assetId)
        .executeTakeFirstOrThrow(),
    ).toEqual({ frameCount: 0, coverTimestampMs: 50 });
    expect(await db.selectFrom('video_moment_frame').select('id').where('assetId', '=', assetId).execute()).toEqual([]);
    expect(f.jobs.queueInTransaction).toHaveBeenCalledWith(expect.anything(), {
      name: JobName.AssetGenerateThumbnails,
      data: { id: parent.id },
    });
    const unlink = vi.fn();
    expect((await f.ctx.get(PhysicalFileRepository).deleteUnreferencedPath(path, unlink)).deleted).toBe(false);
    expect(unlink).not.toHaveBeenCalled();
    expect(
      await db.selectFrom('asset_source_epoch').select('assetId').where('assetId', '=', assetId).execute(),
    ).toEqual([]);
  } finally {
    await f.http.close();
  }
});

it.skipIf(!process.env.FRAMELEAF_NATIVE_DESKTOP_ROOT)(
  'runs the actual native reference publisher over HTTPS through lost and foreign receipts without uploading originals',
  async () => {
    const desktop = process.env.FRAMELEAF_NATIVE_DESKTOP_ROOT!;
    const f = await setup();
    const root = await mkdtemp(join(await realpath(tmpdir()), 'frameleaf-native-reference-'));
    const metadata = new SystemMetadataRepository(db);
    const policies = new DesktopAssistancePolicyService(metadata);
    const http = await controllerSetup(
      [DesktopDeviceController, PhotoSourceController],
      [
        {
          provide: DesktopDeviceService,
          useValue: new DesktopDeviceService(new DesktopDeviceRepository(db), metadata, policies),
        },
        { provide: DesktopAssistancePolicyService, useValue: policies },
        { provide: DesktopWorkerAuthService, useValue: {} },
        { provide: PhotoSourceService, useValue: f.service },
      ],
    );
    http.authenticate.mockResolvedValue(f.auth);
    const publish = f.service.publishReference.bind(f.service);
    let attempts = 0;
    const replies = vi.spyOn(f.service, 'publishReference').mockImplementation(async (...args) => {
      const receipt = await publish(...args);
      attempts++;
      if (attempts === 1) throw new ServiceUnavailableException('Synthetic lost receipt');
      if (attempts === 2) return { ...receipt, ownerId: randomUUID() };
      return receipt;
    });
    const token = randomBytes(32).toString('base64url');
    const requests: { method: string | undefined; path: string }[] = [];
    const parse = json({ limit: '16kb' });
    const tls = createServer(
      {
        key: readFileSync('test/fixtures/frameleaf-relay/tun.key.pem'),
        cert: readFileSync('test/fixtures/frameleaf-relay/tun.cert.pem'),
      },
      (incoming, outgoing) => {
        if (!incoming.url?.startsWith('/api/') || incoming.headers.authorization !== `Bearer ${token}`) {
          outgoing.writeHead(401).end();
          return;
        }
        requests.push({ method: incoming.method, path: incoming.url });
        incoming.url = incoming.url.slice(4);
        parse(incoming, outgoing, (error) => {
          if (error) {
            outgoing.writeHead(error.status ?? 400).end();
            return;
          }
          http.getHttpServer().emit('request', incoming, outgoing);
        });
      },
    );
    let native: ChildProcess | undefined;
    let exit: Promise<number | null> | undefined;
    try {
      await new Promise<void>((resolve) => tls.listen(0, '127.0.0.1', resolve));
      const address = tls.address() as { port: number };
      const built = await promisify(execFile)(
        'cargo',
        [
          'test',
          '--manifest-path',
          'src-tauri/Cargo.toml',
          '--lib',
          '--offline',
          '--locked',
          '--no-run',
          '--message-format=json',
        ],
        { cwd: desktop, timeout: 300_000, maxBuffer: 8 * 1024 * 1024 },
      );
      const artifact = built.stdout
        .split('\n')
        .filter(Boolean)
        .map((line) => JSON.parse(line))
        .find(
          (item) =>
            item.reason === 'compiler-artifact' &&
            item.target.name === 'frameleaf_desktop' &&
            item.profile.test &&
            item.executable,
        );
      expect(artifact?.executable).toBeTruthy();
      native = spawn(
        artifact.executable,
        [
          'source_reads::native_reference_tests::actual_native_reference_publication',
          '--ignored',
          '--exact',
          '--nocapture',
        ],
        { cwd: desktop, stdio: ['pipe', 'pipe', 'pipe'] },
      );
      exit = new Promise((resolve) => {
        native!.once('exit', resolve);
        native!.once('error', () => resolve(-1));
      });
      let errors = '';
      native.stderr!.on('data', (bytes) => {
        errors = (errors + String(bytes)).slice(-8192);
      });
      const lines = createInterface({ input: native.stdout! })[Symbol.asyncIterator]();
      const message = async () => {
        for (;;) {
          let timer: NodeJS.Timeout | undefined;
          const next = await Promise.race([
            lines.next(),
            new Promise<never>((_, reject) => {
              timer = setTimeout(() => reject(new Error('Native reference fixture deadline')), 60_000);
            }),
          ]).finally(() => clearTimeout(timer));
          if (next.done) throw new Error('Native reference fixture stopped: ' + errors);
          if (next.value.startsWith('REFERENCE_PUBLICATION ')) return JSON.parse(next.value.slice(22));
        }
      };
      native.stdin!.write(
        JSON.stringify({
          server: `https://tun.eu1.relays.frameleaf.test:${address.port}`,
          accountId: f.user.id,
          token,
          caPem: readFileSync('test/fixtures/frameleaf-relay/ca.cert.pem', 'utf8'),
          root,
        }) + '\n',
      );
      const lost = await message();
      expect(lost.phase).toBe('lost-receipt');
      const first = await db
        .selectFrom('photo_source_resource as resource')
        .innerJoin('photo_source_run as run', 'run.id', 'resource.runId')
        .selectAll('resource')
        .where('run.sourceId', '=', lost.sourceId)
        .executeTakeFirstOrThrow();
      expect(first.state).toBe('verified');
      expect(first.assetId).toBeTruthy();
      native.stdin!.write(JSON.stringify({ command: 'resume' }) + '\n');
      expect((await message()).phase).toBe('foreign-receipt-refused');
      native.stdin!.write(JSON.stringify({ command: 'resume' }) + '\n');
      const done = await message();
      expect(done).toMatchObject({
        phase: 'complete',
        independentOriginalUnchanged: true,
        cacheRetained: true,
        readAndUploadAllowancesUnchanged: true,
        receipt: {
          sourceId: lost.sourceId,
          runId: first.runId,
          itemId: first.id,
          resourceId: first.id,
          assetId: first.assetId,
          ownerId: f.user.id,
          version: first.version,
          sha256: lost.sha256,
          bytes: lost.bytes,
          storage: 'reference',
        },
      });
      native.stdin!.end();
      let timer: NodeJS.Timeout | undefined;
      const code = await Promise.race([
        exit,
        new Promise<never>((_, reject) => {
          timer = setTimeout(() => reject(new Error('Native reference shutdown deadline')), 10_000);
        }),
      ]).finally(() => clearTimeout(timer));
      expect(code, errors).toBe(0);
      expect(attempts).toBe(4);
      expect(
        await db.selectFrom('photo_source_run').selectAll().where('sourceId', '=', lost.sourceId).execute(),
      ).toMatchObject([{ id: first.runId, state: 'complete' }]);
      expect(
        await db
          .selectFrom('photo_source_resource as resource')
          .innerJoin('photo_source_run as run', 'run.id', 'resource.runId')
          .select('resource.id')
          .where('run.sourceId', '=', lost.sourceId)
          .execute(),
      ).toEqual([{ id: first.id }]);
      expect(
        await db.selectFrom('asset_upload_resource').select('id').where('ownerId', '=', f.user.id).execute(),
      ).toHaveLength(0);
      expect(f.jobs.queueInTransaction).toHaveBeenCalledTimes(1);
      expect(requests.some(({ path }) => path.includes('?') || path.includes(token) || path.includes('/assets'))).toBe(
        false,
      );
    } finally {
      if (native && native.exitCode === null) {
        native.kill('SIGTERM');
        await Promise.race([exit, new Promise((resolve) => setTimeout(resolve, 5000))]);
        if (native.exitCode === null) {
          native.kill('SIGKILL');
          await exit;
        }
      }
      tls.closeAllConnections();
      await new Promise<void>((resolve) => tls.close(() => resolve()));
      replies.mockRestore();
      await http.close();
      await f.http.close();
      await rm(root, { recursive: true, force: true });
    }
  },
  360_000,
);
