import type { DuplicateDecision, DuplicateKeeperState } from 'src/repositories/duplicate-decision.repository.js';
import {
  AssetStatus,
  AssetType,
  AssetVisibility,
  DuplicateDecisionKind,
  DuplicateGroupBlock,
  DuplicateGroupKind,
  MediaOperationBulkAction,
  MediaOperationItemStatus,
} from 'src/enum.js';
import { DuplicateDecisionReason, DuplicateDecisionService } from 'src/services/duplicate-decision.service.js';
import { authStub } from 'test/fixtures/auth.stub.js';
import { newUuid, newUuidV7 } from 'test/small.factory.js';

const owner = authStub.user1;
const ownerId = owner.user.id;
const elevated = { ...owner, session: { id: 'session', hasElevatedPermission: true } } as typeof owner;

const keeperState = (overrides: Partial<DuplicateKeeperState> = {}): DuplicateKeeperState => ({
  isFavorite: false,
  visibility: AssetVisibility.Timeline,
  rating: null,
  description: '',
  latitude: null,
  longitude: null,
  albumIds: [],
  tagIds: [],
  ...overrides,
});

const asset = (id: string, time = '2026-09-06T16:24:12.000Z', type = AssetType.Image) => ({
  id,
  type,
  localDateTime: time,
  originalFileName: `${id}.jpg`,
  exifInfo: { dateTimeOriginal: time, fileSizeInByte: 1000 },
});

describe(DuplicateDecisionService.name, () => {
  let sut: DuplicateDecisionService;
  let repository: Record<string, any>;
  let access: Record<string, any>;
  let duplicates: { getDuplicates: any; resolve: any; delete: any };
  let assets: { updateAll: any };
  let albums: { removeAssets: any };
  let tags: { removeAssets: any };
  let stacks: { create: any; delete: any };
  let trash: { restoreAssets: any };

  const operationId = newUuidV7();
  const duplicateId = newUuid();
  const [keeper, copy, other] = [newUuid(), newUuid(), newUuid()];
  const members = [keeper, copy, other];

  const group = (overrides = {}) => ({
    duplicateId,
    decision: DuplicateDecisionKind.Keepers,
    memberIds: members,
    keepAssetIds: [keeper],
    ...overrides,
  });

  const recorded = (overrides: Partial<DuplicateDecision> = {}): DuplicateDecision =>
    ({
      id: newUuidV7(),
      ownerId,
      duplicateId,
      operationId,
      decision: DuplicateDecisionKind.Keepers,
      memberIds: members,
      keepAssetIds: [keeper],
      trashAssetIds: [copy, other],
      stackId: null,
      state: {},
      createdAt: new Date('2026-09-23T10:00:00.000Z'),
      appliedAt: null,
      undoOperationId: null,
      undoneAt: null,
      ...overrides,
    }) as DuplicateDecision;

  const groupMembers = (ids: string[], ownerOf: (id: string) => string = () => ownerId) =>
    ids.map((id) => ({ id, duplicateId, ownerId: ownerOf(id) }));

  const grantAll = () =>
    access.asset.checkOwnerAccess.mockImplementation((_userId: string, ids: Set<string>) => Promise.resolve(ids));

  beforeEach(() => {
    repository = {
      getGroupMembers: vi.fn().mockResolvedValue(groupMembers(members)),
      getAssetStates: vi.fn().mockResolvedValue([]),
      getKeeperStates: vi.fn().mockResolvedValue(new Map([[keeper, keeperState()]])),
      getLockedIds: vi.fn().mockResolvedValue(new Set()),
      getStackAssetIds: vi.fn().mockResolvedValue([]),
      relink: vi.fn().mockResolvedValue(undefined),
      unlink: vi.fn().mockResolvedValue(undefined),
      getOperation: vi.fn().mockResolvedValue(undefined),
      adopt: vi.fn().mockResolvedValue(undefined),
      close: vi.fn().mockResolvedValue(undefined),
      create: vi.fn().mockImplementation((values: Partial<DuplicateDecision>) => Promise.resolve(recorded(values))),
      getUnfinished: vi.fn().mockResolvedValue(undefined),
      getForOperation: vi.fn().mockResolvedValue(undefined),
      getById: vi.fn(),
      markApplied: vi.fn().mockResolvedValue(undefined),
      beginUndo: vi.fn().mockResolvedValue(true),
      markUndone: vi.fn().mockResolvedValue(undefined),
      listRecent: vi.fn().mockResolvedValue([]),
      listActiveOperations: vi.fn().mockResolvedValue([]),
    };
    access = { asset: { checkOwnerAccess: vi.fn().mockResolvedValue(new Set()) } };
    duplicates = {
      getDuplicates: vi.fn().mockResolvedValue([]),
      resolve: vi.fn().mockResolvedValue([{ id: duplicateId, success: true }]),
      delete: vi.fn().mockResolvedValue(undefined),
    };
    assets = { updateAll: vi.fn().mockResolvedValue(undefined) };
    albums = { removeAssets: vi.fn().mockResolvedValue([]) };
    tags = { removeAssets: vi.fn().mockResolvedValue([]) };
    stacks = { create: vi.fn().mockResolvedValue({ id: 'stack-1' }), delete: vi.fn().mockResolvedValue(undefined) };
    trash = { restoreAssets: vi.fn().mockResolvedValue({ count: 0 }) };

    sut = new DuplicateDecisionService(
      { setContext: vi.fn(), warn: vi.fn(), log: vi.fn() } as never,
      repository as never,
      access as never,
      duplicates as never,
      assets as never,
      albums as never,
      tags as never,
      stacks as never,
      trash as never,
    );
  });

  describe('getReview', () => {
    it('lists a group the session sees completely as decidable, with its suggestion and evidence', async () => {
      duplicates.getDuplicates.mockResolvedValue([
        { duplicateId, assets: members.map((id) => asset(id)), suggestedKeepAssetIds: [keeper] },
      ]);

      const [review] = await sut.getReview(owner);

      expect(review).toEqual(
        expect.objectContaining({
          duplicateId,
          kind: DuplicateGroupKind.Duplicates,
          editable: true,
          blockedReason: null,
          hiddenMemberCount: 0,
          suggestedKeepAssetIds: [keeper],
          totalBytes: 3000,
        }),
      );
      expect(review.qualities.map(({ assetId }) => assetId)).toEqual(members);
    });

    it('never decides a group on the part a session sees: photos it does not see block the group', async () => {
      duplicates.getDuplicates.mockResolvedValue([
        { duplicateId, assets: [asset(keeper), asset(copy)], suggestedKeepAssetIds: [keeper] },
      ]);

      const [review] = await sut.getReview(owner);

      expect(review).toEqual(
        expect.objectContaining({
          editable: false,
          blockedReason: DuplicateGroupBlock.HiddenMembers,
          hiddenMemberCount: 1,
        }),
      );
    });

    it('blocks a group holding another account’s photo, without counting or naming it', async () => {
      duplicates.getDuplicates.mockResolvedValue([
        { duplicateId, assets: [asset(keeper), asset(copy)], suggestedKeepAssetIds: [keeper] },
      ]);
      repository.getGroupMembers.mockResolvedValue(
        groupMembers([keeper, copy, other], (id) => (id === other ? 'someone-else' : ownerId)),
      );

      const [review] = await sut.getReview(owner);

      expect(review).toEqual(
        expect.objectContaining({
          editable: false,
          blockedReason: DuplicateGroupBlock.OtherOwner,
          hiddenMemberCount: 0,
        }),
      );
      expect(JSON.stringify(review)).not.toContain(other);
    });

    it('never suggests trashing frames of a burst', async () => {
      const frames = members.map((id, index) => asset(id, `2026-09-06T16:24:12.${index}00Z`));
      duplicates.getDuplicates.mockResolvedValue([{ duplicateId, assets: frames, suggestedKeepAssetIds: [keeper] }]);

      const [review] = await sut.getReview(owner);

      expect(review.kind).toBe(DuplicateGroupKind.Burst);
      expect(review.suggestedKeepAssetIds).toEqual([]);
    });
  });

  describe('getHistory', () => {
    it('groups recent decisions by job, newest first, and says which jobs can be undone', async () => {
      const older = newUuidV7();
      repository.listRecent.mockResolvedValue([
        recorded({ operationId: older, appliedAt: new Date(), createdAt: new Date('2026-09-22T10:00:00.000Z') }),
        recorded({ appliedAt: new Date() }),
        recorded({ duplicateId: newUuid(), appliedAt: null }),
      ]);

      const history = await sut.getHistory(elevated);

      expect(history.recent.map(({ operationId: id }) => id)).toEqual([operationId, older]);
      expect(history.recent[0].undoable).toBe(false);
      expect(history.recent[1].undoable).toBe(true);
    });

    it('offers undo again after an unfinished undo job, never for copies gone for good', async () => {
      const permanentJob = newUuidV7();
      repository.listRecent.mockResolvedValue([
        recorded({ appliedAt: new Date(), undoOperationId: newUuidV7() }),
        recorded({ operationId: permanentJob, appliedAt: new Date(), state: { permanent: true } }),
        recorded({ operationId: newUuidV7(), appliedAt: null, undoneAt: new Date() }),
      ]);

      const history = await sut.getHistory(elevated);

      const byJob = new Map(history.recent.map((batch) => [batch.operationId, batch]));
      expect(byJob.get(operationId)?.undoable).toBe(true);
      expect(byJob.get(operationId)?.groups[0].undoing).toBe(false);
      expect(byJob.get(permanentJob)?.undoable).toBe(false);
      // a decision its job closed without applying is not history
      expect(history.recent).toHaveLength(2);
    });

    it('never names a Locked photo to a session that has not unlocked', async () => {
      repository.listRecent.mockResolvedValue([recorded({ appliedAt: new Date() })]);
      repository.listActiveOperations.mockResolvedValue([
        {
          id: operationId,
          action: MediaOperationBulkAction.ResolveDuplicates,
          duplicateGroups: [group()],
        },
      ]);
      repository.getLockedIds.mockResolvedValue(new Set([copy]));

      const history = await sut.getHistory(owner);

      expect(history).toEqual({ recent: [], active: [] });
    });
  });

  describe('applyGroup', () => {
    it('records the keeper’s state before changing anything, then resolves and completes', async () => {
      grantAll();
      repository.getGroupMembers
        .mockResolvedValueOnce(groupMembers(members)) // the check
        .mockResolvedValueOnce(groupMembers(members)); // the apply
      repository.getAssetStates.mockResolvedValue([
        { id: keeper, ownerId, duplicateId: null, stackId: null, status: AssetStatus.Active, deletedAt: null },
        { id: copy, ownerId, duplicateId: null, stackId: null, status: AssetStatus.Trashed, deletedAt: new Date() },
        { id: other, ownerId, duplicateId: null, stackId: null, status: AssetStatus.Trashed, deletedAt: new Date() },
      ]);

      const outcomes = await sut.applyGroup(owner, operationId, group());

      expect(repository.create).toHaveBeenCalledWith(
        expect.objectContaining({
          ownerId,
          duplicateId,
          operationId,
          keepAssetIds: [keeper],
          trashAssetIds: [copy, other],
          state: { before: { [keeper]: keeperState() } },
        }),
      );
      expect(duplicates.resolve).toHaveBeenCalledWith(owner, {
        groups: [{ duplicateId, keepAssetIds: [keeper], trashAssetIds: [copy, other] }],
      });
      expect(repository.markApplied).toHaveBeenCalled();
      expect(outcomes).toEqual(members.map((id) => ({ id, status: MediaOperationItemStatus.Ok })));
    });

    it('skips a group whose photos changed after the owner reviewed it', async () => {
      grantAll();
      repository.getGroupMembers.mockResolvedValue(groupMembers([keeper, copy]));

      const outcomes = await sut.applyGroup(owner, operationId, group());

      expect(repository.create).not.toHaveBeenCalled();
      expect(duplicates.resolve).not.toHaveBeenCalled();
      expect(outcomes).toEqual(
        members.map((id) => ({
          id,
          status: MediaOperationItemStatus.Skipped,
          reasonKey: DuplicateDecisionReason.Changed,
        })),
      );
    });

    it('refuses a group holding another account’s photo exactly as one that does not exist', async () => {
      grantAll();
      repository.getGroupMembers.mockResolvedValueOnce(
        groupMembers(members, (id) => (id === other ? 'someone-else' : ownerId)),
      );
      const foreign = await sut.applyGroup(owner, operationId, group());
      repository.getGroupMembers.mockResolvedValueOnce([]);
      const missing = await sut.applyGroup(owner, operationId, group());

      expect(duplicates.resolve).not.toHaveBeenCalled();
      expect(foreign[0]).toEqual(expect.objectContaining({ reasonKey: DuplicateDecisionReason.NotFound }));
      expect(missing[0]).toEqual(foreign[0]);
    });

    it('answers a replayed batch from the record instead of deciding the group twice', async () => {
      repository.getForOperation.mockResolvedValue(recorded({ appliedAt: new Date() }));

      const outcomes = await sut.applyGroup(owner, operationId, group());

      expect(duplicates.resolve).not.toHaveBeenCalled();
      expect(outcomes.every(({ status }) => status === MediaOperationItemStatus.Ok)).toBe(true);
    });

    it('finishes a half-applied group with only the photos still in it, so no keeper is merged twice', async () => {
      repository.getForOperation.mockResolvedValue(recorded());
      repository.getGroupMembers.mockResolvedValue(groupMembers([copy, other]));
      repository.getAssetStates.mockResolvedValue([
        { id: keeper, ownerId, duplicateId: null, stackId: null, status: AssetStatus.Active, deletedAt: null },
        { id: copy, ownerId, duplicateId: null, stackId: null, status: AssetStatus.Trashed, deletedAt: new Date() },
        { id: other, ownerId, duplicateId: null, stackId: null, status: AssetStatus.Trashed, deletedAt: new Date() },
      ]);

      await sut.applyGroup(owner, operationId, group());

      expect(duplicates.resolve).toHaveBeenCalledWith(owner, {
        groups: [{ duplicateId, keepAssetIds: [], trashAssetIds: [copy, other] }],
      });
    });

    it('lets a retry finish the same half-applied decision, and hands the record to the retry', async () => {
      const failedJob = newUuidV7();
      repository.getUnfinished.mockResolvedValue(recorded({ operationId: failedJob }));
      repository.getOperation.mockResolvedValue({ id: operationId, status: 'rendering', retryOfId: failedJob });

      await sut.applyGroup(owner, operationId, group());

      expect(repository.adopt).toHaveBeenCalledWith(expect.any(String), operationId);
      expect(duplicates.resolve).toHaveBeenCalled();
    });

    it('leaves a different half-applied decision for the owner to review again', async () => {
      const failedJob = newUuidV7();
      repository.getUnfinished.mockResolvedValue(recorded({ operationId: failedJob, keepAssetIds: [copy] }));
      repository.getOperation.mockResolvedValue({ id: operationId, status: 'rendering', retryOfId: failedJob });

      const outcomes = await sut.applyGroup(owner, operationId, group());

      expect(duplicates.resolve).not.toHaveBeenCalled();
      expect(outcomes[0]).toEqual(expect.objectContaining({ reasonKey: DuplicateDecisionReason.Changed }));
    });

    it('never touches a group another running job is deciding', async () => {
      const otherJob = newUuidV7();
      repository.getUnfinished.mockResolvedValue(recorded({ operationId: otherJob }));
      repository.getOperation.mockImplementation((id: string) =>
        Promise.resolve({ id, status: id === otherJob ? 'rendering' : 'rendering', retryOfId: null }),
      );

      const outcomes = await sut.applyGroup(owner, operationId, group());

      expect(repository.close).not.toHaveBeenCalled();
      expect(duplicates.resolve).not.toHaveBeenCalled();
      expect(outcomes[0]).toEqual(expect.objectContaining({ reasonKey: DuplicateDecisionReason.Changed }));
    });

    it('closes a decision whose job ended with nobody retrying it, so the group can be decided again', async () => {
      grantAll();
      const deadJob = newUuidV7();
      repository.getUnfinished.mockResolvedValue(recorded({ operationId: deadJob, keepAssetIds: [copy] }));
      repository.getOperation.mockImplementation((id: string) =>
        Promise.resolve({ id, status: id === deadJob ? 'failed' : 'rendering', retryOfId: null }),
      );

      await sut.applyGroup(owner, operationId, group());

      expect(repository.close).toHaveBeenCalled();
      expect(repository.create).toHaveBeenCalledWith(expect.objectContaining({ operationId, keepAssetIds: [keeper] }));
    });

    it('never decides a photo that joined the group after the review', async () => {
      repository.getForOperation.mockResolvedValue(recorded({ decision: DuplicateDecisionKind.KeepAll }));
      repository.getGroupMembers.mockResolvedValue(groupMembers([...members, newUuid()]));

      const outcomes = await sut.applyGroup(owner, operationId, group({ decision: DuplicateDecisionKind.KeepAll }));

      expect(repository.unlink).not.toHaveBeenCalled();
      expect(outcomes[0]).toEqual(expect.objectContaining({ status: MediaOperationItemStatus.Failed }));
    });

    it('keeps every photo by taking exactly the reviewed photos out of the group', async () => {
      grantAll();

      await sut.applyGroup(owner, operationId, group({ decision: DuplicateDecisionKind.KeepAll, keepAssetIds: [] }));

      expect(repository.unlink).toHaveBeenCalledWith(ownerId, members, duplicateId);
      expect(duplicates.delete).not.toHaveBeenCalled();
      expect(duplicates.resolve).not.toHaveBeenCalled();
    });

    it('records a decision whose copies were deleted for good as one that cannot be undone', async () => {
      grantAll();
      repository.getAssetStates.mockResolvedValue([
        { id: keeper, ownerId, duplicateId: null, stackId: null, status: AssetStatus.Active, deletedAt: null },
        { id: copy, ownerId, duplicateId: null, stackId: null, status: AssetStatus.Deleted, deletedAt: new Date() },
        { id: other, ownerId, duplicateId: null, stackId: null, status: AssetStatus.Deleted, deletedAt: new Date() },
      ]);

      await sut.applyGroup(owner, operationId, group());

      expect(repository.markApplied).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ state: expect.objectContaining({ permanent: true }) }),
      );
    });

    it('stacks the whole group with the chosen cover on top', async () => {
      grantAll();
      repository.getAssetStates.mockResolvedValue(
        members.map((id) => ({ id, ownerId, duplicateId, stackId: null, status: AssetStatus.Active, deletedAt: null })),
      );

      await sut.applyGroup(owner, operationId, group({ decision: DuplicateDecisionKind.Stack, keepAssetIds: [copy] }));

      expect(stacks.create).toHaveBeenCalledWith(owner, { assetIds: [copy, keeper, other] });
      expect(repository.unlink).toHaveBeenCalledWith(ownerId, members, duplicateId);
      expect(repository.markApplied).toHaveBeenCalledWith(
        expect.any(String),
        expect.objectContaining({ stackId: 'stack-1' }),
      );
    });
  });

  describe('undoGroup', () => {
    const undoOperationId = newUuidV7();
    const applied = (overrides: Partial<DuplicateDecision> = {}) =>
      recorded({
        appliedAt: new Date(),
        state: {
          before: { [keeper]: keeperState({ description: 'mine' }) },
          after: { [keeper]: keeperState({ description: 'mine\ntheirs', albumIds: ['album-1'] }) },
        },
        ...overrides,
      });
    const undoGroupOf = (decision: DuplicateDecision) => ({ ...group(), decisionId: decision.id });
    const statesAfterKeepers = () => [
      { id: keeper, ownerId, duplicateId: null, stackId: null, status: AssetStatus.Active, deletedAt: null },
      { id: copy, ownerId, duplicateId: null, stackId: null, status: AssetStatus.Trashed, deletedAt: new Date() },
      { id: other, ownerId, duplicateId: null, stackId: null, status: AssetStatus.Trashed, deletedAt: new Date() },
    ];

    it('restores the trashed copies, takes back what the merge added and puts the group back', async () => {
      const decision = applied();
      grantAll();
      repository.getById.mockResolvedValue(decision);
      repository.getAssetStates.mockImplementation((ids: string[]) =>
        Promise.resolve(statesAfterKeepers().filter(({ id }) => ids.includes(id))),
      );
      repository.getKeeperStates.mockResolvedValue(
        new Map([[keeper, keeperState({ description: 'mine\ntheirs', albumIds: ['album-1'] })]]),
      );

      const outcomes = await sut.undoGroup(owner, undoOperationId, undoGroupOf(decision));

      expect(repository.beginUndo).toHaveBeenCalledWith(decision.id, undoOperationId, undefined);
      expect(trash.restoreAssets).toHaveBeenCalledWith(owner, { ids: [copy, other] });
      expect(assets.updateAll).toHaveBeenCalledWith(owner, { ids: [keeper], description: 'mine' });
      expect(albums.removeAssets).toHaveBeenCalledWith(owner, 'album-1', { ids: [keeper] });
      expect(repository.relink).toHaveBeenCalledWith(ownerId, members, duplicateId);
      expect(repository.markUndone).toHaveBeenCalledWith(decision.id);
      expect(outcomes.every(({ status }) => status === MediaOperationItemStatus.Ok)).toBe(true);
    });

    it('never overwrites a newer edit, and never changes the visibility of a Locked keeper', async () => {
      const decision = applied({
        state: {
          before: { [keeper]: keeperState({ description: 'mine', visibility: AssetVisibility.Timeline }) },
          after: { [keeper]: keeperState({ description: 'mine\ntheirs', visibility: AssetVisibility.Archive }) },
        },
      });
      grantAll();
      repository.getById.mockResolvedValue(decision);
      repository.getAssetStates.mockImplementation((ids: string[]) =>
        Promise.resolve(statesAfterKeepers().filter(({ id }) => ids.includes(id))),
      );
      repository.getKeeperStates.mockResolvedValue(
        new Map([[keeper, keeperState({ description: 'edited since', visibility: AssetVisibility.Archive })]]),
      );
      repository.getLockedIds.mockResolvedValue(new Set([keeper]));

      await sut.undoGroup(owner, undoOperationId, undoGroupOf(decision));

      expect(assets.updateAll).not.toHaveBeenCalled();
    });

    it('carries on an undo whose job ended unfinished, without reading its half-done work as a change', async () => {
      const stalledUndo = newUuidV7();
      const decision = applied({ undoOperationId: stalledUndo });
      repository.getById.mockResolvedValue(decision);
      repository.getOperation.mockResolvedValue({ id: stalledUndo, status: 'failed', retryOfId: null });
      // half undone: a copy is already back from the trash, which a fresh check would call a change
      repository.getAssetStates.mockImplementation((ids: string[]) =>
        Promise.resolve(
          statesAfterKeepers()
            .map((state) => (state.id === copy ? { ...state, status: AssetStatus.Active, deletedAt: null } : state))
            .filter(({ id }) => ids.includes(id)),
        ),
      );

      const outcomes = await sut.undoGroup(owner, undoOperationId, undoGroupOf(decision));

      expect(repository.beginUndo).toHaveBeenCalledWith(decision.id, undoOperationId, stalledUndo);
      expect(trash.restoreAssets).toHaveBeenCalledWith(owner, { ids: [other] });
      expect(outcomes.every(({ status }) => status === MediaOperationItemStatus.Ok)).toBe(true);
    });

    it('leaves a decision alone while another undo job is still working on it', async () => {
      const runningUndo = newUuidV7();
      repository.getById.mockResolvedValue(applied({ undoOperationId: runningUndo }));
      repository.getOperation.mockResolvedValue({ id: runningUndo, status: 'rendering', retryOfId: null });

      const outcomes = await sut.undoGroup(owner, undoOperationId, undoGroupOf(applied()));

      expect(repository.beginUndo).not.toHaveBeenCalled();
      expect(outcomes[0]).toEqual(expect.objectContaining({ reasonKey: DuplicateDecisionReason.Undone }));
    });

    it('cannot undo once a trashed copy has been deleted for good', async () => {
      const decision = applied();
      repository.getById.mockResolvedValue(decision);
      repository.getAssetStates.mockResolvedValue(statesAfterKeepers().filter(({ id }) => id !== other));

      const outcomes = await sut.undoGroup(owner, undoOperationId, undoGroupOf(decision));

      expect(repository.beginUndo).not.toHaveBeenCalled();
      expect(trash.restoreAssets).not.toHaveBeenCalled();
      expect(outcomes[0]).toEqual(expect.objectContaining({ reasonKey: DuplicateDecisionReason.Deleted }));
    });

    it('cannot undo a decision whose photos joined another group since', async () => {
      const decision = applied();
      repository.getById.mockResolvedValue(decision);
      repository.getAssetStates.mockResolvedValue(
        statesAfterKeepers().map((state) => (state.id === keeper ? { ...state, duplicateId: newUuid() } : state)),
      );

      const outcomes = await sut.undoGroup(owner, undoOperationId, undoGroupOf(decision));

      expect(outcomes[0]).toEqual(expect.objectContaining({ reasonKey: DuplicateDecisionReason.UndoChanged }));
    });

    it('answers a replayed undo as done, and another account’s decision as not found', async () => {
      const done = applied({ undoneAt: new Date(), undoOperationId });
      repository.getById.mockResolvedValueOnce(done).mockResolvedValueOnce(undefined);

      const replayed = await sut.undoGroup(owner, undoOperationId, undoGroupOf(done));
      const foreign = await sut.undoGroup(owner, undoOperationId, undoGroupOf(done));

      expect(replayed.every(({ status }) => status === MediaOperationItemStatus.Ok)).toBe(true);
      expect(foreign[0]).toEqual(expect.objectContaining({ reasonKey: DuplicateDecisionReason.NotFound }));
      expect(repository.relink).not.toHaveBeenCalled();
    });

    it('takes a stack it made apart only while it is still exactly the group', async () => {
      const decision = applied({
        decision: DuplicateDecisionKind.Stack,
        stackId: 'stack-1',
        trashAssetIds: [],
        state: {},
      });
      grantAll();
      repository.getById.mockResolvedValue(decision);
      repository.getAssetStates.mockResolvedValue(
        members.map((id) => ({
          id,
          ownerId,
          duplicateId: null,
          stackId: 'stack-1',
          status: AssetStatus.Active,
          deletedAt: null,
        })),
      );
      repository.getStackAssetIds.mockResolvedValue([...members, newUuid()]);

      const outcomes = await sut.undoGroup(owner, undoOperationId, undoGroupOf(decision));

      expect(stacks.delete).not.toHaveBeenCalled();
      expect(outcomes[0]).toEqual(expect.objectContaining({ reasonKey: DuplicateDecisionReason.UndoChanged }));
    });
  });
});
