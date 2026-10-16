import { Kysely } from 'kysely';
import { AssetLockReason } from 'src/enum.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { StackRepository } from 'src/repositories/stack.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let db: Kysely<DB>;
beforeAll(async () => {
  db = await getKyselyDB();
});
afterAll(async () => {
  await db.destroy();
});

it.each([false, true])(
  'unstack fences current members, selection and owner with recorded elevation=%s',
  async (elevated) => {
    const { ctx } = newMediumService(BaseService, { database: db, real: [StackRepository], mock: [LoggingRepository] });
    const { user } = await ctx.newUser();
    const { user: stranger } = await ctx.newUser();
    const repository = new StackRepository(db);
    const stack = async (ownerId: string, count: number) => {
      const members = [];
      for (let i = 0; i < count; i++) members.push((await ctx.newAsset({ ownerId })).asset.id);
      const row = await repository.create({ ownerId }, members);
      return { id: row.id, members };
    };
    const open = await stack(user.id, 2);
    const blocked = await stack(user.id, 2);
    const unselected = await stack(user.id, 1);
    const moved = await stack(user.id, 1);
    const foreign = await stack(stranger.id, 1);
    await db
      .insertInto('asset_lock')
      .values({ assetId: blocked.members[1], reason: AssetLockReason.Marked, lockedBy: user.id })
      .execute();
    const auth = { ...factory.auth({ user: { id: user.id } }), system: true as const };
    const targets = [open.id, blocked.id, unselected.id, foreign.id];
    const selected = [open.members[0], blocked.members[0], moved.members[0]];
    const result = await repository.unstackSelection(auth, targets, selected, elevated);
    expect(new Set(result.deletedStackIds)).toEqual(new Set(elevated ? [open.id, blocked.id] : [open.id]));
    expect(new Set(result.unstackedAssetIds)).toEqual(new Set(elevated ? selected.slice(0, 2) : selected.slice(0, 1)));
    expect(result.lockedAssetIds).toEqual(elevated ? [] : [blocked.members[0]]);
    for (const untouched of [unselected, moved, foreign, ...(!elevated ? [blocked] : [])]) {
      const members = await db.selectFrom('asset').select('id').where('stackId', '=', untouched.id).execute();
      expect(new Set(members.map((row) => row.id))).toEqual(new Set(untouched.members));
    }
    // Replaying the original payload tolerates deleted targets and cannot touch unrelated remaining stacks.
    await repository.unstackSelection(auth, targets, [moved.members[0]], elevated);
    expect(await db.selectFrom('stack').select('id').where('id', '=', unselected.id).executeTakeFirst()).toBeDefined();
    expect(await db.selectFrom('stack').select('id').where('id', '=', moved.id).executeTakeFirst()).toBeDefined();
  },
);
