import { Kysely } from 'kysely';
import { AlbumUserRole, AssetFileType, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetFileRepository } from 'src/repositories/asset-file.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { ForkPrivacyRepository } from 'src/repositories/fork-privacy.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { DB } from 'src/schema/index.js';
import { AssetFileService } from 'src/services/asset-file.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getActiveForkKyselyDB, getKyselyDB } from 'test/utils.js';

/**
 * FL-34 (ported from PR131 02db47e12c): derivative files carry their source asset's hidden-content
 * filter. Adapted to per-asset `asset_lock`: a `Locked` seed is a timeline asset with a lock record.
 */
let database: Kysely<DB>;
beforeAll(async () => {
  database = await getActiveForkKyselyDB();
});
afterAll(async () => database?.destroy());
const methods = ['get', 'download', 'delete'] as const;

const setup = async (db = database, visibility = AssetVisibility.Timeline, isEdited = true) => {
  const { sut, ctx } = newMediumService(AssetFileService, {
    database: db,
    real: [AssetRepository, AssetFileRepository, AccessRepository],
    mock: [JobRepository, LoggingRepository],
  });
  ctx.getMock(JobRepository).queue.mockResolvedValue();
  const { user } = await ctx.newUser();
  const { asset } = await ctx.newAsset({ ownerId: user.id, visibility });
  await ctx.newAssetFile({
    assetId: asset.id,
    type: AssetFileType.Preview,
    path: '/synthetic/derived-preview.jpeg',
    isEdited,
  });
  const file = await db.selectFrom('asset_file').selectAll().where('assetId', '=', asset.id).executeTakeFirstOrThrow();
  const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });
  const locked = { ...factory.auth({ user, session: { hasElevatedPermission: false } }), hideNsfwAssets: true };
  const mark = () => new ForkPrivacyRepository(db).saveClassification(asset.id, true, { action: 'marked-nsfw' }, db);
  return { sut, ctx, asset, file, user, elevated, locked, mark };
};

it.each(methods)(
  'denies %s of a remembered derivative file after its source is marked and the session locks',
  async (method) => {
    const { sut, ctx, asset, file, elevated, locked, mark } = await setup();
    await expect(sut.get(elevated, file.id)).resolves.toMatchObject({ id: file.id });
    await mark();
    // The ordinary source-keyed list already applies source privacy.
    await expect(sut.search(locked, { assetId: asset.id })).rejects.toThrow();
    await expect(sut[method](locked, file.id)).rejects.toThrow();
    expect(ctx.getMock(JobRepository).queue).not.toHaveBeenCalled();
    await expect(
      database.selectFrom('asset_file').select('id').where('id', '=', file.id).executeTakeFirst(),
    ).resolves.toEqual({ id: file.id });
  },
);

it.each([false, true])(
  'allows an elevated owner to read/download/delete a sensitive derivative (edited=%s)',
  async (isEdited) => {
    const { sut, ctx, file, elevated, mark } = await setup(database, AssetVisibility.Timeline, isEdited);
    await mark();
    await expect(sut.get(elevated, file.id)).resolves.toMatchObject({ id: file.id });
    await expect(sut.download(elevated, file.id)).resolves.toMatchObject({ path: file.path });
    await sut.delete(elevated, file.id);
    expect(ctx.getMock(JobRepository).queue).toHaveBeenCalledOnce();
  },
);

it('preserves owner access when hiding is disabled and denies locked files without elevation', async () => {
  const { sut, user, file, mark } = await setup();
  await mark();
  const unfiltered = factory.auth({ user });
  await expect(sut.download(unfiltered, file.id)).resolves.toMatchObject({ path: file.path });
  const legacy = await setup(database, AssetVisibility.Locked);
  for (const method of methods)
    await expect(legacy.sut[method](factory.auth({ user: legacy.user }), legacy.file.id)).rejects.toThrow();
  await expect(legacy.sut.download(legacy.elevated, legacy.file.id)).resolves.toMatchObject({ path: legacy.file.path });
});

it('does not grant asset-file access through admin status, partnership, shared albums or public links', async () => {
  const { sut, ctx, asset, user, file } = await setup();
  const { user: other } = await ctx.newUser();
  await ctx.newPartner({ sharedById: user.id, sharedWithId: other.id });
  const { album } = await ctx.newAlbum({ ownerId: user.id }, [asset.id]);
  await ctx.newAlbumUser({ albumId: album.id, userId: other.id, role: AlbumUserRole.Viewer });
  const foreign = factory.auth({ user: { ...other, isAdmin: true }, session: { hasElevatedPermission: true } });
  const shared = factory.auth({ user, sharedLink: { allowDownload: true }, session: { hasElevatedPermission: true } });
  for (const auth of [foreign, shared])
    for (const method of methods) await expect(sut[method](auth, file.id)).rejects.toThrow();
});

it('fails closed for missing active privacy rows while allowing the elevated owner', async () => {
  const { sut, asset, file, elevated, locked } = await setup();
  await new ForkPrivacyRepository(database).delete([asset.id]);
  for (const method of methods) await expect(sut[method](locked, file.id)).rejects.toThrow();
  await expect(sut.download(elevated, file.id)).resolves.toMatchObject({ path: file.path });
});

it('applies tag/person suppression to derivative access independently of sensitive classification', async () => {
  const { sut, ctx, asset, file, user, locked } = await setup();
  const { tag } = await ctx.newTag({ userId: user.id, value: 'private-rule' });
  await ctx.newTagAsset({ tagIds: [tag.id], assetIds: [asset.id] });
  const { person } = await ctx.newPerson({ ownerId: user.id });
  await ctx.newAssetFace({ assetId: asset.id, personGroupId: person.personGroupId });
  for (const rule of [
    { tagIds: [tag.id], personIds: [], petIds: [] },
    { tagIds: [], personIds: [person.personGroupId], petIds: [] },
  ]) {
    const auth = {
      ...locked,
      hiddenContent: { ...rule, userId: user.id, includeNsfw: false, scope: 'owned' as const },
    };
    for (const method of methods) await expect(sut[method](auth, file.id)).rejects.toThrow();
  }
});

it('uses legacy source classification before the active-sidecar cutover', async () => {
  const legacyDatabase = await getKyselyDB();
  try {
    const { sut, asset, file, locked } = await setup(legacyDatabase);
    await legacyDatabase.updateTable('asset').set({ is_nsfw: true }).where('id', '=', asset.id).execute();
    for (const method of methods) await expect(sut[method](locked, file.id)).rejects.toThrow();
  } finally {
    await legacyDatabase.destroy();
  }
});
