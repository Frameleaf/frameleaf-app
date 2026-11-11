import { Kysely, sql } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import type { MediaImportAuthority } from 'src/repositories/media-import.repository.js';
import { MediaImportCreateDto } from 'src/dtos/media-import.dto.js';
import { LibraryScope, Permission } from 'src/enum.js';
import { AssetUploadResourceRepository } from 'src/repositories/asset-upload-resource.repository.js';
import { CaptureRepository } from 'src/repositories/capture.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaImportRepository } from 'src/repositories/media-import.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
}, 60_000);
afterAll(async () => {
  await db?.destroy();
});
const entry = {
  provider: 'fixture',
  creatorId: 'creator',
  postId: 'post',
  attachmentId: 'attachment',
  pageUrl: 'https://example.org/post',
  title: 'Post',
  description: 'Text',
  creator: 'Creator',
  publishedAt: '2026-01-01T00:00:00Z',
  kind: 'image' as const,
};
const setup = async () => {
  const ctx = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] }).ctx;
  const { user } = await ctx.newUser();
  const { album } = await ctx.newAlbum({ ownerId: user.id, libraryScope: LibraryScope.Design });
  const key = await db
    .insertInto('api_key')
    .values({
      userId: user.id,
      name: 'Media',
      key: randomBytes(32),
      permissions: [Permission.MediaImportCreate, Permission.MediaSubscriptionWrite],
    })
    .returningAll()
    .executeTakeFirstOrThrow();
  const auth = { user, apiKey: { id: key.id, permissions: key.permissions } };
  const repo = new MediaImportRepository(db, new CaptureRepository(db));
  const preview = await repo.inspect(user.id, key.id, { urls: [entry.pageUrl] });
  await db.updateTable('media_import').set({ state: 'ready' }).where('id', '=', preview.id).execute();
  const item = await db
    .insertInto('media_import_item')
    .values({ ownerId: user.id, importId: preview.id, sourceKey: 'source', entry })
    .returningAll()
    .executeTakeFirstOrThrow();
  const dto = MediaImportCreateDto.schema.parse({
    inspectionId: preview.id,
    itemIds: [item.id],
    albumId: album.id,
    idempotencyKey: randomUUID(),
  });
  return { ctx, auth, repo, preview, item, dto, album };
};
async function claim(ownerId: string, importId: string, itemId: string): Promise<MediaImportAuthority> {
  const id = randomUUID(),
    token = randomUUID();
  await db
    .insertInto('job_queue')
    .values({ name: 'backgroundTask', concurrency: 2 })
    .onConflict((oc) => oc.doNothing())
    .execute();
  await sql`insert into job (id, queue, name, data, state, token, "safeToRetry", "deadlineMs", "leaseExpiresAt")
    values (${id}::uuid,'backgroundTask','media-import',${JSON.stringify({ id: importId })}::jsonb,'active',${token}::uuid,true,3600000,now()+interval '1 hour')`.execute(
    db,
  );
  return { ownerId, importId, itemId, generation: 1, subscriptionGeneration: null, jobId: id, jobToken: token };
}

describe('durable Boards media imports', () => {
  it('serializes unresolved inspections with downloads and caps known providers at two', async () => {
    const { repo } = await setup();
    const row = { connectionId: null };
    const entered = Promise.withResolvers<void>(),
      release = Promise.withResolvers<void>();
    const inspection = repo.withCapacity(row, null, async () => {
      entered.resolve();
      await release.promise;
      return true;
    });
    await entered.promise;
    try {
      expect(await repo.withCapacity(row, 'youtube', () => Promise.resolve(true))).toBeUndefined();
      expect(await repo.withCapacity(row, null, () => Promise.resolve(true))).toBeUndefined();
    } finally {
      release.resolve();
      await inspection;
    }
    const knownEntered = Promise.withResolvers<void>(),
      knownRelease = Promise.withResolvers<void>();
    const first = repo.withCapacity(row, 'youtube', async () => {
      knownEntered.resolve();
      await knownRelease.promise;
      return true;
    });
    await knownEntered.promise;
    try {
      expect(await repo.withCapacity(row, 'youtube', () => Promise.resolve(true))).toBeUndefined();
      expect(await repo.withCapacity(row, null, () => Promise.resolve(true))).toBeUndefined();
      expect(
        await repo.withCapacity(row, 'vimeo', async () => {
          expect(
            await repo.withCapacity({ connectionId: randomUUID() }, 'other', () => Promise.resolve(true)),
          ).toBeUndefined();
          return true;
        }),
      ).toBe(true);
    } finally {
      knownRelease.resolve();
      await first;
    }
  });
  it('serializes duplicate submissions and rejects a changed idempotent request', async () => {
    const { repo, auth, dto } = await setup();
    const [first, second] = await Promise.all([repo.create(auth, dto), repo.create(auth, dto)]);
    expect(first.id).toBe(second.id);
    expect(await repo.items(first.id)).toHaveLength(1);
    await expect(repo.create(auth, { ...dto, streamMp4: true })).rejects.toThrow('Idempotency');
  });
  it('does not expose another owner’s inspection or connection', async () => {
    const one = await setup(),
      two = await setup();
    await expect(one.repo.get(two.auth.user.id, one.preview.id)).rejects.toThrow('unavailable');
    await expect(one.repo.create(two.auth, one.dto)).rejects.toThrow('unavailable');
    const connection = await one.repo.addSiteConnection({
      id: randomUUID(),
      ownerId: one.auth.user.id,
      provider: 'fixture',
      label: 'Fixture',
      domains: ['example.org'],
      encryptedSession: 'ciphertext',
    });
    await expect(one.repo.connection(two.auth.user.id, connection.id)).rejects.toThrow('unavailable');
  });
  it('requires a current job token, live authorization and destination at publication', async () => {
    const { repo, auth, dto, album } = await setup();
    const operation = await repo.create(auth, dto);
    const item = (await repo.items(operation.id))[0];
    const authority = await claim(auth.user.id, operation.id, item.id);
    await expect(repo.assertAuthority(authority)).resolves.toHaveProperty('user.id', auth.user.id);
    await expect(repo.assertAuthority({ ...authority, jobToken: randomUUID() })).rejects.toThrow('revoked');
    await db.deleteFrom('album_user').where('albumId', '=', album.id).execute();
    await expect(repo.assertAuthority(authority)).rejects.toThrow('unavailable');
  });
  it('cancellation revokes authority without deleting published receipts', async () => {
    const { repo, auth, dto } = await setup();
    const operation = await repo.create(auth, dto),
      item = (await repo.items(operation.id))[0];
    const authority = await claim(auth.user.id, operation.id, item.id);
    await repo.cancel(auth.user.id, operation.id);
    await expect(repo.assertAuthority(authority)).rejects.toThrow();
    expect(await repo.items(operation.id)).toHaveLength(1);
  });
  it('revokes queued work when its API key loses media permission', async () => {
    const { repo, auth, dto } = await setup();
    const operation = await repo.create(auth, dto);
    const item = (await repo.items(operation.id))[0];
    const authority = await claim(auth.user.id, operation.id, item.id);
    await db
      .updateTable('api_key')
      .set({ permissions: [Permission.CaptureCreate] })
      .where('id', '=', auth.apiKey.id)
      .execute();
    await expect(repo.assertAuthority(authority)).rejects.toThrow('authorization was revoked');
  });
  it('keeps accepted Library work after extension sign-out', async () => {
    const { repo, auth, dto } = await setup();
    await db
      .insertInto('browser_extension_access')
      .values({
        userId: auth.user.id,
        apiKeyId: auth.apiKey.id,
        client: 'chrome',
        redirectOrigin: 'https://aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa.chromiumapp.org',
        installationId: randomUUID(),
      })
      .execute();
    const operation = await repo.create(auth, dto),
      item = (await repo.items(operation.id))[0];
    expect(operation.apiKeyId).toBeNull();
    const authority = await claim(auth.user.id, operation.id, item.id);
    await db.deleteFrom('api_key').where('id', '=', auth.apiKey.id).execute();
    await expect(repo.assertAuthority(authority)).resolves.toHaveProperty('user.id', auth.user.id);
    await db.updateTable('user').set({ uploadsPaused: true }).where('id', '=', auth.user.id).execute();
    await expect(repo.assertAuthority(authority)).rejects.toThrow('paused');
  });
  it('disconnects retained access and fences already-claimed work', async () => {
    const { repo, auth, dto, preview } = await setup();
    const connection = await repo.addSiteConnection({
      id: randomUUID(),
      ownerId: auth.user.id,
      provider: 'fixture',
      label: 'Fixture',
      domains: ['example.org'],
      encryptedSession: 'ciphertext',
    });
    await db
      .updateTable('media_import')
      .set({ connectionId: connection.id, connectionRevision: connection.revision })
      .where('id', '=', preview.id)
      .execute();
    const operation = await repo.create(auth, dto);
    const item = (await repo.items(operation.id))[0];
    const authority = await claim(auth.user.id, operation.id, item.id);
    await expect(repo.assertAuthority(authority)).resolves.toBeDefined();
    await repo.updateConnection(auth.user.id, connection.id, null);
    await expect(repo.assertAuthority(authority)).rejects.toThrow();
    expect(await repo.connection(auth.user.id, connection.id)).toMatchObject({
      encryptedSession: null,
      status: 'disconnected',
      revision: 2,
    });
    expect((await repo.get(auth.user.id, operation.id)).state).toBe('paused');
  });
  it('replaces expired staging receipts while retaining committed upload identity', async () => {
    const { repo, auth, dto } = await setup();
    const operation = await repo.create(auth, dto),
      item = (await repo.items(operation.id))[0];
    const authority = await claim(auth.user.id, operation.id, item.id);
    const file = { filename: 'fixture.png', sha256: Buffer.alloc(32, 1).toString('hex') };
    const id = await repo.uploadId(authority, file);
    await new AssetUploadResourceRepository(db).create(id, auth.user.id, {
      checksum: Buffer.from(file.sha256, 'hex'),
      contentType: 'image/png',
      size: 10,
      metadata: {
        filename: file.filename,
        fileCreatedAt: new Date(),
        fileModifiedAt: new Date(),
        libraryScope: LibraryScope.Design,
        publication: 'media-import',
        mediaImportItemId: item.id,
      },
    });
    expect(await repo.uploadId(authority, file)).toBe(id);
    await db
      .updateTable('asset_upload_resource')
      .set({ expiresAt: new Date(0) })
      .where('id', '=', id)
      .execute();
    expect(await repo.uploadId(authority, file)).not.toBe(id);
    expect(
      (await db.selectFrom('asset_upload_resource').select('state').where('id', '=', id).executeTakeFirstOrThrow())
        .state,
    ).toBe('cancelled');
    await db.updateTable('asset_upload_resource').set({ state: 'published' }).where('id', '=', id).execute();
    await db.updateTable('media_import_item').set({ uploadId: id }).where('id', '=', item.id).execute();
    expect(await repo.uploadId(authority, file)).toBe(id);
  });
  it('rolls back publication and membership if the receipt cannot commit', async () => {
    const { repo, auth, dto, ctx } = await setup();
    const operation = await repo.create(auth, dto),
      item = (await repo.items(operation.id))[0];
    const authority = await claim(auth.user.id, operation.id, item.id);
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id, libraryScope: LibraryScope.Design });
    await repo.uploadId(authority);
    let reachedCommit = false;
    await expect(
      db.transaction().execute(async (tx) => {
        await repo.publish(tx, authority, () => Promise.resolve({ id: asset.id, status: 'created' as const }));
        reachedCommit = true;
        throw new Error('crash before commit');
      }),
    ).rejects.toThrow('crash before commit');
    expect(reachedCommit).toBe(true);
    expect((await repo.items(operation.id))[0].state).toBe('discovered');
    expect(
      await db
        .selectFrom('album_asset')
        .selectAll()
        .where('albumId', '=', dto.albumId)
        .where('assetId', '=', asset.id)
        .execute(),
    ).toHaveLength(0);
  });
  it('keeps exactly one publication receipt across repeats and suppresses deleted media', async () => {
    const { repo, auth, dto, ctx } = await setup();
    const operation = await repo.create(auth, dto),
      item = (await repo.items(operation.id))[0];
    const authority = await claim(auth.user.id, operation.id, item.id);
    await repo.uploadId(authority);
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id, libraryScope: LibraryScope.Design });
    const publish = vi.fn(() => Promise.resolve({ id: asset.id, status: 'created' as const }));
    for (let attempt = 0; attempt < 2; attempt++)
      await db.transaction().execute((tx) => repo.publish(tx, authority, publish));
    expect(publish).toHaveBeenCalledTimes(1);
    await repo.progress(authority, 'failed', undefined, 'failure after commit');
    expect((await repo.items(operation.id))[0].state).toBe('saved');
    expect(await db.selectFrom('asset_source').selectAll().where('assetId', '=', asset.id).execute()).toHaveLength(1);
    const { tag } = await ctx.newTag({ userId: auth.user.id, value: 'Added on reimport' });
    const tagged = await repo.create(auth, { ...dto, tagIds: [tag.id], idempotencyKey: randomUUID() });
    const taggedItem = (await repo.items(tagged.id))[0];
    const taggedAuthority = await claim(auth.user.id, tagged.id, taggedItem.id);
    expect(await repo.reusePublished(taggedAuthority, taggedItem)).toBe(true);
    expect(
      await db
        .selectFrom('tag_asset')
        .selectAll()
        .where('assetId', '=', asset.id)
        .where('tagId', '=', tag.id)
        .execute(),
    ).toHaveLength(1);
    await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();
    const removed = (await repo.items(operation.id))[0];
    expect(removed.suppression).toBe('owner');
    const another = await repo.create(auth, { ...dto, idempotencyKey: randomUUID() });
    expect(await repo.suppressed(another, (await repo.items(another.id))[0])).toBe(true);
    expect(await repo.suppressed({ ...another, overrideSuppression: true }, (await repo.items(another.id))[0])).toBe(
      false,
    );
    await db.deleteFrom('asset').where('id', '=', asset.id).execute();
    expect((await repo.items(operation.id))[0].assetId).toBe(asset.id);
  });
  it('retains collection removals for the subscription and leaves other imports alone', async () => {
    const { repo, auth, dto, ctx, preview } = await setup();
    await db
      .updateTable('media_import')
      .set({
        inspection: {
          kind: 'feed',
          provider: 'fixture',
          creatorId: 'creator',
          creator: 'Creator',
          title: 'Creator',
          canonicalUrl: entry.pageUrl,
          checkpoint: null,
          complete: true,
          limitation: null,
        },
      })
      .where('id', '=', preview.id)
      .execute();
    const subscription = await repo.createSubscription(auth, {
      inspectionId: preview.id,
      history: { mode: 'all' },
      intervalMinutes: 60,
      idempotencyKey: randomUUID(),
    });
    const operation = await repo.create(auth, { ...dto, albumId: subscription.albumId! });
    await db
      .updateTable('media_import')
      .set({ subscriptionId: subscription.id, subscriptionGeneration: 1 })
      .where('id', '=', operation.id)
      .execute();
    const item = (await repo.items(operation.id))[0];
    const authority = { ...(await claim(auth.user.id, operation.id, item.id)), subscriptionGeneration: 1 };
    await repo.finishSubscription(
      authority,
      {
        ...preview.inspection!,
        kind: 'feed',
        provider: 'fixture',
        creatorId: 'creator',
        creator: 'Creator',
        title: 'Creator',
        canonicalUrl: entry.pageUrl,
        checkpoint: null,
        complete: true,
        limitation: null,
        entries: [],
      },
      true,
    );
    expect((await repo.subscription(auth.user.id, subscription.id)).historyComplete).toBe(false);
    await repo.uploadId(authority);
    const { asset } = await ctx.newAsset({ ownerId: auth.user.id, libraryScope: LibraryScope.Design });
    await db
      .transaction()
      .execute((tx) =>
        repo.publish(tx, authority, () => Promise.resolve({ id: asset.id, status: 'created' as const })),
      );
    await db
      .deleteFrom('album_asset')
      .where('albumId', '=', subscription.albumId!)
      .where('assetId', '=', asset.id)
      .execute();
    expect((await repo.items(operation.id))[0].suppression).toBe('subscription');
    expect(await db.selectFrom('asset').select('id').where('id', '=', asset.id).execute()).toHaveLength(1);
    await repo.updateSubscription(auth.user.id, subscription.id, { action: 'unsubscribe' });
    expect((await repo.subscription(auth.user.id, subscription.id)).status).toBe('unsubscribed');
    expect(await db.selectFrom('album').select('id').where('id', '=', subscription.albumId!).execute()).toHaveLength(1);
  });
});
