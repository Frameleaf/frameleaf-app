import { describe, expect, it, vi } from 'vitest';
import { createStudioProjectSession, type StudioProjectApi } from './project-session';

vi.mock('@frameleaf/sdk', () => ({ StudioProjectShelf: { Active: 'active' } }));

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  let reject!: (error: unknown) => void;
  const promise = new Promise<T>((yes, no) => {
    resolve = yes;
    reject = no;
  });
  return { promise, resolve, reject };
};
const lease = {
  heldByYou: true,
  heldByAnother: false,
  leaseMs: 90_000,
  renewMs: 30_000,
  autosaveDebounceMs: 1500,
  expiresAt: '2100-01-01T00:00:00Z',
};
const graphA = { timeline: { items: [{ id: 'clip', mediaId: 'a' }] }, unsent: 'preserve me' };
const graphB = { ...graphA, timeline: { items: [{ id: 'clip', mediaId: 'b' }] } };
const detail = (graph = graphA, revision = 3) => ({
  id: 'project',
  name: 'Project',
  ownerId: 'owner',
  access: 'owner',
  revision,
  envelope: { schemaVersion: 1, engine: 'freecut', engineRevision: 'rev', graph },
  lease,
  resources: { hiddenSources: [] },
  shelf: 'active',
});
const fixture = async () => {
  const pending: Array<() => void> = [];
  const api = {
    get: vi.fn().mockResolvedValue(detail()),
    acquireLease: vi.fn().mockResolvedValue(lease),
    save: vi.fn(),
    releaseLease: vi.fn().mockResolvedValue(undefined),
  };
  const session = createStudioProjectSession({
    projectId: 'project',
    name: 'Project',
    engineRevision: 'rev',
    clientId: 'client',
    isOnline: () => true,
    api: api as unknown as StudioProjectApi,
    onChange: () => undefined,
    newKey: () => 'commit-key',
    setTimer: (fn) => {
      pending.push(fn);
      return () => {
        const index = pending.indexOf(fn);
        if (index !== -1) {
          pending.splice(index, 1);
        }
      };
    },
  });
  await session.open();
  return { api, session, pending };
};

describe('waitable editor relink commit', () => {
  it('publishes only after the real leased save accepts the complete graph', async () => {
    const { session, api } = await fixture();
    const save = deferred<{ revision: number; lease: typeof lease }>();
    api.save.mockReturnValue(save.promise);
    const commit = session.commitEditorDraft(graphB, 3, session.state.project.graphVersion!);
    expect(session.state.project.graph).toEqual(graphA);
    expect(api.save).toHaveBeenCalledWith(
      'project',
      expect.objectContaining({
        expectedRevision: 3,
        clientId: 'client',
        requestKey: 'commit-key',
        envelope: expect.objectContaining({ graph: graphB }),
      }),
    );
    save.resolve({ revision: 4, lease });
    await expect(commit).resolves.toEqual({ status: 'saved', revision: 4 });
    expect(session.state.project.graph).toEqual(graphB);
    await session.dispose();
  });

  it('keeps A and never schedules B again after a refused save', async () => {
    const { session, api, pending } = await fixture();
    api.save.mockRejectedValue(Object.assign(new Error('refused'), { status: 400 }));
    await expect(session.commitEditorDraft(graphB, 3, session.state.project.graphVersion!)).resolves.toMatchObject({
      status: 'rejected',
    });
    expect(session.state.project.graph).toEqual(graphA);
    for (const timer of pending) {
      timer();
    }
    await Promise.resolve();
    expect(api.save).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('reconciles a lost save response through the existing read path without resubmitting B', async () => {
    const { session, api } = await fixture();
    api.save.mockRejectedValue(new Error('response lost'));
    api.get.mockResolvedValue(detail(graphB, 4));
    await expect(session.commitEditorDraft(graphB, 3, session.state.project.graphVersion!)).resolves.toEqual({
      status: 'saved',
      revision: 4,
    });
    expect(api.save).toHaveBeenCalledTimes(1);
    expect(api.get).toHaveBeenCalledTimes(2);
    await session.dispose();
  });

  it('accepts a reconciled JSON graph regardless of stored object key order', async () => {
    const { session, api } = await fixture();
    api.save.mockRejectedValue(new Error('response lost'));
    api.get.mockResolvedValue(detail({ unsent: graphB.unsent, timeline: graphB.timeline }, 4));
    await expect(session.commitEditorDraft(graphB, 3, session.state.project.graphVersion!)).resolves.toEqual({
      status: 'saved',
      revision: 4,
    });
    expect(api.save).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('guards editing when both the save response and origin reconciliation fail', async () => {
    const { session, api } = await fixture();
    api.save.mockRejectedValue(new Error('response lost'));
    api.get.mockRejectedValue(new Error('read unavailable'));
    await expect(session.commitEditorDraft(graphB, 3, session.state.project.graphVersion!)).resolves.toMatchObject({
      status: 'rejected',
    });
    expect(session.state.project.graph).toEqual(graphA);
    expect(session.state.status).toBe('conflict');
    expect(session.state.error).toContain('uncertain');
    expect(api.save).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('rejects stale graph versions and late saves from a disposed origin', async () => {
    const { session, api } = await fixture();
    const version = session.state.project.graphVersion!;
    session.stage(graphA);
    await expect(session.commitEditorDraft(graphB, 3, version)).resolves.toMatchObject({ status: 'rejected' });
    expect(api.save).not.toHaveBeenCalled();
    const save = deferred<{ revision: number; lease: typeof lease }>();
    api.save.mockReturnValue(save.promise);
    const commit = session.commitEditorDraft(graphB, 3, session.state.project.graphVersion!);
    await session.dispose();
    save.resolve({ revision: 4, lease });
    await expect(commit).resolves.toMatchObject({ status: 'rejected' });
    expect(session.state.project.graph).toEqual(graphA);
  });
  it('commits all pending editor edits and reopens the accepted replacement graph', async () => {
    const { session, api, pending } = await fixture();
    const leaseTimers = pending.length;
    const editedA = { ...graphA, localEdit: { text: 'unsubmitted title', keyframes: [1, 2] } };
    session.stageEditor(editedA, ['clip.move'], 3, session.state.project.graphVersion!);
    const completeB = { ...editedA, timeline: graphB.timeline };
    api.save.mockResolvedValue({ revision: 4, lease });
    await expect(session.commitEditorDraft(completeB, 3, session.state.project.graphVersion!)).resolves.toEqual({
      status: 'saved',
      revision: 4,
    });
    expect(api.save.mock.calls[0]![1].envelope.graph).toEqual(completeB);
    expect(pending).toHaveLength(leaseTimers);
    api.get.mockResolvedValue(detail(completeB, 4));
    await session.open();
    expect(session.state.project.graph).toEqual(completeB);
    expect(api.save).toHaveBeenCalledTimes(1);
    await session.dispose();
  });

  it('fences an A-B-A captured scope even when the original project is current again', async () => {
    const { session, api } = await fixture();
    const save = deferred<{ revision: number; lease: typeof lease }>();
    let epoch = 0;
    api.save.mockReturnValue(save.promise);
    const captured = epoch;
    const commit = session.commitEditorDraft(graphB, 3, session.state.project.graphVersion!, () => epoch === captured);
    epoch += 2;
    save.resolve({ revision: 4, lease });
    await expect(commit).resolves.toMatchObject({ status: 'rejected' });
    expect(session.state.project.graph).toEqual(graphA);
    expect(api.save).toHaveBeenCalledTimes(1);
    await session.dispose();
  });
});
