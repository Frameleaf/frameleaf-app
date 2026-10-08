import { beforeEach, describe, expect, it, vi } from 'vitest';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { websocketEvents, websocketStore } from '$lib/stores/websocket';
import { generatedMediaAlias, hydrateGeneratedMedia, storeGeneratedMedia } from './generated-media';
import { createStudioGeneratedAccess } from './generated-media-client';

const operationId = '0195e2a0-0000-7000-8000-000000000012';
const projectId = '0195e2a0-0000-7000-8000-000000000010';
const generatedId = `reverse-${operationId}`;
const graph = {
  timeline: {
    items: [
      {
        id: 'clip',
        type: 'video',
        generatedId,
        sourceStart: 60,
        sourceEnd: 90,
        from: 10,
        durationInFrames: 30,
        transform: { opacity: 0.5 },
      },
    ],
  },
};
const result = {
  operationId,
  projectId,
  generatedId,
  frames: 300,
  frameRate: { num: 30, den: 1 },
  width: 32,
  height: 32,
  browserPreview: {
    generatedId: `reverse-preview-${operationId}`,
    checksum: 'ab'.repeat(32),
    contentType: 'video/mp4',
    delivery: 'authenticated',
    profile: 'h264-main-3.2-aac-lc-v1',
  },
};

describe('generated media admission', () => {
  beforeEach(() => websocketStore.connected.set(true));
  it('keeps browser aliases reversible, checks project binding and revokes all retained admissions', async () => {
    const revoked = vi.fn();
    const request = vi.fn(async (_: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return Response.json(result);
    });
    const access = createStudioGeneratedAccess(revoked, request as typeof fetch);
    const media = await access.admit(projectId, graph, 1);
    expect(request.mock.calls[0][1]).toMatchObject({ credentials: 'same-origin', cache: 'no-store' });
    const hydrated = hydrateGeneratedMedia(graph, media) as typeof graph;
    expect(hydrated.timeline.items[0]).toMatchObject({
      generatedId,
      mediaId: generatedMediaAlias(generatedId),
      src: expect.stringContaining(`/media-operations/${operationId}/reverse-preview`),
    });
    expect(storeGeneratedMedia(hydrated)).toEqual(graph);
    expect(() => hydrateGeneratedMedia(graph, [])).toThrow('not authorized');
    expect(() => storeGeneratedMedia({ ...graph.timeline.items[0], mediaId: 'library-id' })).toThrow('library asset');
    // Removed clips can still have media in the bin; that cached admission must remain revocable.
    await access.admit(projectId, {}, 2);
    eventManager.emit('AssetsDelete', ['source']);
    expect(revoked).toHaveBeenCalledTimes(1);
    expect(await access.recheck()).toBe(false);
    await expect(access.admit(projectId, graph, 3)).rejects.toThrow('revoked');
    access.dispose();

    const denied = createStudioGeneratedAccess(
      vi.fn(),
      vi.fn(async () => Response.json({ ...result, projectId: 'other' })) as typeof fetch,
    );
    await expect(denied.admit(projectId, graph)).rejects.toThrow('binding');
    denied.dispose();
  });

  it('C2 RED: targets pending old admission without revoking a new operation', async () => {
    const oldId = '0195e2a0-0000-7000-8000-000000000099';
    const listen = vi.spyOn(websocketEvents, 'on');
    listen.mockClear();
    const notify = (id: string) => {
      const receiver = listen.mock.calls.find(([event]) => event === 'AssetLocalEffectsV1')![1] as (data: {
        streamEpoch: string;
        sequence: string;
        effectId: string;
        assetIds: string[];
        revokedOperationIds: string[];
      }) => void;
      receiver({
        streamEpoch: 'actual-local-stream',
        sequence: '1',
        effectId: 'effect-1',
        assetIds: [],
        revokedOperationIds: [id],
      });
    };
    const revoked = vi.fn();
    const response = deferredResponse();
    const access = createStudioGeneratedAccess(revoked, vi.fn(() => response.promise) as typeof fetch);
    const pending = access.admit(projectId, graph, 1);
    await Promise.resolve();
    notify(oldId);
    expect(revoked).not.toHaveBeenCalled();
    notify(operationId);
    expect(revoked).toHaveBeenCalledTimes(1);
    response.resolve(Response.json(result));
    await expect(pending).rejects.toThrow('revoked');
    access.dispose();

    listen.mockClear();
    const freshRevoked = vi.fn();
    const fresh = createStudioGeneratedAccess(freshRevoked, vi.fn(async () => Response.json(result)) as typeof fetch);
    await fresh.admit(projectId, graph, 1);
    notify(oldId);
    expect(freshRevoked).not.toHaveBeenCalled();
    expect(await fresh.recheck()).toBe(true);
    fresh.dispose();
    listen.mockRestore();
  });

  it('does not publish an admission whose request completes after revocation', async () => {
    let resolve!: (response: Response) => void;
    const request = vi.fn((_: RequestInfo | URL, init?: RequestInit) => {
      void init;
      return new Promise<Response>((done) => {
        resolve = done;
      });
    });
    const access = createStudioGeneratedAccess(vi.fn(), request as typeof fetch);
    const pending = access.admit(projectId, graph);
    const failure = expect(pending).rejects.toThrow();
    await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
    eventManager.emit('AssetsDelete', ['source']);
    expect(request.mock.calls[0][1]?.signal?.aborted).toBe(true);
    resolve(Response.json(result));
    await failure;
    access.dispose();
  });
});

it('refuses generated admission when the revocation channel is unavailable', async () => {
  websocketStore.connected.set(false);
  const request = vi.fn();
  const access = createStudioGeneratedAccess(vi.fn(), request);
  await expect(access.admit(projectId, graph)).rejects.toThrow('revoked');
  expect(request).not.toHaveBeenCalled();
  access.dispose();
});

const deferredResponse = () => {
  let resolve!: (response: Response) => void;
  const promise = new Promise<Response>((done) => {
    resolve = done;
  });
  return { promise, resolve };
};
const otherOperationId = '0195e2a0-0000-7000-8000-000000000013';
const otherResult = {
  ...result,
  operationId: otherOperationId,
  generatedId: `reverse-${otherOperationId}`,
  browserPreview: { ...result.browserPreview, generatedId: `reverse-preview-${otherOperationId}` },
};
const additionalGraph = { timeline: { items: [...graph.timeline.items, { generatedId: otherResult.generatedId }] } };
const resultFor = (input: RequestInfo | URL) =>
  Response.json(String(input).includes(otherOperationId) ? otherResult : result);

describe('overlapping generated admission and focus checks', () => {
  beforeEach(() => websocketStore.connected.set(true));

  it('waits for initial admission before judging a concurrent focus check', async () => {
    const initial = deferredResponse();
    const request = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockImplementationOnce(() => initial.promise)
      .mockImplementation(async (input) => resultFor(input));
    const revoked = vi.fn();
    const access = createStudioGeneratedAccess(revoked, request);
    const recheck = vi.spyOn(access, 'recheck');
    try {
      const admission = access.admit(projectId, graph, 1);
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      dispatchEvent(new Event('focus'));
      expect(request).toHaveBeenCalledOnce();
      initial.resolve(Response.json(result));
      await expect(admission).resolves.toHaveLength(1);
      await expect(recheck.mock.results[0].value).resolves.toBe(true);
      expect(revoked).not.toHaveBeenCalled();
    } finally {
      access.dispose();
    }
  });

  it('waits for additional IDs to be admitted before judging a concurrent focus check', async () => {
    const first = deferredResponse();
    const second = deferredResponse();
    const request = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json(result))
      .mockImplementationOnce(() => first.promise)
      .mockImplementationOnce(() => second.promise)
      .mockImplementation(async (input) => resultFor(input));
    const revoked = vi.fn();
    const access = createStudioGeneratedAccess(revoked, request);
    const recheck = vi.spyOn(access, 'recheck');
    try {
      await access.admit(projectId, graph, 1);
      const admission = access.admit(projectId, additionalGraph, 2);
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(3));
      dispatchEvent(new Event('focus'));
      expect(request).toHaveBeenCalledTimes(3);
      first.resolve(Response.json(result));
      second.resolve(Response.json(otherResult));
      await expect(admission).resolves.toHaveLength(2);
      await expect(recheck.mock.results[0].value).resolves.toBe(true);
      expect(revoked).not.toHaveBeenCalled();
    } finally {
      access.dispose();
    }
  });

  it.each([200, 403])('freshly checks restored access after an older recheck returns HTTP %s', async (status) => {
    const old = deferredResponse();
    const request = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json(result))
      .mockImplementationOnce(() => old.promise)
      .mockImplementation(async (input) => resultFor(input));
    const revoked = vi.fn();
    const access = createStudioGeneratedAccess(revoked, request);
    try {
      await access.admit(projectId, graph, 1);
      const check = access.recheck();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      await expect(access.admit(projectId, additionalGraph, 2)).resolves.toHaveLength(2);
      old.resolve(Response.json(result, { status }));
      await expect(check).resolves.toBe(true);
      expect(request).toHaveBeenCalledTimes(6);
      expect(revoked).not.toHaveBeenCalled();
    } finally {
      access.dispose();
    }
  });

  it('refuses playback when the fresh current-generation check denies access', async () => {
    const old = deferredResponse();
    const request = vi
      .fn<(input: RequestInfo | URL, init?: RequestInit) => Promise<Response>>()
      .mockResolvedValueOnce(Response.json(result))
      .mockImplementationOnce(() => old.promise)
      .mockResolvedValueOnce(Response.json(result))
      .mockResolvedValueOnce(Response.json(otherResult))
      .mockImplementation(async () => new Response(null, { status: 403 }));
    const revoked = vi.fn();
    const access = createStudioGeneratedAccess(revoked, request);
    try {
      await access.admit(projectId, graph, 1);
      const check = access.recheck();
      await vi.waitFor(() => expect(request).toHaveBeenCalledTimes(2));
      await access.admit(projectId, additionalGraph, 2);
      old.resolve(new Response(null, { status: 403 }));
      await expect(check).resolves.toBe(false);
      expect(request).toHaveBeenCalledTimes(6);
      expect(revoked).toHaveBeenCalledOnce();
    } finally {
      access.dispose();
    }
  });

  it.each([projectId, null])('revokes pending admission for project invalidation %s', async (invalidated) => {
    const pending = deferredResponse();
    const listen = vi.spyOn(websocketEvents, 'on');
    listen.mockClear();
    const revoked = vi.fn();
    const request = vi.fn(async () => pending.promise);
    const access = createStudioGeneratedAccess(revoked, request);
    try {
      const admission = access.admit(projectId, graph, 1);
      const rejection = expect(admission).rejects.toThrow('binding');
      await vi.waitFor(() => expect(request).toHaveBeenCalledOnce());
      const invalidate = listen.mock.calls.find(([event]) => event === 'StudioProjectInvalidatedV1')![1] as (data: {
        projectId: string | null;
      }) => void;
      invalidate({ projectId: 'another-project' });
      expect(revoked).not.toHaveBeenCalled();
      invalidate({ projectId: invalidated });
      expect(revoked).toHaveBeenCalledOnce();
      pending.resolve(Response.json(result));
      await rejection;
    } finally {
      access.dispose();
      listen.mockRestore();
    }
  });
});
