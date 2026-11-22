import { BadRequestException, NotFoundException } from '@nestjs/common';
import { Kysely, sql } from 'kysely';
import { createHash, randomUUID } from 'node:crypto';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import type { AuthDto } from 'src/dtos/auth.dto.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { AssetMediaStatus } from 'src/dtos/asset-media-response.dto.js';
import {
  FAKE_PROVIDER,
  type FakeRemoteFile,
  FakeRemoteSource,
  fakeRemoteSourceProvider,
} from 'src/import-connectors/fake.source.js';
import { registerRemoteSource, unregisterRemoteSource } from 'src/import-connectors/remote-source.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { ImportConnectorRepository } from 'src/repositories/import-connector.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { TakeoutStagingRepository } from 'src/repositories/takeout-staging.repository.js';
import { TakeoutRepository } from 'src/repositories/takeout.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { ImportConnectorWorkerService } from 'src/services/import-connector-worker.service.js';
import { ImportConnectorService } from 'src/services/import-connector.service.js';
import { TakeoutWorkerService } from 'src/services/takeout-worker.service.js';
import { TAKEOUT_DEFAULT_OPTIONS } from 'src/utils/takeout.js';
import { newMediumService } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

/**
 * FL-920 on PostgreSQL: the connection, run and seen-file queries, the real job queue and real
 * staging, with the fake source. The library's own services are stood in for by direct inserts, so
 * what is proved here is the framework and its use of the Google Photos import path; the whole
 * product path runs in `e2e/src/specs/server/api/import-connector.e2e-spec.ts`.
 */

const SECRET = 'hunter2-app-password';
const bytes = (text: string) => Buffer.from(text).toString('base64');
const digest = (algorithm: string, data: string) => createHash(algorithm).update(Buffer.from(data, 'base64')).digest();

let db: Kysely<DB>;
let directory: string;

beforeAll(async () => {
  db = await getActiveForkKyselyDB();
  directory = await mkdtemp(join(tmpdir(), 'frameleaf-import-connector-'));
  StorageCore.setMediaLocation(directory);
}, 60_000);

afterAll(async () => {
  unregisterRemoteSource(FAKE_PROVIDER);
  await db?.destroy();
  if (directory) {
    await rm(directory, { recursive: true, force: true });
  }
});

const setup = async () => {
  const { ctx } = newMediumService(BaseService, {
    database: db,
    real: [UserRepository, AccessRepository],
    mock: [LoggingRepository],
  });
  const { user } = await ctx.newUser();
  const { user: other } = await ctx.newUser();
  const authOf = (id: string): AuthDto =>
    ({
      user: {
        id,
        isAdmin: false,
        name: 'Owner',
        email: `${id}@example.com`,
        quotaUsageInBytes: 0,
        quotaSizeInBytes: null,
      },
      session: { id: randomUUID() },
    }) as AuthDto;

  // One source instance stands for the remote, so a test can change what is there between scans.
  const source = new FakeRemoteSource([]);
  registerRemoteSource({ ...fakeRemoteSourceProvider, open: () => source });

  const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };
  const crypto = { randomUUID, serverKeyedHash: vi.fn().mockResolvedValue('keyed-hash') };
  const config = { getEnv: () => ({ frameleafCloud: { identityDir: directory }, storage: { importRoots: [] } }) };
  const repository = new ImportConnectorRepository(db);
  const takeout = new TakeoutRepository(db);
  const operations = new MediaOperationRepository(db);
  const staging = new TakeoutStagingRepository();
  vi.spyOn(staging, 'freeBytes').mockResolvedValue(10 * 1024 ** 4);

  const service = new ImportConnectorService(
    logger as never,
    repository,
    takeout,
    { pause: vi.fn(), resume: vi.fn(), cancel: vi.fn() } as never,
    ctx.get(AccessRepository),
    crypto as never,
    config as never,
  );
  const connectors = new ImportConnectorWorkerService(
    logger as never,
    repository,
    takeout,
    staging,
    crypto as never,
    config as never,
  );

  // The library, as far as the import path uses it: real rows, written directly.
  const uploadAsset = vi.fn(
    async (
      auth: AuthDto,
      dto: { filename: string; isFavorite?: boolean },
      file: { checksum: Buffer; originalPath: string },
    ) => {
      const { asset } = await ctx.newAsset({
        ownerId: auth.user.id,
        checksum: file.checksum,
        originalPath: file.originalPath,
        originalFileName: dto.filename,
        isFavorite: dto.isFavorite === true,
      });
      return { id: asset.id, status: AssetMediaStatus.CREATED };
    },
  );
  const assetMedia = {
    uploadAsset,
    needsOriginal: vi.fn().mockResolvedValue(false),
    bulkUploadCheck: vi.fn(async (auth: AuthDto, dto: { assets: Array<{ id: string; checksum: string }> }) => ({
      results: await Promise.all(
        dto.assets.map(async ({ id, checksum }) => ({
          id,
          assetId: (
            await db
              .selectFrom('asset')
              .select('id')
              .where('ownerId', '=', auth.user.id)
              .where('checksum', '=', Buffer.from(checksum, 'hex'))
              .executeTakeFirst()
          )?.id,
        })),
      ),
    })),
  };
  const assets = {
    lock: vi.fn(),
    fillMissingMetadata: vi.fn().mockResolvedValue(true),
    update: vi.fn(async (_auth: AuthDto, id: string, update: { description?: string; isFavorite?: boolean }) => {
      if (update.description !== undefined) {
        await ctx.newExif({ assetId: id, description: update.description });
      }
      if (update.isFavorite) {
        await db.updateTable('asset').set({ isFavorite: true }).where('id', '=', id).execute();
      }
    }),
  };
  const albums = {
    create: vi.fn(async (auth: AuthDto, dto: { albumName: string }) => {
      const { album } = await ctx.newAlbum({ ownerId: auth.user.id, albumName: dto.albumName });
      return { id: album.id };
    }),
    addAssets: vi.fn(async (_auth: AuthDto, albumId: string, dto: { ids: string[] }) => {
      for (const assetId of dto.ids) {
        await ctx.newAlbumAsset({ albumId, assetId });
      }
      return dto.ids.map((id) => ({ id, success: true }));
    }),
    delete: vi.fn(),
  };
  const worker = new TakeoutWorkerService(
    logger as never,
    operations,
    takeout,
    staging,
    ctx.get(UserRepository),
    assetMedia as never,
    assets as never,
    albums as never,
    { relinkOne: vi.fn() } as never,
    config as never,
    connectors,
  );

  const remote = (file: Partial<FakeRemoteFile> & { path: string }): FakeRemoteFile => ({
    data: bytes(`bytes of ${file.path} ${randomUUID()}`),
    ...file,
  });
  const connect = async (owner = user.id) =>
    service.create(authOf(owner), {
      provider: FAKE_PROVIDER,
      displayName: 'My Nextcloud',
      credentials: { token: SECRET, files: [] },
      roots: [],
      dailyCheck: true,
    });
  const libraryOf = (ownerId: string) =>
    db
      .selectFrom('asset')
      .leftJoin('asset_exif', 'asset_exif.assetId', 'asset.id')
      .select(['asset.id', 'asset.originalFileName', 'asset.isFavorite', 'asset.deletedAt', 'asset_exif.description'])
      .where('asset.ownerId', '=', ownerId)
      .orderBy('asset.originalFileName')
      .execute();
  const albumsOf = async (ownerId: string) => {
    const { rows } = await sql<{ name: string; files: string[] }>`
      select album."albumName" as name, array_agg(asset."originalFileName" order by asset."originalFileName") as files
      from album
      inner join album_user on album_user."albumId" = album.id and album_user."userId" = ${ownerId}::uuid
      inner join album_asset on album_asset."albumId" = album.id
      inner join asset on asset.id = album_asset."assetId"
      group by album.id order by album."albumName"
    `.execute(db);
    return rows;
  };

  return {
    ctx,
    owner: authOf(user.id),
    stranger: authOf(other.id),
    source,
    service,
    connectors,
    worker,
    repository,
    takeout,
    uploadAsset,
    remote,
    connect,
    libraryOf,
    albumsOf,
    logger,
  };
};

describe('import connections on PostgreSQL (FL-920)', () => {
  it('imports a fake source: albums created, captions to descriptions, favourites kept, duplicates skipped', async () => {
    const { ctx, owner, source, service, worker, uploadAsset, remote, connect, libraryOf, albumsOf } = await setup();
    const duplicate = remote({ path: 'Camera/already-here.jpg' });
    await ctx.newAsset({
      ownerId: owner.user.id,
      checksum: digest('sha256', duplicate.data),
      originalFileName: 'already-here.jpg',
    });
    source.files = [
      remote({ path: 'Trips/Italy/rome.jpg', caption: 'Rome at dusk', favourite: true }),
      remote({ path: 'Trips/Italy/pisa.jpg' }),
      remote({ path: 'Camera/clip.mp4', albumHint: null }),
      duplicate,
      remote({ path: 'Trips/notes.txt' }),
    ];
    const connection = await connect();

    const queued = await service.scan(owner, connection.id);
    expect(queued).toMatchObject({ state: 'queued', phase: 'scanning', action: 'scan' });
    await worker.drain();

    const review = await service.run(owner, connection.id, queued.id);
    expect(review).toMatchObject({
      state: 'review',
      counts: { items: 4, ready: 4, imported: 0, rejected: 1 },
      albums: [
        { folder: 'Camera', name: 'Camera', count: 1, selected: true },
        { folder: 'Trips/Italy', name: 'Italy', count: 2, selected: true },
      ],
    });
    expect(source.opened).toEqual([]);
    const listed = await service.items(owner, connection.id, queued.id, { offset: 0, limit: 100 });
    expect(listed.items.map(({ path, state }) => [path, state])).toEqual([
      ['Camera/already-here.jpg', 'ready'],
      ['Camera/clip.mp4', 'ready'],
      ['Trips/Italy/pisa.jpg', 'ready'],
      ['Trips/Italy/rome.jpg', 'ready'],
    ]);

    await service.startImport(owner, connection.id, queued.id, { ...TAKEOUT_DEFAULT_OPTIONS });
    await worker.drain();

    const done = await service.run(owner, connection.id, queued.id);
    expect(done).toMatchObject({ state: 'completed', counts: { imported: 3, matched: 1, ready: 0, failed: 0 } });
    expect(uploadAsset).toHaveBeenCalledTimes(3);
    expect(await libraryOf(owner.user.id)).toMatchObject([
      { originalFileName: 'already-here.jpg' },
      { originalFileName: 'clip.mp4', description: null, isFavorite: false },
      { originalFileName: 'pisa.jpg', isFavorite: false },
      { originalFileName: 'rome.jpg', description: 'Rome at dusk', isFavorite: true },
    ]);
    expect(await albumsOf(owner.user.id)).toEqual([
      { name: 'Camera', files: ['already-here.jpg'] },
      { name: 'Italy', files: ['pisa.jpg', 'rome.jpg'] },
    ]);
    const after = await service.items(owner, connection.id, queued.id, { offset: 0, limit: 100, state: 'matched' });
    expect(after.items.map(({ path }) => path)).toEqual(['Camera/already-here.jpg']);
    expect((await service.get(owner, connection.id)).importedItems).toBe(4);
  });

  it('daily check imports only new items; a removed remote file changes nothing locally', async () => {
    const { owner, source, service, connectors, worker, uploadAsset, remote, connect, libraryOf, albumsOf } =
      await setup();
    source.files = [remote({ path: 'Trips/a.jpg' }), remote({ path: 'Trips/b.jpg' })];
    const connection = await connect();
    const first = await service.scan(owner, connection.id);
    await worker.drain();
    await service.startImport(owner, connection.id, first.id, { ...TAKEOUT_DEFAULT_OPTIONS });
    await worker.drain();
    const libraryBefore = await libraryOf(owner.user.id);
    expect(libraryBefore).toHaveLength(2);

    // The scan just started counts as today's check.
    expect(await connectors.dailyCheck()).toBe(0);

    // A day later: a.jpg is gone from the source and c.jpg is new.
    source.files = [source.files[1], remote({ path: 'Trips/c.jpg' })];
    source.opened.length = 0;
    uploadAsset.mockClear();
    await db
      .updateTable('import_connection')
      .set({ lastScanAt: sql<Date>`now() - interval '25 hours'` })
      .where('id', '=', connection.id)
      .execute();
    expect(await connectors.dailyCheck()).toBe(1);
    // Never two at once, and not again today.
    expect(await connectors.dailyCheck()).toBe(0);
    // The scan and the import it leads to, with no review in between.
    await worker.drain();

    expect(source.opened.map(({ remoteId }) => remoteId)).toEqual(['Trips/c.jpg']);
    expect(uploadAsset).toHaveBeenCalledTimes(1);
    const library = await libraryOf(owner.user.id);
    expect(library.map(({ originalFileName }) => originalFileName)).toEqual(['a.jpg', 'b.jpg', 'c.jpg']);
    // The photo that came from the removed file is exactly as it was, and so is its album.
    expect(library.slice(0, 2)).toEqual(libraryBefore);
    expect(library[0].deletedAt).toBeNull();
    expect(await albumsOf(owner.user.id)).toEqual([{ name: 'Trips', files: ['a.jpg', 'b.jpg', 'c.jpg'] }]);
    const seen = await db
      .selectFrom('import_connection_item')
      .select(['path', 'fileId'])
      .where('connectionId', '=', connection.id)
      .orderBy('path')
      .execute();
    expect(seen.map(({ path }) => path)).toEqual(['Trips/a.jpg', 'Trips/b.jpg', 'Trips/c.jpg']);
    expect(seen.every(({ fileId }) => fileId !== null)).toBe(true);
    const runs = await service.runs(owner, connection.id);
    expect(runs.map(({ state }) => state)).toEqual(['completed', 'completed']);
    expect(runs[0].counts).toMatchObject({ items: 1, imported: 1 });

    // A day with nothing new leaves no run behind.
    await db
      .updateTable('import_connection')
      .set({ lastScanAt: sql<Date>`now() - interval '25 hours'` })
      .where('id', '=', connection.id)
      .execute();
    expect(await connectors.dailyCheck()).toBe(1);
    await worker.drain();
    expect(await service.runs(owner, connection.id)).toHaveLength(2);
    expect(await libraryOf(owner.user.id)).toHaveLength(3);
  });

  it('keeps credentials sealed at rest and out of every answer and log line', async () => {
    const { owner, source, service, worker, remote, connect, logger } = await setup();
    source.files = [remote({ path: 'Trips/a.jpg' })];
    const connection = await connect();
    const run = await service.scan(owner, connection.id);
    await worker.drain();

    const stored = await db
      .selectFrom('import_connection')
      .selectAll()
      .where('id', '=', connection.id)
      .executeTakeFirstOrThrow();
    expect(stored.sealedCredentials.toString('latin1')).not.toContain(SECRET);
    expect(JSON.stringify({ ...stored, sealedCredentials: undefined })).not.toContain(SECRET);

    const said = JSON.stringify([
      connection,
      await service.list(owner),
      await service.get(owner, connection.id),
      await service.runs(owner, connection.id),
      await service.run(owner, connection.id, run.id),
      await service.items(owner, connection.id, run.id, { offset: 0, limit: 100 }),
      await service.statistics(),
      Object.values(logger).flatMap((fn) => fn.mock.calls),
    ]);
    expect(said).not.toContain(SECRET);
    expect(said).not.toContain(stored.sealedCredentials.toString('base64'));
    const operations = await db
      .selectFrom('media_operation')
      .selectAll()
      .where('ownerId', '=', owner.user.id)
      .execute();
    expect(JSON.stringify(operations)).not.toContain(SECRET);
  });

  it('shows a connection and its runs to its owner only; an administrator gets counts', async () => {
    const { owner, stranger, source, service, worker, takeout, remote, connect } = await setup();
    source.files = [remote({ path: 'Trips/a.jpg' })];
    const connection = await connect();
    const run = await service.scan(owner, connection.id);
    await worker.drain();

    expect(await service.list(stranger)).toEqual([]);
    for (const attempt of [
      () => service.get(stranger, connection.id),
      () => service.scan(stranger, connection.id),
      () => service.runs(stranger, connection.id),
      () => service.run(stranger, connection.id, run.id),
      () => service.items(stranger, connection.id, run.id, { offset: 0, limit: 100 }),
      () => service.startImport(stranger, connection.id, run.id, { ...TAKEOUT_DEFAULT_OPTIONS }),
      () => service.setRoots(stranger, connection.id, { roots: [] }),
      () => service.remove(stranger, connection.id),
    ]) {
      await expect(attempt()).rejects.toBeInstanceOf(NotFoundException);
    }
    // The owner's run is not reachable through another of their own connections either.
    const second = await connect();
    await expect(service.run(owner, second.id, run.id)).rejects.toBeInstanceOf(NotFoundException);

    // A connection's run is not a Google Photos import: those routes neither list nor open it.
    expect(await takeout.list(owner.user.id)).toEqual([]);
    expect(await takeout.get(owner.user.id, run.id)).toBeUndefined();
    expect(await takeout.get(owner.user.id, run.id, true)).toMatchObject({ connectionId: connection.id });

    const statistics = await service.statistics();
    expect(statistics.providers.find(({ provider }) => provider === FAKE_PROVIDER)!.connections).toBeGreaterThanOrEqual(
      2,
    );
    expect(Object.keys(statistics).toSorted()).toEqual(['providers', 'total']);
    expect(Object.keys(statistics.providers[0]).toSorted()).toEqual(['connections', 'dailyCheck', 'provider']);
  });

  it('runs one job at a time per connection, and removing a connection keeps its photos', async () => {
    const { owner, source, service, worker, remote, connect, libraryOf } = await setup();
    source.files = [remote({ path: 'Trips/a.jpg' })];
    const connection = await connect();
    const run = await service.scan(owner, connection.id);

    await expect(service.scan(owner, connection.id)).rejects.toBeInstanceOf(BadRequestException);
    await expect(service.remove(owner, connection.id)).rejects.toBeInstanceOf(BadRequestException);

    await worker.drain();
    await service.startImport(owner, connection.id, run.id, { ...TAKEOUT_DEFAULT_OPTIONS });
    await worker.drain();
    expect(await libraryOf(owner.user.id)).toHaveLength(1);

    await service.remove(owner, connection.id);

    expect(await db.selectFrom('takeout_import').select('id').where('id', '=', run.id).execute()).toEqual([]);
    expect(await libraryOf(owner.user.id)).toMatchObject([{ originalFileName: 'a.jpg', deletedAt: null }]);
  });

  it('offers a file again only when it changed, and resumes a download that was cut short', async () => {
    const { owner, source, service, worker, remote, connect, libraryOf } = await setup();
    const big = remote({ path: 'Trips/big.jpg', data: Buffer.alloc(300_000, 7).toString('base64') });
    source.files = [big];
    const connection = await connect();
    const first = await service.scan(owner, connection.id);
    await worker.drain();
    source.failAfterBytes = 100_000;
    await service.startImport(owner, connection.id, first.id, { ...TAKEOUT_DEFAULT_OPTIONS });
    await worker.drain();

    // Cut short: reported on the file, waiting for the run's one automatic retry.
    const failed = await service.items(owner, connection.id, first.id, { offset: 0, limit: 100 });
    expect(await libraryOf(owner.user.id)).toHaveLength(0);
    expect(failed.items).toHaveLength(1);

    await db.updateTable('media_operation').set({ retryAt: null }).where('ownerId', '=', owner.user.id).execute();
    await worker.drain();

    expect(source.opened).toEqual([
      { remoteId: 'Trips/big.jpg', start: 0 },
      { remoteId: 'Trips/big.jpg', start: 100_000 },
    ]);
    expect(await libraryOf(owner.user.id)).toHaveLength(1);
    const stored = await db.selectFrom('asset').select('checksum').where('ownerId', '=', owner.user.id).execute();
    expect(stored[0].checksum.equals(digest('sha256', big.data))).toBe(true);

    // Unchanged at the source: the next scan offers nothing. Changed: it is offered again.
    const unchanged = await service.scan(owner, connection.id);
    await worker.drain();
    expect((await service.run(owner, connection.id, unchanged.id)).counts.items).toBe(0);
    source.files = [{ ...big, data: bytes('edited at the source'), modifiedAt: '2025-05-05T00:00:00.000Z' }];
    const changed = await service.scan(owner, connection.id);
    await worker.drain();
    expect((await service.run(owner, connection.id, changed.id)).counts).toMatchObject({ items: 1, ready: 1 });
    expect(await libraryOf(owner.user.id)).toHaveLength(1);
  });
});
