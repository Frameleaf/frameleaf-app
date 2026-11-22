import { ConflictException, NotFoundException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { existsSync } from 'node:fs';
import { mkdtemp, readFile, readdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { vi } from 'vitest';
import type { JobRepository } from 'src/repositories/job.repository.js';
import { StorageCore } from 'src/cores/storage.core.js';
import { JobName, JobStatus } from 'src/enum.js';
import { LocationHistoryRepository } from 'src/repositories/location-history.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { LocationHistoryService } from 'src/services/location-history.service.js';
import { UserService } from 'src/services/user.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

/** FL-925: location history files, from upload to stored places, on a real database and a real folder. */
const fixtures = path.resolve(import.meta.dirname, '../../../fixtures/location-history');

let db: Kysely<DB>;
let media: string;
beforeAll(async () => {
  db = await getKyselyDB();
  media = await mkdtemp(path.join(tmpdir(), 'location-history-medium-'));
  StorageCore.setMediaLocation(media);
});
afterAll(async () => {
  await db?.destroy();
  await rm(media, { recursive: true, force: true });
});

const setup = () => {
  // only for its helpers that insert users and photos
  const { ctx } = newMediumService(UserService, { database: db, real: [], mock: [LoggingRepository] });
  const logger = { setContext: vi.fn(), log: vi.fn(), warn: vi.fn() } as unknown as LoggingRepository;
  const queue = vi.fn();
  const sut = new LocationHistoryService(
    logger,
    { queue } as unknown as JobRepository,
    new LocationHistoryRepository(db),
  );
  return { ctx, sut, queue };
};

type Auth = ReturnType<typeof factory.auth>;

/** Upload `bytes` in parts of `partSize` and add the file, as the browser does. */
const add = async (sut: LocationHistoryService, auth: Auth, fileName: string, bytes: Buffer, partSize = 700) => {
  const upload = await sut.createUpload(auth, { size: bytes.length });
  let received = 0;
  while (received < bytes.length) {
    const part = bytes.subarray(received, received + partSize);
    ({ receivedBytes: received } = await sut.uploadChunk(auth, upload.id, received, part));
  }
  return sut.createSource(auth, { uploadId: upload.id, fileName });
};

const addFixture = async (sut: LocationHistoryService, auth: Auth, name: string) =>
  add(sut, auth, name, await readFile(path.join(fixtures, name)));

const pointsOf = (sourceId: string) =>
  db.selectFrom('location_point').selectAll().where('sourceId', '=', sourceId).orderBy('recordedAt').execute();

const stagedFiles = async (ownerId: string) =>
  readdir(path.join(media, 'location-history', ownerId)).catch(() => [] as string[]);

describe(LocationHistoryService.name, () => {
  it.each([
    ['Timeline.android.json', 'google-timeline', 8, '2024-07-01T15:00:00.000Z', '2024-07-01T16:30:00.000Z'],
    ['Timeline.iphone.json', 'google-timeline', 7, '2024-08-10T06:00:00.000Z', '2024-08-10T08:00:00.000Z'],
    ['Records.json', 'google-records', 4, '2019-04-03T01:00:00.000Z', '2019-04-03T18:00:00.000Z'],
    ['2019_JULY.json', 'google-timeline', 6, '2019-07-05T15:00:00.000Z', '2019-07-05T16:30:00.000Z'],
    ['track.gpx', 'gpx', 6, '2023-09-16T08:00:00.000Z', '2023-09-16T09:40:00.000Z'],
    ['owntracks.rec', 'owntracks', 3, '2022-05-20T14:00:00.000Z', '2022-05-20T14:15:00.000Z'],
    ['owntracks-api.json', 'owntracks', 2, '2022-05-21T14:00:00.000Z', '2022-05-21T14:05:00.000Z'],
    ['dawarich.geojson', 'geojson', 4, '2023-11-14T22:13:20.000Z', '2023-11-14T22:33:20.000Z'],
  ])('imports %s with its places and date span', async (name, kind, pointCount, firstAt, lastAt) => {
    const { ctx, sut, queue } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });

    const added = await addFixture(sut, auth, name);
    expect(added).toMatchObject({ fileName: name, kind: null, importedAt: null, pointCount: 0, error: null });
    expect(queue).toHaveBeenCalledWith({ name: JobName.LocationHistoryImport, data: { id: added.id } });

    await expect(sut.handleImport({ id: added.id })).resolves.toBe(JobStatus.Success);

    const [source] = await sut.getSources(auth);
    expect(source).toMatchObject({ id: added.id, fileName: name, kind, pointCount, firstAt, lastAt, error: null });
    expect(source.importedAt).not.toBeNull();
    const points = await pointsOf(added.id);
    expect(points).toHaveLength(pointCount);
    expect(points.every((point) => point.ownerId === user.id)).toBe(true);
    expect(new Date(points[0].recordedAt).toISOString()).toBe(firstAt);
    // the upload is gone once read: the history lives only in the database
    expect(await stagedFiles(user.id)).toEqual([]);
  });

  it('keeps a history to its owner, and removes it with the account', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: partner } = await ctx.newUser();
    await ctx.newPartner({ sharedById: user.id, sharedWithId: partner.id });
    await ctx.newPartner({ sharedById: partner.id, sharedWithId: user.id });
    const { user: admin } = await ctx.newUser({ isAdmin: true });
    const auth = factory.auth({ user });

    const added = await addFixture(sut, auth, 'track.gpx');
    await sut.handleImport({ id: added.id });

    for (const other of [partner, admin]) {
      const otherAuth = factory.auth({ user: other });
      await expect(sut.getSources(otherAuth)).resolves.toEqual([]);
      await expect(sut.deleteSource(otherAuth, added.id)).rejects.toBeInstanceOf(NotFoundException);
      // nor can they send parts into, or add, an upload that is not theirs
      const upload = await sut.createUpload(auth, { size: 4 });
      await expect(sut.uploadChunk(otherAuth, upload.id, 0, Buffer.from('<gpx'))).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(sut.createSource(otherAuth, { uploadId: upload.id, fileName: 'x.gpx' })).rejects.toBeInstanceOf(
        NotFoundException,
      );
      await expect(sut.getSources(otherAuth)).resolves.toEqual([]);
    }
    expect(await pointsOf(added.id)).toHaveLength(6);

    await sut.onUserDelete({ id: user.id } as never);
    expect(existsSync(path.join(media, 'location-history', user.id))).toBe(false);
    await db.deleteFrom('user').where('id', '=', user.id).execute();
    expect(await pointsOf(added.id)).toEqual([]);
    await expect(
      db.selectFrom('location_history_source').select('id').where('ownerId', '=', user.id).execute(),
    ).resolves.toEqual([]);
  });

  it('removes a file’s history without touching any photo', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newExif({ assetId: asset.id, latitude: 51.4254, longitude: -116.1773, city: 'Lake Louise' });
    const before = await db.selectFrom('asset_exif').selectAll().where('assetId', '=', asset.id).executeTakeFirst();
    const assetBefore = await db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirst();

    const kept = await addFixture(sut, auth, 'owntracks.rec');
    const removed = await addFixture(sut, auth, 'track.gpx');
    await sut.handleImport({ id: kept.id });
    await sut.handleImport({ id: removed.id });

    await sut.deleteSource(auth, removed.id);

    expect(await pointsOf(removed.id)).toEqual([]);
    expect(await pointsOf(kept.id)).toHaveLength(3);
    expect((await sut.getSources(auth)).map((source) => source.id)).toEqual([kept.id]);
    await expect(
      db.selectFrom('asset_exif').selectAll().where('assetId', '=', asset.id).executeTakeFirst(),
    ).resolves.toEqual(before);
    await expect(db.selectFrom('asset').selectAll().where('id', '=', asset.id).executeTakeFirst()).resolves.toEqual(
      assetBefore,
    );
    // a file removed while it waits is passed over when its turn comes
    const waiting = await addFixture(sut, auth, 'track.gpx');
    await sut.deleteSource(auth, waiting.id);
    await expect(sut.handleImport({ id: waiting.id })).resolves.toBe(JobStatus.Skipped);
    expect(await stagedFiles(user.id)).toEqual([]);
  });

  it('says why a file that is not a history could not be read, and keeps nothing of it', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });

    const photo = await add(sut, auth, 'IMG_0001.jpg', Buffer.from([0xff, 0xd8, 0xff, 0xe0, 0, 16, 74, 70]));
    const other = await add(sut, auth, 'albums.json', Buffer.from('{"albums":[{"title":"Summer"}]}'));
    await expect(sut.handleImport({ id: photo.id })).resolves.toBe(JobStatus.Failed);
    await expect(sut.handleImport({ id: other.id })).resolves.toBe(JobStatus.Failed);

    const sources = await sut.getSources(auth);
    expect(sources.find((source) => source.id === photo.id)).toMatchObject({
      error: 'This file is not a location history',
      importedAt: null,
      pointCount: 0,
    });
    expect(sources.find((source) => source.id === other.id)).toMatchObject({
      error: 'No places with a date and time were found in this file',
      importedAt: null,
      pointCount: 0,
    });
    expect(await stagedFiles(user.id)).toEqual([]);
  });

  it('starts a file again when a run was cut short, without counting a place twice', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const added = await addFixture(sut, auth, 'track.gpx');
    // what a run that stopped half way left behind
    await db
      .insertInto('location_point')
      .values({
        ownerId: user.id,
        sourceId: added.id,
        recordedAt: new Date('2023-09-16T08:00:00Z'),
        latitude: 51,
        longitude: -116,
      })
      .execute();

    await expect(sut.handleImport({ id: added.id })).resolves.toBe(JobStatus.Success);
    expect(await pointsOf(added.id)).toHaveLength(6);
    // and a second delivery of a finished file changes nothing
    await expect(sut.handleImport({ id: added.id })).resolves.toBe(JobStatus.Skipped);
    expect(await pointsOf(added.id)).toHaveLength(6);
  });

  it('resumes an upload where it stopped, and refuses a part from anywhere else', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const bytes = await readFile(path.join(fixtures, 'track.gpx'));
    const upload = await sut.createUpload(auth, { size: bytes.length });

    await expect(sut.uploadChunk(auth, upload.id, 0, bytes.subarray(0, 500))).resolves.toEqual({
      id: upload.id,
      receivedBytes: 500,
    });
    // the same part again, as after a dropped reply
    await expect(sut.uploadChunk(auth, upload.id, 0, bytes.subarray(0, 500))).resolves.toMatchObject({
      receivedBytes: 500,
    });
    await expect(sut.uploadChunk(auth, upload.id, 600, bytes.subarray(600))).rejects.toBeInstanceOf(ConflictException);
    await sut.uploadChunk(auth, upload.id, 500, bytes.subarray(500));

    const added = await sut.createSource(auth, { uploadId: upload.id, fileName: String.raw`C:\Users\me\track.gpx` });
    expect(added.fileName).toBe('track.gpx');
    await sut.handleImport({ id: added.id });
    expect(await pointsOf(added.id)).toHaveLength(6);
    // an upload is used once
    await expect(sut.createSource(auth, { uploadId: upload.id, fileName: 'track.gpx' })).rejects.toBeInstanceOf(
      NotFoundException,
    );
    expect(await sut.getSources(auth)).toHaveLength(1);
  });

  it('stores a long file in batches and counts as it goes', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const auth = factory.auth({ user });
    const start = Date.UTC(2021, 0, 1);
    const count = 25_000;
    const lines = Array.from({ length: count }, (_, index) => {
      const time = new Date(start + index * 60_000).toISOString();
      return `{"latitudeE7":${511_784_000 + index},"longitudeE7":${-1_155_708_000 - index},"accuracy":10,"timestamp":"${time}"}`;
    });
    const added = await add(sut, auth, 'Records.json', Buffer.from(`{"locations":[${lines.join(',')}]}`), 1024 * 1024);

    await expect(sut.handleImport({ id: added.id })).resolves.toBe(JobStatus.Success);

    const [source] = await sut.getSources(auth);
    expect(source).toMatchObject({
      kind: 'google-records',
      pointCount: count,
      firstAt: new Date(start).toISOString(),
      lastAt: new Date(start + (count - 1) * 60_000).toISOString(),
    });
    const stored = await db
      .selectFrom('location_point')
      .select((eb) => eb.fn.countAll<string>().as('count'))
      .where('ownerId', '=', user.id)
      .executeTakeFirstOrThrow();
    expect(Number(stored.count)).toBe(count);
  });
});
