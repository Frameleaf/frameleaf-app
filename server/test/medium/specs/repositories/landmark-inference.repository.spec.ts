import { Kysely } from 'kysely';
import { AssetLockReason, AssetVisibility, UserMetadataKey } from 'src/enum.js';
import { queueExecution } from 'src/queue/context.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { MapRepository } from 'src/repositories/map.repository.js';
import { SearchRepository } from 'src/repositories/search.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { DB } from 'src/schema/index.js';
import { mediumFactory } from 'test/medium.factory.js';
import { getActiveForkKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
let ownerId: string;
let sut: MapRepository;
let search: SearchRepository;
const point = { latitude: 48.8584, longitude: 2.2945 };
const makeAsset = async (
  options: {
    minute?: number;
    located?: boolean;
    owner?: string;
    model?: string;
    visibility?: AssetVisibility;
    lockedLocation?: boolean;
  } = {},
) => {
  const asset = mediumFactory.assetInsert({
    ownerId: options.owner ?? ownerId,
    fileCreatedAt: new Date(Date.UTC(2026, 0, 1, 12, options.minute ?? 0)),
    visibility: options.visibility ?? AssetVisibility.Timeline,
  });
  await new AssetRepository(db).create(asset);
  await db
    .insertInto('asset_exif')
    .values({
      assetId: asset.id,
      make: 'Canon',
      model: options.model ?? 'EOS R5',
      ...(options.located ? point : { latitude: null, longitude: null }),
      ...(options.lockedLocation ? { lockedProperties: ['latitude', 'longitude'] } : {}),
    })
    .execute();
  return asset.id;
};
const vector = (second = 0) => JSON.stringify([1, second, ...Array.from({ length: 766 }, () => 0)]);
const modelKey = `clip:${'a'.repeat(64)}`;
const embed = (assetId: string, embedding = vector(), producerModelKey: string | null = modelKey) =>
  db.insertInto('smart_search').values({ assetId, embedding, producerModelKey }).execute();
const matches = (assetId: string) => search.getAssetLandmarks(assetId);

describe('landmarks inferred from local photos (FL-358)', () => {
  beforeEach(async () => {
    db = await getActiveForkKyselyDB();
    const user = await mediumFactory.userWithClusterGroup(db);
    await new UserRepository(db).create(user);
    ownerId = user.id;
    sut = new MapRepository(undefined as never, undefined as never, { setContext() {} } as never, db as never);
    search = new SearchRepository(db);
    await db
      .insertInto('landmark')
      .values({ id: 'Q243', name: 'Eiffel Tower', kind: 'tower', names: {}, ...point, radiusM: 165, rank: 200 })
      .execute();
  });
  afterEach(async () => {
    await db?.destroy();
  });

  it('borrows the same camera location without changing EXIF or chaining inferences', async () => {
    const donor = await makeAsset({ located: true });
    const target = await makeAsset({ minute: 3 });
    const distant = await makeAsset({ minute: 7 });
    await sut.inferLandmarks();
    await expect(matches(target)).resolves.toEqual([
      { id: 'Q243', name: 'Eiffel Tower', kind: 'tower', inference: 'temporal' },
    ]);
    await expect(matches(distant)).resolves.toEqual([]);
    await expect(
      db.selectFrom('asset_exif').select(['latitude', 'longitude']).where('assetId', '=', target).executeTakeFirst(),
    ).resolves.toEqual({ latitude: null, longitude: null });
    await sut.inferLandmarks();
    await expect(matches(target)).resolves.toHaveLength(1);
    await db.updateTable('asset_exif').set({ latitude: 40 }).where('assetId', '=', donor).execute();
    await expect(matches(target)).resolves.toEqual([]);
  });

  it('rejects other cameras, other owners, archived donors and deliberately cleared locations', async () => {
    await makeAsset({ located: true });
    const user = await mediumFactory.userWithClusterGroup(db);
    await new UserRepository(db).create(user);
    const targets = [
      await makeAsset({ model: 'EOS R6' }),
      await makeAsset({ owner: user.id }),
      await makeAsset({ lockedLocation: true }),
    ];
    await sut.inferLandmarks();
    for (const id of targets) await expect(matches(id)).resolves.toEqual([]);
    await db.updateTable('asset').set({ visibility: AssetVisibility.Archive }).where('ownerId', '=', ownerId).execute();
    const target = await makeAsset();
    await sut.inferLandmarks();
    await expect(matches(target)).resolves.toEqual([]);
  });

  it('stops revealing evidence immediately when the source is Locked or deleted', async () => {
    const donor = await makeAsset({ located: true });
    const target = await makeAsset({ minute: 1 });
    await sut.inferLandmarks();
    await expect(matches(target)).resolves.toHaveLength(1);
    await db.insertInto('asset_lock').values({ assetId: donor, reason: AssetLockReason.Marked }).execute();
    await expect(matches(target)).resolves.toEqual([]);
    await db.deleteFrom('asset_lock').where('assetId', '=', donor).execute();
    await db.deleteFrom('asset').where('id', '=', donor).execute();
    await expect(matches(target)).resolves.toEqual([]);
  });

  it('invalidates the estimate when a different nearby camera reading is moved', async () => {
    await makeAsset({ located: true, minute: -1 });
    const context = await makeAsset({ located: true, minute: 2 });
    const target = await makeAsset();
    await sut.inferLandmarks();
    await expect(matches(target)).resolves.toHaveLength(1);
    await db.updateTable('asset_exif').set({ latitude: 40 }).where('assetId', '=', context).execute();
    await expect(matches(target)).resolves.toEqual([]);
  });

  it('removes indirect location clues when a donor becomes hidden by an owner rule', async () => {
    const donor = await makeAsset({ located: true });
    const target = await makeAsset({ minute: 1 });
    await sut.inferLandmarks();
    const [tag] = await db.insertInto('tag').values({ userId: ownerId, value: 'Private' }).returning('id').execute();
    await db.insertInto('tag_closure').values({ id_ancestor: tag.id, id_descendant: tag.id }).execute();
    await db.insertInto('tag_asset').values({ assetId: donor, tagId: tag.id }).execute();
    await db
      .insertInto('user_metadata')
      .values({
        userId: ownerId,
        key: UserMetadataKey.Preferences,
        value: { privacy: { suppression: { tagIds: [tag.id], personIds: [], petIds: [], scope: 'owned' } } },
      } as never)
      .execute();
    await expect(matches(target)).resolves.toEqual([]);
    await expect(
      search.getVisitedLandmarks([ownerId], {
        hiddenContent: {
          userId: ownerId,
          includeNsfw: false,
          tagIds: [tag.id],
          personIds: [],
          petIds: [],
          scope: 'owned',
        },
      }),
    ).resolves.toEqual([]);
  });

  it('recognises a distant landmark from existing matching-model embeddings', async () => {
    const donors = [await makeAsset({ located: true }), await makeAsset({ located: true, minute: 60 })];
    const target = await makeAsset({ minute: 120 });
    await db
      .insertInto('landmark')
      .values({
        id: 'Q1',
        name: 'Viewpoint',
        kind: 'park',
        names: {},
        latitude: 48.86,
        longitude: 2.31,
        radiusM: 50,
        rank: 20,
      })
      .execute();
    await db
      .updateTable('asset_exif')
      .set({ latitude: 48.86, longitude: 2.31 })
      .where('assetId', '=', target)
      .execute();
    for (const id of [...donors, target]) await embed(id);
    await sut.inferLandmarks();
    await expect(matches(target)).resolves.toEqual([
      { id: 'Q1', name: 'Viewpoint', kind: 'park' },
      { id: 'Q243', name: 'Eiffel Tower', kind: 'tower', inference: 'visual' },
    ]);
    await expect(
      db.selectFrom('asset_exif').select(['latitude', 'longitude']).where('assetId', '=', target).executeTakeFirst(),
    ).resolves.toEqual({ latitude: 48.86, longitude: 2.31 });
    await db
      .updateTable('asset_exif')
      .set({ latitude: null, longitude: null })
      .where('assetId', '=', donors[0])
      .execute();
    await expect(matches(target)).resolves.toEqual([{ id: 'Q1', name: 'Viewpoint', kind: 'park' }]);
  });

  it('groups a landmark under the recorded country rather than inferred photos place labels', async () => {
    const donors = [await makeAsset({ located: true }), await makeAsset({ located: true, minute: 60 })];
    for (const id of donors) {
      await db
        .updateTable('asset_exif')
        .set({ city: 'Paris', state: 'Île-de-France', country: 'France' })
        .where('assetId', '=', id)
        .execute();
      await embed(id);
    }
    for (const minute of [120, 121, 122]) {
      const id = await makeAsset({ minute });
      await db
        .updateTable('asset_exif')
        .set({ city: 'London', state: 'England', country: 'United Kingdom' })
        .where('assetId', '=', id)
        .execute();
      await embed(id);
    }
    await sut.inferLandmarks();
    await expect(search.getVisitedLandmarks([ownerId])).resolves.toMatchObject([
      { id: 'Q243', assetCount: 5, city: 'Paris', state: 'Île-de-France', country: 'France' },
    ]);
  });

  it('does not compare unknown or different embedding producers', async () => {
    const a = await makeAsset({ located: true });
    const b = await makeAsset({ located: true, minute: 60 });
    const target = await makeAsset({ minute: 120 });
    await embed(a);
    await embed(b, vector(), `clip:${'b'.repeat(64)}`);
    await embed(target);
    await sut.inferLandmarks();
    await expect(matches(target)).resolves.toEqual([]);
    await db.updateTable('smart_search').set({ producerModelKey: null }).execute();
    await sut.inferLandmarks();
    await expect(matches(target)).resolves.toEqual([]);
  });

  it('falls back to visual evidence when another same-camera GPS in the window conflicts', async () => {
    const before = await makeAsset({ located: true, minute: -1 });
    const after = await makeAsset({ located: true, minute: 1 });
    const conflict = await makeAsset({ located: true, minute: -4 });
    await db.updateTable('asset_exif').set({ latitude: 40 }).where('assetId', '=', conflict).execute();
    const target = await makeAsset();
    for (const id of [before, after, target]) await embed(id);
    await sut.inferLandmarks();
    await expect(matches(target)).resolves.toMatchObject([{ id: 'Q243', inference: 'visual' }]);
  });

  it('honours cancellation and reports committed progress during a backfill', async () => {
    await makeAsset({ located: true });
    const target = await makeAsset({ minute: 1 });
    const controller = new AbortController();
    controller.abort(new Error('cancelled'));
    const progress = vi.fn();
    await expect(
      queueExecution.run({ signal: controller.signal, progress, progressUnits: 0 } as never, () =>
        sut.inferLandmarks(),
      ),
    ).rejects.toThrow('cancelled');
    await expect(matches(target)).resolves.toEqual([]);
    const signal = new AbortController().signal;
    await queueExecution.run({ signal, progress, progressUnits: 0 } as never, () => sut.inferLandmarks());
    expect(progress).toHaveBeenLastCalledWith(1);
  });

  it('visits each unlocated photo once across backfill page boundaries', async () => {
    for (let index = 0; index < 101; index++) await makeAsset({ minute: index });
    const controller = new AbortController();
    let completed = 0;
    const progress = (units: number) => {
      completed = units;
      if (units > 101) controller.abort(new Error('backfill revisited a page'));
    };
    await queueExecution.run({ signal: controller.signal, progress, progressUnits: 0 } as never, () =>
      sut.inferLandmarks(),
    );
    expect(completed).toBe(101);
  });
});
