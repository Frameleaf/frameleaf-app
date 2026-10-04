import { Kysely } from 'kysely';
import request from 'supertest';
import { SyncController } from 'src/controllers/sync.controller.js';
import { AlbumSourceKind } from 'src/dtos/album-source.dto.js';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { GlobalExceptionFilter } from 'src/middleware/global-exception.filter.js';
import { AlbumSourceRepository } from 'src/repositories/album-source.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncService } from 'src/services/sync.service.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { controllerSetup, getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
const types = [SyncRequestType.AlbumSourceLinksV1];
const events = (rows: any[]) => rows.filter((row) => row.type !== SyncEntityType.SyncCompleteV1);

describe(SyncRequestType.AlbumSourceLinksV1, () => {
  it('keeps source-link checkpoints out of the legacy GET /sync/ack response without losing resume state', async () => {
    const ctx = new SyncTestContext(db);
    const { auth, user, session } = await ctx.newSyncAuthUser();
    const { auth: otherAuth } = await ctx.newSyncAuthUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Private source' });
    const links = new AlbumSourceRepository(db);
    const id = await links.write((tx) =>
      links.create(tx, {
        userId: user.id,
        albumId: album.id,
        kind: AlbumSourceKind.IosPhotos,
        sourceId: 'private-cloud-source',
        deviceKey: null,
        name: 'Private source',
      }),
    );
    const http = await controllerSetup(SyncController, [
      { provide: SyncService, useValue: ctx.sut },
      { provide: GlobalExceptionFilter, useValue: { handleError: vi.fn() } },
    ]);
    // Authentication selects the real database session; sync handlers and repositories remain real.
    http.authenticate.mockResolvedValue(auth);

    try {
      const legacy = events(await ctx.syncStream(auth, [SyncRequestType.AuthUsersV1]));
      expect(legacy).toEqual([expect.objectContaining({ type: SyncEntityType.AuthUserV1, ack: expect.any(String) })]);
      const legacyAck = { type: SyncEntityType.AuthUserV1, ack: legacy[0].ack };
      await ctx.syncAckAll(auth, legacy);

      const created = events(await ctx.syncStream(auth, types));
      expect(created).toEqual([
        expect.objectContaining({ type: SyncEntityType.AlbumSourceLinkV1, data: expect.objectContaining({ id }) }),
      ]);
      expect(events(await ctx.syncStream(otherAuth, types))).toEqual([]);
      await request(http.getHttpServer())
        .post('/sync/ack')
        .send({ acks: [created[0].ack] })
        .expect(204);
      await ctx.assertSyncIsComplete(auth, types);

      await links.write((tx) => links.delete(tx, id));
      const deleted = events(await ctx.syncStream(auth, types));
      expect(deleted).toEqual([
        expect.objectContaining({ type: SyncEntityType.AlbumSourceLinkDeleteV1, data: { linkId: id } }),
      ]);
      await request(http.getHttpServer())
        .post('/sync/ack')
        .send({ acks: [deleted[0].ack] })
        .expect(204);
      await ctx.assertSyncIsComplete(auth, types);

      const stored = await db
        .selectFrom('session_sync_checkpoint')
        .select(['type', 'ack'])
        .where('sessionId', '=', session.id)
        .execute();
      expect(stored).toEqual(
        expect.arrayContaining([
          legacyAck,
          { type: SyncEntityType.AlbumSourceLinkV1, ack: created[0].ack },
          { type: SyncEntityType.AlbumSourceLinkDeleteV1, ack: deleted[0].ack },
        ]),
      );

      const { body } = await request(http.getHttpServer()).get('/sync/ack').expect(200);
      expect(body).toContainEqual(legacyAck);
      expect(body.filter(({ type }: { type: string }) => type.startsWith('AlbumSourceLink'))).toEqual([]);

      const { body: fullView } = await request(http.getHttpServer()).get('/sync/ack/v2').expect(200);
      expect(fullView).toHaveLength(stored.length);
      expect(fullView).toEqual(expect.arrayContaining(stored));
      expect(fullView).toContainEqual({ type: SyncEntityType.AlbumSourceLinkV1, ack: created[0].ack });
      expect(fullView).toContainEqual({ type: SyncEntityType.AlbumSourceLinkDeleteV1, ack: deleted[0].ack });

      // Neither another user nor another session belonging to this owner inherits these checkpoints.
      http.authenticate.mockResolvedValue(otherAuth);
      const { body: otherView } = await request(http.getHttpServer()).get('/sync/ack/v2').expect(200);
      expect(otherView).toEqual([]);
      const { session: otherSession } = await ctx.newSession({ userId: user.id });
      http.authenticate.mockResolvedValue({ ...auth, session: otherSession });
      const { body: otherSessionView } = await request(http.getHttpServer()).get('/sync/ack/v2').expect(200);
      expect(otherSessionView).toEqual([]);

      http.authenticate.mockResolvedValue({ ...auth, session: undefined });
      await request(http.getHttpServer()).get('/sync/ack/v2').expect(403);
    } finally {
      await http.close();
    }
  });

  it('sends links, their changes and their removal, and only the owner’s', async () => {
    const ctx = new SyncTestContext(db);
    const { auth, user } = await ctx.newSyncAuthUser();
    const { auth: otherAuth } = await ctx.newSyncAuthUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Trip' });
    const links = new AlbumSourceRepository(db);
    const id = await links.write((tx) =>
      links.create(tx, {
        userId: user.id,
        albumId: album.id,
        kind: AlbumSourceKind.IosPhotos,
        sourceId: 'cloud-1',
        deviceKey: null,
        name: 'Trip',
      }),
    );

    const first = await ctx.syncStream(auth, types);
    expect(events(first)).toEqual([
      {
        type: SyncEntityType.AlbumSourceLinkV1,
        ack: expect.any(String),
        data: expect.objectContaining({
          id,
          albumId: album.id,
          kind: 'ios-photos',
          sourceId: 'cloud-1',
          deviceKey: null,
          lastSourceName: 'Trip',
        }),
      },
    ]);
    expect(events(first)[0].data).not.toHaveProperty('albumName');
    expect(events(await ctx.syncStream(otherAuth, types))).toEqual([]);
    await ctx.syncAckAll(auth, first);
    await ctx.assertSyncIsComplete(auth, types);

    await links.write((tx) => links.update(tx, id, { lastSourceName: 'Trip 2026' }));
    const updated = await ctx.syncStream(auth, types);
    expect(events(updated)).toEqual([
      expect.objectContaining({
        type: SyncEntityType.AlbumSourceLinkV1,
        data: expect.objectContaining({ id, lastSourceName: 'Trip 2026' }),
      }),
    ]);
    await ctx.syncAckAll(auth, updated);

    await links.write((tx) => links.delete(tx, id));
    const deleted = await ctx.syncStream(auth, types);
    expect(events(deleted)).toEqual([
      expect.objectContaining({ type: SyncEntityType.AlbumSourceLinkDeleteV1, data: { linkId: id } }),
    ]);
    await ctx.syncAckAll(auth, deleted);
    await ctx.assertSyncIsComplete(auth, types);
  });

  it('removes a link whose album was deleted', async () => {
    const ctx = new SyncTestContext(db);
    const { auth, user } = await ctx.newSyncAuthUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Short' });
    const links = new AlbumSourceRepository(db);
    const id = await links.write((tx) =>
      links.create(tx, {
        userId: user.id,
        albumId: album.id,
        kind: AlbumSourceKind.AndroidFolder,
        sourceId: '7:DCIM/Short',
        deviceKey: 'android',
        name: 'Short',
      }),
    );
    await ctx.syncAckAll(auth, await ctx.syncStream(auth, types));

    await db.updateTable('album').set({ deletedAt: new Date() }).where('id', '=', album.id).execute();
    expect(events(await ctx.syncStream(auth, types))).toEqual([
      expect.objectContaining({ type: SyncEntityType.AlbumSourceLinkDeleteV1, data: { linkId: id } }),
    ]);
  });
});
