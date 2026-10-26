import { Kysely, sql } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import type { DB } from 'src/schema/index.js';
import { ChecksumAlgorithm } from 'src/enum.js';
import { DesktopDeviceRepository } from 'src/repositories/desktop-device.repository.js';
import { LibraryRepository } from 'src/repositories/library.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PhotoSourceRepository } from 'src/repositories/photo-source.repository.js';
import { SessionRepository } from 'src/repositories/session.repository.js';
import { SourceResourceReadRepository } from 'src/repositories/source-resource-read.repository.js';
import { SourceResourceRepository } from 'src/repositories/source-resource.repository.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => db?.destroy());
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
    sut: new SourceResourceReadRepository(db, grants),
  };
};

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
