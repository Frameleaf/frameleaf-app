import { Kysely, sql } from 'kysely';
import { randomBytes } from 'node:crypto';
import type { DB } from 'src/schema/index.js';
import { AssetFileType, MediaOperationDestination, StudioExportScope, StudioExportVersionState } from 'src/enum.js';
import { canonicalTestContext, expectCanonicalTables } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db?.destroy();
});

const fixture = async () => {
  const ctx = canonicalTestContext(db);
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id });
  return { ctx, user, asset };
};
const eventRows = async (ownerId: string) =>
  (
    await sql<{ event: string; deliveryId: string; position: string; format: string | null }>`
  SELECT event,"deliveryId",position::text,format FROM connect_event WHERE "ownerId"=${ownerId}::uuid ORDER BY position
`.execute(db)
  ).rows;
const file = (assetId: string, type: AssetFileType) => ({ assetId, type, path: '/sanitized/fixture', isEdited: false });

describe('Connect transactional production on the canonical migration chain', () => {
  it('installs the event stream, event, readiness and cursor authorities', async () => {
    await expectCanonicalTables(db, [
      'connect_event_stream',
      'connect_event',
      'connect_asset_ready',
      'connect_event_cursor',
    ]);
  });
  it('emits ready only after metadata and both ordinary renditions; retries retain one delivery identity', async () => {
    const { user, asset } = await fixture();
    await db.insertInto('asset_file').values(file(asset.id, AssetFileType.Preview)).execute();
    await db.insertInto('asset_file').values(file(asset.id, AssetFileType.Thumbnail)).execute();
    expect(await eventRows(user.id)).toEqual([]);
    await db.insertInto('asset_job_status').values({ assetId: asset.id, metadataExtractedAt: new Date() }).execute();
    const events = await eventRows(user.id);
    expect(events.map(({ event }) => event)).toEqual(['asset.ready']);
    await db.updateTable('asset_file').set({ path: '/sanitized/retry' }).where('assetId', '=', asset.id).execute();
    expect(await eventRows(user.id)).toEqual(events);
  });
  it('rolls back the media mutation, readiness marker and event together', async () => {
    const { user, asset } = await fixture();
    await db.insertInto('asset_job_status').values({ assetId: asset.id, metadataExtractedAt: new Date() }).execute();
    await db.insertInto('asset_file').values(file(asset.id, AssetFileType.Preview)).execute();
    await expect(
      db.transaction().execute(async (tx) => {
        await tx.insertInto('asset_file').values(file(asset.id, AssetFileType.Thumbnail)).execute();
        throw new Error('simulated crash');
      }),
    ).rejects.toThrow('simulated crash');
    expect(await eventRows(user.id)).toEqual([]);
    await db.insertInto('asset_file').values(file(asset.id, AssetFileType.Thumbnail)).execute();
    expect((await eventRows(user.id)).map(({ event }) => event)).toEqual(['asset.ready']);
  });
  it('records only real album membership insertions and a new occurrence on re-add', async () => {
    const { ctx, user, asset } = await fixture();
    const { album } = await ctx.newAlbum({ ownerId: user.id });
    const membership = { albumId: album.id, assetId: asset.id };
    await db.insertInto('album_asset').values(membership).execute();
    await db
      .insertInto('album_asset')
      .values(membership)
      .onConflict((oc) => oc.doNothing())
      .execute();
    expect(await eventRows(user.id)).toHaveLength(1);
    await db.deleteFrom('album_asset').where('albumId', '=', album.id).execute();
    await db.insertInto('album_asset').values(membership).execute();
    expect(new Set((await eventRows(user.id)).map(({ deliveryId }) => deliveryId)).size).toBe(2);
  });
  it('records publication atomically and excludes project-only output', async () => {
    const { user, asset } = await fixture();
    const version = await db
      .insertInto('studio_export_version')
      .values({
        ownerId: user.id,
        projectId: null,
        revision: 1,
        revisionDigest: 'test',
        destination: MediaOperationDestination.Local,
        settings: { format: 'mp4-h264' },
        outputContentType: 'video/mp4',
        state: StudioExportVersionState.Staged,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await db
      .updateTable('studio_export_version')
      .set({ state: StudioExportVersionState.Published, scope: StudioExportScope.Project, publishedAt: new Date() })
      .where('id', '=', version.id)
      .execute();
    expect(await eventRows(user.id)).toEqual([]);
    const output = await db
      .insertInto('studio_export_version')
      .values({
        ownerId: user.id,
        projectId: null,
        revision: 1,
        revisionDigest: randomBytes(8).toString('hex'),
        destination: MediaOperationDestination.Local,
        settings: { format: 'mp4-h264' },
        outputContentType: 'video/mp4',
        state: StudioExportVersionState.Staged,
      })
      .returning('id')
      .executeTakeFirstOrThrow();
    await expect(
      db.transaction().execute(async (tx) => {
        await tx
          .updateTable('studio_export_version')
          .set({
            state: StudioExportVersionState.Published,
            scope: StudioExportScope.Library,
            resultAssetId: asset.id,
            publishedAt: new Date(),
          })
          .where('id', '=', output.id)
          .execute();
        throw new Error('rollback publication');
      }),
    ).rejects.toThrow('rollback publication');
    expect(await eventRows(user.id)).toEqual([]);
    await db
      .updateTable('studio_export_version')
      .set({
        state: StudioExportVersionState.Published,
        scope: StudioExportScope.Library,
        resultAssetId: asset.id,
        publishedAt: new Date(),
      })
      .where('id', '=', output.id)
      .execute();
    const events = await eventRows(user.id);
    expect(events.map(({ event, format }) => ({ event, format }))).toEqual([
      { event: 'studio.export.completed', format: 'video/mp4' },
    ]);
    await db.updateTable('studio_export_version').set({ updatedAt: new Date() }).where('id', '=', output.id).execute();
    expect(await eventRows(user.id)).toEqual(events);
  });
});

it('serializes simultaneous rendition publications without losing the ready transition', async () => {
  const { user, asset } = await fixture();
  await db.insertInto('asset_job_status').values({ assetId: asset.id, metadataExtractedAt: new Date() }).execute();
  let ready = 0;
  const barrier = Promise.withResolvers<void>();
  const publish = (type: AssetFileType) =>
    db.transaction().execute(async (tx) => {
      await sql`SELECT id FROM asset WHERE id=${asset.id}::uuid FOR KEY SHARE`.execute(tx);
      if (++ready === 2) barrier.resolve();
      await barrier.promise;
      await tx.insertInto('asset_file').values(file(asset.id, type)).execute();
    });
  await Promise.all([publish(AssetFileType.Preview), publish(AssetFileType.Thumbnail)]);
  expect((await eventRows(user.id)).map((e) => e.event)).toEqual(['asset.ready']);
});

it('deduplicates a stable source identity without moving the owner sequence', async () => {
  const { user, asset } = await fixture();
  const append = () =>
    sql`SELECT connect_event_append(${user.id}::uuid,'stable-source','asset.ready',${asset.id}::uuid,NULL,NULL,NULL)`.execute(
      db,
    );
  await Promise.all([append(), append()]);
  const events = await eventRows(user.id);
  expect(events).toHaveLength(1);
  expect(events[0].position).toBe('1');
  await append();
  expect(await eventRows(user.id)).toEqual(events);
});
