import { BadRequestException } from '@nestjs/common';
import { Kysely } from 'kysely';
import { randomBytes, randomUUID } from 'node:crypto';
import { tryPromise } from 'src/utils/promise.js';
import { AssetVisibility, MediaOperationDestination, MediaOperationKind, MediaOperationStatus } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { TakeoutConflict, TakeoutRepository } from 'src/repositories/takeout.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { TakeoutService } from 'src/services/takeout.service.js';
import { TAKEOUT_DEFAULT_OPTIONS, takeoutStableId } from 'src/utils/takeout.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: new TakeoutRepository(defaultDatabase), operations: ctx.get(MediaOperationRepository) };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

afterEach(async () => {
  await defaultDatabase.deleteFrom('takeout_import').execute();
  await defaultDatabase.deleteFrom('media_operation').execute();
});

/** One staged photo with an item, as a scan records it. */
const seedItem = async (
  sut: TakeoutRepository,
  importId: string,
  sourceId: string,
  { name = 'IMG_1.jpg', ...rest }: { name?: string; folder?: string; locked?: boolean; checksum?: Buffer } = {},
) => {
  const options = { name, ...rest };
  const folder = options.folder ?? 'Trip';
  const id = takeoutStableId(`${sourceId}:${folder}/${options.name}`);
  await sut.recordFile({
    id,
    importId,
    sourceId,
    entryName: `Takeout/Google Photos/${folder}/${options.name}`,
    relativePath: `${folder}/${options.name}`,
    folder,
    name: options.name,
    kind: 'image',
    path: `/staging/${id}`,
    size: 10,
    checksum: options.checksum ?? randomBytes(32),
    legacyChecksum: randomBytes(20),
    modifiedAt: new Date(0),
    metadata: null,
  });
  await sut.recordItem({
    id,
    importId,
    state: 'ready',
    metadata: { title: options.name },
    sidecarId: null,
    candidates: [],
    albums: [folder],
    warnings: ['no_sidecar'],
    locked: options.locked ?? false,
  });
  return id;
};

const seedImport = async (sut: TakeoutRepository, ownerId: string) => {
  const row = await sut.create(ownerId, 'Google Photos import', { ...TAKEOUT_DEFAULT_OPTIONS });
  const source = await sut.withImport(ownerId, row.id, (tx) =>
    sut.addSource(tx, { importId: row.id, name: 'takeout-001.zip', kind: 'zip', path: '/staging/a.zip', size: 100 }),
  );
  return { row, source };
};

const newOperation = (operations: MediaOperationRepository, ownerId: string, importId: string, action: string) =>
  operations.create({
    ownerId,
    kind: MediaOperationKind.TakeoutImport,
    destination: MediaOperationDestination.Local,
    label: 'Google Photos import',
    snapshot: { importId, action },
    settings: {},
  });

const requestService = (repository: TakeoutRepository) =>
  new TakeoutService(
    { setContext: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() } as never,
    repository,
    { prepare: () => Promise.resolve('/staging/admission'), freeBytes: () => tryPromise(() => 1024 ** 4) } as never,
    {} as never,
    {} as never,
    {} as never,
    {} as never,
  );

const staleAuth = (ownerId: string) => ({
  ...authStub.user1,
  user: { ...authStub.user1.user, id: ownerId, quotaSizeInBytes: 100, quotaUsageInBytes: 0 },
});

describe(TakeoutRepository.name, () => {
  it('admits archives using current database quota and usage rather than stale auth', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    await ctx.database
      .updateTable('user')
      .set({ quotaSizeInBytes: 10, quotaUsageInBytes: 8 })
      .where('id', '=', user.id)
      .execute();
    const row = await sut.create(user.id, 'Quota', { ...TAKEOUT_DEFAULT_OPTIONS });
    await expect(
      requestService(sut).addArchive(staleAuth(user.id), row.id, { name: 'takeout.zip', size: 6 }),
    ).rejects.toBeInstanceOf(BadRequestException);
    expect(await sut.sources(row.id)).toEqual([]);
  });

  it('admits only one of two concurrent archives in different imports of the same account', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    await ctx.database
      .updateTable('user')
      .set({ quotaSizeInBytes: 10, quotaUsageInBytes: 0 })
      .where('id', '=', user.id)
      .execute();
    const first = await sut.create(user.id, 'First', { ...TAKEOUT_DEFAULT_OPTIONS });
    const second = await sut.create(user.id, 'Second', { ...TAKEOUT_DEFAULT_OPTIONS });
    const service = requestService(sut);
    const results = await Promise.allSettled([
      service.addArchive(staleAuth(user.id), first.id, { name: 'first.zip', size: 6 }),
      service.addArchive(staleAuth(user.id), second.id, { name: 'second.zip', size: 6 }),
    ]);
    expect(results.filter((result) => result.status === 'fulfilled')).toHaveLength(1);
    const rejected = results.filter((result) => result.status === 'rejected');
    expect(rejected).toHaveLength(1);
    expect(rejected[0].reason).toBeInstanceOf(BadRequestException);
    const sources = [...(await sut.sources(first.id)), ...(await sut.sources(second.id))];
    expect(sources).toHaveLength(1);
    expect(sources[0].size).toBe(6);
  });

  it('releases a failed admission and rolls back its staged bytes before the next attempt', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    await ctx.database
      .updateTable('user')
      .set({ quotaSizeInBytes: 10, quotaUsageInBytes: 0 })
      .where('id', '=', user.id)
      .execute();
    const row = await sut.create(user.id, 'Rollback', { ...TAKEOUT_DEFAULT_OPTIONS });
    await expect(
      sut.withImport(user.id, row.id, async (tx, _row, _operation, quota) => {
        expect(quota).toEqual({ quotaSizeInBytes: 10, quotaUsageInBytes: 0 });
        await sut.addSource(tx, {
          importId: row.id,
          name: 'failed.zip',
          kind: 'zip',
          path: '/staging/failed.zip',
          size: 6,
        });
        throw new Error('injected admission failure');
      }),
    ).rejects.toThrow('injected admission failure');
    expect(await sut.sources(row.id)).toEqual([]);
    await expect(
      requestService(sut).addArchive(staleAuth(user.id), row.id, { name: 'retry.zip', size: 6 }),
    ).resolves.toMatchObject({ size: 6 });
  });

  it('answers only to the import’s owner', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { row } = await seedImport(sut, owner.id);

    await expect(sut.get(owner.id, row.id)).resolves.toMatchObject({ id: row.id, phase: 'sources' });
    await expect(sut.get(other.id, row.id)).resolves.toBeUndefined();
    await expect(sut.withImport(other.id, row.id, () => Promise.resolve())).rejects.toThrow('Import not found');
  });

  it.each(['chosen', 'equal-count', 'skipped'] as const)(
    'upgrades a %s pending rescan to Locked without replacing its decision',
    async (mode) => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { row, source } = await seedImport(sut, user.id);
      const id = await seedItem(sut, row.id, source.id);
      const metadata = { title: 'IMG_1.jpg', description: 'Retained choice' };
      const candidate = { id: randomUUID(), path: 'Trip/original.json', metadata };
      const candidates = mode === 'equal-count' ? [candidate, { ...candidate, id: randomUUID() }] : [candidate];
      const state = mode === 'equal-count' ? 'review' : mode === 'skipped' ? 'skipped' : 'ready';
      await sut.recordItem({
        id,
        importId: row.id,
        state,
        metadata,
        sidecarId: candidate.id,
        candidates,
        albums: ['Trip'],
        warnings: [],
        locked: false,
      });
      const privateCandidate = {
        id: randomUUID(),
        path: 'Trip/private.json',
        metadata: { title: 'IMG_1.jpg', locked: true },
      };
      await sut.recordItem({
        id,
        importId: row.id,
        state: 'review',
        metadata: privateCandidate.metadata,
        sidecarId: privateCandidate.id,
        candidates: mode === 'equal-count' ? [candidate, privateCandidate] : [...candidates, privateCandidate],
        albums: ['Trip'],
        warnings: ['locked'],
        locked: true,
      });
      expect(await sut.getItem(row.id, id)).toMatchObject({
        state,
        metadata,
        sidecarId: candidate.id,
        candidates,
        locked: true,
        withheld: true,
        warnings: ['locked'],
      });
      expect(await sut.items(row.id, { offset: 0, limit: 50, includeLocked: false })).toEqual({ items: [], total: 0 });
    },
  );

  it('does not relabel an already published item through a later scan record', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { row, source } = await seedImport(sut, user.id);
    const id = await seedItem(sut, row.id, source.id);
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await sut.itemAsset(id, asset.id, 'created');
    await sut.itemDone(id, 'imported');
    await sut.recordItem({
      id,
      importId: row.id,
      state: 'review',
      metadata: { title: 'Changed' },
      sidecarId: null,
      candidates: [],
      albums: ['Trip'],
      warnings: ['locked'],
      locked: true,
    });
    expect(await sut.getItem(row.id, id)).toMatchObject({ state: 'imported', assetId: asset.id, locked: false });
  });

  it('never unlocks a pending private item when a public rescan has more candidates', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { row, source } = await seedImport(sut, user.id);
    const id = await seedItem(sut, row.id, source.id, { locked: true });
    const candidate = { id: randomUUID(), path: 'Trip/public.json', metadata: { title: 'IMG_1.jpg' } };
    await sut.recordItem({
      id,
      importId: row.id,
      state: 'ready',
      metadata: candidate.metadata,
      sidecarId: candidate.id,
      candidates: [candidate],
      albums: ['Trip'],
      warnings: [],
      locked: false,
    });
    expect(await sut.getItem(row.id, id)).toMatchObject({ locked: true, withheld: true });
  });

  it('records a staged file once, however often the scan meets it', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { row, source } = await seedImport(sut, user.id);

    const id = await seedItem(sut, row.id, source.id, { name: 'IMG_1.jpg' });
    await seedItem(sut, row.id, source.id, { name: 'IMG_1.jpg' });

    expect(await sut.hasFile(id)).toBe(true);
    expect((await sut.counts(row.id)).files).toBe(1);
    expect((await sut.counts(row.id)).items).toBe(1);
  });

  it('never overwrites a decision, but takes more sidecars for an item still waiting', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { row, source } = await seedImport(sut, user.id);
    const id = await seedItem(sut, row.id, source.id, { name: 'IMG_1.jpg' });
    const candidate = { id: randomUUID(), path: 'Trip/IMG_1.jpg.json', metadata: { title: 'IMG_1.jpg' } };

    // A later scan found the sidecar in an archive added since.
    await sut.recordItem({
      id,
      importId: row.id,
      state: 'ready',
      metadata: candidate.metadata,
      sidecarId: candidate.id,
      candidates: [candidate],
      albums: ['Trip'],
      warnings: [],
      locked: false,
    });
    expect((await sut.getItem(row.id, id))?.sidecarId).toBe(candidate.id);

    // Once a sidecar is chosen, a scan changes nothing.
    await sut.recordItem({
      id,
      importId: row.id,
      state: 'review',
      metadata: { title: 'IMG_1.jpg' },
      sidecarId: null,
      candidates: [candidate, { ...candidate, id: randomUUID() }],
      albums: ['Trip'],
      warnings: ['ambiguous_sidecar'],
      locked: false,
    });
    expect(await sut.getItem(row.id, id)).toMatchObject({ state: 'ready', sidecarId: candidate.id });
  });

  it('lets one job at a time hold an import', async () => {
    const { ctx, sut, operations } = setup();
    const { user } = await ctx.newUser();
    const { row } = await seedImport(sut, user.id);
    const first = await newOperation(operations, user.id, row.id, 'scan');
    const second = await newOperation(operations, user.id, row.id, 'scan');

    await expect(sut.claimRun(row.id, first.id)).resolves.toBe(true);
    await expect(sut.claimRun(row.id, first.id)).resolves.toBe(true);
    await expect(sut.claimRun(row.id, second.id)).resolves.toBe(false);

    await ctx.database
      .updateTable('media_operation')
      .set({ status: MediaOperationStatus.Failed })
      .where('id', '=', first.id)
      .execute();
    await expect(sut.claimRun(row.id, second.id)).resolves.toBe(true);
  });

  it('reports the latest job of each step, never another owner’s', async () => {
    const { ctx, sut, operations } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { row } = await seedImport(sut, user.id);
    await newOperation(operations, user.id, row.id, 'scan');
    const scan = await newOperation(operations, user.id, row.id, 'scan');
    const importing = await newOperation(operations, user.id, row.id, 'import');
    await newOperation(operations, other.id, row.id, 'import');

    const latest = await sut.latestOperations(user.id, [row.id]);

    expect(latest.map(({ operation }) => operation.id).sort()).toEqual([scan.id, importing.id].sort());
  });

  it('leaves Locked items out of a listing for a locked session and counts them', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { row, source } = await seedImport(sut, user.id);
    await seedItem(sut, row.id, source.id, { name: 'IMG_1.jpg' });
    await seedItem(sut, row.id, source.id, { name: 'IMG_2.jpg', folder: 'Locked Folder', locked: true });

    const hidden = await sut.items(row.id, { offset: 0, limit: 50, includeLocked: false });
    const shown = await sut.items(row.id, { offset: 0, limit: 50, includeLocked: true });

    expect(hidden.items.map((item) => item.name)).toEqual(['IMG_1.jpg']);
    expect(hidden.total).toBe(1);
    expect(shown.total).toBe(2);
    expect((await sut.counts(row.id)).hiddenLocked).toBe(1);
  });

  it('also withholds an item that matched a photo already Locked in the library', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { row, source } = await seedImport(sut, user.id);
    const { asset } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
    const matched = await seedItem(sut, row.id, source.id, { name: 'IMG_1.jpg' });
    await seedItem(sut, row.id, source.id, { name: 'IMG_2.jpg' });
    await sut.itemAsset(matched, asset.id, 'matched');

    const hidden = await sut.items(row.id, { offset: 0, limit: 50, includeLocked: false });

    expect(hidden.items.map((item) => item.name)).toEqual(['IMG_2.jpg']);
    expect((await sut.counts(row.id)).hiddenLocked).toBe(1);
    expect(await sut.albums(row.id, false)).toEqual([{ folder: 'Trip', count: 1 }]);
    expect(await sut.albums(row.id, true)).toEqual([{ folder: 'Trip', count: 2 }]);
  });

  it('counts what is already in the owner’s library by checksum', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { row, source } = await seedImport(sut, user.id);
    const checksum = randomBytes(32);
    await ctx.newAsset({ ownerId: user.id, checksum });
    const elsewhere = randomBytes(32);
    await ctx.newAsset({ ownerId: other.id, checksum: elsewhere });
    await seedItem(sut, row.id, source.id, { name: 'IMG_1.jpg', checksum });
    await seedItem(sut, row.id, source.id, { name: 'IMG_2.jpg', checksum: elsewhere });
    await seedItem(sut, row.id, source.id, { name: 'IMG_3.jpg' });

    await expect(sut.matchSummary(user.id, row.id)).resolves.toEqual({ matchedOriginals: 1, newAssets: 2 });
  });

  it('reuses the album a folder became only while the owner still has it', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { album } = await ctx.newAlbum({ ownerId: user.id, albumName: 'Trip' });

    await expect(sut.setAlbumFor(user.id, 'Trip', album.id)).resolves.toBe(album.id);
    await expect(sut.getAlbumFor(user.id, 'Trip')).resolves.toBe(album.id);

    await ctx.database.updateTable('album').set({ deletedAt: new Date() }).where('id', '=', album.id).execute();
    await expect(sut.getAlbumFor(user.id, 'Trip')).resolves.toBeUndefined();
  });

  it('closes archive uploads once the scan has started', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { row, source } = await seedImport(sut, user.id);
    await sut.withImport(user.id, row.id, (tx) => sut.setPhase(tx, row.id, 'scanning'));

    await expect(sut.writeChunk(user.id, row.id, source.id, () => Promise.resolve(10))).rejects.toBeInstanceOf(
      TakeoutConflict,
    );
  });

  it('refuses a second Live Photo pair that shares a part with an approved one', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { row, source } = await seedImport(sut, user.id);
    const photo = await seedItem(sut, row.id, source.id, { name: 'IMG_1.HEIC' });
    const video = await seedItem(sut, row.id, source.id, { name: 'IMG_1.MP4' });
    const other = await seedItem(sut, row.id, source.id, { name: 'IMG_1(1).MP4' });
    await sut.recordPair(row.id, photo, video);
    await sut.recordPair(row.id, photo, other);

    await sut.withImport(user.id, row.id, (tx) => sut.decidePair(tx, row.id, photo, video, true));
    await expect(
      sut.withImport(user.id, row.id, (tx) => sut.decidePair(tx, row.id, photo, other, true)),
    ).rejects.toBeInstanceOf(TakeoutConflict);
    expect((await sut.counts(row.id)).suggestedPairs).toBe(1);
  });

  it('gives failed items their automatic retry and imports only what is still to do', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { row, source } = await seedImport(sut, user.id);
    const done = await seedItem(sut, row.id, source.id, { name: 'IMG_1.jpg' });
    const failed = await seedItem(sut, row.id, source.id, { name: 'IMG_2.jpg' });
    await sut.itemDone(done, 'imported');
    await sut.itemDone(failed, 'failed', 'Album membership could not be restored');

    expect(await sut.pendingItems(row.id, 50)).toEqual([]);
    await expect(sut.retryFailed(row.id)).resolves.toBe(1);
    expect((await sut.pendingItems(row.id, 50)).map((item) => item.id)).toEqual([failed]);
  });

  it('imports unclear photos with their chosen details, and trashed photos only when asked', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { row, source } = await seedImport(sut, user.id);
    const unclear = await seedItem(sut, row.id, source.id, { name: 'IMG_1.jpg' });
    const trashed = await seedItem(sut, row.id, source.id, { name: 'IMG_2.jpg' });
    const chosen = { title: 'IMG_1.jpg', description: 'most likely' };
    await defaultDatabase
      .updateTable('takeout_item')
      .set({ state: 'review', sidecarId: unclear, metadata: chosen as never })
      .where('id', '=', unclear)
      .execute();
    await defaultDatabase
      .updateTable('takeout_item')
      .set({ state: 'skipped', warnings: ['trashed'] as never })
      .where('id', '=', trashed)
      .execute();

    await sut.withImport(user.id, row.id, (tx) => sut.releaseReview(tx, row.id));
    await expect(sut.getItem(row.id, unclear)).resolves.toMatchObject({
      state: 'ready',
      sidecarId: unclear,
      metadata: chosen,
    });
    await expect(sut.getItem(row.id, trashed)).resolves.toMatchObject({ state: 'skipped' });

    await sut.withImport(user.id, row.id, (tx) => sut.includeTrashed(tx, row.id));
    await expect(sut.getItem(row.id, trashed)).resolves.toMatchObject({ state: 'ready' });
  });
});
