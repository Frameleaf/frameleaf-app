import { Kysely } from 'kysely';
import { createHash, randomBytes, randomUUID } from 'node:crypto';
import { mkdirSync } from 'node:fs';
import { copyFile, mkdtemp, rename, rm, stat, unlink } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import { AlbumUserRole } from 'src/enum.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { CryptoRepository } from 'src/repositories/crypto.repository.js';
import { HouseholdLinkRepository } from 'src/repositories/household-link.repository.js';
import { HouseholdReceiveRepository } from 'src/repositories/household-receive.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { HouseholdReceiveService } from 'src/services/household-receive.service.js';
import { mediumFactory, newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

type Item = { id: string; bytes: Buffer; description: string; stopped?: boolean };

/**
 * FL-994 against real PostgreSQL: a copy follows the sender until its owner edits it, and no protocol path removes
 * anything. The other household is a scripted peer; the tables, the edit hook and the asset rows are the real ones.
 */
describe('HouseholdReceiveService (medium)', () => {
  let database: Kysely<DB>;
  let media: string;

  beforeAll(async () => {
    database = await getActiveForkKyselyDB();
    media = await mkdtemp(join(tmpdir(), 'household-receive-medium-'));
    StorageCore.setMediaLocation(media);
  });
  afterAll(async () => {
    StorageCore.reset();
    await rm(media, { recursive: true, force: true });
  });

  const setup = async () => {
    const { ctx } = newMediumService(BaseService, {
      database,
      real: [AlbumRepository, AssetRepository, PersonRepository, UserRepository],
      mock: [LoggingRepository],
    });
    // `run` walks every link, and the scripted peer would answer for all of them
    await database.deleteFrom('household_link').execute();
    const links = new HouseholdLinkRepository(database);
    const receive = new HouseholdReceiveRepository(database);
    const partnerOrigin = new PartnerOriginRepository(database);
    const assets = ctx.get(AssetRepository);
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const link = await links.create({
      cloudLinkId: randomUUID(),
      peerInstanceId: randomUUID(),
      peerName: 'Anna',
      householdName: 'The Grandparents',
      peerPublicKey: 'k'.repeat(43),
    });

    const shareId = randomUUID();
    const items = new Map<string, Item>();
    const members = new Map<string, string>([
      [user.id, 'invited'],
      [other.id, 'invited'],
    ]);
    const entryOf = (item: Item, seq: number) =>
      item.stopped
        ? { seq, kind: 'asset', id: item.id, stop: true }
        : {
            seq,
            kind: 'asset',
            id: item.id,
            asset: {
              id: item.id,
              type: 'IMAGE',
              originalFileName: `${item.id}.jpg`,
              checksum: createHash('sha256').update(item.bytes).digest('hex'),
              size: item.bytes.length,
              fileCreatedAt: '2026-01-15T12:00:00.000Z',
              localDateTime: '2026-01-15T12:00:00.000Z',
              timeZone: 'UTC',
              description: item.description,
              rating: 4,
              latitude: 53.8,
              longitude: -1.5,
              city: 'Leeds',
              state: null,
              country: 'UK',
              width: 10,
              height: 10,
              duration: null,
              livePhotoVideoId: null,
              stackId: null,
              stackPrimary: false,
              updatedAt: '2026-01-16T12:00:00.000Z',
              download: { token: 'a.b.c', expiresAt: new Date(Date.now() + 600_000).toISOString() },
            },
          };
    const client = {
      connection: 'wan',
      get: vi.fn((path: string) => {
        if (path === 'handshake') {
          return Promise.resolve({ version: 1, name: 'Anna', maxOriginalBytes: 20 * 1024 ** 3 });
        }
        if (path === 'shares') {
          return Promise.resolve(
            members.size === 0
              ? []
              : [
                  {
                    id: shareId,
                    name: 'Family',
                    description: '',
                    ownerName: 'Anna',
                    members: [...members].map(([remoteUserId, state]) => ({ remoteUserId, role: 'viewer', state })),
                  },
                ],
          );
        }
        // the whole feed on one page, as a reader that starts over sees it
        const entries = items
          .values()
          .map((item, index) => entryOf(item, index + 1))
          .toArray();
        return Promise.resolve({
          version: 1,
          shareId,
          entries,
          nextCursor: String(entries.length),
          complete: true,
        });
      }),
      post: vi.fn(() => Promise.resolve({})),
      original: vi.fn((path: string) => {
        const id = path.split('/').at(-1)!;
        return Promise.resolve(new Response(items.get(id)!.bytes));
      }),
    };

    const assetMedia = {
      refuseDeletedByOwner: () => Promise.resolve(),
      uploadAsset: vi.fn(async (auth: any, dto: any, file: any, _sidecar: unknown, publication: any) => {
        const asset = await publication((tx: any) =>
          assets.create(
            mediumFactory.assetInsert({
              ownerId: auth.user.id,
              checksum: file.checksum,
              originalPath: file.originalPath,
              originalFileName: dto.filename,
            }),
            undefined,
            tx,
          ),
        );
        await assets.upsertExif({
          exif: { assetId: asset.id, fileSizeInByte: file.size },
          lockedPropertiesBehavior: 'override',
        });
        return { id: asset.id, status: AssetMediaStatus.CREATED };
      }),
    };
    const sut = new HouseholdReceiveService(
      receive,
      links,
      { peerClient: () => client } as never,
      assetMedia as never,
      assets,
      ctx.get(AlbumRepository),
      ctx.get(UserRepository),
      ctx.get(PersonRepository),
      { searchFaces: () => Promise.resolve([]) } as never,
      { getQueueHolds: () => Promise.resolve([]), queueAll: vi.fn() } as never,
      {
        findRecentByDedupeKey: () => Promise.resolve(null),
        create: (row: object) => Promise.resolve({ id: randomUUID(), createdAt: new Date(), readAt: null, ...row }),
      } as never,
      { clientSend: vi.fn() } as never,
      { emit: () => Promise.resolve() } as never,
      {
        mkdirSync: (path: string) => void mkdirSync(path, { recursive: true }),
        rename,
        stat,
        copyFile,
        unlink,
      } as never,
      new CryptoRepository(),
      { getEnv: () => ({}) } as never,
      {} as never,
      { setContext: vi.fn(), warn: vi.fn(), log: vi.fn(), debug: vi.fn(), error: vi.fn() } as never,
    );

    const addItem = (description = 'First') => {
      const item: Item = { id: randomUUID(), bytes: randomBytes(256), description };
      items.set(item.id, item);
      return item;
    };
    const shareOf = async (userId = user.id) => {
      const rows = await receive.getSharesOfUser(userId);
      return rows[0];
    };
    const authOf = (id: string) => ({ user: { id } }) as never;
    const accept = async (userId = user.id) => {
      const row = await shareOf(userId);
      await sut.accept(authOf(userId), row.id);
      members.set(userId, 'accepted');
      return shareOf(userId);
    };
    const pull = async (userId = user.id) => {
      const row = await shareOf(userId);
      await receive.updateShare(row.id, { nextPullAt: null, cursor: 0 });
      await sut.pull(link, (await receive.getShare(row.id))!);
      return shareOf(userId);
    };
    const copyId = async (remoteId: string, userId = user.id) =>
      (await receive.getOrigin({ linkId: link.id, remoteId, kind: 'asset', userId }))!.localId;
    const exifOf = (assetId: string) =>
      database.selectFrom('asset_exif').selectAll().where('assetId', '=', assetId).executeTakeFirstOrThrow();
    const assetRow = (id: string) =>
      database.selectFrom('asset').select(['id', 'deletedAt', 'status']).where('id', '=', id).executeTakeFirst();
    const inSpace = async (albumId: string, assetId: string) =>
      !!(await database
        .selectFrom('album_asset')
        .select('assetId')
        .where('albumId', '=', albumId)
        .where('assetId', '=', assetId)
        .executeTakeFirst());

    return {
      ctx,
      sut,
      link,
      links,
      receive,
      partnerOrigin,
      user,
      other,
      items,
      members,
      client,
      assetMedia,
      addItem,
      shareOf,
      accept,
      pull,
      copyId,
      exifOf,
      assetRow,
      inSpace,
    };
  };

  it('acceptance: a copy follows the sender until the recipient edits it, through the real edit hook', async () => {
    const t = await setup();
    const item = t.addItem('First');
    await t.sut.poll(t.link);
    const share = await t.accept();
    expect(share).toMatchObject({ state: 'accepted', spaceName: 'Family' });
    await t.pull();

    const id = await t.copyId(item.id);
    expect(await t.exifOf(id)).toMatchObject({ description: 'First', rating: 4, city: 'Leeds', country: 'UK' });
    expect(await t.inSpace(share.albumId!, id)).toBe(true);
    const album = await t.ctx.get(AlbumRepository).getById(share.albumId!, { withAssets: false }, t.user.id);
    expect(album).toMatchObject({ albumName: 'Family', description: 'From The Grandparents', kind: 'space' });
    expect(album?.albumUsers).toEqual([expect.objectContaining({ role: AlbumUserRole.Owner })]);

    item.description = 'Second';
    await t.pull();
    expect((await t.exifOf(id)).description).toBe('Second');

    // the recipient edits it: the value and the hook partner copies use, as AssetService does
    await t.partnerOrigin.withOriginEdit('asset', [id], ['description'], async (tx) => {
      await t.ctx
        .get(AssetRepository)
        .upsertExif({ exif: { assetId: id, description: 'Mine' }, lockedPropertiesBehavior: 'override' }, tx);
    });
    const origin = await t.receive.getOrigin({
      linkId: t.link.id,
      remoteId: item.id,
      kind: 'asset',
      userId: t.user.id,
    });
    expect(origin?.overriddenFields).toEqual(['description']);

    item.description = 'Third';
    await t.pull();
    const exif = await t.exifOf(id);
    expect(exif.description).toBe('Mine');
    // only that field became theirs
    expect(exif.city).toBe('Leeds');
  });

  it('T19: sender removal, deletion, a lock and unlinking leave every copy present and in the space', async () => {
    const t = await setup();
    const removed = t.addItem();
    const kept = t.addItem();
    await t.sut.poll(t.link);
    const share = await t.accept();
    await t.pull();
    const ids = [await t.copyId(removed.id), await t.copyId(kept.id)];

    removed.stopped = true;
    await t.pull();
    const stopped = await t.receive.getOrigin({
      linkId: t.link.id,
      remoteId: removed.id,
      kind: 'asset',
      userId: t.user.id,
    });
    expect(stopped?.followUntilEdited).toBe(false);

    await t.links.update(t.link.id, { state: 'ended', endedAt: new Date() });
    await t.sut.run();
    expect((await t.shareOf()).state).toBe('left');
    for (const id of ids) {
      expect(await t.assetRow(id)).toMatchObject({ id, deletedAt: null, status: 'active' });
      expect(await t.inSpace(share.albumId!, id)).toBe(true);
    }
    const rows = await t.receive.getOrigin({ linkId: t.link.id, remoteId: kept.id, kind: 'asset', userId: t.user.id });
    expect(rows?.followUntilEdited).toBe(false);
  });

  it('a permanently deleted copy is not created again: its origin row stays as the tombstone', async () => {
    const t = await setup();
    const item = t.addItem();
    await t.sut.poll(t.link);
    await t.accept();
    await t.pull();
    const id = await t.copyId(item.id);

    await t.ctx.get(AssetRepository).remove({ id });
    expect(await t.assetRow(id)).toBeUndefined();
    item.description = 'Changed';
    await t.pull();

    expect(t.assetMedia.uploadAsset).toHaveBeenCalledTimes(1);
    expect(await t.copyId(item.id)).toBe(id);
    expect(await t.assetRow(id)).toBeUndefined();
  });

  it('acceptance: a person removed stops receiving while another member of the household continues', async () => {
    const t = await setup();
    const first = t.addItem('First');
    await t.sut.poll(t.link);
    await t.accept();
    await t.accept(t.other.id);
    await t.pull();
    await t.pull(t.other.id);

    t.members.delete(t.user.id);
    await t.sut.poll(t.link);
    expect((await t.shareOf()).state).toBe('left');
    expect((await t.shareOf(t.other.id)).state).toBe('accepted');

    first.description = 'After removal';
    const second = t.addItem('New');
    await t.sut.run();
    await t.pull(t.other.id);

    expect((await t.exifOf(await t.copyId(first.id))).description).toBe('First');
    await expect(
      t.receive.getOrigin({ linkId: t.link.id, remoteId: second.id, kind: 'asset', userId: t.user.id }),
    ).resolves.toBeUndefined();
    expect((await t.exifOf(await t.copyId(first.id, t.other.id))).description).toBe('After removal');
    expect(await t.copyId(second.id, t.other.id)).toBeDefined();
  });

  it('leaving one share keeps following what another share of the same person still holds', async () => {
    const t = await setup();
    const item = t.addItem();
    await t.sut.poll(t.link);
    const share = await t.accept();
    await t.pull();
    const second = await t.receive.createInvited({
      linkId: t.link.id,
      remoteShareId: randomUUID(),
      userId: t.user.id,
      spaceName: 'Second',
      ownerName: 'Anna',
    });
    await t.receive.updateShare(second!.id, { state: 'accepted' });
    const key = { linkId: t.link.id, remoteId: item.id, kind: 'asset' as const, userId: t.user.id };
    await t.receive.addOriginShare(key, second!.id);

    await t.receive.leaveOrigins(share);
    expect(await t.receive.getOrigin(key)).toMatchObject({ followUntilEdited: true, shareIds: [second!.id] });

    await t.receive.updateShare(second!.id, { state: 'left' });
    await t.receive.leaveOrigins(second!);
    expect(await t.receive.getOrigin(key)).toMatchObject({ followUntilEdited: false, shareIds: [] });
  });

  it('T20: a person lands on detected faces of the copies only, and face boxes survive as jsonb', async () => {
    const t = await setup();
    const item = t.addItem();
    await t.sut.poll(t.link);
    await t.accept();
    await t.pull();
    const id = await t.copyId(item.id);
    const { assetFace } = await t.ctx.newAssetFace({
      assetId: id,
      boundingBoxX1: 10,
      boundingBoxY1: 10,
      boundingBoxX2: 50,
      boundingBoxY2: 50,
      imageWidth: 100,
      imageHeight: 100,
    });
    // a face on the recipient's own photo, at the same place, which no manifest may reach
    const { asset: own } = await t.ctx.newAsset({ ownerId: t.user.id });
    const { assetFace: ownFace } = await t.ctx.newAssetFace({
      assetId: own.id,
      boundingBoxX1: 10,
      boundingBoxY1: 10,
      boundingBoxX2: 50,
      boundingBoxY2: 50,
      imageWidth: 100,
      imageHeight: 100,
    });
    const remote = randomUUID();
    const boxes = [
      { assetId: item.id, x1: 11, y1: 11, x2: 49, y2: 49, width: 100, height: 100 },
      { assetId: own.id, x1: 11, y1: 11, x2: 49, y2: 49, width: 100, height: 100 },
    ];
    await t.receive.savePendingPerson(t.link.id, t.user.id, remote, 'Nana', boxes);
    const [pending] = await t.receive.getPendingPeople(t.link.id);
    expect(pending.faces).toEqual(boxes);

    await t.sut.resolvePerson(t.link.id, t.user.id, remote, pending.name, pending.faces);

    const origin = await t.receive.getOrigin({
      linkId: t.link.id,
      remoteId: remote,
      kind: 'person',
      userId: t.user.id,
    });
    expect(origin).toMatchObject({ isCopy: true, followUntilEdited: true });
    const face = (faceId: string) =>
      database.selectFrom('asset_face').select('personGroupId').where('id', '=', faceId).executeTakeFirstOrThrow();
    expect((await face(assetFace.id!)).personGroupId).toBe(origin!.localId);
    expect((await face(ownFace.id!)).personGroupId).toBeNull();
    await expect(
      t.ctx.get(PersonRepository).getByGroupId({ ownerId: t.user.id, personGroupId: origin!.localId }),
    ).resolves.toMatchObject({ name: 'Nana' });

    // the same edit hook makes the name the recipient's own
    await t.partnerOrigin.markPersonOverridden(t.user.id, [origin!.localId], ['name']);
    expect(
      (await t.receive.getOrigin({ linkId: t.link.id, remoteId: remote, kind: 'person', userId: t.user.id }))
        ?.overriddenFields,
    ).toEqual(['name']);
  });

  it('holds one pull per share, and an unknown id in the list makes no row', async () => {
    const t = await setup();
    t.members.set(randomUUID(), 'invited');
    await t.sut.poll(t.link);
    await expect(
      database.selectFrom('household_inbound_share').select('userId').where('linkId', '=', t.link.id).execute(),
    ).resolves.toHaveLength(2);
    const share = await t.accept();
    await expect(t.receive.claimPull(share.id, 60_000)).resolves.toBe(true);
    await expect(t.receive.claimPull(share.id, 60_000)).resolves.toBe(false);
    await t.receive.updateShare(share.id, { pullingUntil: null });
    await expect(t.receive.claimPull(share.id, 60_000)).resolves.toBe(true);
  });

  it('saves the cursor and resumes after a bad page, writing nothing from it', async () => {
    const t = await setup();
    const item = t.addItem();
    await t.sut.poll(t.link);
    await t.accept();
    const real = t.client.get.getMockImplementation()!;
    t.client.get.mockImplementation(async (path: string) => {
      const reply: any = await real(path);
      if (path.endsWith('manifest')) {
        reply.entries[0].asset.latitude = 900;
      }
      return reply;
    });
    const refused = await t.pull();
    expect(refused).toMatchObject({ lastError: 'bad-page', cursor: 0, failures: 1 });
    await expect(
      t.receive.getOrigin({ linkId: t.link.id, remoteId: item.id, kind: 'asset', userId: t.user.id }),
    ).resolves.toBeUndefined();

    t.client.get.mockImplementation(real);
    const after = await t.pull();
    expect(after).toMatchObject({ lastError: null, failures: 0, cursor: 1 });
  });
});
