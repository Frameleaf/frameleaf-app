import { Kysely, sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import request from 'supertest';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import type { DB } from 'src/schema/index.js';
import { ConnectEventController } from 'src/controllers/connect-event.controller.js';
import {
  AssetFileType,
  AssetLockReason,
  AssetStatus,
  AssetVisibility,
  MediaOperationDestination,
  StudioExportScope,
  StudioExportVersionState,
} from 'src/enum.js';
import { ConnectEventRepository } from 'src/repositories/connect-event.repository.js';
import { ConnectEventService } from 'src/services/connect-event.service.js';
import { canonicalTestContext } from 'test/fixtures/canonical-database.js';
import { factory } from 'test/small.factory.js';
import { controllerSetup, getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});
const fixture = async (allLibraryRead = true) => {
  const ctx = canonicalTestContext(db);
  const { user } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id });
  const client = await db
    .insertInto('oauth_client')
    .values({ name: 'Connect test', redirectUris: ['https://test.invalid/callback'] })
    .returningAll()
    .executeTakeFirstOrThrow();
  const policy = {
    version: 1 as const,
    readAlbumIds: [album.id],
    allLibraryRead,
    writableAlbumIds: [],
    writeWorkspaces: [],
  };
  const grant = await db
    .insertInto('oauth_grant')
    .values({
      userId: user.id,
      clientId: client.id,
      scopes: ['events:read', 'library:read'],
      resource: 'https://library.invalid/api/connect',
      accessPolicy: policy,
      policyRevision: 1,
      accessTokenHash: randomBytes(32),
      refreshTokenHash: randomBytes(32),
      accessExpiresAt: new Date(Date.now() + 86_400_000),
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const auth: AuthDto = {
    ...factory.auth({ user: { id: user.id } }),
    oauthApp: {
      grantId: grant.id,
      clientId: client.id,
      clientName: client.name,
      scopes: grant.scopes,
      resource: grant.resource,
      accessPolicy: policy,
      policyRevision: 1,
    },
  };
  return { ctx, user, album, grant, auth, repo: new ConnectEventRepository(db) };
};
const append = async (ownerId: string, assetId: string, count = 1) => {
  await sql`SELECT connect_event_append(${ownerId}::uuid,gen_random_uuid()::text,'asset.ready',${assetId}::uuid,NULL,NULL,NULL) FROM generate_series(1,${count})`.execute(
    db,
  );
};

it('initializes a resumable checkpoint even when the owner has no events', async () => {
  const f = await fixture();
  const initial = await f.repo.read(f.auth);
  expect(initial).toMatchObject({ items: [], hasMore: false, bounded: false });
  expect(initial.nextCursor).toMatch(/^[\w-]{43}$/);
  const empty = await f.repo.read(f.auth, { cursor: initial.nextCursor! });
  expect(empty.items).toEqual([]);
  const { asset } = await f.ctx.newAsset({ ownerId: f.user.id });
  await append(f.user.id, asset.id);
  const page = await f.repo.read(f.auth, { cursor: empty.nextCursor! });
  expect(page.items.map((e) => e.subject.id)).toEqual([asset.id]);
});

it('starts now without replaying history and samples independently from the checkpoint', async () => {
  const f = await fixture();
  const { asset } = await f.ctx.newAsset({ ownerId: f.user.id });
  await append(f.user.id, asset.id);
  const initial = await f.repo.read(f.auth, { start: 'now' });
  expect(initial.items).toEqual([]);
  expect((await f.repo.sample(f.auth)).items).toHaveLength(1);
  expect((await f.repo.read(f.auth, { cursor: initial.nextCursor! })).items).toEqual([]);
  await append(f.user.id, asset.id);
  const first = await f.repo.read(f.auth, { cursor: initial.nextCursor! });
  const retry = await f.repo.read(f.auth, { cursor: initial.nextCursor! });
  expect(first.items).toHaveLength(1);
  expect(first.items).toEqual(retry.items);
});

it('filters before page limits and drains across inaccessible rows without disclosing counts', async () => {
  const f = await fixture(false);
  const initial = await f.repo.read(f.auth, { type: 'asset.ready' });
  const visible: string[] = [];
  for (let i = 0; i < 5; i++) {
    const { asset } = await f.ctx.newAsset({ ownerId: f.user.id });
    if (i % 2 === 0) {
      await f.ctx.newAlbumAsset({ albumId: f.album.id, assetId: asset.id });
      visible.push(asset.id);
    }
    await append(f.user.id, asset.id);
  }
  const first = await f.repo.read(f.auth, { cursor: initial.nextCursor!, limit: 2 });
  expect(first.items.map((e) => e.subject.id)).toEqual(visible.slice(0, 2));
  expect(first.hasMore).toBe(true);
  const last = await f.repo.read(f.auth, { cursor: first.nextCursor!, limit: 2 });
  expect(last.items.map((e) => e.subject.id)).toEqual(visible.slice(2));
  expect(last.hasMore).toBe(false);
  expect(Object.keys(last).sort()).toEqual(['bounded', 'hasMore', 'items', 'nextCursor']);
});

it.each(['locked', 'hidden', 'trashed', 'removed', 'owner-changed'] as const)(
  'rechecks %s assets before each fetch',
  async (change) => {
    const f = await fixture(false);
    const initial = await f.repo.read(f.auth);
    const { asset } = await f.ctx.newAsset({ ownerId: f.user.id });
    await f.ctx.newAlbumAsset({ albumId: f.album.id, assetId: asset.id });
    await append(f.user.id, asset.id);
    switch (change) {
      case 'locked': {
        await db
          .insertInto('asset_lock')
          .values({ assetId: asset.id, reason: AssetLockReason.Marked, lockedBy: f.user.id })
          .execute();
        break;
      }
      case 'hidden': {
        await db.updateTable('asset').set({ visibility: AssetVisibility.Hidden }).where('id', '=', asset.id).execute();
        break;
      }
      case 'trashed': {
        await db
          .updateTable('asset')
          .set({ status: AssetStatus.Trashed, deletedAt: new Date() })
          .where('id', '=', asset.id)
          .execute();
        break;
      }
      case 'removed': {
        await db.deleteFrom('album_asset').where('assetId', '=', asset.id).execute();
        break;
      }
      case 'owner-changed': {
        const { user } = await f.ctx.newUser();
        await db.updateTable('asset').set({ ownerId: user.id }).where('id', '=', asset.id).execute();

        break;
      }
      // No default
    }
    expect((await f.repo.read(f.auth, { cursor: initial.nextCursor! })).items).toEqual([]);
  },
);

it('does not expose historical album details after removal even under whole-library read', async () => {
  const f = await fixture();
  const initial = await f.repo.read(f.auth, { type: 'album.asset.added' });
  const { asset } = await f.ctx.newAsset({ ownerId: f.user.id });
  await f.ctx.newAlbumAsset({ albumId: f.album.id, assetId: asset.id });
  expect((await f.repo.read(f.auth, { cursor: initial.nextCursor! })).items[0].detail).toEqual({ albumId: f.album.id });
  await db.deleteFrom('album_asset').where('assetId', '=', asset.id).execute();
  expect((await f.repo.read(f.auth, { cursor: initial.nextCursor! })).items).toEqual([]);
});

it('refuses another owner, grant, policy, scope, mode, filter or tampered cursor', async () => {
  const f = await fixture();
  const first = await f.repo.read(f.auth, { type: 'asset.ready', albumId: f.album.id });
  const cursor = first.nextCursor!;
  await expect(f.repo.read(f.auth, { cursor: cursor + 'x' })).rejects.toMatchObject({ status: 410 });
  await expect(f.repo.read(f.auth, { cursor, type: 'album.asset.added' })).rejects.toMatchObject({ status: 410 });
  await expect(f.repo.read(f.auth, { cursor, albumId: factory.uuid() })).rejects.toMatchObject({ status: 410 });
  await expect(f.repo.read(f.auth, { cursor }, 'latest')).rejects.toMatchObject({ status: 410 });
  const other = await fixture();
  await expect(f.repo.read(other.auth, { cursor })).rejects.toMatchObject({ status: 410 });
  const grant = await db
    .insertInto('oauth_grant')
    .values({
      userId: f.user.id,
      clientId: f.grant.clientId,
      scopes: f.grant.scopes,
      resource: f.grant.resource,
      accessPolicy: f.grant.accessPolicy,
      policyRevision: 1,
      accessTokenHash: randomBytes(32),
      refreshTokenHash: randomBytes(32),
      accessExpiresAt: f.grant.accessExpiresAt,
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  await expect(
    f.repo.read({ ...f.auth, oauthApp: { ...f.auth.oauthApp!, grantId: grant.id } }, { cursor }),
  ).rejects.toMatchObject({ status: 410 });
  await db
    .updateTable('oauth_grant')
    .set({ scopes: ['events:read'] })
    .where('id', '=', f.grant.id)
    .execute();
  await expect(f.repo.read(f.auth, { cursor })).rejects.toMatchObject({ status: 410 });
  await db
    .updateTable('oauth_grant')
    .set({ scopes: f.grant.scopes, policyRevision: 2 })
    .where('id', '=', f.grant.id)
    .execute();
  await expect(f.repo.read(f.auth, { cursor })).rejects.toMatchObject({ status: 410 });
});

it('refuses expired cursors and revoked live grants', async () => {
  const f = await fixture();
  const initial = await f.repo.read(f.auth);
  await sql`UPDATE connect_event_cursor SET "expiresAt"=now()-interval '1 second' WHERE "grantId"=${f.grant.id}::uuid`.execute(
    db,
  );
  await expect(f.repo.read(f.auth, { cursor: initial.nextCursor! })).rejects.toMatchObject({ status: 410 });
  await db.updateTable('oauth_grant').set({ revokedAt: new Date() }).where('id', '=', f.grant.id).execute();
  await expect(f.repo.read(f.auth)).rejects.toMatchObject({ status: 401 });
});

it('returns at most the newest1000 across exactly10pages and excludes later arrivals from that snapshot', async () => {
  const f = await fixture();
  const { asset } = await f.ctx.newAsset({ ownerId: f.user.id });
  await append(f.user.id, asset.id, 1005);
  let page = await f.repo.read(f.auth, {}, 'latest');
  const ids = page.items.map((e) => e.deliveryId);
  expect(page.items).toHaveLength(100);
  await append(f.user.id, asset.id, 3);
  for (let i = 1; i < 10; i++) {
    expect(page.hasMore).toBe(true);
    page = await f.repo.read(f.auth, { cursor: page.nextCursor! }, 'latest');
    ids.push(...page.items.map((e) => e.deliveryId));
  }
  expect(page).toMatchObject({ hasMore: false, nextCursor: null, bounded: true });
  expect(new Set(ids).size).toBe(1000);
  const expected = await sql<{
    deliveryId: string;
  }>`SELECT "deliveryId" FROM connect_event WHERE "ownerId"=${f.user.id}::uuid AND position<=1005 ORDER BY position DESC LIMIT 1000`.execute(
    db,
  );
  expect(ids).toEqual(expected.rows.map((r) => r.deliveryId));
});

it('expires overtaken checkpoints before and after retention cleanup', async () => {
  const f = await fixture();
  const initial = await f.repo.read(f.auth);
  const { asset } = await f.ctx.newAsset({ ownerId: f.user.id });
  await append(f.user.id, asset.id);
  await sql`UPDATE connect_event SET "occurredAt"=now()-interval '31 days' WHERE "ownerId"=${f.user.id}::uuid`.execute(
    db,
  );
  await expect(f.repo.read(f.auth, { cursor: initial.nextCursor! })).rejects.toMatchObject({ status: 410 });
  await new ConnectEventService(f.repo).onNightlyDatabaseCleanup();
  expect((await sql`SELECT 1 FROM connect_event WHERE "ownerId"=${f.user.id}::uuid`.execute(db)).rows).toEqual([]);
  await expect(f.repo.read(f.auth, { cursor: initial.nextCursor! })).rejects.toMatchObject({ status: 410 });
  expect((await f.repo.read(f.auth)).items).toEqual([]);
});

it('serves the actual authenticated routes with bounded queries and no-store responses', async () => {
  const f = await fixture();
  const http = await controllerSetup(ConnectEventController, [
    ConnectEventService,
    { provide: ConnectEventRepository, useValue: f.repo },
  ]);
  try {
    http.authenticate.mockResolvedValue(f.auth);
    const result = await request(http.getHttpServer()).get('/connect/events?start=now');
    expect(result.status).toBe(200);
    expect(result.headers['cache-control']).toBe('no-store');
    expect(result.body.nextCursor).toMatch(/^[\w-]{43}$/);
    for (const query of [
      'limit=101',
      'limit=0',
      'type=cloud.backup.failed',
      'albumId=invalid',
      'start=all',
      'cursor=abc&start=now',
    ]) {
      expect((await request(http.getHttpServer()).get('/connect/events?' + query)).status).toBe(400);
    }
    expect((await request(http.getHttpServer()).get('/connect/events?cursor=invalid')).status).toBe(410);
    expect((await request(http.getHttpServer()).get('/connect/events/latest')).body).toMatchObject({
      bounded: true,
      items: [],
    });
    expect((await request(http.getHttpServer()).get('/connect/events/sample')).body).toEqual({ items: [] });
    await db
      .updateTable('oauth_grant')
      .set({ scopes: ['library:read'] })
      .where('id', '=', f.grant.id)
      .execute();
    expect((await request(http.getHttpServer()).get('/connect/events')).status).toBe(403);
  } finally {
    await http.close();
  }
});

it('keeps commit order across an in-flight producer and initializes before its eventual commit', async () => {
  const f = await fixture();
  const { asset } = await f.ctx.newAsset({ ownerId: f.user.id });
  const arrived = Promise.withResolvers<void>();
  const hold = Promise.withResolvers<void>();
  const producer = db.transaction().execute(async (tx) => {
    await sql`SELECT connect_event_append(${f.user.id}::uuid,'pending','asset.ready',${asset.id}::uuid,NULL,NULL,NULL)`.execute(
      tx,
    );
    arrived.resolve();
    await hold.promise;
  });
  await arrived.promise;
  try {
    const initial = await f.repo.read(f.auth);
    const next = append(f.user.id, asset.id);
    hold.resolve();
    await producer;
    await next;
    const page = await f.repo.read(f.auth, { cursor: initial.nextCursor! });
    expect(page.items).toHaveLength(2);
    expect(new Set(page.items.map((e) => e.deliveryId)).size).toBe(2);
  } finally {
    hold.resolve();
    await producer;
  }
});

it('never delegates read access through shared selected albums or another owner’s asset', async () => {
  const f = await fixture(false);
  const other = await fixture(false);
  const { asset } = await f.ctx.newAsset({ ownerId: f.user.id });
  await f.ctx.newAlbumUser({ albumId: other.album.id, userId: f.user.id });
  await f.ctx.newAlbumAsset({ albumId: other.album.id, assetId: asset.id });
  await db
    .updateTable('oauth_grant')
    .set({ accessPolicy: { ...f.grant.accessPolicy!, readAlbumIds: [other.album.id] } })
    .where('id', '=', f.grant.id)
    .execute();
  await append(f.user.id, asset.id);
  expect((await f.repo.sample(f.auth)).items).toEqual([]);
  const foreign = await f.ctx.newAsset({ ownerId: other.user.id });
  await f.ctx.newAlbumAsset({ albumId: f.album.id, assetId: foreign.asset.id });
  await append(other.user.id, foreign.asset.id);
  await db
    .updateTable('oauth_grant')
    .set({ accessPolicy: f.grant.accessPolicy })
    .where('id', '=', f.grant.id)
    .execute();
  expect((await f.repo.sample(f.auth)).items).toEqual([]);
});

it('rechecks Studio source privacy without requiring source membership in the output album', async () => {
  const f = await fixture(false);
  const { asset: source } = await f.ctx.newAsset({ ownerId: f.user.id });
  const { asset: output } = await f.ctx.newAsset({ ownerId: f.user.id });
  await f.ctx.newAlbumAsset({ albumId: f.album.id, assetId: output.id });
  const version = await db
    .insertInto('studio_export_version')
    .values({
      ownerId: f.user.id,
      projectId: null,
      revision: 1,
      revisionDigest: 'privacy',
      destination: MediaOperationDestination.Local,
      settings: { format: 'sdr-jpeg' },
      outputContentType: 'image/jpeg',
      state: StudioExportVersionState.Staged,
    })
    .returning('id')
    .executeTakeFirstOrThrow();
  await db
    .insertInto('studio_export_version_source')
    .values({
      versionId: version.id,
      key: 'source',
      kind: 'library',
      resourceId: source.id,
      assetId: source.id,
      ownerId: f.user.id,
      sourceAccess: 'owner',
    })
    .execute();
  await db
    .updateTable('studio_export_version')
    .set({
      state: StudioExportVersionState.Published,
      scope: StudioExportScope.Library,
      resultAssetId: output.id,
      publishedAt: new Date(),
    })
    .where('id', '=', version.id)
    .execute();
  const sample = await f.repo.sample(f.auth, { type: 'studio.export.completed' });
  expect(sample.items.map((e) => e.subject.id)).toEqual([output.id]);
  expect(sample.items[0].detail).toEqual({ format: 'image/jpeg' });
  await db.updateTable('asset').set({ visibility: AssetVisibility.Hidden }).where('id', '=', source.id).execute();
  expect((await f.repo.sample(f.auth, { type: 'studio.export.completed' })).items).toEqual([]);
});

it('retains first-ready identity after event cleanup and deletes expired cursor records', async () => {
  const f = await fixture();
  const { asset } = await f.ctx.newAsset({ ownerId: f.user.id });
  await db.insertInto('asset_job_status').values({ assetId: asset.id, metadataExtractedAt: new Date() }).execute();
  await db
    .insertInto('asset_file')
    .values(
      [AssetFileType.Preview, AssetFileType.Thumbnail].map((type) => ({
        assetId: asset.id,
        type,
        path: '/sanitized/fixture',
      })),
    )
    .execute();
  expect((await f.repo.sample(f.auth)).items).toHaveLength(1);
  const cursor = (await f.repo.read(f.auth)).nextCursor!;
  await sql`UPDATE connect_event SET "occurredAt"=now()-interval '31 days' WHERE "ownerId"=${f.user.id}::uuid`.execute(
    db,
  );
  await sql`UPDATE connect_event_cursor SET "expiresAt"=now()-interval '1 second' WHERE "grantId"=${f.grant.id}::uuid`.execute(
    db,
  );
  await new ConnectEventService(f.repo).onNightlyDatabaseCleanup();
  await db.updateTable('asset_file').set({ path: '/sanitized/retry' }).where('assetId', '=', asset.id).execute();
  expect((await f.repo.sample(f.auth)).items).toEqual([]);
  expect(await db.selectFrom('connect_event_cursor').selectAll().where('grantId', '=', f.grant.id).execute()).toEqual(
    [],
  );
  await expect(f.repo.read(f.auth, { cursor })).rejects.toMatchObject({ status: 410 });
});

it('keeps the newest1000 window usable while unrelated older events expire', async () => {
  const f = await fixture();
  const { asset } = await f.ctx.newAsset({ ownerId: f.user.id });
  await append(f.user.id, asset.id, 1005);
  await sql`UPDATE connect_event SET "occurredAt"=now()-interval '31 days' WHERE "ownerId"=${f.user.id}::uuid AND position=1`.execute(
    db,
  );
  const first = await f.repo.read(f.auth, {}, 'latest');
  expect(first.items).toHaveLength(100);
  await sql`UPDATE connect_event SET "occurredAt"=now()-interval '31 days' WHERE "ownerId"=${f.user.id}::uuid AND position=2`.execute(
    db,
  );
  await f.repo.cleanup();
  const second = await f.repo.read(f.auth, { cursor: first.nextCursor! }, 'latest');
  expect(second.items).toHaveLength(100);
  expect(second.hasMore).toBe(true);
});

it('expires a newest-first cursor when its own bounded window is pruned', async () => {
  const f = await fixture();
  const { asset } = await f.ctx.newAsset({ ownerId: f.user.id });
  await append(f.user.id, asset.id, 1005);
  const first = await f.repo.read(f.auth, {}, 'latest');
  await sql`UPDATE connect_event SET "occurredAt"=now()-interval '31 days' WHERE "ownerId"=${f.user.id}::uuid AND position<=6`.execute(
    db,
  );
  await f.repo.cleanup();
  await expect(f.repo.read(f.auth, { cursor: first.nextCursor! }, 'latest')).rejects.toMatchObject({ status: 410 });
});
