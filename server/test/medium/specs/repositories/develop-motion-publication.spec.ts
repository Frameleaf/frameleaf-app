import { Kysely } from 'kysely';
import { AssetDevelopRevisionStatus } from 'src/dtos/asset-develop.dto.js';
import { AssetLockReason, AssetType, AssetVisibility, Permission } from 'src/enum.js';
import { assertPublicationMotionSource, publicationTransaction } from 'src/queue/transaction.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetDevelopRepository } from 'src/repositories/asset-develop.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { DB } from 'src/schema/index.js';
import { requireAccess } from 'src/utils/access.js';
import { defaultDevelopRecipe } from 'src/utils/develop-recipe.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { seedCanonicalAsset, seedCanonicalUser } from 'test/fixtures/canonical-database.js';
import { getKyselyDB } from 'test/utils.js';

describe('motion keyframe source adoption', () => {
  let db: Kysely<DB>;
  beforeAll(async () => {
    db = await getKyselyDB();
  });
  afterAll(async () => {
    await db?.destroy();
  });

  const prepare = async () => {
    const owner = await seedCanonicalUser(db);
    const motionSeed = await seedCanonicalAsset(db, {
      ownerId: owner.id,
      type: AssetType.Video,
      visibility: AssetVisibility.Hidden,
    });
    const stillSeed = await seedCanonicalAsset(db, { ownerId: owner.id, livePhotoVideoId: motionSeed.id });
    const motion = await db.selectFrom('asset').selectAll().where('id', '=', motionSeed.id).executeTakeFirstOrThrow();
    const still = await db.selectFrom('asset').selectAll().where('id', '=', stillSeed.id).executeTakeFirstOrThrow();
    const revisions = new AssetDevelopRepository(db);
    const input = {
      assetId: still.id,
      ownerId: owner.id,
      recipe: { ...defaultDevelopRecipe(), keyFrame: { timeMs: 1000 } },
      recipeVersion: 1,
      label: null,
    };
    const previous = await revisions.create({
      ...input,
      status: AssetDevelopRevisionStatus.Rendered,
      masterPath: '/previous/master',
    });
    await revisions.setCurrent(still.id, previous.id);
    const candidate = await revisions.create({ ...input, status: AssetDevelopRevisionStatus.Rendering });
    const adopt = () =>
      db.transaction().execute((tx) =>
        publicationTransaction.run(tx, async () => {
          await assertPublicationMotionSource(still.id, owner.id, still.checksum, motion.id, motion.checksum);
          await revisions.update(candidate.id, {
            status: AssetDevelopRevisionStatus.Rendered,
            masterPath: '/attempt/master',
            sourceAssetId: motion.id,
            sourceChecksum: Buffer.alloc(32, 4),
          });
          await revisions.setCurrent(still.id, candidate.id);
        }),
      );
    return { owner, motion, still, revisions, previous, candidate, adopt };
  };

  it('uses the existing owner and PIN authority for an independently locked paired clip', async () => {
    const f = await prepare();
    const access = new AccessRepository(db);
    const auth = { ...authStub.user1, user: { ...authStub.user1.user, id: f.owner.id } };
    await requireAccess(access, { auth, permission: Permission.AssetEditGet, ids: [f.motion.id] });
    await db
      .insertInto('asset_lock')
      .values({ assetId: f.motion.id, reason: AssetLockReason.Marked, lockedBy: f.owner.id })
      .execute();
    await requireAccess(access, { auth, permission: Permission.AssetEditGet, ids: [f.still.id] });
    await expect(
      requireAccess(access, { auth, permission: Permission.AssetEditGet, ids: [f.motion.id] }),
    ).rejects.toThrow();
    const elevated = { ...auth, session: { ...auth.session!, hasElevatedPermission: true } };
    await requireAccess(access, { auth: elevated, permission: Permission.AssetEditGet, ids: [f.motion.id] });
    await expect(f.adopt()).rejects.toThrow('Prepared motion source changed or became unavailable');
  });

  it('accepts the owner’s Hidden paired clip with honest motion source lineage', async () => {
    const f = await prepare();
    await f.adopt();
    expect(await f.revisions.getCurrent(f.still.id)).toMatchObject({
      id: f.candidate.id,
      sourceAssetId: f.motion.id,
      sourceChecksum: Buffer.alloc(32, 4),
    });
  });

  it.each(['checksum', 'unlink', 'replace', 'lock', 'delete', 'offline', 'owner'] as const)(
    'rejects %s after rendering while preserving the previous current version',
    async (change) => {
      const f = await prepare();
      switch (change) {
        case 'checksum': {
          await db
            .updateTable('asset')
            .set({ checksum: Buffer.alloc(20, 5) })
            .where('id', '=', f.motion.id)
            .execute();
          break;
        }
        case 'unlink': {
          await db.updateTable('asset').set({ livePhotoVideoId: null }).where('id', '=', f.still.id).execute();
          break;
        }
        case 'replace': {
          const replacement = await seedCanonicalAsset(db, { ownerId: f.owner.id, type: AssetType.Video });
          await db
            .updateTable('asset')
            .set({ livePhotoVideoId: replacement.id })
            .where('id', '=', f.still.id)
            .execute();
          break;
        }
        case 'lock': {
          await db
            .insertInto('asset_lock')
            .values({ assetId: f.motion.id, reason: AssetLockReason.Marked, lockedBy: f.owner.id })
            .execute();
          break;
        }
        case 'delete': {
          await db.updateTable('asset').set({ deletedAt: new Date() }).where('id', '=', f.motion.id).execute();
          break;
        }
        case 'offline': {
          await db.updateTable('asset').set({ isOffline: true }).where('id', '=', f.motion.id).execute();
          break;
        }
        case 'owner': {
          const owner = await seedCanonicalUser(db);
          await db.updateTable('asset').set({ ownerId: owner.id }).where('id', '=', f.motion.id).execute();
          break;
        }
      }
      await expect(f.adopt()).rejects.toThrow('Prepared motion source changed or became unavailable');
      expect((await f.revisions.getCurrent(f.still.id))?.id).toBe(f.previous.id);
      expect((await f.revisions.get(f.candidate.id))?.masterPath).toBeNull();
    },
  );

  it('serializes a competing privacy lock with adoption on the same asset rows', async () => {
    const f = await prepare();
    const { promise: gate, resolve: release } = Promise.withResolvers<void>();
    const { promise: ready, resolve: pinned } = Promise.withResolvers<void>();
    const adopting = db.transaction().execute((tx) =>
      publicationTransaction.run(tx, async () => {
        await assertPublicationMotionSource(f.still.id, f.owner.id, f.still.checksum, f.motion.id, f.motion.checksum);
        pinned();
        await gate;
        await f.revisions.update(f.candidate.id, {
          status: AssetDevelopRevisionStatus.Rendered,
          masterPath: '/attempt/master',
        });
        await f.revisions.setCurrent(f.still.id, f.candidate.id);
      }),
    );
    await ready;
    let lockFinished = false;
    const locking = new AssetRepository(db).lock([f.motion.id], AssetLockReason.Marked, f.owner.id).then(() => {
      lockFinished = true;
    });
    await new Promise((resolve) => setTimeout(resolve, 30));
    expect(lockFinished).toBe(false);
    release();
    await Promise.all([adopting, locking]);
    expect((await new AssetRepository(db).getById(f.motion.id))?.isLocked).toBe(true);
  });
});
