import { BadRequestException, ForbiddenException, NotFoundException } from '@nestjs/common';
import {
  AccountEventAction,
  AssetType,
  AssetVisibility,
  MediaOperationBulkAction,
  MediaOperationItemStatus,
  MediaOperationStatus,
  Permission,
} from 'src/enum.js';
import { AssistantAction, AssistantActionItem } from 'src/repositories/assistant-action.repository.js';
import { AssistantActionService } from 'src/services/assistant-action.service.js';
import { emptyBulkResult } from 'src/utils/bulk-operation.js';
import { factory } from 'test/small.factory.js';

// every album and tag in these tests is the person's own to write to
vi.mock('src/utils/access.js', async (importOriginal) => ({
  ...(await importOriginal<typeof import('src/utils/access.js')>()),
  checkAccess: vi.fn((_access: unknown, { ids }: { ids: Iterable<string> }) => Promise.resolve(new Set(ids))),
}));

type LibraryItem = AssistantActionItem & { ownerId: string };

const DAY = 24 * 60 * 60 * 1000;
const at = (seconds: number) => new Date(Date.parse('2024-07-02T10:00:00.000Z') + seconds * 1000);

/** A small library held in memory, with the journal and the bulk queue it writes to. */
const setup = () => {
  const auth = factory.auth({ session: {} });
  const library = new Map<string, LibraryItem>();
  const locked = new Set<string>();
  const hidden = new Set<string>();
  const albumMembers = new Map<string, Set<string>>();
  const tagMembers = new Map<string, Set<string>>();
  const rows = new Map<string, AssistantAction>();
  const jobs = new Map<string, Record<string, unknown>>();
  let sequence = 0;

  const item = (overrides: Partial<LibraryItem> = {}) => {
    const value: LibraryItem = {
      id: factory.uuid(),
      ownerId: auth.user.id,
      type: AssetType.Image,
      isFavorite: false,
      visibility: AssetVisibility.Timeline,
      fileCreatedAt: at(sequence++ * 600),
      rating: null,
      burstId: null,
      score: 0.5,
      ...overrides,
    };
    library.set(value.id, value);
    return value;
  };

  const actions = {
    create: vi.fn((values: Partial<AssistantAction>) => {
      const row = {
        id: `action-${rows.size + 1}`,
        createdAt: new Date(),
        mediaOperationId: null,
        createdAlbumId: null,
        before: null,
        undo: null,
        appliedAt: null,
        undoneAt: null,
        ...values,
      } as AssistantAction;
      rows.set(row.id, row);
      return Promise.resolve({ ...row });
    }),
    get: vi.fn((id: string, userId: string) => {
      const row = rows.get(id);
      return Promise.resolve(row && row.userId === userId ? { ...row } : undefined);
    }),
    getAll: vi.fn((userId: string, { take }: { take: number }) =>
      Promise.resolve(
        rows
          .values()
          .filter((row) => row.userId === userId)
          .toArray()
          .toReversed()
          .slice(0, take),
      ),
    ),
    transition: vi.fn((id: string, userId: string, from: string, update: Partial<AssistantAction>) => {
      const row = rows.get(id);
      if (!row || row.userId !== userId || row.status !== from) {
        return Promise.resolve();
      }
      Object.assign(row, update);
      return Promise.resolve({ ...row });
    }),
    update: vi.fn((id: string, _userId: string, update: Partial<AssistantAction>) => {
      Object.assign(rows.get(id)!, update);
      return Promise.resolve();
    }),
    expire: vi.fn().mockResolvedValue(2),
    getItems: vi.fn((userId: string, ids: string[]) =>
      Promise.resolve(
        ids
          .map((id) => library.get(id))
          .filter((value): value is LibraryItem => !!value && value.ownerId === userId)
          .map(({ ownerId: _ownerId, ...value }) => ({ ...value })),
      ),
    ),
    getAlbumMembers: vi.fn((albumId: string, ids: string[]) =>
      Promise.resolve(new Set(ids.filter((id) => albumMembers.get(albumId)?.has(id)))),
    ),
    getAlbumAssetIds: vi.fn((albumId: string) => Promise.resolve([...(albumMembers.get(albumId) ?? [])])),
    getTagMembers: vi.fn((tagId: string, ids: string[]) =>
      Promise.resolve(new Set(ids.filter((id) => tagMembers.get(tagId)?.has(id)))),
    ),
    getTagAssetIds: vi.fn((tagId: string) => Promise.resolve([...(tagMembers.get(tagId) ?? [])])),
  };

  const assistant = { requireAvailable: vi.fn().mockResolvedValue({}) };
  const operations = {
    createBulk: vi.fn((_auth: unknown, dto: { action: MediaOperationBulkAction; assetIds: string[] }) => {
      const id = `job-${jobs.size + 1}`;
      jobs.set(id, {
        id,
        ownerId: auth.user.id,
        status: MediaOperationStatus.Completed,
        snapshot: { ...dto, payload: {} },
        result: emptyBulkResult(dto.assetIds.length),
        processedUnits: String(dto.assetIds.length),
      });
      return Promise.resolve({ id });
    }),
  };
  const operationRepository = {
    getForOwner: vi.fn((id: string, ownerId: string) => {
      const job = jobs.get(id);
      return Promise.resolve(job && job.ownerId === ownerId ? job : undefined);
    }),
  };
  const assetRepository = {
    getLockedAssetIds: vi.fn((ids: string[]) => Promise.resolve(new Set(ids.filter((id) => locked.has(id))))),
    getHiddenContentAssetIds: vi.fn((ids: string[]) => Promise.resolve(new Set(ids.filter((id) => hidden.has(id))))),
  };
  const tagRepository = { getByValue: vi.fn().mockResolvedValue(void 0) };
  const access = {};
  const accountEvents = { create: vi.fn().mockResolvedValue(void 0) };
  const assets = {
    updateAll: vi.fn((_auth: unknown, { ids, rating }: { ids: string[]; rating: number | null }) => {
      for (const id of ids) {
        library.get(id)!.rating = rating;
      }
      return Promise.resolve();
    }),
    deleteAll: vi.fn(),
  };
  const albumList = [
    { id: factory.uuid(), albumName: 'Lisbon trip', isSmart: false, isLocked: false },
    { id: factory.uuid(), albumName: 'Private', isSmart: false, isLocked: true },
    { id: factory.uuid(), albumName: 'Screenshots', isSmart: true, isLocked: false },
  ];
  const albums = {
    getAll: vi.fn().mockResolvedValue(albumList),
    get: vi.fn((_auth: unknown, id: string) => {
      const album = albumList.find((candidate) => candidate.id === id);
      return album ? Promise.resolve(album) : Promise.reject(new BadRequestException('Album not found'));
    }),
    create: vi.fn((_auth: unknown, { albumName }: { albumName: string }) => {
      const album = { id: factory.uuid(), albumName, isSmart: false, isLocked: false };
      albumList.push(album);
      return Promise.resolve(album);
    }),
    delete: vi.fn().mockResolvedValue(void 0),
  };
  const tagList = [{ id: factory.uuid(), name: 'Beach', value: 'Trips/Beach' }];
  const tags = {
    getAll: vi.fn().mockResolvedValue(tagList),
    upsert: vi.fn((_auth: unknown, { tags: names }: { tags: string[] }) =>
      Promise.resolve(names.map((name) => ({ id: factory.uuid(), name, value: name }))),
    ),
    remove: vi.fn().mockResolvedValue(void 0),
  };
  const logger = { setContext: vi.fn(), debug: vi.fn(), log: vi.fn(), warn: vi.fn(), error: vi.fn() };

  const sut = new AssistantActionService(
    logger as never,
    actions as never,
    assistant as never,
    operations as never,
    operationRepository as never,
    assetRepository as never,
    tagRepository as never,
    access as never,
    accountEvents as never,
    assets as never,
    albums as never,
    tags as never,
  );

  /** What the bulk worker would have done for the last queued job. */
  const runJob = () => {
    const [, dto] = operations.createBulk.mock.calls.at(-1)!;
    const payload = (dto as { payload?: { albumId?: string; tagIds?: string[] } }).payload ?? {};
    for (const id of dto.assetIds) {
      const value = library.get(id)!;
      switch (dto.action) {
        case MediaOperationBulkAction.Favorite: {
          value.isFavorite = true;
          break;
        }
        case MediaOperationBulkAction.Archive: {
          value.visibility = AssetVisibility.Archive;
          break;
        }
        case MediaOperationBulkAction.AddToAlbum: {
          albumMembers.set(payload.albumId!, (albumMembers.get(payload.albumId!) ?? new Set()).add(id));
          break;
        }
        case MediaOperationBulkAction.Tag: {
          for (const tagId of payload.tagIds ?? []) {
            tagMembers.set(tagId, (tagMembers.get(tagId) ?? new Set()).add(id));
          }
          break;
        }
        default: {
          break;
        }
      }
    }
  };

  return {
    sut,
    auth,
    item,
    library,
    locked,
    hidden,
    albumMembers,
    tagMembers,
    rows,
    jobs,
    actions,
    assistant,
    operations,
    assets,
    albums,
    albumList,
    tags,
    tagList,
    tagRepository,
    accountEvents,
    runJob,
  };
};

const skippedOf = (response: { skipped: { reason: string; count: number }[] }) =>
  Object.fromEntries(response.skipped.map(({ reason, count }) => [reason, count]));

describe(AssistantActionService.name, () => {
  describe('propose', () => {
    it('changes nothing and answers the count, a sample and what was left out', async () => {
      const { sut, auth, item, locked, hidden, operations, assets, albums, tags, rows } = setup();
      const plain = item();
      const loved = item({ isFavorite: true });
      const secret = item();
      const ruleHidden = item();
      const partners = item({ ownerId: factory.uuid() });
      locked.add(secret.id);
      hidden.add(ruleHidden.id);

      const response = await sut.propose(auth, {
        question: 'favourite the beach photos',
        tool: 'favourite',
        assetIds: [plain.id, loved.id, secret.id, ruleHidden.id, partners.id, plain.id],
      });

      expect(response).toMatchObject({
        kind: 'favourite',
        status: 'proposed',
        question: 'favourite the beach photos',
        total: 1,
        sampleAssetIds: [plain.id],
        canUndo: false,
        mediaOperationId: null,
      });
      expect(skippedOf(response)).toEqual({ not_found: 1, locked: 2, already_done: 1 });
      expect(rows.size).toBe(1);
      expect(plain.isFavorite).toBe(false);
      expect(operations.createBulk).not.toHaveBeenCalled();
      expect(assets.updateAll).not.toHaveBeenCalled();
      expect(albums.create).not.toHaveBeenCalled();
      expect(tags.upsert).not.toHaveBeenCalled();
    });

    it('is refused from a shared link and when the assistant is turned off', async () => {
      const { sut, auth, item, assistant, rows } = setup();
      assistant.requireAvailable.mockRejectedValue(new ForbiddenException('not available'));
      await expect(sut.propose(auth, { tool: 'favourite', assetIds: [item().id] })).rejects.toBeInstanceOf(
        ForbiddenException,
      );
      expect(rows.size).toBe(0);
    });

    it('holds an API key to the permissions of the change', async () => {
      const { sut, item } = setup();
      const auth = factory.auth({ apiKey: { permissions: [Permission.AssetRead, Permission.AssetUpdate] } });
      await expect(
        sut.propose(auth, { tool: 'create_album', arguments: { name: 'Trips' }, assetIds: [item().id] }),
      ).rejects.toBeInstanceOf(ForbiddenException);
    });

    it('refuses arguments that are not the tool’s', async () => {
      const { sut, auth, item } = setup();
      await expect(sut.propose(auth, { tool: 'create_album', assetIds: [item().id] })).rejects.toBeInstanceOf(
        BadRequestException,
      );
      await expect(
        sut.propose(auth, { tool: 'favourite', arguments: { album: 'Lisbon trip' }, assetIds: [item().id] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('resolves an album by name and leaves out items already in it', async () => {
      const { sut, auth, item, albumList, albumMembers } = setup();
      const [trip] = albumList;
      const inAlbum = item();
      const outside = item();
      albumMembers.set(trip.id, new Set([inAlbum.id]));

      const response = await sut.propose(auth, {
        tool: 'add_to_album',
        arguments: { album: 'lisbon TRIP' },
        assetIds: [inAlbum.id, outside.id],
      });

      expect(response).toMatchObject({ albumId: trip.id, albumName: 'Lisbon trip', total: 1 });
      expect(skippedOf(response)).toEqual({ already_done: 1 });
    });

    it('never adds to a Locked album, a smart album or an album it cannot find', async () => {
      const { sut, auth, item } = setup();
      for (const album of ['Private', 'Screenshots', 'No such album']) {
        await expect(
          sut.propose(auth, { tool: 'add_to_album', arguments: { album }, assetIds: [item().id] }),
        ).rejects.toBeInstanceOf(BadRequestException);
      }
    });

    it('resolves tags by name, plans a new tag and refuses one the session cannot see', async () => {
      const { sut, auth, item, tagList, tagMembers, tagRepository } = setup();
      const [beach] = tagList;
      const tagged = item();
      const untagged = item();
      tagMembers.set(beach.id, new Set([tagged.id]));

      const existing = await sut.propose(auth, {
        tool: 'tag',
        arguments: { tags: ['beach'] },
        assetIds: [tagged.id, untagged.id],
      });
      expect(existing).toMatchObject({ tags: ['Trips/Beach'], total: 1 });

      const fresh = await sut.propose(auth, {
        tool: 'tag',
        arguments: { tags: ['Sunsets'] },
        assetIds: [tagged.id, untagged.id],
      });
      expect(fresh).toMatchObject({ tags: ['Sunsets'], total: 2 });

      tagRepository.getByValue.mockResolvedValue({ id: factory.uuid(), value: 'Secret' });
      await expect(
        sut.propose(auth, { tool: 'tag', arguments: { tags: ['Secret'] }, assetIds: [tagged.id] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('refuses a tag marked Locked', async () => {
      const { sut, item, tagList } = setup();
      const auth = factory.auth({ session: {} });
      auth.suppressedContent = {
        userId: auth.user.id,
        includeNsfw: false,
        tagIds: [tagList[0].id],
        personIds: [],
        petIds: [],
        scope: 'owned',
      };
      await expect(
        sut.propose(auth, { tool: 'tag', arguments: { tags: ['Beach'] }, assetIds: [item().id] }),
      ).rejects.toBeInstanceOf(BadRequestException);
    });

    it('proposes a cull that keeps the best of each burst', async () => {
      const { sut, auth, item } = setup();
      const worst = item({ burstId: 'burst', score: 0.1 });
      const best = item({ burstId: 'burst', score: 0.9 });
      const middle = item({ burstId: 'burst', score: 0.4 });
      const alone = item();
      const video = item({ type: AssetType.Video, burstId: 'burst' });

      const response = await sut.propose(auth, {
        tool: 'cull',
        assetIds: [worst.id, best.id, middle.id, alone.id, video.id],
      });

      expect(response).toMatchObject({ kind: 'cull', total: 2, bursts: 1, keptAssetIds: [best.id] });
      expect(response.sampleAssetIds).toEqual([worst.id, middle.id]);
      expect(skippedOf(response)).toEqual({ kept: 1, not_in_burst: 2 });
    });
  });

  describe('apply', () => {
    it('queues the change on the bulk path and records what each item was', async () => {
      const { sut, auth, item, operations, rows, accountEvents } = setup();
      const first = item();
      const second = item();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [first.id, second.id] });
      // the person favourites one by hand between the proposal and the confirmation
      second.isFavorite = true;

      const response = await sut.apply(auth, proposal.id);

      expect(operations.createBulk).toHaveBeenCalledExactlyOnceWith(auth, {
        action: MediaOperationBulkAction.Favorite,
        assetIds: [first.id],
        payload: {},
        scope: { assistantActionId: proposal.id, undo: false },
      });
      expect(response).toMatchObject({ status: 'applied', total: 1, mediaOperationId: 'job-1', canUndo: true });
      expect(skippedOf(response)).toEqual({ already_done: 1 });
      expect(response.undoExpiresAt).not.toBeNull();
      expect(rows.get(proposal.id)!.before).toMatchObject({ assetIds: [first.id] });
      expect(accountEvents.create).toHaveBeenCalledWith(
        expect.objectContaining({ action: AccountEventAction.AssistantActionApplied, detail: 'favourite: 1' }),
      );
    });

    it('answers another person’s proposal like one that does not exist', async () => {
      const { sut, auth, item, operations } = setup();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [item().id] });
      const other = factory.auth({ session: {} });

      await expect(sut.apply(other, proposal.id)).rejects.toBeInstanceOf(NotFoundException);
      await expect(sut.undo(other, proposal.id)).rejects.toBeInstanceOf(NotFoundException);
      expect(operations.createBulk).not.toHaveBeenCalled();
    });

    it('applies a proposal once', async () => {
      const { sut, auth, item, operations } = setup();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [item().id] });
      await sut.apply(auth, proposal.id);

      await expect(sut.apply(auth, proposal.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(operations.createBulk).toHaveBeenCalledTimes(1);
    });

    it('refuses a proposal left unconfirmed for more than a day', async () => {
      const { sut, auth, item, rows, operations } = setup();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [item().id] });
      rows.get(proposal.id)!.createdAt = new Date(Date.now() - 2 * DAY);

      await expect(sut.apply(auth, proposal.id)).rejects.toThrow('expired');
      expect(rows.get(proposal.id)!.status).toBe('expired');
      expect(operations.createBulk).not.toHaveBeenCalled();
    });

    it('leaves out an item locked since the proposal, and refuses when nothing is left', async () => {
      const { sut, auth, item, locked, operations, rows } = setup();
      const only = item();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [only.id] });
      locked.add(only.id);

      await expect(sut.apply(auth, proposal.id)).rejects.toThrow('Nothing is left to change');
      expect(operations.createBulk).not.toHaveBeenCalled();
      expect(rows.get(proposal.id)!.status).toBe('proposed');
    });

    it('makes the album, then adds the items to it through a bulk job', async () => {
      const { sut, auth, item, albums, operations, rows } = setup();
      const first = item();
      const proposal = await sut.propose(auth, {
        tool: 'create_album',
        arguments: { name: 'Harbour' },
        assetIds: [first.id],
      });
      expect(proposal.albumId).toBeNull();

      const response = await sut.apply(auth, proposal.id);

      expect(albums.create).toHaveBeenCalledWith(auth, { albumName: 'Harbour', description: null });
      const albumId = rows.get(proposal.id)!.createdAlbumId;
      expect(albumId).toEqual(expect.any(String));
      expect(operations.createBulk).toHaveBeenCalledWith(
        auth,
        expect.objectContaining({
          action: MediaOperationBulkAction.AddToAlbum,
          assetIds: [first.id],
          payload: { albumId },
        }),
      );
      expect(response).toMatchObject({ albumId, albumName: 'Harbour', status: 'applied' });
    });

    it('takes the new album away again and stays proposed when the job cannot be queued', async () => {
      const { sut, auth, item, albums, operations, rows } = setup();
      const proposal = await sut.propose(auth, {
        tool: 'create_album',
        arguments: { name: 'Harbour' },
        assetIds: [item().id],
      });
      operations.createBulk.mockRejectedValueOnce(new Error('queue is down'));

      await expect(sut.apply(auth, proposal.id)).rejects.toThrow('queue is down');

      expect(albums.delete).toHaveBeenCalledTimes(1);
      expect(rows.get(proposal.id)).toMatchObject({
        status: 'proposed',
        appliedAt: null,
        before: null,
        createdAlbumId: null,
      });
    });

    it('makes a new tag at confirmation and records which items lacked each tag', async () => {
      const { sut, auth, item, tagList, tagMembers, tags, operations, rows } = setup();
      const [beach] = tagList;
      const tagged = item();
      const untagged = item();
      tagMembers.set(beach.id, new Set([tagged.id]));
      const proposal = await sut.propose(auth, {
        tool: 'tag',
        arguments: { tags: ['Beach', 'Sunsets'] },
        assetIds: [tagged.id, untagged.id],
      });
      expect(tags.upsert).not.toHaveBeenCalled();

      await sut.apply(auth, proposal.id);

      expect(tags.upsert).toHaveBeenCalledWith(auth, { tags: ['Sunsets'] });
      const before = rows.get(proposal.id)!.before as { tags: Record<string, string[]>; createdTagIds: string[] };
      const [sunsetsId] = before.createdTagIds;
      expect(before.tags).toEqual({ [beach.id]: [untagged.id], [sunsetsId]: [tagged.id, untagged.id] });
      expect(operations.createBulk).toHaveBeenCalledWith(
        auth,
        expect.objectContaining({
          action: MediaOperationBulkAction.Tag,
          assetIds: [tagged.id, untagged.id],
          payload: { tagIds: [beach.id, sunsetsId] },
        }),
      );
    });

    it('culls by archiving and rating Rejected, and never deletes', async () => {
      const { sut, auth, item, operations, assets, rows } = setup();
      const best = item({ burstId: 'burst', score: 0.9 });
      const other = item({ burstId: 'burst', score: 0.2, rating: null });
      const proposal = await sut.propose(auth, { tool: 'cull', assetIds: [best.id, other.id] });

      await sut.apply(auth, proposal.id);

      expect(operations.createBulk).toHaveBeenCalledExactlyOnceWith(
        auth,
        expect.objectContaining({ action: MediaOperationBulkAction.Archive, assetIds: [other.id] }),
      );
      expect(assets.updateAll).toHaveBeenCalledExactlyOnceWith(auth, { ids: [other.id], rating: -1 });
      expect(assets.deleteAll).not.toHaveBeenCalled();
      expect(rows.get(proposal.id)!.before).toMatchObject({ assetIds: [other.id], ratings: { [other.id]: null } });
      expect(best.rating).toBeNull();
    });
  });

  describe('undo', () => {
    it('restores only what is still as the change left it, and says what it skipped', async () => {
      const { sut, auth, item, operations, runJob, accountEvents } = setup();
      const first = item();
      const second = item();
      const third = item();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [first.id, second.id, third.id] });
      await sut.apply(auth, proposal.id);
      runJob();
      // afterwards the person removes one favourite by hand
      second.isFavorite = false;

      const response = await sut.undo(auth, proposal.id);

      expect(operations.createBulk).toHaveBeenLastCalledWith(auth, {
        action: MediaOperationBulkAction.Unfavorite,
        assetIds: [first.id, third.id],
        payload: {},
        scope: { assistantActionId: proposal.id, undo: true },
      });
      expect(response).toMatchObject({ status: 'undone', canUndo: false });
      expect(response.undo).toMatchObject({ restored: 2, albumRemoved: false, mediaOperationIds: ['job-2'] });
      expect(response.undo!.skipped).toEqual([{ reason: 'changed_since', count: 1, sampleAssetIds: [second.id] }]);
      expect(accountEvents.create).toHaveBeenLastCalledWith(
        expect.objectContaining({ action: AccountEventAction.AssistantActionUndone, detail: 'favourite: 2' }),
      );
    });

    it('undoes a change once', async () => {
      const { sut, auth, item, runJob, operations } = setup();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [item().id] });
      await sut.apply(auth, proposal.id);
      runJob();
      await sut.undo(auth, proposal.id);

      await expect(sut.undo(auth, proposal.id)).rejects.toBeInstanceOf(BadRequestException);
      expect(operations.createBulk).toHaveBeenCalledTimes(2);
    });

    it('cannot undo a proposal that was never confirmed', async () => {
      const { sut, auth, item } = setup();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [item().id] });
      await expect(sut.undo(auth, proposal.id)).rejects.toBeInstanceOf(BadRequestException);
    });

    it('waits for the change to finish being applied', async () => {
      const { sut, auth, item, jobs, rows } = setup();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [item().id] });
      await sut.apply(auth, proposal.id);
      jobs.get('job-1')!.status = MediaOperationStatus.Rendering;

      await expect(sut.undo(auth, proposal.id)).rejects.toThrow('still being applied');
      expect(rows.get(proposal.id)!.status).toBe('applied');
    });

    it('leaves alone what the change never reached', async () => {
      const { sut, auth, item, jobs, runJob, operations } = setup();
      const done = item();
      const refused = item();
      const unreached = item();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [done.id, refused.id, unreached.id] });
      await sut.apply(auth, proposal.id);
      runJob();
      // the job was cancelled after two items, and was refused for one of those
      Object.assign(jobs.get('job-1')!, {
        status: MediaOperationStatus.Cancelled,
        processedUnits: '2',
        result: {
          ...emptyBulkResult(3),
          succeeded: 1,
          skipped: 1,
          items: [{ id: refused.id, status: MediaOperationItemStatus.Skipped }],
        },
      });

      const response = await sut.undo(auth, proposal.id);

      expect(operations.createBulk).toHaveBeenLastCalledWith(
        auth,
        expect.objectContaining({ action: MediaOperationBulkAction.Unfavorite, assetIds: [done.id] }),
      );
      expect(response.undo).toMatchObject({ restored: 1 });
      expect(skippedOf(response.undo!)).toEqual({ not_applied: 2 });
    });

    it('stops being possible after 30 days', async () => {
      const { sut, auth, item, rows, runJob, operations } = setup();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [item().id] });
      await sut.apply(auth, proposal.id);
      runJob();
      rows.get(proposal.id)!.appliedAt = new Date(Date.now() - 31 * DAY);

      await expect(sut.undo(auth, proposal.id)).rejects.toThrow('30 days');
      expect(rows.get(proposal.id)!.status).toBe('expired');
      expect(operations.createBulk).toHaveBeenCalledTimes(1);
    });

    it('removes an album it made when nothing else changed in it', async () => {
      const { sut, auth, item, albums, runJob, operations, rows } = setup();
      const proposal = await sut.propose(auth, {
        tool: 'create_album',
        arguments: { name: 'Harbour' },
        assetIds: [item().id, item().id],
      });
      await sut.apply(auth, proposal.id);
      runJob();

      const response = await sut.undo(auth, proposal.id);

      expect(albums.delete).toHaveBeenCalledExactlyOnceWith(auth, rows.get(proposal.id)!.createdAlbumId);
      expect(operations.createBulk).toHaveBeenCalledTimes(1);
      expect(response.undo).toMatchObject({ restored: 2, albumRemoved: true, mediaOperationIds: [] });
    });

    it('keeps an album that gained other photos and removes only what it added', async () => {
      const { sut, auth, item, albums, albumMembers, runJob, operations, rows } = setup();
      const added = item();
      const proposal = await sut.propose(auth, {
        tool: 'create_album',
        arguments: { name: 'Harbour' },
        assetIds: [added.id],
      });
      await sut.apply(auth, proposal.id);
      runJob();
      const albumId = rows.get(proposal.id)!.createdAlbumId!;
      albumMembers.get(albumId)!.add(item().id);

      const response = await sut.undo(auth, proposal.id);

      expect(albums.delete).not.toHaveBeenCalled();
      expect(operations.createBulk).toHaveBeenLastCalledWith(
        auth,
        expect.objectContaining({
          action: MediaOperationBulkAction.RemoveFromAlbum,
          assetIds: [added.id],
          payload: { albumId },
        }),
      );
      expect(response.undo).toMatchObject({ restored: 1, albumRemoved: false });
    });

    it('reports an album that is gone instead of failing', async () => {
      const { sut, auth, item, albums, runJob, operations } = setup();
      const proposal = await sut.propose(auth, {
        tool: 'create_album',
        arguments: { name: 'Harbour' },
        assetIds: [item().id],
      });
      await sut.apply(auth, proposal.id);
      runJob();
      albums.get.mockRejectedValue(new BadRequestException('Album not found'));

      const response = await sut.undo(auth, proposal.id);

      expect(operations.createBulk).toHaveBeenCalledTimes(1);
      expect(response.undo).toMatchObject({ restored: 0 });
      expect(skippedOf(response.undo!)).toEqual({ album_gone: 1 });
    });

    it('takes a tag off the items that gained it and removes a tag it made', async () => {
      const { sut, auth, item, tagList, tagMembers, tags, runJob, operations, rows } = setup();
      const [beach] = tagList;
      const tagged = item();
      const untagged = item();
      tagMembers.set(beach.id, new Set([tagged.id]));
      const proposal = await sut.propose(auth, {
        tool: 'tag',
        arguments: { tags: ['Beach', 'Sunsets'] },
        assetIds: [tagged.id, untagged.id],
      });
      await sut.apply(auth, proposal.id);
      runJob();
      const [sunsetsId] = (rows.get(proposal.id)!.before as { createdTagIds: string[] }).createdTagIds;

      const response = await sut.undo(auth, proposal.id);

      // Beach was on one photo before, so it stays there; Sunsets was made for this and goes whole
      expect(operations.createBulk).toHaveBeenLastCalledWith(
        auth,
        expect.objectContaining({
          action: MediaOperationBulkAction.Untag,
          assetIds: [untagged.id],
          payload: { tagIds: [beach.id] },
        }),
      );
      expect(tags.remove).toHaveBeenCalledExactlyOnceWith(auth, sunsetsId);
      expect(response.undo).toMatchObject({ restored: 2, tagsRemoved: ['Sunsets'], skipped: [] });
    });

    it('un-archives a cull and clears Rejected back to the rating each frame had', async () => {
      const { sut, auth, item, runJob, operations, assets } = setup();
      const best = item({ burstId: 'burst', score: 0.9 });
      const unrated = item({ burstId: 'burst', score: 0.2 });
      const kept = item({ burstId: 'burst', score: 0.3 });
      const proposal = await sut.propose(auth, { tool: 'cull', assetIds: [best.id, unrated.id, kept.id] });
      await sut.apply(auth, proposal.id);
      runJob();
      expect(unrated).toMatchObject({ rating: -1, visibility: AssetVisibility.Archive });
      // the person rescues one frame by hand: back on the timeline, three stars
      Object.assign(kept, { rating: 3, visibility: AssetVisibility.Timeline });
      assets.updateAll.mockClear();

      const response = await sut.undo(auth, proposal.id);

      expect(operations.createBulk).toHaveBeenLastCalledWith(
        auth,
        expect.objectContaining({ action: MediaOperationBulkAction.Unarchive, assetIds: [unrated.id] }),
      );
      expect(assets.updateAll).toHaveBeenCalledExactlyOnceWith(auth, { ids: [unrated.id], rating: null });
      expect(assets.deleteAll).not.toHaveBeenCalled();
      expect(kept.rating).toBe(3);
      expect(response.undo).toMatchObject({ restored: 1 });
      expect(skippedOf(response.undo!)).toEqual({ changed_since: 1 });
    });

    it('does not restore an item that was locked after the change', async () => {
      const { sut, auth, item, locked, runJob, operations } = setup();
      const secret = item();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [secret.id] });
      await sut.apply(auth, proposal.id);
      runJob();
      locked.add(secret.id);

      const response = await sut.undo(auth, proposal.id);

      expect(operations.createBulk).toHaveBeenCalledTimes(1);
      expect(skippedOf(response.undo!)).toEqual({ locked: 1 });
    });
  });

  describe('history', () => {
    it('lists the person’s own actions, newest first, and says when there are more', async () => {
      const { sut, auth, item } = setup();
      const first = await sut.propose(auth, { tool: 'favourite', assetIds: [item().id] });
      const second = await sut.propose(auth, { tool: 'favourite', assetIds: [item().id] });

      await expect(sut.getAll(auth, { take: 1 })).resolves.toMatchObject({
        actions: [{ id: second.id }],
        hasMore: true,
      });
      await expect(sut.getAll(auth, {})).resolves.toMatchObject({
        actions: [{ id: second.id }, { id: first.id }],
        hasMore: false,
      });
      await expect(sut.getAll(factory.auth({ session: {} }), {})).resolves.toEqual({ actions: [], hasMore: false });
    });

    it('reads an applied change past its window as expired before the nightly pass', async () => {
      const { sut, auth, item, rows } = setup();
      const proposal = await sut.propose(auth, { tool: 'favourite', assetIds: [item().id] });
      await sut.apply(auth, proposal.id);
      rows.get(proposal.id)!.appliedAt = new Date(Date.now() - 31 * DAY);

      const { actions } = await sut.getAll(auth, {});
      expect(actions[0]).toMatchObject({ status: 'expired', canUndo: false });
    });

    it('expires old proposals and applied changes nightly', async () => {
      const { sut, actions } = setup();
      await sut.onNightlyDatabaseCleanup();

      const [{ proposedBefore, appliedBefore }] = actions.expire.mock.calls[0];
      expect(Date.now() - proposedBefore.getTime()).toBeGreaterThanOrEqual(DAY - 1000);
      expect(Date.now() - appliedBefore.getTime()).toBeGreaterThanOrEqual(30 * DAY - 1000);
    });
  });
});
