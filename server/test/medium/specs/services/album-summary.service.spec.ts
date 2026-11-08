import { Kysely, sql } from 'kysely';
import { AlbumUserRole, AssetLockReason, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AlbumSummaryRepository, uuidV7Floor } from 'src/repositories/album-summary.repository.js';
import { AlbumRepository } from 'src/repositories/album.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ClassificationRepository } from 'src/repositories/classification.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { FrameleafUserLicenseRepository } from 'src/repositories/frameleaf-user-license.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PartnerOriginRepository } from 'src/repositories/partner-origin.repository.js';
import { PartnerRepository } from 'src/repositories/partner.repository.js';
import { SmartAlbumRepository } from 'src/repositories/smart-album.repository.js';
import { SystemMetadataRepository } from 'src/repositories/system-metadata.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { AlbumService } from 'src/services/album.service.js';
import { albumViewerKey } from 'src/utils/album-viewer-key.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB as getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const services = newMediumService(AlbumService, {
    database: defaultDatabase,
    real: [
      AccessRepository,
      AlbumRepository,
      AlbumSummaryRepository,
      AssetRepository,
      ClassificationRepository,
      PartnerOriginRepository,
      PartnerRepository,
      SmartAlbumRepository,
      UserRepository,
      FrameleafUserLicenseRepository,
      SystemMetadataRepository,
    ],
    mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
  });
  services.ctx.getMock(EventRepository).emit.mockResolvedValue();
  return services;
};

/** A plain session and a PIN-unlocked one for the same person. */
const sessionsOf = (userId: string) => ({
  plain: factory.auth({ user: { id: userId }, session: { hasElevatedPermission: false } }),
  elevated: factory.auth({ user: { id: userId }, session: { hasElevatedPermission: true } }),
});

const firstAlbum = async (sut: AlbumService, auth: ReturnType<typeof factory.auth>) =>
  (await sut.getTree(auth)).albums[0];

/** The stored rows of one album. A refresh is never awaited by the read that started it. */
const rowsOf = async (albumId: string) => {
  const { rows } = await sql<{ assetCount: number; viewerKey: string }>`
    SELECT "assetCount", "viewerKey" FROM album_summary WHERE "albumId" = ${albumId}::uuid
  `.execute(defaultDatabase);
  return rows;
};

const waitForRows = (albumId: string, count: number) =>
  vi.waitFor(async () => expect(await rowsOf(albumId)).toHaveLength(count), { timeout: 10_000, interval: 25 });

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe('album summaries are kept per viewer (FL-1297)', () => {
  it('never gives a session without its PIN the counts stored for a PIN-unlocked one', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset: visible } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: locked } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [visible.id, locked.id]);
    const { plain, elevated } = sessionsOf(owner.id);

    // The first read of a variant does not wait for its numbers.
    expect(await firstAlbum(sut, elevated)).toMatchObject({ assetCount: 0, statsPending: true });
    await waitForRows(album.id, 1);
    expect(await firstAlbum(sut, elevated)).toMatchObject({ assetCount: 2 });

    // The row written for the unlocked session exists, and the plain session does not get it.
    expect(await firstAlbum(sut, plain)).toMatchObject({ assetCount: 0, statsPending: true });
    await waitForRows(album.id, 2);

    const seenByPlain = await firstAlbum(sut, plain);
    expect(seenByPlain.assetCount).toBe(1);
    expect(seenByPlain.statsPending).toBeUndefined();
    expect((await firstAlbum(sut, elevated)).assetCount).toBe(2);

    const counts = (await rowsOf(album.id)).map(({ assetCount }) => assetCount).toSorted((a, b) => a - b);
    expect(counts).toEqual([1, 2]);
  });

  it('keeps another member of a shared album on their own row', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: member } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: locked } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id, locked.id]);
    await ctx.newAlbumUser({ albumId: album.id, userId: member.id, role: AlbumUserRole.Viewer });

    const { elevated } = sessionsOf(owner.id);
    await sut.getTree(elevated);
    await waitForRows(album.id, 1);

    const memberSession = factory.auth({ user: { id: member.id }, session: { hasElevatedPermission: true } });
    const firstRead = (await sut.getTree(memberSession)).albums[0];
    expect(firstRead).toMatchObject({ assetCount: 0, statsPending: true });
    await waitForRows(album.id, 2);
    expect((await sut.getTree(memberSession)).albums[0].assetCount).toBe(1);
  });

  it('keeps a session that hides sensitive items apart from one that does not', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);

    const shows = factory.auth({ user: { id: owner.id }, session: { hasElevatedPermission: false } });
    const hides = { ...shows, hideNsfwAssets: true };

    await sut.getTree(shows);
    await waitForRows(album.id, 1);
    expect(await firstAlbum(sut, hides)).toMatchObject({ assetCount: 0, statsPending: true });
    await waitForRows(album.id, 2);
  });
});

describe('album summaries are stored and refreshed in the background (FL-1297)', () => {
  it('stores an album with no visible item, which then stops being pending and renders as empty', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset: locked } = await ctx.newAsset({ ownerId: owner.id, visibility: AssetVisibility.Locked });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [locked.id]);
    const { album: empty } = await ctx.newAlbum({ ownerId: owner.id }, []);
    const { plain } = sessionsOf(owner.id);

    await sut.getTree(plain);
    await waitForRows(album.id, 1);
    await waitForRows(empty.id, 1);

    const albums = (await sut.getTree(plain)).albums;
    expect(albums.map(({ assetCount }) => assetCount)).toEqual([0, 0]);
    expect(albums.every(({ statsPending }) => statsPending === undefined)).toBe(true);
  });

  it('stores the same dates the album page reads live', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset: first } = await ctx.newAsset({
      ownerId: owner.id,
      localDateTime: new Date('2021-03-05T22:30:00.000Z'),
    });
    const { asset: last } = await ctx.newAsset({
      ownerId: owner.id,
      localDateTime: new Date('2021-07-09T01:15:00.000Z'),
    });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [first.id, last.id]);
    const { plain } = sessionsOf(owner.id);
    await sut.getTree(plain);
    await waitForRows(album.id, 1);

    const listed = await firstAlbum(sut, plain);
    const opened = await sut.get(plain, album.id);

    expect(listed.startDate).toEqual(opened.startDate);
    expect(listed.endDate).toEqual(opened.endDate);
    expect(listed.lastModifiedAssetTimestamp).toEqual(opened.lastModifiedAssetTimestamp);
    expect(listed.assetCount).toBe(2);
  });

  /** A row already stored for this person's plain session, as if a refresh had written it `age` ago. */
  const storeRow = async (albumId: string, ownerId: string, age: string) => {
    const viewerKey = albumViewerKey({ othersRulesViewerId: ownerId });
    await sql`
      INSERT INTO album_summary ("albumId", "viewerKey", "assetCount", "computedAt")
      VALUES (${albumId}::uuid, ${viewerKey}, 99, now() - ${age}::interval)
    `.execute(defaultDatabase);
  };

  const storedCount = async (albumId: string) => (await rowsOf(albumId))[0]?.assetCount;

  it('recomputes a stored row older than a day, which covers rules that change no item', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
    await storeRow(album.id, owner.id, '25 hours');

    // A stale tile is shown while the refresh it started runs.
    expect((await firstAlbum(sut, sessionsOf(owner.id).plain)).assetCount).toBe(99);
    await vi.waitFor(async () => expect(await storedCount(album.id)).toBe(1), { timeout: 10_000, interval: 25 });
  });

  it('leaves alone a row with nothing new since it was computed', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
    // Computed after the album was filled by more than the margin for slow commits.
    await storeRow(album.id, owner.id, '-10 minutes');
    const summaries = ctx.get(AlbumSummaryRepository);
    const upsert = vi.spyOn(summaries, 'upsert');
    const changed = vi.spyOn(summaries, 'getChangedAt');

    await sut.getTree(sessionsOf(owner.id).plain);

    await vi.waitFor(() => expect(changed).toHaveBeenCalled(), { timeout: 10_000, interval: 25 });
    await expect(changed.mock.results[0].value).resolves.toBeDefined();
    expect(upsert).not.toHaveBeenCalled();
    expect(await storedCount(album.id)).toBe(99);
  });

  it('recomputes a stored row once an item is added after it', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, []);
    await storeRow(album.id, owner.id, '1 hour');
    await ctx.newAlbumAsset({ albumId: album.id, assetId: asset.id });

    await sut.getTree(sessionsOf(owner.id).plain);

    await vi.waitFor(async () => expect(await storedCount(album.id)).toBe(1), { timeout: 10_000, interval: 25 });
  });

  it('does not make the list wait for a refresh', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);
    let release = () => {};
    const blocked = new Promise<void>((resolve) => (release = resolve));
    const live = ctx.get(AlbumRepository);
    const original = live.getMetadataForIds.bind(live);
    vi.spyOn(live, 'getMetadataForIds').mockImplementation(async (...args) => {
      await blocked;
      return original(...args);
    });

    // With the refresh stuck, the read still answers.
    expect((await sut.getTree(sessionsOf(owner.id).plain)).albums[0]).toMatchObject({ statsPending: true });
    release();
    await waitForRows(album.id, 1);
  });
});

describe(AlbumSummaryRepository.name, () => {
  const changedSet = async (repository: AlbumSummaryRepository, ids: string[], since: Date) =>
    new Set((await repository.getChangedAt(ids, since)).map(({ albumId }) => albumId));

  it('finds an album by the items added to it, removed from it, or changed in it', async () => {
    const { ctx } = setup();
    const repository = ctx.get(AlbumSummaryRepository);
    const albums = ctx.get(AlbumRepository);
    const { user: owner } = await ctx.newUser();
    const { asset: kept } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: added } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: removed } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: edited } = await ctx.newAsset({ ownerId: owner.id });
    const { album: gained } = await ctx.newAlbum({ ownerId: owner.id }, [kept.id]);
    const { album: lost } = await ctx.newAlbum({ ownerId: owner.id }, [removed.id]);
    const { album: changed } = await ctx.newAlbum({ ownerId: owner.id }, [edited.id]);
    const { album: untouched } = await ctx.newAlbum({ ownerId: owner.id }, [kept.id]);
    const ids = [gained.id, lost.id, changed.id, untouched.id];

    await new Promise((resolve) => setTimeout(resolve, 10));
    const since = new Date();
    await new Promise((resolve) => setTimeout(resolve, 10));
    expect(await changedSet(repository, ids, since)).toEqual(new Set());

    await albums.addAssetIds(gained.id, [added.id]);
    await albums.removeAssetIds(lost.id, [removed.id]);
    await ctx.get(AssetRepository).update({ id: edited.id, isFavorite: true });

    expect(await changedSet(repository, ids, since)).toEqual(new Set([gained.id, lost.id, changed.id]));
  });

  it('notices a photo being locked, which no album row records', async () => {
    const { ctx } = setup();
    const repository = ctx.get(AlbumSummaryRepository);
    const { user: owner } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: owner.id });
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, [asset.id]);

    await new Promise((resolve) => setTimeout(resolve, 10));
    const since = new Date();
    await new Promise((resolve) => setTimeout(resolve, 10));
    await ctx.get(AssetRepository).lock([asset.id], AssetLockReason.Marked, owner.id);

    expect(await changedSet(repository, [album.id], since)).toEqual(new Set([album.id]));
  });

  it('stores a zero for an album the read found nothing in', async () => {
    const { ctx } = setup();
    const repository = ctx.get(AlbumSummaryRepository);
    const { user: owner } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, []);

    await repository.upsert('viewer', new Date(), [album.id], []);

    expect(await repository.getByIds('viewer', [album.id])).toEqual([
      expect.objectContaining({ albumId: album.id, assetCount: 0, startDate: null, endDate: null }),
    ]);
  });

  it('removes the rows when the album is deleted', async () => {
    const { ctx } = setup();
    const repository = ctx.get(AlbumSummaryRepository);
    const { user: owner } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, []);
    await repository.upsert('viewer', new Date(), [album.id], []);

    await defaultDatabase.deleteFrom('album').where('id', '=', album.id).execute();

    expect(await repository.getByIds('viewer', [album.id])).toEqual([]);
  });

  it('clears only rows older than the cut-off', async () => {
    const { ctx } = setup();
    const repository = ctx.get(AlbumSummaryRepository);
    const { user: owner } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: owner.id }, []);
    const now = Date.now();
    await repository.upsert('old', new Date(now - 60_000), [album.id], []);
    await repository.upsert('recent', new Date(now), [album.id], []);

    await repository.deleteComputedBefore(new Date(now - 30_000));

    expect(await repository.getByIds('old', [album.id])).toEqual([]);
    expect(await repository.getByIds('recent', [album.id])).toHaveLength(1);
  });
});

describe(uuidV7Floor.name, () => {
  it('sorts below every id made in that millisecond or later, and above earlier ones', async () => {
    const at = new Date();
    const { rows } = await sql<{ earlier: string; same: string; later: string }>`
      SELECT immich_uuid_v7(${new Date(at.getTime() - 1)}::timestamptz) AS earlier,
        immich_uuid_v7(${at}::timestamptz) AS same,
        immich_uuid_v7(${new Date(at.getTime() + 1)}::timestamptz) AS later
    `.execute(defaultDatabase);
    const floor = uuidV7Floor(at);
    expect(rows[0].earlier < floor).toBe(true);
    expect(rows[0].same >= floor).toBe(true);
    expect(rows[0].later > floor).toBe(true);
  });
});
