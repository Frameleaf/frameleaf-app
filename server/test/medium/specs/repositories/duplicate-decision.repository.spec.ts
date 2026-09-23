import { Kysely, sql } from 'kysely';
import {
  AssetStatus,
  AssetVisibility,
  DuplicateDecisionKind,
  MediaOperationBulkAction,
  MediaOperationDestination,
  MediaOperationKind,
} from 'src/enum.js';
import { DuplicateDecisionRepository } from 'src/repositories/duplicate-decision.repository.js';
import { LoggingRepository } from 'src/repositories/logging.repository.js';
import { MediaOperationRepository } from 'src/repositories/media-operation.repository.js';
import { DB } from 'src/schema/index.js';
import { BaseService } from 'src/services/base.service.js';
import { newMediumService } from 'test/medium.factory.js';
import { factory } from 'test/small.factory.js';
import { getKyselyDB } from 'test/utils.js';

let defaultDatabase: Kysely<DB>;

const setup = () => {
  const { ctx } = newMediumService(BaseService, {
    database: defaultDatabase,
    real: [],
    mock: [LoggingRepository],
  });
  return { ctx, sut: new DuplicateDecisionRepository(defaultDatabase) };
};

/** The stored JSON kind of each list: a value serialized twice would read back as 'string'. */
const jsonTypes = async (id: string) => {
  const { rows } = await sql<{ memberIds: string; keepAssetIds: string; trashAssetIds: string; state: string }>`
    SELECT
      jsonb_typeof("memberIds") AS "memberIds",
      jsonb_typeof("keepAssetIds") AS "keepAssetIds",
      jsonb_typeof("trashAssetIds") AS "trashAssetIds",
      jsonb_typeof(state) AS state
    FROM duplicate_decision
    WHERE id = ${id}::uuid
  `.execute(defaultDatabase);
  return rows[0];
};

beforeAll(async () => {
  defaultDatabase = await getKyselyDB();
});

describe(DuplicateDecisionRepository.name, () => {
  const newJob = (ctx: ReturnType<typeof setup>['ctx'], ownerId: string, groups: unknown[] = []) =>
    ctx.get(MediaOperationRepository).create({
      ownerId,
      kind: MediaOperationKind.Bulk,
      destination: MediaOperationDestination.Local,
      label: 'resolve duplicates',
      snapshot: {
        action: MediaOperationBulkAction.ResolveDuplicates,
        assetIds: [],
        payload: { duplicateGroups: groups },
      },
      settings: {},
    });

  describe('getGroupMembers', () => {
    it('reads the complete group, whoever owns each photo, so a mixed group is never decided in part', async () => {
      const { ctx, sut } = setup();
      const { user: owner } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const duplicateId = factory.uuid();
      const { asset: mine } = await ctx.newAsset({ ownerId: owner.id, duplicateId });
      const { asset: theirs } = await ctx.newAsset({ ownerId: other.id, duplicateId });
      await ctx.newExif({ assetId: mine.id, make: 'Canon' });
      await ctx.newExif({ assetId: theirs.id, make: 'Canon' });

      const members = await sut.getGroupMembers([duplicateId]);

      expect(members).toEqual(
        expect.arrayContaining([
          { id: mine.id, ownerId: owner.id, duplicateId },
          { id: theirs.id, ownerId: other.id, duplicateId },
        ]),
      );
    });

    it('leaves out Locked, trashed, stacked and hidden photos, as the review and resolve do', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const duplicateId = factory.uuid();
      const { asset: visible } = await ctx.newAsset({ ownerId: user.id, duplicateId });
      const { asset: locked } = await ctx.newAsset({
        ownerId: user.id,
        duplicateId,
        visibility: AssetVisibility.Locked,
      });
      const { asset: trashed } = await ctx.newAsset({
        ownerId: user.id,
        duplicateId,
        deletedAt: new Date(),
        status: AssetStatus.Trashed,
      });
      const { asset: hidden } = await ctx.newAsset({
        ownerId: user.id,
        duplicateId,
        visibility: AssetVisibility.Hidden,
      });
      const { asset: stacked } = await ctx.newAsset({ ownerId: user.id, duplicateId });
      const { asset: sibling } = await ctx.newAsset({ ownerId: user.id });
      await ctx.newStack({ ownerId: user.id }, [stacked.id, sibling.id]);
      for (const { id } of [visible, locked, trashed, hidden, stacked]) {
        await ctx.newExif({ assetId: id, make: 'Canon' });
      }
      // no metadata at all: the review and resolve never read such a photo into a group either
      await ctx.newAsset({ ownerId: user.id, duplicateId });

      const members = await sut.getGroupMembers([duplicateId]);

      expect(members.map(({ id }) => id)).toEqual([visible.id]);
    });
  });

  describe('decisions', () => {
    it('stores the lists as JSON and answers a replayed create with the first row', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const operation = await newJob(ctx, user.id);
      const values = {
        ownerId: user.id,
        duplicateId: factory.uuid(),
        operationId: operation.id,
        decision: DuplicateDecisionKind.Keepers,
        memberIds: [factory.uuid(), factory.uuid()],
        keepAssetIds: [] as string[],
        trashAssetIds: [] as string[],
        state: { before: {} },
      };
      values.keepAssetIds = [values.memberIds[0]];
      values.trashAssetIds = [values.memberIds[1]];

      const first = await sut.create(values);
      const replay = await sut.create(values);

      expect(replay.id).toBe(first.id);
      expect(await jsonTypes(first.id)).toEqual({
        memberIds: 'array',
        keepAssetIds: 'array',
        trashAssetIds: 'array',
        state: 'object',
      });
      expect(first.memberIds).toEqual(values.memberIds);
      expect(first.trashAssetIds).toEqual(values.trashAssetIds);
      expect(await sut.getUnfinished(user.id, values.duplicateId)).toEqual(expect.objectContaining({ id: first.id }));

      await sut.markApplied(first.id, { stackId: null, state: { before: {}, after: {} } });
      expect((await jsonTypes(first.id))?.state).toBe('object');
      expect((await sut.getById(user.id, first.id))?.state).toEqual({ before: {}, after: {} });
      expect(await sut.getUnfinished(user.id, values.duplicateId)).toBeUndefined();
      expect((await sut.getById(user.id, first.id))?.appliedAt).not.toBeNull();
    });

    it('lets exactly one undo job claim a decision, and never another account', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const operation = await newJob(ctx, user.id);
      const [undoA, undoB] = [await newJob(ctx, user.id), await newJob(ctx, user.id)];
      const decision = await sut.create({
        ownerId: user.id,
        duplicateId: factory.uuid(),
        operationId: operation.id,
        decision: DuplicateDecisionKind.KeepAll,
        memberIds: [factory.uuid(), factory.uuid()],
        keepAssetIds: [],
        trashAssetIds: [],
        state: {},
      });
      await sut.markApplied(decision.id, { stackId: null, state: {} });

      expect(await sut.beginUndo(decision.id, undoA.id)).toBe(true);
      expect(await sut.beginUndo(decision.id, undoA.id)).toBe(true);
      expect(await sut.beginUndo(decision.id, undoB.id)).toBe(false);
      expect(await sut.getById(other.id, decision.id)).toBeUndefined();
      expect(await sut.getByIds(other.id, [decision.id])).toEqual([]);
    });

    it('lists the recent decision jobs of the owner only', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const operation = await newJob(ctx, user.id);
      await sut.create({
        ownerId: user.id,
        duplicateId: factory.uuid(),
        operationId: operation.id,
        decision: DuplicateDecisionKind.Stack,
        memberIds: [factory.uuid(), factory.uuid()],
        keepAssetIds: [],
        trashAssetIds: [],
        state: {},
      });

      expect(await sut.listRecent(user.id, 10)).toHaveLength(1);
      expect(await sut.listRecent(other.id, 10)).toEqual([]);
    });
  });

  describe('relink', () => {
    it('puts only the owner’s photos that belong to no other group back into the group', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const { user: other } = await ctx.newUser();
      const duplicateId = factory.uuid();
      const { asset: free } = await ctx.newAsset({ ownerId: user.id });
      const { asset: regrouped } = await ctx.newAsset({ ownerId: user.id, duplicateId: factory.uuid() });
      const { asset: foreign } = await ctx.newAsset({ ownerId: other.id });

      await sut.relink(user.id, [free.id, regrouped.id, foreign.id], duplicateId);

      const states = new Map(
        (await sut.getAssetStates([free.id, regrouped.id, foreign.id])).map((state) => [state.id, state]),
      );
      expect(states.get(free.id)?.duplicateId).toBe(duplicateId);
      expect(states.get(regrouped.id)?.duplicateId).not.toBe(duplicateId);
      expect(states.get(foreign.id)?.duplicateId).toBeNull();
    });
  });

  describe('listActiveOperations', () => {
    it('returns the owner’s running decision jobs with their groups', async () => {
      const { ctx, sut } = setup();
      const { user } = await ctx.newUser();
      const groups = [{ duplicateId: factory.uuid(), decision: 'keep-all', memberIds: ['a', 'b'], keepAssetIds: [] }];
      const operation = await newJob(ctx, user.id, groups);

      const active = await sut.listActiveOperations(user.id);

      expect(active).toEqual([
        { id: operation.id, action: MediaOperationBulkAction.ResolveDuplicates, duplicateGroups: groups },
      ]);
    });
  });
});
