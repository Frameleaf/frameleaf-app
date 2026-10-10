import { Kysely } from 'kysely';
import { AssetLockReason, AssetVisibility } from 'src/enum.js';
import { AccessRepository } from 'src/repositories/access.repository.js';
import { AssetRepository } from 'src/repositories/asset.repository.js';
import { EventRepository } from 'src/repositories/event.repository.js';
import { JobRepository } from 'src/repositories/job.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { PersonRepository } from 'src/repositories/person.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { UserRepository } from 'src/repositories/user.repository.js';
import { WebsocketRepository } from 'src/repositories/websocket.repository.js';
import { DB } from 'src/schema/index.js';
import { StackService } from 'src/services/stack.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = (db?: Kysely<DB>) => {
  const { sut, ctx } = newMediumService(StackService, {
    database: db || defaultDatabase,
    real: [AccessRepository, AssetRepository, PersonRepository, StackRepository, UserRepository],
    mock: [EventRepository, JobRepository, LoggingRepository, WebsocketRepository],
  });

  ctx.getMock(WebsocketRepository).clientSend.mockReturnValue();
  ctx.getMock(EventRepository).emit.mockResolvedValue();
  ctx.getMock(JobRepository).queueAll.mockResolvedValue();

  return { sut, ctx };
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(StackService.name, () => {
  describe('create', () => {
    it('should not stack an asset of another user', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { user: otherUser } = await ctx.newUser();
      const { asset } = await ctx.newAsset({ ownerId: user.id });
      const { asset: otherAsset } = await ctx.newAsset({ ownerId: otherUser.id });

      await expect(sut.create(factory.auth({ user }), { assetIds: [asset.id, otherAsset.id] })).rejects.toThrow(
        'Not found or no asset.update access',
      );
      await expect(
        ctx.database.selectFrom('stack').selectAll().where('ownerId', '=', user.id).execute(),
      ).resolves.toEqual([]);
    });
  });

  describe('Locked media (FL-34)', () => {
    it('should return a stack led by Locked media only to its owner in an elevated session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: lockedPrimary } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: member } = await ctx.newAsset({ ownerId: user.id });
      // a stack lists only members with metadata, as every uploaded photo has
      for (const { id } of [lockedPrimary, member]) {
        await ctx.newExif({ assetId: id, make: 'Canon' });
      }
      const { stack } = await ctx.newStack({ ownerId: user.id }, [lockedPrimary.id, member.id]);

      const ordinary = factory.auth({ user });
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

      await expect(sut.search(ordinary, {})).resolves.toEqual([]);
      await expect(sut.search(ordinary, { primaryAssetId: lockedPrimary.id })).resolves.toEqual([]);
      await expect(sut.get(ordinary, stack.id)).rejects.toThrow();

      await expect(sut.search(elevated, {})).resolves.toEqual([
        expect.objectContaining({
          id: stack.id,
          primaryAssetId: lockedPrimary.id,
          assets: [expect.objectContaining({ id: lockedPrimary.id }), expect.objectContaining({ id: member.id })],
        }),
      ]);
      await expect(sut.get(elevated, stack.id)).resolves.toEqual(
        expect.objectContaining({ primaryAssetId: lockedPrimary.id }),
      );

      // the member's own read leaves the stack off unless the owner has unlocked
      const assets = ctx.get(AssetRepository);
      const ordinaryRead = await assets.getById(member.id, { stack: { assets: true } });
      expect(ordinaryRead?.stack).toBeNull();
      const elevatedRead = await assets.getById(member.id, { stack: { assets: true, lockedOwnerId: user.id } });
      expect(elevatedRead?.stack).toEqual(expect.objectContaining({ primaryAssetId: lockedPrimary.id }));
    });

    it('should list a Locked member only for its owner in an elevated session', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: primary } = await ctx.newAsset({ ownerId: user.id });
      const { asset: lockedMember } = await ctx.newAsset({ ownerId: user.id });
      for (const { id } of [primary, lockedMember]) {
        await ctx.newExif({ assetId: id, make: 'Canon' });
      }
      const { stack } = await ctx.newStack({ ownerId: user.id }, [primary.id, lockedMember.id]);
      // A stack created with a Locked photo is Locked as a whole (FL-53); a member locked on its own
      // (a record saved before that rule) must still stay out of an ordinary session's listing.
      await ctx.database
        .insertInto('asset_lock')
        .values({ assetId: lockedMember.id, reason: AssetLockReason.Marked, lockedBy: user.id })
        .execute();

      const memberIds = async (auth: ReturnType<typeof factory.auth>) => {
        const { assets } = await sut.get(auth, stack.id);
        return assets.map(({ id }) => id);
      };

      await expect(memberIds(factory.auth({ user }))).resolves.toEqual([primary.id]);
      await expect(memberIds(factory.auth({ user, session: { hasElevatedPermission: true } }))).resolves.toEqual([
        primary.id,
        lockedMember.id,
      ]);
    });
  });

  describe('notifying a new stack that carries Locked media (FL-53)', () => {
    it('pushes a real-time update for a plain photo a new stack carries into the Locked folder', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: locked } = await ctx.newAsset({ ownerId: user.id, visibility: AssetVisibility.Locked });
      const { asset: plain } = await ctx.newAsset({ ownerId: user.id });
      const elevated = factory.auth({ user, session: { hasElevatedPermission: true } });

      await sut.create(elevated, { assetIds: [locked.id, plain.id] });

      expect(ctx.getMock(WebsocketRepository).clientSend).toHaveBeenCalledWith(
        'on_asset_update',
        user.id,
        expect.objectContaining({ id: plain.id, visibility: AssetVisibility.Locked }),
      );
    });

    it('pushes nothing when the new stack holds no Locked media', async () => {
      const { sut, ctx } = setup();
      const { user } = await ctx.newUser();
      const { asset: first } = await ctx.newAsset({ ownerId: user.id });
      const { asset: second } = await ctx.newAsset({ ownerId: user.id });

      await sut.create(factory.auth({ user }), { assetIds: [first.id, second.id] });

      expect(ctx.getMock(WebsocketRepository).clientSend).not.toHaveBeenCalled();
    });
  });
});
