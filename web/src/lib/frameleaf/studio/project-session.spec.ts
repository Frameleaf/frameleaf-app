import {
  StudioProjectAccess,
  StudioProjectShelf,
  type StudioProjectDetailDto,
  type StudioProjectLeaseDto,
  type StudioProjectSaveResponseDto,
} from '@immich/sdk';
import { beforeEach, describe, expect, it, vi } from 'vitest';
import {
  createStudioProjectSession,
  STUDIO_DRAFT_PROJECT_ID,
  type StudioProjectApi,
  type StudioProjectSession,
  type StudioProjectSessionState,
} from './project-session';

/** An error shaped like the SDK's `HttpError`: a status and the parsed body. */
const httpError = (status: number, data: unknown) => {
  const error = new Error(`HTTP ${status}`) as Error & { status: number; data: unknown };
  error.status = status;
  error.data = data;
  return error;
};

const lease = (overrides: Partial<StudioProjectLeaseDto> = {}): StudioProjectLeaseDto => ({
  heldByYou: true,
  heldByAnother: false,
  expiresAt: '2026-09-22T12:01:30.000Z',
  leaseMs: 90_000,
  renewMs: 30_000,
  autosaveDebounceMs: 1500,
  ...overrides,
});

const detail = (overrides: Partial<StudioProjectDetailDto> = {}): StudioProjectDetailDto => ({
  id: 'p-1',
  ownerId: 'me',
  name: 'Lake trip',
  spaceId: null,
  revision: 3,
  access: StudioProjectAccess.Owner,
  lease: lease(),
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:05:00.000Z',
  envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'rev', graph: { tracks: ['t1'] } },
  digest: 'd3',
  withheld: false,
  resources: { complete: true, refusedCount: 0, checkedAt: '2026-09-22T10:05:00.000Z' },
  shelf: StudioProjectShelf.Active,
  archivedAt: null,
  deletedAt: null,
  purgeAfter: null,
  lastOpenedAt: null,
  thumbnailAssetId: null,
  duplicatedFromId: null,
  importedFromBundle: false,
  ...overrides,
});

const saved = (revision: number): StudioProjectSaveResponseDto => ({
  revision,
  revisionId: `r-${revision}`,
  digest: `d${revision}`,
  replayed: false,
  unchanged: false,
  lease: lease(),
});

type Timer = { callback: () => void; ms: number; cancelled: boolean };

/** Deterministic timers: the test decides when the debounce, the renewal and the retry fire. */
const makeTimers = () => {
  const timers: Timer[] = [];
  const setTimer = (callback: () => void, ms: number) => {
    const timer: Timer = { callback, ms, cancelled: false };
    timers.push(timer);
    return () => {
      timer.cancelled = true;
    };
  };
  const pending = () => timers.filter((timer) => !timer.cancelled);
  const fire = async (predicate: (timer: Timer) => boolean = () => true) => {
    const timer = pending().find((timer) => predicate(timer));
    if (!timer) {
      throw new Error('no pending timer');
    }
    timer.cancelled = true;
    timer.callback();
    await flushPromises();
  };
  return { timers, pending, fire, setTimer };
};

const flushPromises = () => new Promise<void>((resolve) => setTimeout(resolve, 0));

const makeApi = () => {
  const api = {
    get: vi.fn(),
    create: vi.fn(),
    save: vi.fn(),
    restore: vi.fn(),
    acquireLease: vi.fn(),
    releaseLease: vi.fn().mockResolvedValue(''),
    history: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    comments: vi.fn().mockResolvedValue({ items: [], total: 0 }),
    addComment: vi.fn(),
    updateComment: vi.fn(),
    rename: vi.fn(),
  };
  api.get.mockResolvedValue(detail());
  api.acquireLease.mockResolvedValue(lease());
  return api as typeof api & StudioProjectApi;
};

describe('studio project session', () => {
  let api: ReturnType<typeof makeApi>;
  let timers: ReturnType<typeof makeTimers>;
  let states: StudioProjectSessionState[];
  let online: boolean;
  let keys: string[];

  const create = (projectId: string | null = 'p-1'): StudioProjectSession => {
    let counter = 0;
    return createStudioProjectSession({
      api,
      clientId: 'tab-a',
      projectId,
      name: 'Untitled project',
      engineRevision: 'rev',
      onChange: (state) => void states.push(state),
      now: () => 1000,
      setTimer: timers.setTimer,
      isOnline: () => online,
      newKey: () => {
        const key = `key-${++counter}`;
        keys.push(key);
        return key;
      },
    });
  };

  const last = () => states.at(-1)!;

  beforeEach(() => {
    api = makeApi();
    timers = makeTimers();
    states = [];
    online = true;
    keys = [];
  });

  describe('open', () => {
    it('loads the project, takes the lease for the owner and schedules renewal', async () => {
      const session = create();
      await session.open();

      expect(api.get).toHaveBeenCalledWith('p-1', expect.anything());
      expect(api.acquireLease).toHaveBeenCalledWith('p-1', { clientId: 'tab-a' });
      expect(last()).toMatchObject({
        status: 'saved',
        access: 'owner',
        project: { id: 'p-1', name: 'Lake trip', revision: 3, graph: { tracks: ['t1'] }, hasLease: true },
      });
      expect(timers.pending().map((timer) => timer.ms)).toEqual([30_000]);
    });

    it('opens read-only for a reviewer and never asks for a lease', async () => {
      api.get.mockResolvedValue(
        detail({ access: StudioProjectAccess.Reviewer, withheld: true, envelope: null, digest: null }),
      );
      const session = create();
      await session.open();

      expect(api.acquireLease).not.toHaveBeenCalled();
      expect(last()).toMatchObject({
        status: 'review',
        access: 'reviewer',
        withheld: true,
        project: { hasLease: false, graph: null },
      });

      session.stage({ tracks: [] }, ['clip.add']);
      expect(last().hasDraft).toBe(false);
    });

    it('opens for review when another instance holds the lease, without taking it', async () => {
      api.acquireLease.mockRejectedValue(
        httpError(409, { reason: 'lease-held', lease: lease({ heldByYou: false, heldByAnother: true }) }),
      );
      const session = create();
      await session.open();

      expect(last()).toMatchObject({
        status: 'lease-lost',
        project: { id: 'p-1', hasLease: false, graph: { tracks: ['t1'] } },
        conflict: { reason: 'lease-held' },
      });
      expect(api.acquireLease).toHaveBeenCalledWith('p-1', { clientId: 'tab-a' });
    });

    it('opens an archived or trashed project read-only for its owner, without taking the lease', async () => {
      for (const shelf of [StudioProjectShelf.Archived, StudioProjectShelf.Trashed]) {
        api.get.mockResolvedValue(detail({ shelf }));
        api.acquireLease.mockClear();
        const session = create();
        await session.open();

        expect(api.acquireLease).not.toHaveBeenCalled();
        expect(last()).toMatchObject({ status: 'review', access: 'owner', project: { hasLease: false } });
        await session.dispose();
      }
    });

    it('reports a project this account cannot read as forbidden', async () => {
      api.get.mockRejectedValue(httpError(404, { message: 'Studio project not found' }));
      const session = create();
      await session.open();

      expect(last().status).toBe('forbidden');
    });

    it('drops a response from before a reload instead of applying it', async () => {
      let resolveFirst!: (value: StudioProjectDetailDto) => void;
      api.get.mockReturnValueOnce(new Promise<StudioProjectDetailDto>((resolve) => (resolveFirst = resolve)));
      api.get.mockResolvedValueOnce(detail({ revision: 7, name: 'Second' }));
      const session = create();

      const first = session.open();
      await session.reload();
      resolveFirst(detail({ revision: 1, name: 'Stale' }));
      await first;

      expect(last().project).toMatchObject({ revision: 7, name: 'Second' });
      expect(states.some((state) => state.project.name === 'Stale')).toBe(false);
    });
  });

  describe('autosave', () => {
    it('sends the complete document after the debounce with the head it was built on', async () => {
      api.save.mockResolvedValue(saved(4));
      const session = create();
      await session.open();

      session.stage({ tracks: ['t1', 't2'] }, ['clip.add', 'clip.add', 'clip.move']);
      expect(last().status).toBe('dirty');
      expect(api.save).not.toHaveBeenCalled();

      await timers.fire((timer) => timer.ms === 1500);

      expect(api.save).toHaveBeenCalledWith('p-1', {
        clientId: 'tab-a',
        requestKey: 'key-1',
        expectedRevision: 3,
        envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'rev', graph: { tracks: ['t1', 't2'] } },
        summary: { counts: { 'clip.add': 2, 'clip.move': 1 }, total: 3 },
      });
      expect(last()).toMatchObject({ status: 'saved', hasDraft: false, lastSavedAt: 1000, project: { revision: 4 } });
    });

    it('sends the canonical commands behind a draft so the server can check and count them (FL-92)', async () => {
      api.save.mockResolvedValue(saved(4));
      const session = create();
      await session.open();
      const envelope = (id: 'track.add' | 'title.add', key: string) => ({
        id,
        payload: id === 'track.add' ? { kind: 'video' } : { at: { num: 1, den: 1 }, text: 'Hi' },
        revision: 3,
        idempotencyKey: key,
        issuedAt: 5,
      });

      session.stage({ step: 1 }, ['track.add'], [envelope('track.add', 'k-1') as never]);
      session.stage({ step: 2 }, ['title.add'], [envelope('title.add', 'k-2') as never]);
      await timers.fire((timer) => timer.ms === 1500);

      expect(api.save).toHaveBeenCalledWith(
        'p-1',
        expect.objectContaining({
          envelope: expect.objectContaining({ graph: { step: 2 } }),
          summary: { counts: { 'track.add': 1, 'title.add': 1 }, total: 2 },
          commands: [
            expect.objectContaining({ id: 'track.add', idempotencyKey: 'k-1', revision: 3 }),
            expect.objectContaining({ id: 'title.add', idempotencyKey: 'k-2', revision: 3 }),
          ],
        }),
      );
    });

    it('treats a 400 as final: quarantines the commands once, and never retries the same request (FL-92)', async () => {
      api.save
        .mockRejectedValueOnce(httpError(400, { message: 'command 0: unknown field extra' }))
        .mockRejectedValueOnce(httpError(400, { message: 'The graph is not JSON-serializable' }))
        .mockResolvedValueOnce(saved(4));
      const session = create();
      await session.open();
      const envelope = { id: 'track.add', payload: { kind: 'video' }, revision: 3, idempotencyKey: 'k-1', issuedAt: 1 };
      session.stage({ step: 1 }, ['track.add'], [envelope as never]);
      await timers.fire((timer) => timer.ms === 1500);

      // The batch was refused: the document goes again once, on its own, with a fresh key.
      expect(api.save).toHaveBeenCalledTimes(1);
      expect(last()).toMatchObject({ status: 'dirty', error: expect.stringMatching(/./) });
      await timers.fire((timer) => timer.ms === 1500);
      expect(api.save).toHaveBeenCalledTimes(2);
      const second = api.save.mock.calls[1][1];
      expect(second.commands).toBeUndefined();
      expect(second.requestKey).not.toBe(api.save.mock.calls[0][1].requestKey);

      // Refused again without commands: final, surfaced, no retry timer.
      expect(last()).toMatchObject({ status: 'error', hasDraft: true });
      expect(timers.pending().some((timer) => timer.ms === 5000)).toBe(false);

      // The next edit is a new document and gets a new attempt, with no old commands piled on.
      session.stage({ step: 2 }, ['title.add']);
      await timers.fire((timer) => timer.ms === 1500);
      expect(api.save).toHaveBeenCalledTimes(3);
      expect(api.save.mock.calls[2][1].commands).toBeUndefined();
      expect(last()).toMatchObject({ status: 'saved', project: { revision: 4 } });
    });

    it('sends at most 500 commands with a save and counts the rest (FL-92)', async () => {
      api.save.mockResolvedValue(saved(4));
      const session = create();
      await session.open();
      const envelopes = Array.from({ length: 502 }, (_, index) => ({
        id: 'track.add',
        payload: { kind: 'video' },
        revision: 3,
        idempotencyKey: `k-${index}`,
        issuedAt: index,
      }));
      session.stage(
        { step: 1 },
        envelopes.map(() => 'track.add'),
        envelopes as never,
      );
      // At the limit it is sent now, not after the pause.
      await Promise.resolve();
      await Promise.resolve();
      expect(api.save).toHaveBeenCalledTimes(1);
      const dto = api.save.mock.calls[0][1];
      expect(dto.commands).toHaveLength(500);
      expect(dto.commands[0].idempotencyKey).toBe('k-2');
      expect(dto.summary.counts['commands.unchecked']).toBe(2);
    });

    it('retries a lost response with the same key, and takes a new key for a new document', async () => {
      api.save.mockRejectedValueOnce(new TypeError('Failed to fetch')).mockResolvedValue(saved(4));
      const session = create();
      await session.open();

      session.stage({ tracks: ['a'] }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);
      expect(last()).toMatchObject({ status: 'dirty', hasDraft: true, error: 'Failed to fetch' });

      await timers.fire((timer) => timer.ms === 5000);
      expect(api.save.mock.calls.map(([, dto]) => dto.requestKey)).toEqual(['key-1', 'key-1']);
      expect(last().status).toBe('saved');

      session.stage({ tracks: ['a', 'b'] }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);
      expect(api.save.mock.calls.at(-1)?.[1]).toMatchObject({ requestKey: 'key-2', expectedRevision: 4 });
    });

    it('keeps a draft staged while a save is in flight and sends it afterwards', async () => {
      let resolveSave!: (value: StudioProjectSaveResponseDto) => void;
      api.save.mockReturnValueOnce(new Promise<StudioProjectSaveResponseDto>((resolve) => (resolveSave = resolve)));
      api.save.mockResolvedValueOnce(saved(5));
      const session = create();
      await session.open();

      session.stage({ v: 1 }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);
      session.stage({ v: 2 }, ['clip.move']);
      resolveSave(saved(4));
      await flushPromises();

      expect(last()).toMatchObject({ status: 'dirty', hasDraft: true, project: { revision: 4 } });
      await timers.fire((timer) => timer.ms === 1500);
      expect(api.save.mock.calls.at(-1)?.[1]).toMatchObject({
        expectedRevision: 4,
        envelope: expect.objectContaining({ graph: { v: 2 } }),
        summary: { counts: { 'clip.move': 1 }, total: 1 },
      });
      expect(last()).toMatchObject({ status: 'saved', project: { revision: 5 } });
    });

    it('holds the draft while offline and sends it when the connection returns', async () => {
      api.save.mockResolvedValue(saved(4));
      const session = create();
      await session.open();
      online = false;

      session.stage({ tracks: ['a'] }, ['clip.add']);
      expect(last().status).toBe('offline');
      expect(timers.pending().some((timer) => timer.ms === 1500)).toBe(false);

      online = true;
      session.setOnline(true);
      expect(last().status).toBe('dirty');
      await timers.fire((timer) => timer.ms === 1500);
      expect(api.save).toHaveBeenCalledTimes(1);
      expect(last().status).toBe('saved');
    });
  });

  describe('conflicts', () => {
    it('keeps the draft on a stale head and resolves it only by the person’s choice', async () => {
      api.save.mockRejectedValueOnce(httpError(409, { reason: 'stale-revision', currentRevision: 5 }));
      const session = create();
      await session.open();

      session.stage({ mine: true }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);

      expect(last()).toMatchObject({
        status: 'conflict',
        hasDraft: true,
        conflict: { reason: 'stale-revision', currentRevision: 5 },
      });

      // More edits join the waiting draft; autosave does not keep knocking.
      session.stage({ mine: true, more: true }, ['clip.move']);
      expect(last().status).toBe('conflict');
      expect(timers.pending().some((timer) => timer.ms === 1500)).toBe(false);

      api.get.mockResolvedValue(
        detail({
          revision: 5,
          envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'rev', graph: { theirs: true } },
        }),
      );
      await session.reload();
      expect(last()).toMatchObject({
        status: 'saved',
        hasDraft: false,
        project: { revision: 5, graph: { theirs: true } },
      });
    });

    it('saves the draft as a new project and switches to it', async () => {
      api.save.mockRejectedValueOnce(httpError(409, { reason: 'stale-revision', currentRevision: 5 }));
      api.create.mockResolvedValue(detail({ id: 'p-2', name: 'Lake trip (copy)', revision: 1 }));
      const session = create();
      await session.open();
      session.stage({ mine: true }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);

      const id = await session.saveAsCopy('Lake trip (copy)');

      expect(id).toBe('p-2');
      expect(api.create).toHaveBeenCalledWith(
        expect.objectContaining({
          name: 'Lake trip (copy)',
          clientId: 'tab-a',
          envelope: expect.objectContaining({ graph: { mine: true } }),
        }),
      );
      expect(last()).toMatchObject({
        status: 'saved',
        hasDraft: false,
        conflict: null,
        project: { id: 'p-2', revision: 1, hasLease: true },
      });
    });

    it('keeps the draft when the lease is lost and resubmits it after an explicit reacquire', async () => {
      api.save
        .mockRejectedValueOnce(httpError(409, { reason: 'lease-lost', lease: lease({ heldByYou: false }) }))
        .mockResolvedValueOnce(saved(4));
      const session = create();
      await session.open();
      session.stage({ mine: true }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);

      expect(last()).toMatchObject({ status: 'lease-lost', hasDraft: true, project: { hasLease: false } });
      expect(timers.pending().some((timer) => timer.ms === 30_000)).toBe(false);

      const ok = await session.reacquire();
      expect(ok).toBe(true);
      expect(api.acquireLease).toHaveBeenLastCalledWith('p-1', { clientId: 'tab-a', takeover: false });
      expect(last()).toMatchObject({ status: 'dirty', project: { hasLease: true } });

      await timers.fire((timer) => timer.ms === 1500);
      expect(api.save).toHaveBeenCalledTimes(2);
      expect(last()).toMatchObject({ status: 'saved', project: { revision: 4 } });
    });

    it('keeps edits made after the lease was lost with the draft, and sends them on reacquire', async () => {
      api.save
        .mockRejectedValueOnce(httpError(409, { reason: 'lease-lost', lease: lease({ heldByYou: false }) }))
        .mockResolvedValueOnce(saved(4));
      const session = create();
      await session.open();
      session.stage({ step: 1 }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);
      expect(last()).toMatchObject({ status: 'lease-lost', hasDraft: true });

      session.stage({ step: 2 }, ['clip.move']);
      expect(last()).toMatchObject({ status: 'lease-lost', hasDraft: true, project: { graph: { step: 2 } } });
      expect(timers.pending().some((timer) => timer.ms === 1500)).toBe(false);

      await session.reacquire();
      await timers.fire((timer) => timer.ms === 1500);
      expect(api.save).toHaveBeenLastCalledWith(
        'p-1',
        expect.objectContaining({
          envelope: expect.objectContaining({ graph: { step: 2 } }),
          summary: { counts: { 'clip.add': 1, 'clip.move': 1 }, total: 2 },
        }),
      );
    });

    it('turns a reacquire into a conflict when the head moved under the draft', async () => {
      api.save.mockRejectedValueOnce(httpError(409, { reason: 'lease-lost', lease: lease({ heldByYou: false }) }));
      const session = create();
      await session.open();
      session.stage({ mine: true }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);

      api.get.mockResolvedValue(detail({ revision: 9 }));
      await session.takeOver();

      expect(api.acquireLease).toHaveBeenLastCalledWith('p-1', { clientId: 'tab-a', takeover: true });
      expect(last()).toMatchObject({
        status: 'conflict',
        hasDraft: true,
        conflict: { reason: 'stale-revision', currentRevision: 9 },
        // The draft and its base stay in view; only Reload shows the head.
        project: { revision: 3, graph: { mine: true }, hasLease: true },
      });
    });

    it('never overwrites a newer head through conflict, lease lost and take over', async () => {
      api.save.mockRejectedValueOnce(httpError(409, { reason: 'stale-revision', currentRevision: 4 }));
      const session = create();
      await session.open();
      session.stage({ mine: true }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);
      expect(last()).toMatchObject({ status: 'conflict', hasDraft: true });

      // The renewal is refused while the conflict is still open; the conflict stays until resolved.
      api.acquireLease.mockRejectedValueOnce(
        httpError(409, { reason: 'lease-held', lease: lease({ heldByYou: false, heldByAnother: true }) }),
      );
      await timers.fire((timer) => timer.ms === 30_000);
      expect(last()).toMatchObject({
        status: 'conflict',
        conflict: { reason: 'stale-revision' },
        project: { hasLease: false },
      });

      session.stage({ mine: 2 }, ['clip.move']);
      expect(last()).toMatchObject({ status: 'conflict', hasDraft: true, project: { graph: { mine: 2 } } });

      api.get.mockResolvedValue(detail({ revision: 4 }));
      expect(await session.takeOver()).toBe(true);
      expect(last()).toMatchObject({
        status: 'conflict',
        conflict: { reason: 'stale-revision', currentRevision: 4 },
        project: { revision: 3, graph: { mine: 2 }, hasLease: true },
      });
      expect(timers.pending().some((timer) => timer.ms === 1500)).toBe(false);
      expect(api.save).toHaveBeenCalledTimes(1);
      expect(api.save).toHaveBeenLastCalledWith('p-1', expect.objectContaining({ expectedRevision: 3 }));
    });

    it('never saves a discarded draft after Reload, a refused lease, an edit and a take over', async () => {
      api.save.mockRejectedValueOnce(httpError(409, { reason: 'stale-revision', currentRevision: 4 }));
      const session = create();
      await session.open();
      session.stage({ mine: true }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);
      expect(last()).toMatchObject({ status: 'conflict', hasDraft: true });

      // Reload reads B's revision 4, but B still holds the lease.
      api.get.mockResolvedValue(detail({ revision: 4, envelope: { ...detail().envelope!, graph: { theirs: true } } }));
      api.acquireLease.mockRejectedValueOnce(
        httpError(409, { reason: 'lease-held', lease: lease({ heldByYou: false, heldByAnother: true }) }),
      );
      await session.reload();
      expect(last()).toMatchObject({ status: 'lease-lost', hasDraft: false, project: { revision: 4 } });

      // An editor that still shows the discarded draft reports the revision it was loaded from.
      session.stage({ mine: 2 }, ['clip.move'], [], 3);
      expect(await session.takeOver()).toBe(true);
      expect(last()).toMatchObject({ status: 'conflict', conflict: { currentRevision: 4 }, hasDraft: true });
      expect(api.save).toHaveBeenCalledTimes(1);
    });

    it('carries an editor edit over its own save the editor has not heard of yet', async () => {
      api.save.mockResolvedValueOnce(saved(4)).mockResolvedValueOnce(saved(5));
      const session = create();
      await session.open();
      session.stage({ step: 1 }, ['editor.save'], [], 3);
      await timers.fire((timer) => timer.ms === 1500);
      expect(last()).toMatchObject({ status: 'saved', project: { revision: 4 } });

      // The next edit lands before the editor sees revision 4: it still reports base 3.
      session.stage({ step: 2 }, ['editor.save'], [], 3);
      await timers.fire((timer) => timer.ms === 1500);
      expect(api.save).toHaveBeenLastCalledWith('p-1', expect.objectContaining({ expectedRevision: 4 }));
      expect(last()).toMatchObject({ status: 'saved', project: { revision: 5 } });
    });

    it('never carries an editor edit over a save that was not the editor’s own graph', async () => {
      api.save.mockResolvedValueOnce(saved(4)).mockResolvedValueOnce(saved(5));
      const session = create();
      await session.open();
      // A canonical command stored by the host: the editor has not loaded it.
      session.stage({ command: true }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);
      session.stage({ editor: true }, ['editor.save'], [], 3);
      await timers.fire((timer) => timer.ms === 1500);
      expect(api.save).toHaveBeenLastCalledWith('p-1', expect.objectContaining({ expectedRevision: 3 }));
    });

    it('forgets the editor’s own saves once the project is read again', async () => {
      api.save.mockResolvedValueOnce(saved(4)).mockResolvedValueOnce(saved(6));
      const session = create();
      await session.open();
      session.stage({ step: 1 }, ['editor.save'], [], 3);
      await timers.fire((timer) => timer.ms === 1500);
      api.get.mockResolvedValue(detail({ revision: 5 }));
      await session.reload();
      session.stage({ stale: true }, ['editor.save'], [], 3);
      await timers.fire((timer) => timer.ms === 1500);
      expect(api.save).toHaveBeenLastCalledWith('p-1', expect.objectContaining({ expectedRevision: 3 }));
    });

    it('sends an edit from an editor still showing an older revision against that revision', async () => {
      api.save.mockResolvedValueOnce(saved(5));
      api.get.mockResolvedValue(detail({ revision: 4 }));
      const session = create();
      await session.open();

      session.stage({ stale: true }, ['clip.add'], [], 3);
      await timers.fire((timer) => timer.ms === 1500);
      expect(api.save).toHaveBeenLastCalledWith('p-1', expect.objectContaining({ expectedRevision: 3 }));
    });

    it('keeps the conflict when the lease lapses and is reacquired over a moved head', async () => {
      api.save.mockRejectedValueOnce(httpError(409, { reason: 'stale-revision', currentRevision: 4 }));
      const session = create();
      await session.open();
      session.stage({ mine: true }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);

      api.acquireLease.mockRejectedValueOnce(
        httpError(409, { reason: 'lease-lost', lease: lease({ heldByYou: false }) }),
      );
      await timers.fire((timer) => timer.ms === 30_000);
      expect(last()).toMatchObject({ status: 'conflict', project: { hasLease: false } });

      api.get.mockResolvedValue(detail({ revision: 4 }));
      expect(await session.reacquire()).toBe(true);
      expect(last()).toMatchObject({ status: 'conflict', conflict: { currentRevision: 4 }, hasDraft: true });
      expect(timers.pending().some((timer) => timer.ms === 1500)).toBe(false);
      expect(api.save).toHaveBeenCalledTimes(1);
    });

    it('sends a draft staged during a save against the revision that save stored', async () => {
      let resolveFirst: (value: ReturnType<typeof saved>) => void = () => {};
      api.save
        .mockImplementationOnce(() => new Promise((resolve) => (resolveFirst = resolve)))
        .mockResolvedValueOnce(saved(5));
      const session = create();
      await session.open();
      session.stage({ step: 1 }, ['clip.add']);
      const firing = timers.fire((timer) => timer.ms === 1500);
      await flushPromises();
      session.stage({ step: 2 }, ['clip.move']);
      resolveFirst(saved(4));
      await firing;
      await flushPromises();
      expect(last()).toMatchObject({ status: 'dirty', project: { revision: 4, graph: { step: 2 } } });

      await timers.fire((timer) => timer.ms === 1500);
      expect(api.save).toHaveBeenLastCalledWith(
        'p-1',
        expect.objectContaining({ expectedRevision: 4, envelope: expect.objectContaining({ graph: { step: 2 } }) }),
      );
    });

    it('renews the lease on the timer and drops to review when renewal is refused', async () => {
      const session = create();
      await session.open();

      await timers.fire((timer) => timer.ms === 30_000);
      expect(api.acquireLease).toHaveBeenCalledTimes(2);
      expect(timers.pending().map((timer) => timer.ms)).toEqual([30_000]);

      api.acquireLease.mockRejectedValueOnce(
        httpError(409, { reason: 'lease-held', lease: lease({ heldByYou: false, heldByAnother: true }) }),
      );
      await timers.fire((timer) => timer.ms === 30_000);
      expect(last()).toMatchObject({ status: 'lease-lost', project: { hasLease: false } });
    });

    it('turns read-only, keeping the draft, when the owner archives the project elsewhere', async () => {
      const session = create();
      await session.open();
      session.stage({ tracks: ['t1', 't2'] }, ['clip.add']);

      api.acquireLease.mockRejectedValueOnce(httpError(409, { reason: 'project-archived', currentRevision: 3 }));
      await timers.fire((timer) => timer.ms === 30_000);

      expect(last()).toMatchObject({
        status: 'review',
        project: { hasLease: false },
        conflict: { reason: 'project-archived' },
        hasDraft: true,
      });
      expect(timers.pending()).toEqual([]);
    });
  });

  describe('new draft', () => {
    it('creates the project on the first save and switches to its id', async () => {
      api.create.mockResolvedValue(detail({ id: 'p-new', name: 'Untitled project', revision: 1 }));
      const session = create(null);
      await session.open();

      expect(api.get).not.toHaveBeenCalled();
      expect(last().project).toMatchObject({ id: STUDIO_DRAFT_PROJECT_ID, revision: 0, hasLease: true });

      session.stage({ tracks: [] }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);

      expect(api.create).toHaveBeenCalledWith({
        name: 'Untitled project',
        clientId: 'tab-a',
        envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'rev', graph: { tracks: [] } },
        requestKey: 'key-1',
      });
      expect(last()).toMatchObject({ status: 'saved', project: { id: 'p-new', revision: 1, hasLease: true } });
      expect(timers.pending().map((timer) => timer.ms)).toEqual([30_000]);
    });
  });

  describe('restore', () => {
    it('flushes the draft, appends the restore against the current head and reloads the graph', async () => {
      api.save.mockResolvedValue(saved(4));
      api.restore.mockResolvedValue(saved(5));
      api.get.mockResolvedValueOnce(detail()).mockResolvedValueOnce(
        detail({
          revision: 5,
          envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'rev', graph: { old: true } },
        }),
      );
      const session = create();
      await session.open();
      session.stage({ mine: true }, ['clip.add']);

      const ok = await session.restore(1);

      expect(ok).toBe(true);
      expect(api.save).toHaveBeenCalledTimes(1);
      expect(api.restore).toHaveBeenCalledWith('p-1', {
        clientId: 'tab-a',
        requestKey: 'key-2',
        expectedRevision: 4,
        revision: 1,
      });
      expect(last()).toMatchObject({ status: 'saved', project: { revision: 5, graph: { old: true } } });
    });

    it('refuses to restore without the lease', async () => {
      api.get.mockResolvedValue(detail({ access: StudioProjectAccess.Reviewer }));
      const session = create();
      await session.open();

      expect(await session.restore(1)).toBe(false);
      expect(api.restore).not.toHaveBeenCalled();
    });
  });

  describe('dispose', () => {
    it('releases the lease, cancels timers and ignores late responses', async () => {
      let resolveSave!: (value: StudioProjectSaveResponseDto) => void;
      api.save.mockReturnValueOnce(new Promise<StudioProjectSaveResponseDto>((resolve) => (resolveSave = resolve)));
      const session = create();
      await session.open();
      session.stage({ mine: true }, ['clip.add']);
      await timers.fire((timer) => timer.ms === 1500);

      await session.dispose();
      const before = states.length;
      resolveSave(saved(4));
      await flushPromises();

      expect(api.releaseLease).toHaveBeenCalledWith('p-1', { clientId: 'tab-a' });
      expect(timers.pending()).toEqual([]);
      expect(states.length).toBe(before);
    });
  });
});

describe('rename (Studio.jsx renameProject)', () => {
  const make = (projectId: string | null) => {
    const api = makeApi();
    const timers = makeTimers();
    const session = createStudioProjectSession({
      api,
      clientId: 'tab-a',
      projectId,
      name: 'Untitled project',
      engineRevision: 'rev',
      onChange: () => {},
      now: () => 1000,
      setTimer: timers.setTimer,
      isOnline: () => true,
      newKey: () => 'key',
    });
    return { api, session };
  };

  it('renames a saved project on the server and keeps the stored name when refused', async () => {
    const { api, session } = make('p-1');
    await session.open();
    api.rename.mockResolvedValue({ name: 'Lake trip' });
    await expect(session.rename('  Lake trip  ')).resolves.toBe(true);
    expect(api.rename).toHaveBeenCalledWith('p-1', 'Lake trip');
    expect(session.state.project.name).toBe('Lake trip');

    api.rename.mockRejectedValue(new Error('403'));
    await expect(session.rename('Other')).resolves.toBe(false);
    expect(session.state.project.name).toBe('Lake trip');
    await expect(session.rename(' '.repeat(3))).resolves.toBe(false);
  });

  it('names a draft for its first save without asking the server', async () => {
    const { api, session } = make(null);
    await session.open();
    await expect(session.rename('Lake trip')).resolves.toBe(true);
    expect(api.rename).not.toHaveBeenCalled();
    expect(session.state.project.name).toBe('Lake trip');
  });
});
