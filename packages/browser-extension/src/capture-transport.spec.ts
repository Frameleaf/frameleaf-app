import { afterEach, describe, expect, it, vi } from 'vitest';
import { defaults } from '@frameleaf/sdk';
import {
  createCaptureTransport,
  DeliveryFailure,
  retryAfterAt,
} from './capture-transport';
import type { CaptureTask } from './queue';
const binding = {
  serverId: 'server-one',
  userId: '11111111-1111-4111-8111-111111111111',
  credentialId: '22222222-2222-4222-8222-222222222222',
  origin: 'https://frameleaf.example/subpath',
};
const id = '33333333-3333-4333-8333-333333333333';
const task: CaptureTask = {
  version: 1,
  id,
  captureId: id,
  binding,
  albumId: '44444444-4444-4444-8444-444444444444',
  tagIds: [],
  source: {
    pageUrl: 'https://example.com/',
    title: 'Reference',
    capturedAt: '2026-10-28T12:00:00.000Z',
  },
  file: {
    filename: 'référence.png',
    size: 3,
    type: 'image/png',
    sha256: 'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
  },
  phase: 'upload',
  state: 'uploading',
  offset: 0,
  attempts: 1,
  createdAt: 1,
  updatedAt: 1,
};
const caps = {
  version: 1,
  captureSupported: true,
  serverId: binding.serverId,
  userId: binding.userId,
  maxFileBytes: 104857600,
};
const state = {
  id,
  offset: 0,
  ready: false,
  expiresAt: '2030-01-01T00:00:00.000Z',
};
const json = (
  data: unknown,
  status = 200,
  headers: Record<string, string> = {},
) =>
  new Response(JSON.stringify(data), {
    status,
    headers: { 'content-type': 'application/json', ...headers },
  });
const originalHeaders = defaults.headers;
afterEach(() => {
  defaults.headers = originalHeaders;
});
function harness(response: () => Response = json.bind(null, state)) {
  const fetch = vi.fn(async (url: string, init?: RequestInit) =>
    url.endsWith('/capture/capabilities') ? json(caps) : response(),
  );
  return {
    fetch,
    transport: createCaptureTransport(binding, 'selected-key', {
      fetch: fetch as typeof globalThis.fetch,
    }),
  };
}
describe('capture-only delivery contract', () => {
  it('revalidates identity and pins every authenticated upload to the selected subpath', async () => {
    defaults.headers = {
      authorization: 'must-not-forward',
      cookie: 'private-cookie',
      'x-api-key': 'wrong-key',
    };
    const { fetch, transport } = harness();
    await transport.getUpload(task);
    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      binding.origin + '/api/capture/capabilities',
      binding.origin + '/api/capture/uploads/' + id,
    ]);
    for (const [, init] of fetch.mock.calls) {
      const headers = new Headers(init?.headers);
      expect(headers.get('authorization')).toBeNull();
      expect(headers.get('cookie')).toBeNull();
      expect(headers.get('x-api-key')).toBe('selected-key');
      expect(init).toMatchObject({
        credentials: 'omit',
        redirect: 'error',
        referrerPolicy: 'no-referrer',
        cache: 'no-store',
      });
    }
  });
  it('creates only a private capture resource with immutable UUID, digest, media headers and UTF8 metadata', async () => {
    const { fetch, transport } = harness();
    await transport.createUpload(task);
    const [url, init] = fetch.mock.calls[1];
    expect(url).toContain('/capture/uploads');
    const headers = new Headers(init?.headers);
    expect(headers.get('upload-draft-interop-version')).toBe('9');
    expect(headers.get('upload-complete')).toBe('?0');
    expect(headers.get('upload-length')).toBe('3');
    expect(headers.get('repr-digest')).toBe(
      'sha-256=:ungWv48Bz+pBQUDeXa4iI7ADYaOWF3qctBD/YfIAFa0=:',
    );
    const encoded = headers.get('asset-metadata')!;
    const metadata = JSON.parse(
      Buffer.from(encoded, 'base64url').toString('utf8'),
    );
    expect(metadata).toEqual({
      publication: 'capture',
      captureId: id,
      libraryScope: 'design',
      filename: 'référence.png',
      fileCreatedAt: task.source.capturedAt,
      fileModifiedAt: task.source.capturedAt,
    });
    expect(headers.get('content-type')).toBe('image/png');
    expect((init?.body as Blob).size).toBe(0);
  });
  it('appends only the remaining bounded bytes with explicit completion and no create metadata', async () => {
    const { fetch, transport } = harness(() =>
      json({ ...state, offset: 3, ready: true }),
    );
    await transport.appendUpload(task, new Blob(['abc']), 1);
    const init = fetch.mock.calls[1][1];
    const headers = new Headers(init?.headers);
    expect(init?.method).toBe('PATCH');
    expect(headers.get('content-type')).toBe('application/partial-upload');
    expect(headers.get('upload-offset')).toBe('1');
    expect(headers.get('upload-complete')).toBe('?1');
    expect(headers.has('asset-metadata')).toBe(false);
    expect(await (init?.body as Blob).text()).toBe('bc');
  });
  it('accepts no-content cancellation and keeps all requests on capture routes', async () => {
    const { fetch, transport } = harness(
      () => new Response(null, { status: 204 }),
    );
    await expect(transport.cancelUpload(task)).resolves.toBeUndefined();
    expect(fetch.mock.calls[1][0]).toBe(
      binding.origin + '/api/capture/uploads/' + id,
    );
    expect(fetch.mock.calls[1][1]?.method).toBe('DELETE');
  });
  it.each([
    [401, 'authorization'],
    [403, 'authorization'],
    [404, 'missing'],
    [409, 'attention'],
    [410, 'attention'],
    [413, 'permanent'],
    [415, 'permanent'],
    [429, 'retry'],
    [503, 'retry'],
    [507, 'attention'],
  ])(
    'classifies HTTP%s without exposing response text',
    async (status, kind) => {
      const { transport } = harness(() =>
        json({ message: 'private server diagnostic' }, status as number, {
          'retry-after': '60',
        }),
      );
      try {
        await transport.getUpload(task);
        throw new Error('Expected failure');
      } catch (error) {
        expect(error).toBeInstanceOf(DeliveryFailure);
        expect(error).toMatchObject({ kind, status });
        expect((error as Error).message).not.toContain('private');
        if (kind === 'retry')
          expect((error as DeliveryFailure).retryAt).toBeGreaterThan(
            Date.now() + 55000,
          );
      }
    },
  );
  it('preserves Retry-After and transient classification during identity preflight too', async () => {
    const fetch = vi
      .fn()
      .mockResolvedValue(json({}, 503, { 'retry-after': '60' }));
    const transport = createCaptureTransport(binding, 'selected-key', {
      fetch,
    });
    await expect(transport.getUpload(task)).rejects.toMatchObject({
      kind: 'retry',
      status: 503,
    });
    expect(fetch).toHaveBeenCalledOnce();
  });
  it('parses Retry-After delta/date and ignores invalid/past/unbounded values', () => {
    const now = Date.parse('2026-10-28T12:00:00Z');
    expect(retryAfterAt('60', now)).toBe(now + 60000);
    expect(retryAfterAt('Wed, 28 Oct 2026 12:01:00 GMT', now)).toBe(
      now + 60000,
    );
    for (const value of [
      null,
      '-1',
      'NaN',
      'Infinity',
      '999999999999999999999',
      '9000000000000',
      'Tue, 27 Oct 2026 12:00:00 GMT',
    ])
      expect(retryAfterAt(value, now)).toBeUndefined();
  });
  it('rejects a changed account and malformed or mismatched resource state before trusting offsets', async () => {
    for (const response of [
      { ...state, id: task.albumId },
      { ...state, offset: 4 },
      { ...state, offset: 1, ready: true },
      { ...state, expiresAt: 'invalid' },
    ]) {
      const { transport } = harness(() => json(response));
      await expect(transport.getUpload(task)).rejects.toThrow();
    }
    const fetch = vi
      .fn()
      .mockResolvedValue(json({ ...caps, userId: task.albumId }));
    await expect(
      createCaptureTransport(binding, 'selected-key', { fetch }).getUpload(
        task,
      ),
    ).rejects.toThrow('different');
    expect(fetch).toHaveBeenCalledTimes(1);
  });
  it('projects only a matching typed server receipt and commits the persisted immutable file metadata', async () => {
    const committedTask: CaptureTask = {
      ...task,
      state: 'committing',
      phase: 'commit',
      offset: 3,
    };
    const result = {
      captureId: id,
      status: 'duplicate',
      item: { kind: 'asset', asset: { id: task.albumId, private: 'discard' } },
    };
    const { fetch, transport } = harness(() => json(result));
    expect(await transport.commit(committedTask)).toEqual({
      captureId: id,
      status: 'duplicate',
      kind: 'asset',
      itemId: task.albumId,
    });
    expect(JSON.parse(fetch.mock.calls[1][1]?.body as string)).toMatchObject({
      captureId: id,
      uploadResourceId: id,
      sha256: task.file!.sha256,
      albumId: task.albumId,
      source: task.source,
    });
    for (const response of [
      { ...result, captureId: task.albumId },
      { ...result, status: 'unknown' },
      { ...result, item: { kind: 'bookmark', bookmark: { id: task.albumId } } },
      {
        ...result,
        item: {
          kind: 'asset',
          asset: { id: '00000000-0000-0000-0000-000000000000' },
        },
      },
    ]) {
      const { transport } = harness(() => json(response));
      await expect(transport.commit(committedTask)).rejects.toThrow();
    }
  });
  it('refuses a wrong destination or an unpersisted commit phase before sending any request', async () => {
    const { fetch, transport } = harness();
    await expect(
      transport.getUpload({
        ...task,
        binding: { ...binding, userId: task.albumId },
      }),
    ).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
    await expect(transport.commit(task)).rejects.toThrow();
    expect(fetch).not.toHaveBeenCalled();
  });
  it('commits bookmarks with their original target and no file digest', async () => {
    const bookmarkTask: CaptureTask = {
      ...task,
      file: undefined,
      bookmark: {
        url: 'https://example.com/watch?v=123',
        title: 'Watch later',
      },
      phase: 'commit',
      state: 'committing',
      offset: 0,
    };
    const { fetch, transport } = harness(() =>
      json({
        captureId: id,
        status: 'created',
        item: { kind: 'bookmark', bookmark: { id: task.albumId } },
      }),
    );
    expect(await transport.commit(bookmarkTask)).toMatchObject({
      kind: 'bookmark',
      status: 'created',
    });
    const body = JSON.parse(fetch.mock.calls[1][1]?.body as string);
    expect(body.bookmark.url).toBe('https://example.com/watch?v=123');
    expect(body.uploadResourceId).toBeUndefined();
    expect(body.sha256).toBeUndefined();
  });
  it('classifies response-body resets as retryable, including after capability headers', async () => {
    const broken = () =>
      new Response(
        new ReadableStream({
          start(controller) {
            controller.error(new Error('private body diagnostic'));
          },
        }),
        { status: 200 },
      );
    const { transport } = harness(broken);
    await expect(transport.getUpload(task)).rejects.toMatchObject({
      kind: 'retry',
    });
    const fetch = vi.fn().mockImplementation(broken);
    await expect(
      createCaptureTransport(binding, 'selected-key', { fetch }).getUpload(
        task,
      ),
    ).rejects.toMatchObject({ kind: 'retry' });
  });
  it('propagates cancellation into in-flight fetches', async () => {
    const controller = new AbortController();
    let observed: AbortSignal | undefined;
    const fetch = vi.fn(
      (_url: RequestInfo | URL, init?: RequestInit) =>
        new Promise<Response>((_resolve, reject) => {
          observed = init?.signal ?? undefined;
          observed?.addEventListener(
            'abort',
            () => reject(new DOMException('Cancelled', 'AbortError')),
            { once: true },
          );
        }),
    );
    const pending = expect(
      createCaptureTransport(binding, 'selected-key', {
        fetch,
        signal: controller.signal,
      }).getUpload(task),
    ).rejects.toThrow();
    await vi.waitFor(() => expect(fetch).toHaveBeenCalledOnce());
    controller.abort();
    await pending;
    expect(observed?.aborted).toBe(true);
  });
});
