import { Kysely, sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { Readable } from 'node:stream';
import type { DB } from 'src/schema/index.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetStatus, ChecksumAlgorithm } from 'src/enum.js';
import { publicationTransaction } from 'src/queue/transaction.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoSourceRepository } from 'src/repositories/photo-source.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SourceResourceCacheRepository } from 'src/repositories/source-resource-cache.repository.js';
import { SourceResourceReadRepository } from 'src/repositories/source-resource-read.repository.js';
import { SourceResourceRepository } from 'src/repositories/source-resource.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { SourceOriginalService } from 'src/services/source-original.service.js';
import { SourceResourceDeliveryService } from 'src/services/source-resource-delivery.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let cacheFolder: string;
beforeAll(async () => {
  db = await getKyselyDB();
  cacheFolder = await mkdtemp(join(tmpdir(), 'source-publication-budget-'));
});
afterAll(async () => {
  await db?.destroy();
  await rm(cacheFolder, { recursive: true, force: true });
});
const fixture = async () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  const { user } = await ctx.newUser();
  const session = await new SessionRepository(db).create({ userId: user.id, token: randomBytes(32) });
  const device = (await new DesktopDeviceRepository(db).enroll({
    userId: user.id,
    installationId: randomUUID(),
    publicKey: randomBytes(32).toString('base64'),
    name: 'Source fixture',
    platform: 'linux',
    architecture: 'x86_64',
    mode: 'client-worker',
    state: 'awaiting-approval',
  }))!;
  const sources = new PhotoSourceRepository(db);
  const authority = { ownerId: user.id, sessionId: session.id };
  const source = await sources.create(authority, {
    id: randomUUID(),
    deviceId: device.id,
    kind: 'folder',
    mode: 'copy',
    name: 'Fixture',
    scopeFingerprint: 'a'.repeat(64),
  });
  const run = await sources.run(authority, source.id, { id: randomUUID(), maxBytes: 100, maxItems: 2 });
  const resource = await sources.plan(authority, source.id, run.id, {
    id: randomUUID(),
    resourceKey: 'b'.repeat(64),
    version: 'c'.repeat(64),
    sha256: createHash('sha256').update('hello').digest('hex'),
    bytes: 5,
  });
  const library = await new LibraryRepository(db).create({
    ownerId: user.id,
    name: 'Computer fixture',
    readOnly: true,
    importPaths: [],
    exclusionPatterns: [],
  });
  const originalPath = `frameleaf-source://${source.id}/${resource.resourceKey}`;
  const { asset } = await ctx.newAsset({
    ownerId: user.id,
    libraryId: library.id,
    isExternal: true,
    originalPath,
    checksumAlgorithm: ChecksumAlgorithm.sha1Path,
    checksum: createHash('sha1').update(`path:${originalPath}`).digest(),
  });
  await db
    .updateTable('photo_source_resource')
    .set({ assetId: asset.id, state: 'verified', verifiedAt: new Date() })
    .where('id', '=', resource.id)
    .execute();
  // The registration gate remains closed; seed the approved reference binding explicitly.
  await sql`UPDATE photo_source SET mode='reference' WHERE id=${source.id}::uuid`.execute(db);
  await db
    .insertInto('source_original')
    .values({
      assetId: asset.id,
      resourceId: resource.id,
      scopeFingerprint: source.scopeFingerprint,
      authorizationEpoch: device.authorizationEpoch,
    })
    .execute();
  const grants = new SourceResourceRepository(db);
  const grant = (await grants.issue({
    ownerId: user.id,
    photoSessionId: session.id,
    authorizationEpoch: device.authorizationEpoch,
    publicKey: device.publicKey,
    tokenHash: randomBytes(32),
    request: {
      sourceId: source.id,
      deviceId: device.id,
      scopeFingerprint: source.scopeFingerprint,
      requestId: randomUUID(),
      timestamp: Date.now(),
      signature: Buffer.alloc(64).toString('base64'),
    },
  }))!;
  return {
    ctx,
    user,
    session,
    source,
    resource,
    asset,
    device,
    library,
    grant,
    sut: new SourceResourceReadRepository(db, grants, new SourceResourceCacheRepository(db)),
  };
};

it('refuses an ordinary original read for a trashed asset with no deletion timestamp', async () => {
  const f = await fixture();
  await db
    .updateTable('asset')
    .set({ status: AssetStatus.Trashed, deletedAt: null })
    .where('id', '=', f.asset.id)
    .execute();
  expect(await f.sut.enqueue(f.asset.id)).toBeUndefined();
});

it('coalesces only a live approved original and never treats an arbitrary asset path as a source request', async () => {
  const f = await fixture();
  const requests = await Promise.all([f.sut.enqueue(f.asset.id), f.sut.enqueue(f.asset.id)]);
  expect(requests[0]?.id).toBeTruthy();
  expect(requests[0]?.id).toBe(requests[1]?.id);
  expect(
    await db.selectFrom('source_resource_read').select('id').where('assetId', '=', f.asset.id).execute(),
  ).toHaveLength(1);
  await db.updateTable('asset').set({ originalPath: '/private/unapproved.jpg' }).where('id', '=', f.asset.id).execute();
  expect(await f.sut.enqueue(f.asset.id)).toBeUndefined();
});

it('fences concurrent and expired claims, bounds renewal and requires the exact source grant', async () => {
  const f = await fixture();
  const other = await fixture();
  const request = (await f.sut.enqueue(f.asset.id))!;
  const token = randomBytes(32);
  expect(await f.sut.claim(other.grant, token, 100)).toBeUndefined();
  const claims = await Promise.all([f.sut.claim(f.grant, token, 100), f.sut.claim(f.grant, randomBytes(32), 100)]);
  const claim = claims.find(Boolean)!;
  expect(claims.filter(Boolean)).toHaveLength(1);
  expect(claim).toMatchObject({
    id: request.id,
    resourceKey: f.resource.resourceKey,
    version: f.resource.version,
    bytes: 5,
  });
  expect(claim).not.toHaveProperty('originalPath');
  await sql`UPDATE source_resource_read SET "leaseUntil"=clock_timestamp()-interval '1 second' WHERE id=${request.id}::uuid`.execute(
    db,
  );
  const nextToken = randomBytes(32);
  const next = (await f.sut.claim(f.grant, nextToken, 100))!;
  expect(next.claimFence).toBe(claim.claimFence + 1);
  expect(await f.sut.heartbeat(f.grant, claim.id, claim.claimFence, token)).toBeUndefined();
  const renewed = (await f.sut.heartbeat(f.grant, next.id, next.claimFence, nextToken))!;
  expect(renewed.leaseUntil.getTime()).toBeLessThanOrEqual(renewed.deadline.getTime());
});

it('refuses delivery after authority or the current resource binding changes, while an inventory gap preserves it', async () => {
  const f = await fixture();
  const request = (await f.sut.enqueue(f.asset.id))!;
  const token = randomBytes(32);
  const claim = (await f.sut.claim(f.grant, token, 100))!;
  // A partial inventory is not a withdrawal of a previously approved resource.
  expect((await f.sut.beginDelivery(f.grant, request.id, claim.claimFence, token))?.version).toBe(f.resource.version);
  await db.updateTable('desktop_device').set({ state: 'paused' }).where('id', '=', f.device.id).execute();
  expect(await f.sut.heartbeat(f.grant, request.id, claim.claimFence, token)).toBeUndefined();
  const changed = await fixture();
  const pending = (await changed.sut.enqueue(changed.asset.id))!;
  const lease = (await changed.sut.claim(changed.grant, token, 100))!;
  await db.deleteFrom('source_original').where('assetId', '=', changed.asset.id).execute();
  expect(await changed.sut.beginDelivery(changed.grant, pending.id, lease.claimFence, token)).toBeUndefined();
});

it('does not admit an original larger than capacity and retains deleted-asset provenance', async () => {
  const f = await fixture();
  await f.sut.enqueue(f.asset.id);
  expect(await f.sut.claim(f.grant, randomBytes(32), 4)).toBeUndefined();
  expect(await f.sut.claim(f.grant, randomBytes(31), 100)).toBeUndefined();
  await db.deleteFrom('asset').where('id', '=', f.asset.id).execute();
  expect(await db.selectFrom('source_original').selectAll().where('assetId', '=', f.asset.id).execute()).toEqual([]);
  expect(await db.selectFrom('source_resource_read').selectAll().where('assetId', '=', f.asset.id).execute()).toEqual(
    [],
  );
  expect(
    (await db.selectFrom('photo_source_resource').select('assetId').where('id', '=', f.resource.id).executeTakeFirst())
      ?.assetId,
  ).toBe(f.asset.id);
});

it.each([
  'asset-owner',
  'library-owner',
  'library-writable',
  'scope',
  'epoch',
  'deleted',
  'copy-mode',
  'revoked',
  'session-expired',
])('refuses queued reads after %s changes', async (change) => {
  const f = await fixture();
  await f.sut.enqueue(f.asset.id);
  switch (change) {
    case 'asset-owner': {
      const { user } = await f.ctx.newUser();
      await db.updateTable('asset').set({ ownerId: user.id }).where('id', '=', f.asset.id).execute();
      break;
    }
    case 'library-owner': {
      const { user } = await f.ctx.newUser();
      await db.updateTable('library').set({ ownerId: user.id }).where('id', '=', f.library.id).execute();
      break;
    }
    case 'library-writable': {
      await db.updateTable('library').set({ readOnly: false }).where('id', '=', f.library.id).execute();
      break;
    }
    case 'scope': {
      await db
        .updateTable('photo_source')
        .set({ scopeFingerprint: 'f'.repeat(64) })
        .where('id', '=', f.source.id)
        .execute();
      break;
    }
    case 'epoch': {
      await db
        .updateTable('desktop_device')
        .set({ authorizationEpoch: f.device.authorizationEpoch + 1 })
        .where('id', '=', f.device.id)
        .execute();
      break;
    }
    case 'deleted': {
      await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', f.asset.id).execute();
      break;
    }
    case 'copy-mode': {
      await sql`UPDATE photo_source SET mode='copy' WHERE id=${f.source.id}::uuid`.execute(db);
      break;
    }
    case 'revoked': {
      await db.updateTable('photo_source').set({ revokedAt: new Date() }).where('id', '=', f.source.id).execute();
      break;
    }
    case 'session-expired': {
      await db
        .updateTable('session')
        .set({ expiresAt: new Date(0) })
        .where('id', '=', f.session.id)
        .execute();
      break;
    }
  }
  expect(await f.sut.enqueue(f.asset.id)).toBeUndefined();
  expect(await f.sut.claim(f.grant, randomBytes(32), 100)).toBeUndefined();
});

it('rejects stale tokens, duplicate delivery admission and rotated credentials', async () => {
  const f = await fixture();
  await f.sut.enqueue(f.asset.id);
  const token = randomBytes(32);
  const claim = (await f.sut.claim(f.grant, token, 100))!;
  expect(await f.sut.heartbeat(f.grant, claim.id, claim.claimFence, randomBytes(32))).toBeUndefined();
  const deliveries = await Promise.all([
    f.sut.beginDelivery(f.grant, claim.id, claim.claimFence, token),
    f.sut.beginDelivery(f.grant, claim.id, claim.claimFence, token),
  ]);
  expect(deliveries.filter(Boolean)).toHaveLength(1);
  const rotatedHash = randomBytes(32);
  await db
    .updateTable('source_resource_grant')
    .set({ tokenHash: rotatedHash })
    .where('id', '=', f.grant.grantId)
    .execute();
  expect(await f.sut.heartbeat(f.grant, claim.id, claim.claimFence, token)).toBeUndefined();
  expect(
    await f.sut.heartbeat({ ...f.grant, credentialHash: rotatedHash }, claim.id, claim.claimFence, token),
  ).toBeUndefined();
});

it.each(['scope', 'epoch'])('invalidates an admitted delivery when %s approval changes', async (change) => {
  const f = await fixture();
  await f.sut.enqueue(f.asset.id);
  const token = randomBytes(32);
  const claim = (await f.sut.claim(f.grant, token, 100))!;
  expect(await f.sut.beginDelivery(f.grant, claim.id, claim.claimFence, token)).toBeDefined();
  if (change === 'scope') {
    await db
      .updateTable('photo_source')
      .set({ scopeFingerprint: 'f'.repeat(64) })
      .where('id', '=', f.source.id)
      .execute();
  } else {
    await db
      .updateTable('desktop_device')
      .set({ authorizationEpoch: f.device.authorizationEpoch + 1 })
      .where('id', '=', f.device.id)
      .execute();
  }
  expect(await f.sut.heartbeat(f.grant, claim.id, claim.claimFence, token)).toBeUndefined();
  expect(await f.sut.enqueue(f.asset.id)).toBeUndefined();
});

it('expires abandoned requests and never renews or admits a delivery after its deadline', async () => {
  const f = await fixture();
  const first = (await f.sut.enqueue(f.asset.id))!;
  const token = randomBytes(32);
  const claim = (await f.sut.claim(f.grant, token, 100))!;
  await sql`UPDATE source_resource_read SET deadline=clock_timestamp()-interval '1 second' WHERE id=${first.id}::uuid`.execute(
    db,
  );
  expect(await f.sut.heartbeat(f.grant, claim.id, claim.claimFence, token)).toBeUndefined();
  expect(await f.sut.beginDelivery(f.grant, claim.id, claim.claimFence, token)).toBeUndefined();
  const next = (await f.sut.enqueue(f.asset.id))!;
  expect(next.id).not.toBe(first.id);
  expect(
    (await db.selectFrom('source_resource_read').select('state').where('id', '=', first.id).executeTakeFirst())?.state,
  ).toBe('unavailable');
});

it.each(['heartbeat', 'beginDelivery', 'claim'] as const)(
  'rechecks expiry after %s waits for the original lock',
  async (action) => {
    const f = await fixture();
    const request = (await f.sut.enqueue(f.asset.id))!;
    const token = randomBytes(32);
    const claim = action === 'claim' ? undefined : (await f.sut.claim(f.grant, token, 100))!;
    const locked = Promise.withResolvers<void>();
    const release = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await tx.selectFrom('asset').select('id').where('id', '=', f.asset.id).forUpdate().execute();
      locked.resolve();
      await release.promise;
    });
    await locked.promise;
    const pending =
      action === 'claim'
        ? f.sut.claim(f.grant, token, 100)
        : f.sut[action](f.grant, claim!.id, claim!.claimFence, token);
    try {
      const limit = Date.now() + 5000;
      for (;;) {
        const { rows } = await sql<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%FROM asset a JOIN source_original%'
      ) AS waiting`.execute(db);
        if (rows[0].waiting) break;
        if (Date.now() >= limit) throw new Error('Source request did not reach the blocked original lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await db
        .updateTable('source_resource_read')
        .set(
          action === 'claim'
            ? { deadline: sql`clock_timestamp()-interval '1 second'` }
            : { leaseUntil: sql`clock_timestamp()-interval '1 second'` },
        )
        .where('id', '=', request.id)
        .execute();
    } finally {
      release.resolve();
      await blocker;
    }
    expect(await pending).toBeUndefined();
  },
);

it('fences restored source credentials when recovery clears photo sessions without deleting reference provenance', async () => {
  const f = await fixture();
  const request = (await f.sut.enqueue(f.asset.id))!;
  const token = randomBytes(32);
  const claim = (await f.sut.claim(f.grant, token, 100))!;
  expect(claim.id).toBe(request.id);
  // Recovery clears every photo session; this source's authority must disappear through the same FK.
  await db.deleteFrom('session').where('id', '=', f.session.id).execute();
  expect(
    await db.selectFrom('source_resource_grant').select('id').where('sourceId', '=', f.source.id).execute(),
  ).toEqual([]);
  expect(await f.sut.heartbeat(f.grant, claim.id, claim.claimFence, token)).toBeUndefined();
  expect(await f.sut.beginDelivery(f.grant, claim.id, claim.claimFence, token)).toBeUndefined();
  expect(await f.sut.claim(f.grant, randomBytes(32), 100)).toBeUndefined();
  expect(await f.sut.enqueue(f.asset.id)).toBeUndefined();
  expect(
    await db.selectFrom('source_original').select('resourceId').where('assetId', '=', f.asset.id).executeTakeFirst(),
  ).toEqual({ resourceId: f.resource.id });
  expect(
    await db.selectFrom('photo_source_resource').select('assetId').where('id', '=', f.resource.id).executeTakeFirst(),
  ).toEqual({ assetId: f.asset.id });
  expect(await db.selectFrom('asset').select('originalPath').where('id', '=', f.asset.id).executeTakeFirst()).toEqual({
    originalPath: f.asset.originalPath,
  });
});

const deliveryFixture = async (readers: Parameters<SourceResourceReadRepository['enqueue']>[2][] = []) => {
  const f = await fixture();
  if (readers.length > 0) {
    for (const reader of readers) await f.sut.enqueue(f.asset.id, undefined, reader);
  } else await f.sut.enqueue(f.asset.id);
  const token = randomBytes(32);
  const claim = (await f.sut.claim(f.grant, token, 100))!;
  const original = (await f.sut.beginDelivery(f.grant, claim.id, claim.claimFence, token))!;
  const cache = new SourceResourceCacheRepository(db);
  const writer = { id: randomUUID(), ownerId: randomUUID() };
  const disk = (await cache.inspectDisk(cacheFolder))!;
  const entry = await db
    .transaction()
    .execute((tx) => cache.reserve(tx, original, Number.MAX_SAFE_INTEGER, writer, disk));
  if (!entry || entry === 'snapshot-changed') throw new Error('Unexpected fixture admission failure');
  const publish = (tx: Parameters<SourceResourceCacheRepository['reserve']>[0]) =>
    cache.publishVerified(tx, entry.id, writer, {
      fileName: `${randomUUID()}.artifact`,
      bytes: original.bytes,
      sha256: Buffer.from(original.sha256, 'hex'),
    });
  return { ...f, token, claim, original, cache, writer, entry, publish };
};
it.each(['missing', 'expired', 'live'] as const)(
  'publishes managed delivery only for %s consumer interest',
  async (state) => {
    const f = await deliveryFixture();
    await db.updateTable('source_resource_read').set({ consumerManaged: true }).where('id', '=', f.claim.id).execute();
    if (state !== 'missing')
      await db
        .insertInto('source_resource_read_consumer')
        .values({
          readId: f.claim.id,
          readerId: randomUUID(),
          readerOwnerId: randomUUID(),
          expiresAt: new Date(Date.now() + (state === 'live' ? 60_000 : -60_000)),
        })
        .execute();
    const publish = vi.fn(f.publish);
    const result = await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, publish);
    if (state === 'live') expect(result).toBe(true);
    else expect(result).toBeUndefined();
    expect(publish).toHaveBeenCalledTimes(state === 'live' ? 1 : 0);
  },
);
it('atomically publishes the verified cache and completes only one delivery', async () => {
  const f = await deliveryFixture();
  const publish = vi.fn(f.publish);
  const complete = () => f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, publish);
  const results = await Promise.all([complete(), complete()]);
  expect(results.filter(Boolean)).toHaveLength(1);
  expect(await complete()).toBeUndefined();
  expect(publish).toHaveBeenCalledTimes(1);
  expect(
    (await db.selectFrom('source_resource_read').select('state').where('id', '=', f.claim.id).executeTakeFirst())
      ?.state,
  ).toBe('ready');
  expect(
    (await db.selectFrom('source_resource_cache').select('state').where('id', '=', f.entry.id).executeTakeFirst())
      ?.state,
  ).toBe('ready');
});
it.each(['resourceKey', 'version', 'sha256', 'bytes'] as const)(
  'refuses publication when the delivered %s differs',
  async (field) => {
    const f = await deliveryFixture();
    const expected = { ...f.original, [field]: field === 'bytes' ? 6 : 'f'.repeat(64) };
    const publish = vi.fn(f.publish);
    expect(
      await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, expected, publish),
    ).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  },
);
it('refuses publication after the provider version changes during transfer', async () => {
  const f = await deliveryFixture();
  await db
    .updateTable('photo_source_resource')
    .set({ version: 'e'.repeat(64) })
    .where('id', '=', f.resource.id)
    .execute();
  const publish = vi.fn(f.publish);
  expect(
    await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, publish),
  ).toBeUndefined();
  expect(publish).not.toHaveBeenCalled();
});
it.each(['fence', 'token', 'paused', 'expired'] as const)(
  'refuses final publication for %s authority',
  async (change) => {
    const f = await deliveryFixture();
    if (change === 'paused')
      await db.updateTable('desktop_device').set({ state: 'paused' }).where('id', '=', f.device.id).execute();
    else if (change === 'expired')
      await db
        .updateTable('source_resource_read')
        .set({ leaseUntil: new Date(0) })
        .where('id', '=', f.claim.id)
        .execute();
    const publish = vi.fn(f.publish);
    expect(
      await f.sut.completeDelivery(
        f.grant,
        f.claim.id,
        f.claim.claimFence + (change === 'fence' ? 1 : 0),
        change === 'token' ? randomBytes(32) : f.token,
        f.original,
        publish,
      ),
    ).toBeUndefined();
    expect(publish).not.toHaveBeenCalled();
  },
);
it.each(['deadline', 'rejected'] as const)('rolls back cache publication on final %s failure', async (change) => {
  const f = await deliveryFixture();
  const result = await f.sut.completeDelivery(
    f.grant,
    f.claim.id,
    f.claim.claimFence,
    f.token,
    f.original,
    async (tx) => {
      expect(await f.publish(tx)).toBe(true);
      if (change === 'deadline')
        await tx
          .updateTable('source_resource_read')
          .set({ deadline: new Date(0) })
          .where('id', '=', f.claim.id)
          .execute();
      return change !== 'rejected';
    },
  );
  expect(result).toBeUndefined();
  expect(
    (await db.selectFrom('source_resource_read').select('state').where('id', '=', f.claim.id).executeTakeFirst())
      ?.state,
  ).toBe('delivering');
  expect(
    (await db.selectFrom('source_resource_cache').select('state').where('id', '=', f.entry.id).executeTakeFirst())
      ?.state,
  ).toBe('writing');
});

it.each([false, true])(
  'keeps verified bytes and ready state together with a lost commit acknowledgement=%s',
  async (lostAcknowledgement) => {
    const f = await fixture();
    await f.sut.enqueue(f.asset.id);
    const token = 'e'.repeat(64);
    const claim = (await f.sut.claim(f.grant, createHash('sha256').update(token).digest(), 100))!;
    const metadata = {
      requestId: claim.id,
      claimFence: claim.claimFence,
      claimToken: token,
      resourceKey: claim.resourceKey,
      version: claim.version,
      sha256: claim.sha256,
      bytes: claim.bytes,
    };
    const folder = await mkdtemp(join(tmpdir(), 'source-pg-delivery-'));
    const media = vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(folder);
    const grants = new SourceResourceRepository(db);
    const cache = new SourceResourceCacheRepository(db);
    const reads = new SourceResourceReadRepository(db, grants, new SourceResourceCacheRepository(db));
    const transact = grants.withGrant.bind(grants);
    let published = false;
    const publish = cache.publishVerified.bind(cache);
    vi.spyOn(cache, 'publishVerified').mockImplementation(async (...args) => {
      const result = await publish(...args);
      published = result;
      return result;
    });
    vi.spyOn(grants, 'withGrant').mockImplementation(async (grant, action) => {
      const result = await transact(grant, action);
      if (published && lostAcknowledgement) throw new Error('commit acknowledgement lost');
      return result;
    });
    const service = new SourceResourceDeliveryService(
      { authenticate: () => Promise.resolve(f.grant) } as never,
      grants,
      reads,
      cache,
      LoggingRepository.create(),
    );
    try {
      const delivery = service.deliver(
        'bearer',
        'proof',
        Buffer.from(JSON.stringify(metadata)).toString('base64'),
        Readable.from([Buffer.from('hello')]),
      );
      if (lostAcknowledgement) await expect(delivery).rejects.toThrow('commit acknowledgement lost');
      else await expect(delivery).resolves.toEqual({ accepted: true });
      const row = await db
        .selectFrom('source_resource_cache')
        .selectAll()
        .where('readId', '=', claim.id)
        .executeTakeFirstOrThrow();
      expect(row.state).toBe('ready');
      expect(row.writerStoppedAt).not.toBeNull();
      expect(await readFile(join(folder, 'source-original-cache', row.id, row.fileName!))).toEqual(
        Buffer.from('hello'),
      );
      expect(
        (
          await db
            .selectFrom('source_resource_read')
            .select('state')
            .where('id', '=', claim.id)
            .executeTakeFirstOrThrow()
        ).state,
      ).toBe('ready');
      expect(await cache.claimRemoval(row.id)).toBeUndefined();
      await db.updateTable('source_resource_read').set({ state: 'unavailable' }).where('id', '=', claim.id).execute();
      expect((await cache.claimRemoval(row.id))?.state).toBe('deleting');
      await rm(join(folder, 'source-original-cache', row.id), { recursive: true });
      expect(await cache.confirmRemoved(row.id)).toBe(true);
    } finally {
      media.mockRestore();
      await rm(folder, { recursive: true, force: true });
    }
  },
);

it('rejects a consumer byte ceiling before creating or coalescing provider work', async () => {
  const f = await fixture();
  const tooSmall = Number(f.resource.bytes) - 1;
  expect(await f.sut.enqueue(f.asset.id, tooSmall)).toBeUndefined();
  expect(await db.selectFrom('source_resource_read').select('id').where('assetId', '=', f.asset.id).execute()).toEqual(
    [],
  );
  const admitted = await f.sut.enqueue(f.asset.id, Number(f.resource.bytes));
  expect(admitted?.id).toBeTruthy();
  expect(await f.sut.enqueue(f.asset.id, tooSmall)).toBeUndefined();
});

const waitingReader = () => ({ kind: 'http' as const, readerId: randomUUID(), ownerId: randomUUID() });
it('serves a signed delivered original through a live consumer and removes bytes only after reader release', async () => {
  const f = await fixture();
  const folder = await mkdtemp(join(tmpdir(), 'source-live-consumer-'));
  const media = vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(folder);
  const cache = new SourceResourceCacheRepository(db);
  const service = new SourceOriginalService(f.sut, cache);
  const reader = waitingReader();
  const abort = new AbortController();
  const enqueue = vi.spyOn(f.sut, 'enqueue');
  const input = service.open(f.asset.id, reader, () => Promise.resolve(), abort.signal);
  void input.catch(() => {});
  let opened: Awaited<typeof input> | undefined;
  try {
    await expect.poll(() => enqueue.mock.results.length).toBe(1);
    const request = await enqueue.mock.results[0].value;
    const token = 'e'.repeat(64);
    const claim = (await f.sut.claim(f.grant, createHash('sha256').update(token).digest(), 100))!;
    expect(claim.id).toBe(request!.id);
    const delivery = new SourceResourceDeliveryService(
      { authenticate: () => Promise.resolve(f.grant) } as never,
      new SourceResourceRepository(db),
      f.sut,
      cache,
      LoggingRepository.create(),
    );
    const metadata = {
      requestId: claim.id,
      claimFence: claim.claimFence,
      claimToken: token,
      resourceKey: claim.resourceKey,
      version: claim.version,
      sha256: claim.sha256,
      bytes: claim.bytes,
    };
    await expect(
      delivery.deliver(
        'bearer',
        'proof',
        Buffer.from(JSON.stringify(metadata)).toString('base64'),
        Readable.from([Buffer.from('hello')]),
      ),
    ).resolves.toEqual({ accepted: true });
    opened = await input;
    const path = opened.localPath;
    expect(Buffer.concat(await Array.fromAsync(opened.stream))).toEqual(Buffer.from('hello'));
    await opened.settled;
    expect(await readFile(path)).toEqual(Buffer.from('hello'));
    expect(
      await db.selectFrom('source_resource_read_consumer').select('id').where('readId', '=', claim.id).execute(),
    ).toEqual([]);
    const entry = await db
      .selectFrom('source_resource_cache')
      .select('id')
      .where('readId', '=', claim.id)
      .executeTakeFirstOrThrow();
    expect(await cache.claimRemoval(entry.id)).toBeUndefined();
    await opened.release();
    await expect(readFile(path)).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await db.selectFrom('source_resource_cache').select('id').where('id', '=', entry.id).execute()).toEqual([]);
  } finally {
    abort.abort();
    await input.catch(() => {});
    await opened?.release();
    enqueue.mockRestore();
    media.mockRestore();
    await rm(folder, { recursive: true, force: true });
  }
});
it('keeps ready bytes while a second consumer is still waiting to pin them', async () => {
  const first = waitingReader(),
    second = waitingReader();
  const f = await deliveryFixture([first, second]);
  expect(await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, f.publish)).toBe(
    true,
  );
  const pinned = (await f.sut.pinReady(f.asset.id, f.claim.id, first))!;
  expect(await f.cache.release(pinned.leaseId, first)).toBe(true);
  expect(await f.cache.claimRemoval(f.entry.id)).toBeUndefined();
  const next = (await f.sut.pinReady(f.asset.id, f.claim.id, second))!;
  expect(next.cacheId).toBe(pinned.cacheId);
  expect(await f.cache.release(next.leaseId, second)).toBe(true);
  expect((await f.cache.claimRemoval(f.entry.id))?.id).toBe(f.entry.id);
});
it('fences a cancelled in-flight delivery without inventing writer shutdown', async () => {
  const reader = waitingReader();
  const f = await deliveryFixture([reader]);
  await f.sut.releaseConsumer(f.claim.id, { ...reader, ownerId: randomUUID() });
  expect(await f.sut.heartbeat(f.grant, f.claim.id, f.claim.claimFence, f.token)).toBeDefined();
  await f.sut.releaseConsumer(f.claim.id, reader);
  expect(await f.sut.heartbeat(f.grant, f.claim.id, f.claim.claimFence, f.token)).toBeUndefined();
  expect(
    await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, f.publish),
  ).toBeUndefined();
  expect(await f.cache.claimRemoval(f.entry.id)).toBeUndefined();
  const entry = await db
    .selectFrom('source_resource_cache')
    .select(['state', 'writerStoppedAt'])
    .where('id', '=', f.entry.id)
    .executeTakeFirstOrThrow();
  expect(entry).toEqual({ state: 'writing', writerStoppedAt: null });
});
it('serializes the last disconnect with a new consumer joining the same original', async () => {
  const f = await fixture(),
    first = waitingReader(),
    second = waitingReader();
  const request = (await f.sut.enqueue(f.asset.id, undefined, first))!;
  const [, joined] = await Promise.all([
    f.sut.releaseConsumer(request.id, first),
    f.sut.enqueue(f.asset.id, undefined, second),
  ]);
  expect(joined).toBeDefined();
  expect((await f.sut.claim(f.grant, randomBytes(32), 100))?.id).toBe(joined!.id);
  await f.sut.releaseConsumer(joined!.id, second);
  expect(await f.sut.claim(f.grant, randomBytes(32), 100)).toBeUndefined();
});
it('preserves untracked older callers through the existing request deadline', async () => {
  const f = await fixture(),
    reader = waitingReader();
  const managed = (await f.sut.enqueue(f.asset.id, undefined, reader))!;
  expect((await f.sut.enqueue(f.asset.id))?.id).toBe(managed.id);
  await f.sut.releaseConsumer(managed.id, reader);
  expect((await f.sut.claim(f.grant, randomBytes(32), 100))?.id).toBe(managed.id);
});
it('bounds waiting consumers and refuses a reused reader nonce from another process', async () => {
  const f = await fixture(),
    reader = waitingReader();
  const request = (await f.sut.enqueue(f.asset.id, undefined, reader))!;
  expect(await f.sut.enqueue(f.asset.id, undefined, { ...reader, ownerId: randomUUID() })).toBeUndefined();
  for (let index = 1; index < 64; index++)
    expect((await f.sut.enqueue(f.asset.id, undefined, waitingReader()))?.id).toBe(request.id);
  expect(await f.sut.enqueue(f.asset.id, undefined, waitingReader())).toBeUndefined();
  expect(
    await db.selectFrom('source_resource_read_consumer').select('id').where('readId', '=', request.id).execute(),
  ).toHaveLength(64);
});

it('releases the last ready waiter without invalidating an already pinned reader', async () => {
  const first = waitingReader(),
    second = waitingReader();
  const f = await deliveryFixture([first, second]);
  expect(await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, f.publish)).toBe(
    true,
  );
  expect(await f.sut.pinReady(f.asset.id, f.claim.id, { ...second, ownerId: randomUUID() })).toBeUndefined();
  const pinned = (await f.sut.pinReady(f.asset.id, f.claim.id, first))!;
  expect(await f.sut.releaseConsumer(f.claim.id, second)).toBe(f.entry.id);
  expect(await f.sut.pinReady(f.asset.id, f.claim.id, second)).toBeUndefined();
  expect(await f.cache.claimRemoval(f.entry.id)).toBeUndefined();
  expect(await f.sut.checkPinned(f.asset.id, f.claim.id, pinned.cacheId, pinned.leaseId, first)).toBe(true);
  expect(await f.cache.release(pinned.leaseId, first)).toBe(true);
  expect((await f.cache.claimRemoval(f.entry.id))?.id).toBe(f.entry.id);
});
it.each(['cancelled', 'expired'])(
  'does not transfer a %s waiter into a cache pin after a cache lock wait',
  async (reason) => {
    const reader = waitingReader();
    const f = await deliveryFixture([reader]);
    expect(await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, f.publish)).toBe(
      true,
    );
    const locked = Promise.withResolvers<void>(),
      unlock = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await tx.selectFrom('source_resource_cache').select('id').where('id', '=', f.entry.id).forUpdate().execute();
      locked.resolve();
      await unlock.promise;
    });
    await locked.promise;
    const pending = f.sut.pinReady(f.asset.id, f.claim.id, reader);
    try {
      const limit = Date.now() + 5000;
      for (;;) {
        const { rows } = await sql<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%for update of "c"%'
      ) AS waiting`.execute(db);
        if (rows[0].waiting) break;
        if (Date.now() >= limit) throw new Error('Reader did not reach the cache lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      if (reason === 'cancelled') await f.sut.releaseConsumer(f.claim.id, reader);
      else
        await db
          .updateTable('source_resource_read_consumer')
          .set({ expiresAt: new Date(0) })
          .where('readId', '=', f.claim.id)
          .execute();
    } finally {
      unlock.resolve();
      await blocker;
    }
    expect(await pending).toBeUndefined();
    expect(
      await db.selectFrom('source_resource_cache_lease').select('id').where('cacheId', '=', f.entry.id).execute(),
    ).toEqual([]);
    expect((await f.cache.claimRemoval(f.entry.id))?.id).toBe(f.entry.id);
  },
);

it('recovers expired ready caches while preserving a live untracked older caller', async () => {
  const f = await deliveryFixture();
  expect(await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, f.publish)).toBe(
    true,
  );
  expect(await f.cache.removalCandidates()).not.toContainEqual({ id: f.entry.id });
  expect(await f.cache.claimRemoval(f.entry.id, { expiredOnly: true })).toBeUndefined();
  await db
    .updateTable('source_resource_read')
    .set({ deadline: new Date(0) })
    .where('id', '=', f.claim.id)
    .execute();
  expect(await f.cache.removalCandidates()).toContainEqual({ id: f.entry.id });
  // A stale candidate never authorizes removal after request liveness changes.
  await db
    .updateTable('source_resource_read')
    .set({ deadline: new Date(Date.now() + 60_000) })
    .where('id', '=', f.claim.id)
    .execute();
  expect(await f.cache.claimRemoval(f.entry.id, { expiredOnly: true })).toBeUndefined();
  await db
    .updateTable('source_resource_read')
    .set({ deadline: new Date(0) })
    .where('id', '=', f.claim.id)
    .execute();
  expect((await f.cache.claimRemoval(f.entry.id, { expiredOnly: true }))?.id).toBe(f.entry.id);
  // Simulate interruption after deletion was admitted, with the original bytes still on disk.
  const folder = await mkdtemp(join(tmpdir(), 'source-cache-recovery-'));
  const path = join(folder, 'source-original-cache', f.entry.id);
  const media = vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(folder);
  try {
    await mkdir(path, { recursive: true });
    await writeFile(join(path, 'orphan.artifact'), Buffer.from('hello'));
    const service = new SourceResourceDeliveryService(
      {} as never,
      new SourceResourceRepository(db),
      f.sut,
      f.cache,
      f.ctx.get(LoggingRepository),
    );
    await service.onBootstrap();
    await expect(readFile(join(path, 'orphan.artifact'))).rejects.toMatchObject({ code: 'ENOENT' });
    expect(await db.selectFrom('source_resource_cache').select('id').where('id', '=', f.entry.id).execute()).toEqual(
      [],
    );
  } finally {
    media.mockRestore();
    await rm(folder, { recursive: true, force: true });
  }
});

it.each(['claim', 'heartbeat', 'beginDelivery'] as const)(
  'refuses %s after the final waiting caller crashes',
  async (action) => {
    const reader = waitingReader(),
      f = await fixture();
    const request = (await f.sut.enqueue(f.asset.id, undefined, reader))!;
    const token = randomBytes(32);
    const claim = action === 'claim' ? undefined : (await f.sut.claim(f.grant, token, 100))!;
    await db
      .updateTable('source_resource_read_consumer')
      .set({ expiresAt: new Date(0) })
      .where('readId', '=', request.id)
      .execute();
    expect(
      action === 'claim'
        ? await f.sut.claim(f.grant, token, 100)
        : await f.sut[action](f.grant, claim!.id, claim!.claimFence, token),
    ).toBeUndefined();
  },
);
it('refuses completeDelivery after the final waiting caller crashes without proving writer stop', async () => {
  const f = await deliveryFixture([waitingReader()]);
  await db
    .updateTable('source_resource_read_consumer')
    .set({ expiresAt: new Date(0) })
    .where('readId', '=', f.claim.id)
    .execute();
  expect(
    await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, f.publish),
  ).toBeUndefined();
  expect(await f.cache.claimRemoval(f.entry.id)).toBeUndefined();
});

it('renews only the live owning waiter, bounds renewal to the request and preserves other callers', async () => {
  const f = await fixture(),
    first = waitingReader(),
    second = waitingReader();
  const request = (await f.sut.enqueue(f.asset.id, undefined, first))!;
  await f.sut.enqueue(f.asset.id, undefined, second);
  await db
    .updateTable('source_resource_read_consumer')
    .set({ expiresAt: new Date(0) })
    .where('readerId', '=', first.readerId)
    .execute();
  expect(await f.sut.renewConsumer(request.id, first)).toBe(false);
  expect(await f.sut.renewConsumer(request.id, { ...second, ownerId: randomUUID() })).toBe(false);
  const deadline = new Date(Date.now() + 60_000);
  await db.updateTable('source_resource_read').set({ deadline }).where('id', '=', request.id).execute();
  expect(await f.sut.renewConsumer(request.id, second)).toBe(true);
  const consumer = await db
    .selectFrom('source_resource_read_consumer')
    .select('expiresAt')
    .where('readerId', '=', second.readerId)
    .executeTakeFirstOrThrow();
  expect(new Date(consumer.expiresAt!).getTime()).toBe(deadline.getTime());
  expect((await f.sut.claim(f.grant, randomBytes(32), 100))?.id).toBe(request.id);
  await db
    .updateTable('source_resource_read')
    .set({ deadline: new Date(0) })
    .where('id', '=', request.id)
    .execute();
  expect(await f.sut.renewConsumer(request.id, second)).toBe(false);
});
it('keeps legacy null-expiry interest until its existing bounded request deadline', async () => {
  const f = await fixture(),
    reader = waitingReader();
  const request = (await f.sut.enqueue(f.asset.id, undefined, reader))!;
  await db
    .updateTable('source_resource_read_consumer')
    .set({ expiresAt: null })
    .where('readId', '=', request.id)
    .execute();
  const token = randomBytes(32),
    claim = (await f.sut.claim(f.grant, token, 100))!;
  expect(claim.id).toBe(request.id);
  expect(await f.sut.heartbeat(f.grant, claim.id, claim.claimFence, token)).toBeDefined();
  await db
    .updateTable('source_resource_read')
    .set({ deadline: new Date(0) })
    .where('id', '=', request.id)
    .execute();
  expect(await f.sut.heartbeat(f.grant, claim.id, claim.claimFence, token)).toBeUndefined();
});
it('expires abandoned ready interest without revoking an already borrowed file', async () => {
  const first = waitingReader(),
    second = waitingReader();
  const f = await deliveryFixture([first, second]);
  expect(await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, f.publish)).toBe(
    true,
  );
  const pinned = (await f.sut.pinReady(f.asset.id, f.claim.id, first))!;
  await db
    .updateTable('source_resource_read_consumer')
    .set({ expiresAt: new Date(0) })
    .where('readId', '=', f.claim.id)
    .execute();
  expect(await f.sut.pinReady(f.asset.id, f.claim.id, second)).toBeUndefined();
  expect(await f.cache.removalCandidates()).not.toContainEqual({ id: f.entry.id });
  expect(await f.cache.claimRemoval(f.entry.id)).toBeUndefined();
  expect(await f.sut.checkPinned(f.asset.id, f.claim.id, pinned.cacheId, pinned.leaseId, first)).toBe(true);
  expect(await f.cache.release(pinned.leaseId, first)).toBe(true);
  expect(await f.cache.removalCandidates()).toContainEqual({ id: f.entry.id });
  expect((await f.cache.claimRemoval(f.entry.id, { expiredOnly: true }))?.id).toBe(f.entry.id);
});
it('rolls back verified cache publication if the final waiting lease expires during publication', async () => {
  const reader = waitingReader(),
    f = await deliveryFixture([reader]);
  await sql`UPDATE source_resource_read_consumer SET "expiresAt"=clock_timestamp()+interval '500 milliseconds' WHERE "readId"=${f.claim.id}::uuid`.execute(
    db,
  );
  const result = await f.sut.completeDelivery(
    f.grant,
    f.claim.id,
    f.claim.claimFence,
    f.token,
    f.original,
    async (tx) => {
      const accepted = await f.publish(tx);
      await sql`SELECT pg_sleep(0.6)`.execute(tx);
      return accepted;
    },
  );
  expect(result).toBeUndefined();
  expect(
    await db
      .selectFrom('source_resource_cache')
      .select(['state', 'writerStoppedAt'])
      .where('id', '=', f.entry.id)
      .executeTakeFirstOrThrow(),
  ).toEqual({ state: 'writing', writerStoppedAt: null });
});

it('reuses an expired waiting slot without accumulating more than the consumer bound', async () => {
  const f = await fixture(),
    readers = Array.from({ length: 64 }, waitingReader);
  const first = (await f.sut.enqueue(f.asset.id, undefined, readers[0]))!;
  for (const reader of readers.slice(1)) await f.sut.enqueue(f.asset.id, undefined, reader);
  await db
    .updateTable('source_resource_read_consumer')
    .set({ expiresAt: new Date(0) })
    .where('readerId', '=', readers[0].readerId)
    .execute();
  expect((await f.sut.enqueue(f.asset.id, undefined, waitingReader()))?.id).toBe(first.id);
  const consumers = await db
    .selectFrom('source_resource_read_consumer')
    .select('readerId')
    .where('readId', '=', first.id)
    .execute();
  expect(consumers).toHaveLength(64);
  expect(consumers).not.toContainEqual({ readerId: readers[0].readerId });
});
it.each(['claim', 'heartbeat', 'beginDelivery'] as const)(
  'rechecks waiting interest after %s waits on source authority',
  async (action) => {
    const reader = waitingReader(),
      f = await fixture();
    const request = (await f.sut.enqueue(f.asset.id, undefined, reader))!;
    const token = randomBytes(32),
      claim = action === 'claim' ? undefined : (await f.sut.claim(f.grant, token, 100))!;
    const locked = Promise.withResolvers<void>(),
      unlock = Promise.withResolvers<void>();
    const blocker = db.transaction().execute(async (tx) => {
      await tx.selectFrom('asset').select('id').where('id', '=', f.asset.id).forUpdate().execute();
      locked.resolve();
      await unlock.promise;
    });
    await locked.promise;
    const pending =
      action === 'claim'
        ? f.sut.claim(f.grant, token, 100)
        : f.sut[action](f.grant, claim!.id, claim!.claimFence, token);
    try {
      const limit = Date.now() + 5000;
      for (;;) {
        const { rows } = await sql<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%FROM asset a JOIN source_original%'
      ) AS waiting`.execute(db);
        if (rows[0].waiting) break;
        if (Date.now() >= limit) throw new Error('Provider did not reach the source lock');
        await new Promise((resolve) => setTimeout(resolve, 10));
      }
      await db
        .updateTable('source_resource_read_consumer')
        .set({ expiresAt: new Date(0) })
        .where('readId', '=', request.id)
        .execute();
    } finally {
      unlock.resolve();
      await blocker;
    }
    expect(await pending).toBeUndefined();
  },
);

it('does not revive an expired managed waiter when an older caller shares its request', async () => {
  const reader = waitingReader(),
    f = await deliveryFixture([reader]);
  expect((await f.sut.enqueue(f.asset.id))?.id).toBe(f.claim.id);
  expect(await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, f.publish)).toBe(
    true,
  );
  await db
    .updateTable('source_resource_read_consumer')
    .set({ expiresAt: new Date(0) })
    .where('readId', '=', f.claim.id)
    .execute();
  expect(await f.sut.pinReady(f.asset.id, f.claim.id, reader)).toBeUndefined();
  // The genuinely untracked caller still owns its original bounded request.
  expect((await f.sut.pinReady(f.asset.id, f.claim.id, waitingReader()))?.cacheId).toBe(f.entry.id);
});

it('pins only the exact ready delivery while retaining storage ownership after authority ends', async () => {
  const f = await deliveryFixture();
  const reader = { kind: 'http' as const, readerId: randomUUID(), ownerId: randomUUID() };
  expect(await f.sut.pinReady(f.asset.id, f.claim.id, reader)).toBeUndefined();
  expect(await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, f.publish)).toBe(
    true,
  );
  expect(await f.sut.pinReady(randomUUID(), f.claim.id, reader)).toBeUndefined();
  expect(await f.sut.pinReady(f.asset.id, randomUUID(), reader)).toBeUndefined();
  const pinned = (await f.sut.pinReady(f.asset.id, f.claim.id, reader))!;
  expect(pinned).toMatchObject({
    cacheId: f.entry.id,
    bytes: 5,
    sha256: f.original.sha256,
    version: f.original.version,
  });
  expect(pinned.fileName).toMatch(/^[a-f0-9-]{36}[.]artifact$/u);
  expect(await f.sut.checkPinned(f.asset.id, f.claim.id, pinned.cacheId, pinned.leaseId, reader)).toBe(true);
  // A queued adoption already owns this asset lock; source checks must join that transaction.
  await db.connection().execute(async (connection) => {
    await sql`SET lock_timeout='200ms'`.execute(connection);
    try {
      const reads = new SourceResourceReadRepository(
        connection,
        new SourceResourceRepository(connection),
        new SourceResourceCacheRepository(connection),
      );
      await db.transaction().execute(async (tx) => {
        await tx.selectFrom('asset').select('id').where('id', '=', f.asset.id).forUpdate().execute();
        await publicationTransaction.run(tx, async () => {
          expect(await reads.checkPinned(f.asset.id, f.claim.id, pinned.cacheId, pinned.leaseId, reader)).toBe(true);
        });
      });
    } finally {
      await sql`RESET lock_timeout`.execute(connection);
    }
  });
  expect(
    await f.sut.checkPinned(f.asset.id, f.claim.id, pinned.cacheId, pinned.leaseId, {
      ...reader,
      ownerId: randomUUID(),
    }),
  ).toBe(false);
  expect(await f.cache.claimRemoval(f.entry.id)).toBeUndefined();
  await db.updateTable('desktop_device').set({ state: 'paused' }).where('id', '=', f.device.id).execute();
  expect(await f.sut.pinReady(f.asset.id, f.claim.id, { ...reader, readerId: randomUUID() })).toBeUndefined();
  expect(await f.cache.claimRemoval(f.entry.id)).toBeUndefined();
  expect(await f.cache.release(pinned.leaseId, reader)).toBe(true);
  expect(await f.cache.claimRemoval(f.entry.id)).toBeUndefined();
  await db
    .updateTable('source_resource_read')
    .set({ deadline: new Date(0) })
    .where('id', '=', f.claim.id)
    .execute();
  expect((await f.cache.claimRemoval(f.entry.id))?.state).toBe('deleting');
});
it.each(['version', 'scope', 'epoch', 'checksum', 'size', 'fence', 'expired', 'deleting'] as const)(
  'refuses to pin a ready delivery after %s changes',
  async (change) => {
    const f = await deliveryFixture();
    expect(await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, f.publish)).toBe(
      true,
    );
    switch (change) {
      case 'version': {
        await db
          .updateTable('photo_source_resource')
          .set({ version: 'f'.repeat(64) })
          .where('id', '=', f.resource.id)
          .execute();
        break;
      }
      case 'scope': {
        await db
          .updateTable('photo_source')
          .set({ scopeFingerprint: 'f'.repeat(64) })
          .where('id', '=', f.source.id)
          .execute();
        break;
      }
      case 'epoch': {
        await db.updateTable('desktop_device').set({ authorizationEpoch: 2 }).where('id', '=', f.device.id).execute();
        break;
      }
      case 'checksum': {
        await db
          .updateTable('source_resource_cache')
          .set({ sha256: Buffer.alloc(32) })
          .where('id', '=', f.entry.id)
          .execute();
        break;
      }
      case 'size': {
        await db.updateTable('source_resource_cache').set({ bytes: 6 }).where('id', '=', f.entry.id).execute();
        break;
      }
      case 'fence': {
        await db
          .updateTable('source_resource_read')
          .set({ claimFence: f.claim.claimFence + 1 })
          .where('id', '=', f.claim.id)
          .execute();
        break;
      }
      case 'expired': {
        await db
          .updateTable('source_resource_read')
          .set({ deadline: sql`clock_timestamp()-interval '1 second'` })
          .where('id', '=', f.claim.id)
          .execute();
        break;
      }
      case 'deleting': {
        await db.updateTable('source_resource_cache').set({ state: 'deleting' }).where('id', '=', f.entry.id).execute();
        break;
      }
      // No default
    }
    expect(
      await f.sut.pinReady(f.asset.id, f.claim.id, { kind: 'http', readerId: randomUUID(), ownerId: randomUUID() }),
    ).toBeUndefined();
    expect(
      await db.selectFrom('source_resource_cache_lease').select('id').where('cacheId', '=', f.entry.id).execute(),
    ).toEqual([]);
  },
);
it.each([
  ['expired', false],
  ['fence', false],
  ['expired', true],
  ['fence', true],
] as const)('refuses %s changes during a cache lock wait (existing reader: %s)', async (change, existing) => {
  const f = await deliveryFixture();
  expect(await f.sut.completeDelivery(f.grant, f.claim.id, f.claim.claimFence, f.token, f.original, f.publish)).toBe(
    true,
  );
  const reader = { kind: 'http' as const, readerId: randomUUID(), ownerId: randomUUID() };
  const pin = existing ? (await f.sut.pinReady(f.asset.id, f.claim.id, reader))! : undefined;
  const locked = Promise.withResolvers<void>();
  const release = Promise.withResolvers<void>();
  const blocker = db.transaction().execute(async (tx) => {
    await tx.selectFrom('source_resource_cache').select('id').where('id', '=', f.entry.id).forUpdate().execute();
    locked.resolve();
    await release.promise;
  });
  await locked.promise;
  const pending = existing
    ? f.sut.checkPinned(f.asset.id, f.claim.id, pin!.cacheId, pin!.leaseId, reader)
    : f.sut.pinReady(f.asset.id, f.claim.id, reader);
  try {
    const limit = Date.now() + 5000;
    for (;;) {
      const { rows } = await sql<{ waiting: boolean }>`SELECT EXISTS (
        SELECT 1 FROM pg_stat_activity WHERE pid<>pg_backend_pid() AND wait_event_type='Lock'
          AND query LIKE '%source_resource_cache%inner join%'
      ) AS waiting`.execute(db);
      if (rows[0].waiting) break;
      if (Date.now() >= limit) throw new Error('Reader did not reach the cache lock');
      await new Promise((resolve) => setTimeout(resolve, 10));
    }
    await db
      .updateTable('source_resource_read')
      .set(
        change === 'expired'
          ? { deadline: sql`clock_timestamp()-interval '1 second'` }
          : { claimFence: f.claim.claimFence + 1 },
      )
      .where('id', '=', f.claim.id)
      .execute();
  } finally {
    release.resolve();
    await blocker;
  }
  expect(await pending).toBe(existing ? false : undefined);
  expect(
    await db.selectFrom('source_resource_cache_lease').select('id').where('cacheId', '=', f.entry.id).execute(),
  ).toEqual(existing ? [{ id: pin!.leaseId }] : []);
});

it('revokes shared provider work only after its final original consumer disconnects', async () => {
  const f = await fixture();
  const storage = vi.spyOn(StorageCore, 'getMediaLocation').mockReturnValue(tmpdir());
  const service = new SourceOriginalService(f.sut, new SourceResourceCacheRepository(db));
  const enqueue = vi.spyOn(f.sut, 'enqueue');
  const firstAbort = new AbortController(),
    secondAbort = new AbortController();
  const reader = () => ({ kind: 'http' as const, readerId: randomUUID(), ownerId: randomUUID() });
  const first = service.open(f.asset.id, reader(), () => Promise.resolve(), firstAbort.signal);
  const second = service.open(f.asset.id, reader(), () => Promise.resolve(), secondAbort.signal);
  void first.catch(() => {});
  void second.catch(() => {});
  try {
    await expect.poll(() => enqueue.mock.calls.length).toBe(2);
    const requests = await Promise.all(enqueue.mock.results.map((result) => result.value));
    expect(requests[0]?.id).toBe(requests[1]?.id);
    firstAbort.abort();
    await expect(first).rejects.toThrow();
    const alive = await db
      .selectFrom('source_resource_read')
      .select('state')
      .where('id', '=', requests[0]!.id)
      .executeTakeFirstOrThrow();
    expect(alive.state).toBe('pending');
    secondAbort.abort();
    await expect(second).rejects.toThrow();
    // No consumer remains: even an authenticated companion must not begin hydration now.
    const orphan = await f.sut.claim(f.grant, randomBytes(32), Number(f.resource.bytes));
    expect(orphan).toBeUndefined();
  } finally {
    firstAbort.abort();
    secondAbort.abort();
    await Promise.allSettled([first, second]);
    enqueue.mockRestore();
    storage.mockRestore();
  }
});
