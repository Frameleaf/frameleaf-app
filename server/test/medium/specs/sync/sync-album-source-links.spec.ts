import { Kysely } from 'kysely';
import { AlbumSourceKind } from 'src/dtos/album-source.dto.js';
import { SyncEntityType, SyncRequestType } from 'src/enum.js';
import { AlbumSourceRepository } from 'src/repositories/album-source.repository.js';
import { DB } from 'src/schema/index.js';
import { SyncTestContext } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getActiveForkKyselyDB();
});
const types = [SyncRequestType.AlbumSourceLinksV1];
const events = (rows: any[]) => rows.filter((row) => row.type !== SyncEntityType.SyncCompleteV1);

describe(SyncRequestType.AlbumSourceLinksV1, () => {
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
