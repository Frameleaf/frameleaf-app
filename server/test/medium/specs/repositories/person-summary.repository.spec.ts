import { Kysely, sql } from 'kysely';
import { AssetVisibility } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { emptyHiddenContentFilter } from 'src/utils/hidden-content.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

let database: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database, real: [], mock: [LoggingRepository] });
  return { ctx, sut: ctx.get(PersonRepository) };
};

beforeAll(async () => {
  database = await getKyselyDB();
});

afterAll(async () => {
  await database?.destroy();
});

/** FL-1789: the people list reads stored counts; these check that they follow every change. */
describe('people list from stored summaries (FL-1789)', () => {
  const page = { take: 50, skip: 0 };

  /** A named person shown in `photos` of the owner's photos. */
  const personIn = async (
    ctx: ReturnType<typeof setup>['ctx'],
    ownerId: string,
    name: string,
    photos: number,
    fileCreatedAt = new Date('2026-01-01T00:00:00.000Z'),
  ) => {
    const { person } = await ctx.newPerson({ ownerId, name });
    const faces = [];
    for (let index = 0; index < photos; index++) {
      const { asset } = await ctx.newAsset({ ownerId, fileCreatedAt });
      const { assetFace } = await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
      faces.push({ asset, assetFace });
    }
    return { person, faces };
  };

  const counts = async (sut: PersonRepository, ownerId: string) => {
    const { items } = await sut.getAllForUser(page, ownerId, { withHidden: false });
    return Object.fromEntries(items.map((item) => [item.name, Number(item.assetCount)]));
  };

  const summaries = (ownerId: string) =>
    database.selectFrom('person_summary').selectAll().where('ownerId', '=', ownerId).execute();
  const states = (ownerId: string) =>
    database.selectFrom('person_summary_state').selectAll().where('ownerId', '=', ownerId).execute();

  it('reads a page without counting faces again while nothing has changed', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    await personIn(ctx, user.id, 'Ada', 2);

    await expect(counts(sut, user.id)).resolves.toEqual({ Ada: 2 });
    const [first] = await summaries(user.id);
    const [state] = await states(user.id);
    await expect(counts(sut, user.id)).resolves.toEqual({ Ada: 2 });
    await expect(sut.getListedTotals(user.id)).resolves.toMatchObject({ total: 1, hidden: 0 });

    // the same rows and state as the first read left: nothing was counted in between
    await expect(summaries(user.id)).resolves.toEqual([first]);
    await expect(states(user.id)).resolves.toEqual([state]);
  });

  it('keeps counts right after a face is assigned, moved and deleted', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { person: ada, faces } = await personIn(ctx, user.id, 'Ada', 3);
    const { person: bea } = await personIn(ctx, user.id, 'Bea', 1);
    await expect(counts(sut, user.id)).resolves.toEqual({ Ada: 3, Bea: 1 });

    // assigned: a new photo shows Bea
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    await ctx.newAssetFace({ assetId: asset.id, personGroupId: bea.personGroupId });
    await expect(counts(sut, user.id)).resolves.toEqual({ Ada: 3, Bea: 2 });

    // moved: the person the face left is counted again too, though no row names them any more
    await sut.reassignFaces({ faceIds: [faces[0].assetFace.id], newPersonGroupId: bea.personGroupId });
    await expect(counts(sut, user.id)).resolves.toEqual({ Ada: 2, Bea: 3 });

    // deleted: a face taken off a photo, then a photo put in the trash
    await sut.softDeleteAssetFaces(faces[1].assetFace.id);
    await database.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', asset.id).execute();
    await expect(counts(sut, user.id)).resolves.toEqual({ Ada: 1, Bea: 2 });

    // and a photo deleted for good
    await database.deleteFrom('asset').where('id', '=', faces[2].asset.id).execute();
    await expect(counts(sut, user.id)).resolves.toEqual({ Bea: 2 });
    await expect(sut.getListedTotals(user.id)).resolves.toMatchObject({ total: 1 });
    expect(ada.personGroupId).not.toEqual(bea.personGroupId);
  });

  it('keeps counts right after a merge', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { person: ada } = await personIn(ctx, user.id, 'Ada', 2);
    const { person: twin } = await personIn(ctx, user.id, 'Ada again', 3);
    await expect(counts(sut, user.id)).resolves.toEqual({ Ada: 2, 'Ada again': 3 });

    await sut.reassignFaces({ oldPersonGroupId: twin.personGroupId, newPersonGroupId: ada.personGroupId });
    await sut.delete([twin.personGroupId], user.id);

    await expect(counts(sut, user.id)).resolves.toEqual({ Ada: 5 });
    await expect(sut.getListedTotals(user.id)).resolves.toMatchObject({ total: 1, hidden: 0 });
  });

  it('follows hiding a person and archiving or locking a photo', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { person: ada, faces } = await personIn(ctx, user.id, 'Ada', 3);
    await personIn(ctx, user.id, 'Bea', 1);
    await counts(sut, user.id);

    await sut.update({ ownerId: user.id, personGroupId: ada.personGroupId, isHidden: true });
    await expect(counts(sut, user.id)).resolves.toEqual({ Bea: 1 });
    await expect(sut.getListedTotals(user.id)).resolves.toMatchObject({ total: 2, hidden: 1 });
    const withHidden = await sut.getAllForUser(page, user.id, { withHidden: true });
    expect(withHidden.items.map((item) => item.name).toSorted()).toEqual(['Ada', 'Bea']);

    await sut.update({ ownerId: user.id, personGroupId: ada.personGroupId, isHidden: false });
    for (const [index, visibility] of [AssetVisibility.Archive, AssetVisibility.Locked].entries()) {
      await database.updateTable('asset').set({ visibility }).where('id', '=', faces[index].asset.id).execute();
    }
    await expect(counts(sut, user.id)).resolves.toEqual({ Ada: 1, Bea: 1 });
  });

  it('never lets one viewer variant read another’s numbers', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { faces } = await personIn(ctx, user.id, 'Ada', 2);
    await database
      .updateTable('asset')
      .set({ visibility: AssetVisibility.Locked })
      .where('id', '=', faces[0].asset.id)
      .execute();

    const locked = await sut.getAllForUser(page, user.id, { withHidden: false });
    const unlocked = await sut.getAllForUser(page, user.id, { withHidden: false, revealLockedOwnerId: user.id });

    expect(Number(locked.items[0].assetCount)).toBe(1);
    const keys = new Set((await summaries(user.id)).map((row) => row.viewerKey));
    expect(keys.size).toBe(2);
    // whatever an unlocked session counts, the session without its PIN still reads its own row
    expect(Number(unlocked.items[0].assetCount)).toBeGreaterThanOrEqual(1);
    await expect(counts(sut, user.id)).resolves.toEqual({ Ada: 1 });
  });

  it('finds people by name, sorts as the People grid does and pages without repeats', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    await personIn(ctx, user.id, 'Zoë', 3, new Date('2024-01-01T00:00:00.000Z'));
    await personIn(ctx, user.id, 'adam', 1, new Date('2026-01-01T00:00:00.000Z'));
    await personIn(ctx, user.id, 'Bea', 2, new Date('2025-01-01T00:00:00.000Z'));
    // unnamed people show with the default three faces
    await personIn(ctx, user.id, '', 4, new Date('2023-01-01T00:00:00.000Z'));

    const names = async (options: Parameters<PersonRepository['getAllForUser']>[2]) =>
      (await sut.getAllForUser(page, user.id, options)).items.map((item) => item.name);

    await expect(names({ withHidden: false, sort: 'name' })).resolves.toEqual(['adam', 'Bea', 'Zoë', '']);
    await expect(names({ withHidden: false, sort: 'count' })).resolves.toEqual(['', 'Zoë', 'Bea', 'adam']);
    await expect(names({ withHidden: false, sort: 'recent' })).resolves.toEqual(['adam', 'Bea', 'Zoë', '']);
    await expect(names({ withHidden: false, name: 'A', sort: 'name' })).resolves.toEqual(['adam', 'Bea']);
    await expect(names({ withHidden: false, name: '100%' })).resolves.toEqual([]);

    const paged = [];
    for (const skip of [0, 2]) {
      const { items, hasNextPage } = await sut.getAllForUser({ take: 2, skip }, user.id, {
        withHidden: false,
        sort: 'name',
      });
      expect(hasNextPage).toBe(skip === 0);
      paged.push(...items.map((item) => item.name));
    }
    expect(paged).toEqual(['adam', 'Bea', 'Zoë', '']);

    const picker = await sut.getPickerPage(page, user.id, { withHidden: false, name: 'zo' });
    expect(picker.items).toEqual([
      { personGroupId: expect.any(String), name: 'Zoë', updatedAt: expect.any(Date), assetCount: 3 },
    ]);
  });

  // review of PR 1521: tagging a photo with a Locked tag writes only tag_asset, never the photo or its faces
  it('leaves a photo out at once when it gains a Locked tag, and counts it again when the tag goes', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { faces } = await personIn(ctx, user.id, 'Ada', 2);
    const { tag } = await ctx.newTag({ userId: user.id, value: 'Private' });
    // a session without its PIN: the owner's Locked tag rules hide what carries the tag
    const locked = {
      withHidden: false,
      hiddenContent: { ...emptyHiddenContentFilter(user.id), includeNsfw: true, tagIds: [tag.id] },
    };
    const lockedCounts = async () =>
      Object.fromEntries(
        (await sut.getAllForUser(page, user.id, locked)).items.map((item) => [item.name, Number(item.assetCount)]),
      );
    await expect(lockedCounts()).resolves.toEqual({ Ada: 2 });

    await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [faces[0].asset.id] });
    await expect(lockedCounts()).resolves.toEqual({ Ada: 1 });

    await database.deleteFrom('tag_asset').where('tagId', '=', tag.id).execute();
    await expect(lockedCounts()).resolves.toEqual({ Ada: 2 });
  });

  it('starts the change window again a margin back once it has grown, without counting again', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    await personIn(ctx, user.id, 'Ada', 1);
    await counts(sut, user.id);
    // as if the summaries were counted 40 minutes ago and nothing has changed since (stored to the
    // millisecond, as the server writes them)
    await sql`update person_summary_state set "checkedFrom" = date_trunc('milliseconds', now() - interval '1 hour'), "computedAt" = date_trunc('milliseconds', now() - interval '40 minutes') where "ownerId" = ${user.id}`.execute(
      database,
    );
    const [before] = await states(user.id);

    await expect(counts(sut, user.id)).resolves.toEqual({ Ada: 1 });

    const [after] = await states(user.id);
    expect(after.computedAt).toEqual(before.computedAt);
    expect(new Date(after.checkedFrom).getTime()).toBeGreaterThan(new Date(before.checkedFrom).getTime());
  });

  it('drops the summaries of viewer variants nobody reads any more', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    await personIn(ctx, user.id, 'Ada', 1);
    await counts(sut, user.id);

    await sut.deleteSummariesComputedBefore(new Date(Date.now() - 60_000));
    await expect(summaries(user.id)).resolves.toHaveLength(1);
    await sql`update person_summary_state set "computedAt" = now() - interval '31 days' where "ownerId" = ${user.id}`.execute(
      database,
    );
    await sut.deleteSummariesComputedBefore(new Date(Date.now() - 30 * 24 * 60 * 60 * 1000));
    await expect(summaries(user.id)).resolves.toEqual([]);
    await expect(states(user.id)).resolves.toEqual([]);
    // and the next read counts them again
    await expect(counts(sut, user.id)).resolves.toEqual({ Ada: 1 });
  });
});
