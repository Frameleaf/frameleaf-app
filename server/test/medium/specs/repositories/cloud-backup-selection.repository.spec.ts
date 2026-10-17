import { Kysely } from 'kysely';
import { randomUUID } from 'node:crypto';
import { AlbumKind, AlbumUserRole, AssetStatus } from 'src/enum.js';
import { CloudBackupIndexRepository } from 'src/repositories/cloud-backup-index.repository.js';
import { CloudBackupSelectionRepository } from 'src/repositories/cloud-backup-selection.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { type CloudBackupChosen, backupUserFingerprint } from 'src/utils/cloud-backup-selection.js';
import { newMediumService } from 'test/medium.factory.js';
import { getKyselyDB } from 'test/utils.js';

/**
 * FL-362: each account's Cloud Backup choice, the inventory each run takes before its database copy, the
 * walk that follows it, the committed counts and the coverage reports (migration 2100000002990).
 */

const INSTANCE = '01900000-0000-7000-8000-000000000001';
const NOTHING: CloudBackupChosen = {
  albumIds: [],
  collectionIds: [],
  personIds: [],
  tagIds: [],
  folders: [],
  favorites: false,
  dateRanges: [],
};

let db: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, { database: db, real: [], mock: [LoggingRepository] });
  return { ctx, sut: new CloudBackupSelectionRepository(db), index: new CloudBackupIndexRepository(db) };
};

const decisions = async (runId: string) => {
  const rows = await db
    .selectFrom('cloud_backup_decision_asset')
    .select(['assetId', 'reason', 'ownerId'])
    .where('runId', '=', runId)
    .execute();
  return Object.fromEntries(rows.map((row) => [row.assetId, row.reason]));
};

const capture = (
  sut: CloudBackupSelectionRepository,
  runId: string,
  licence?: Parameters<typeof sut.captureInventory>[0]['licence'],
) =>
  sut.captureInventory({
    runId,
    manifestKey: `m/20261016T12000${runId.at(-1)}Z.json.gz`,
    instanceId: INSTANCE,
    licence: licence ?? { scope: 'all' },
  });

beforeEach(async () => {
  // a database of its own per case: an inventory counts every account on the server
  db = await getKyselyDB();
});

afterEach(async () => {
  await db.destroy();
});

describe(CloudBackupSelectionRepository.name, () => {
  it('keeps every owned original under Everything and an account with no originals still counts', async () => {
    const { ctx, sut } = setup();
    const { user: owner } = await ctx.newUser();
    const { user: empty } = await ctx.newUser();
    const { asset: active } = await ctx.newAsset({ ownerId: owner.id });
    const { asset: trashed } = await ctx.newAsset({ ownerId: owner.id, status: AssetStatus.Trashed });
    await ctx.newAsset({ ownerId: owner.id, isExternal: true });
    await ctx.newAsset({ ownerId: owner.id, status: AssetStatus.Deleted });

    const runId = randomUUID();
    await expect(capture(sut, runId)).resolves.toMatchObject({ created: true });

    expect(await decisions(runId)).toEqual({ [active.id]: 'included', [trashed.id]: 'included' });
    const accounts = await sut.getDecisionAccounts(runId);
    expect(accounts).toEqual(
      expect.arrayContaining([
        expect.objectContaining({
          userId: owner.id,
          userFingerprint: backupUserFingerprint(INSTANCE, owner.id),
          selectionHash: null,
          totalOriginals: 2,
          selectedOriginals: 2,
          licenceEligible: true,
          includedOriginals: null,
        }),
        expect.objectContaining({ userId: empty.id, totalOriginals: 0, selectedOriginals: 0, licenceEligible: true }),
      ]),
    );
    expect(accounts).toHaveLength(2);
  });

  it('keeps an original that matches any choice, a date range adding to the others', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const at = (iso: string) => ({ localDateTime: new Date(iso), fileCreatedAt: new Date(iso) });
    const asset = (overrides: Record<string, unknown> = {}) =>
      ctx.newAsset({ ownerId: user.id, ...at('2019-06-01T12:00:00Z'), ...overrides }).then(({ asset }) => asset);

    const inAlbum = await asset();
    const inCollection = await asset();
    const withPerson = await asset();
    const tagged = await asset();
    const inFolder = await asset({ originalPath: '/library/user/Trips/2019/beach.jpg' });
    const favorite = await asset({ isFavorite: true });
    const inRange = await asset(at('2024-03-10T09:00:00Z'));
    const recent = await asset(at(new Date(Date.now() - 30 * 86_400_000).toISOString()));
    const nothing = await asset({ originalPath: '/library/user/Trips2019/not-a-subfolder.jpg' });
    const othersInAlbum = await ctx.newAsset({ ownerId: other.id }).then(({ asset }) => asset);

    const { album } = await ctx.newAlbum({ ownerId: user.id }, [inAlbum.id, othersInAlbum.id]);
    const { album: collection } = await ctx.newAlbum({ ownerId: user.id, kind: AlbumKind.Collection });
    await ctx.newAlbum({ ownerId: user.id, parentId: collection.id }, [inCollection.id]);
    const { person } = await ctx.newPerson({ ownerId: user.id });
    await ctx.newAssetFace({ assetId: withPerson.id, personGroupId: person.personGroupId });
    const { tag: parent } = await ctx.newTag({ userId: user.id, value: 'Travel' });
    const { tag: child } = await ctx.newTag({ userId: user.id, value: 'Travel/Beach', parentId: parent.id });
    await ctx.newTagAsset({ tagIds: [child.id], assetIds: [tagged.id] });
    // the other account chooses only its favorites: its photo in this account's album is its own business
    await sut.setSelection(other.id, { ...NOTHING, favorites: true });
    await sut.setSelection(user.id, {
      albumIds: [album.id],
      collectionIds: [collection.id],
      personIds: [person.personGroupId],
      tagIds: [parent.id],
      folders: ['/library/user/Trips'],
      favorites: true,
      dateRanges: [
        { kind: 'between', from: '2024-03-01', to: '2024-03-31' },
        { kind: 'recent', months: 12 },
      ],
    });

    const runId = randomUUID();
    await capture(sut, runId);

    expect(await decisions(runId)).toEqual({
      [inAlbum.id]: 'included',
      [inCollection.id]: 'included',
      [withPerson.id]: 'included',
      [tagged.id]: 'included',
      [inFolder.id]: 'included',
      [favorite.id]: 'included',
      [inRange.id]: 'included',
      [recent.id]: 'included',
      [nothing.id]: 'selection',
      [othersInAlbum.id]: 'selection',
    });
    const accounts = await sut.getDecisionAccounts(runId);
    expect(accounts.find(({ userId }) => userId === user.id)).toMatchObject({
      totalOriginals: 9,
      selectedOriginals: 8,
      selectionHash: expect.stringMatching(/^[\da-f]{64}$/),
    });
    expect(accounts.find(({ userId }) => userId === other.id)).toMatchObject({
      totalOriginals: 1,
      selectedOriginals: 0,
    });
    await expect(sut.estimate(user.id, await sut.getSelection(user.id))).resolves.toEqual({ total: 9, selected: 8 });
  });

  it('keeps licence eligibility apart from the choice', async () => {
    const { ctx, sut } = setup();
    const { user: licensed } = await ctx.newUser();
    const { user: unlicensed } = await ctx.newUser();
    const { asset: kept } = await ctx.newAsset({ ownerId: licensed.id });
    const { asset: chosenButUnlicensed } = await ctx.newAsset({ ownerId: unlicensed.id, isFavorite: true });
    const { asset: notChosen } = await ctx.newAsset({ ownerId: unlicensed.id });
    await sut.setSelection(unlicensed.id, { ...NOTHING, favorites: true });

    const runId = randomUUID();
    await capture(sut, runId, { scope: 'users', userFingerprints: [backupUserFingerprint(INSTANCE, licensed.id)] });

    expect(await decisions(runId)).toEqual({
      [kept.id]: 'included',
      [chosenButUnlicensed.id]: 'licence',
      [notChosen.id]: 'selection',
    });
    const accounts = await sut.getDecisionAccounts(runId);
    expect(accounts.find(({ userId }) => userId === unlicensed.id)).toMatchObject({
      totalOriginals: 2,
      selectedOriginals: 1,
      licenceEligible: false,
    });
    await expect(sut.getEligibleOwners(runId)).resolves.toEqual(new Set([licensed.id]));
  });

  it('takes one inventory per run and keeps only the latest run’s record', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    await ctx.newAsset({ ownerId: user.id });
    const first = randomUUID();
    const { inventoryAt } = await capture(sut, first);
    await ctx.newAsset({ ownerId: user.id });

    await expect(capture(sut, first)).resolves.toEqual({ inventoryAt, created: false });
    expect(Object.keys(await decisions(first))).toHaveLength(1);

    const second = randomUUID();
    await capture(sut, second);
    await expect(sut.getDecisionRun(first)).resolves.toBeUndefined();
    expect(Object.keys(await decisions(second))).toHaveLength(2);
    await expect(sut.findDecisionRunByManifest(`m/20261016T12000${second.at(-1)}Z.json.gz`)).resolves.toMatchObject({
      runId: second,
    });
  });

  it('drops gone albums, people and tags from a choice without failing a run', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id });
    const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
    const { tag } = await ctx.newTag({ userId: user.id, value: 'Gone' });
    await sut.setSelection(user.id, { ...NOTHING, albumIds: [album.id], tagIds: [tag.id], personIds: [randomUUID()] });
    await ctx.softDeleteAlbum(album.id);
    await db.deleteFrom('tag').where('id', '=', tag.id).execute();

    await expect(sut.getSelection(user.id)).resolves.toEqual({ ...NOTHING, albumIds: [], tagIds: [], personIds: [] });
    const runId = randomUUID();
    await capture(sut, runId);
    expect(await decisions(runId)).toEqual({ [asset.id]: 'selection' });
  });

  it('offers only albums an account owns or shares, and its own collections, people and tags', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { user: other } = await ctx.newUser();
    const { album: own } = await ctx.newAlbum({ ownerId: user.id });
    const { album: shared } = await ctx.newAlbum({ ownerId: other.id });
    await ctx.newAlbumUser({ albumId: shared.id, userId: user.id, role: AlbumUserRole.Viewer });
    const { album: foreign } = await ctx.newAlbum({ ownerId: other.id });
    const { person: foreignPerson } = await ctx.newPerson({ ownerId: other.id });
    const { tag: foreignTag } = await ctx.newTag({ userId: other.id, value: 'Theirs' });

    await expect(
      sut.choosable(user.id, {
        albumIds: [own.id, shared.id, foreign.id],
        collectionIds: [foreign.id],
        personIds: [foreignPerson.personGroupId],
        tagIds: [foreignTag.id],
      }),
    ).resolves.toEqual({ albumIds: [own.id, shared.id], collectionIds: [], personIds: [], tagIds: [] });
  });

  it('inventories more than one coverage page of accounts, every one of them', async () => {
    const { ctx, sut } = setup();
    const users = [];
    for (let index = 0; index < 33; index++) {
      users.push((await ctx.newUser()).user);
    }
    const runId = randomUUID();
    await capture(sut, runId);
    const accounts = await sut.getDecisionAccounts(runId);
    expect(accounts.map(({ userId }) => userId).toSorted()).toEqual(users.map(({ id }) => id).toSorted());
  });

  it('walks only the kept originals and counts what the committed manifest holds per account', async () => {
    const { ctx, sut, index } = setup();
    const { user } = await ctx.newUser();
    const { asset: kept } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
    const { asset: missing } = await ctx.newAsset({ ownerId: user.id, isFavorite: true });
    const { asset: left } = await ctx.newAsset({ ownerId: user.id });
    await sut.setSelection(user.id, { ...NOTHING, favorites: true });
    const runId = randomUUID();
    await capture(sut, runId);
    // added after the inventory: the next run's
    await ctx.newAsset({ ownerId: user.id, isFavorite: true });

    const walked = await index.listAssets({
      afterId: null,
      limit: 25,
      includeThumbs: false,
      includeEncodedVideo: false,
      decisionRunId: runId,
    });
    expect(walked.map(({ id }) => id).toSorted()).toEqual([kept.id, missing.id].toSorted());
    await expect(index.countAssets(runId)).resolves.toBe(2);
    expect(walked.map(({ id }) => id)).not.toContain(left.id);

    const manifest = await index.createManifest({
      bucket: 'https://s3.test/bucket',
      key: 'm/20261016T120000Z.json.gz',
      operationId: runId,
    });
    await index.upsertEntries(manifest.id, [
      {
        fileKey: `${kept.id}:original`,
        assetId: kept.id,
        ownerId: user.id,
        role: 'original',
        path: kept.originalPath,
        sha256: 'a'.repeat(64),
        size: 1,
        mtime: null,
      },
      {
        fileKey: `${kept.id}:sidecar:x`,
        assetId: kept.id,
        ownerId: user.id,
        role: 'sidecar',
        path: 'x',
        sha256: 'b'.repeat(64),
        size: 1,
        mtime: null,
      },
    ]);
    await sut.recordIncluded(runId, manifest.id);
    await sut.recordIncluded(runId, manifest.id);
    expect((await sut.getDecisionAccounts(runId)).find(({ userId }) => userId === user.id)).toMatchObject({
      totalOriginals: 3,
      selectedOriginals: 2,
      includedOriginals: 1,
    });
  });

  it('pages the walk set with each item’s reason, Locked items marked', async () => {
    const { ctx, sut } = setup();
    const { user } = await ctx.newUser();
    const { asset } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'a.jpg' });
    const runId = randomUUID();
    await capture(sut, runId);
    const { asset: later } = await ctx.newAsset({ ownerId: user.id, originalFileName: 'b.jpg' });

    const page = await sut.getInventoryPage(runId, null, 10, user.id);
    expect(page.toSorted((a, b) => a.originalFileName.localeCompare(b.originalFileName))).toEqual([
      { id: asset.id, ownerId: user.id, originalFileName: 'a.jpg', locked: false, reason: 'included' },
      { id: later.id, ownerId: user.id, originalFileName: 'b.jpg', locked: false, reason: null },
    ]);
    await expect(sut.getInventoryPage(null, null, 10, randomUUID())).resolves.toEqual([]);
  });

  it('writes a coverage report once and keeps its exact page bodies', async () => {
    const { sut } = setup();
    const runId = randomUUID();
    const body = JSON.stringify({ rows: [] });
    const report = {
      runId,
      instanceId: INSTANCE,
      revisionId: randomUUID(),
      sequence: 1,
      inventoryAt: new Date('2026-10-16T12:00:00Z'),
      accountCount: 0,
      pageCount: 0,
      snapshot: null,
      pages: [],
      runReport: { runId, manifestKey: null },
      status: 'pending' as const,
    };
    await sut.createCoverageReport(report);
    await sut.createCoverageReport({ ...report, revisionId: randomUUID(), status: 'local' });
    await expect(sut.getCoverageReport(runId)).resolves.toMatchObject({
      revisionId: report.revisionId,
      status: 'pending',
    });
    await expect(sut.listDueCoverageReports(new Date(), 10)).resolves.toHaveLength(1);
    await sut.updateCoverageReport(runId, { status: 'published', publishedAt: new Date(), pages: [], snapshot: null });
    await expect(sut.listDueCoverageReports(new Date(), 10)).resolves.toEqual([]);
    await expect(sut.getLatestPublishedCoverageReport()).resolves.toMatchObject({ runId });
    expect(body).toBe('{"rows":[]}');
  });
});
