import { afterEach, describe, expect, it, vi } from 'vitest';
import { CaptureFailure, getCatalog } from './api';
import {
  checkedOperation,
  connectSite,
  inspect,
  LibraryFailure,
  mediaCapabilities,
  readOperation,
} from './media-api';

const binding = {
  origin: 'https://photos.example',
  serverId: 'server-a',
  userId: '11111111-1111-4111-8111-111111111111',
  credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const capture = {
  version: 1,
  captureSupported: true,
  serverId: binding.serverId,
  userId: binding.userId,
  maxFileBytes: 104857600,
};
const ID = '0190a000-0000-7000-8000-000000000001';
const operation = {
  id: ID,
  state: 'ready',
  kind: 'item',
  provider: 'example',
  creator: 'Someone',
  complete: true,
  limitation: null,
  error: null,
  albumId: null,
  items: [
    {
      id: '0190a000-0000-7000-8000-000000000002',
      title: 'A clip',
      kind: 'video',
      creator: null,
      pageUrl: 'https://video.example/watch?v=1&token=private',
    },
  ],
  discovered: 1,
  saved: 0,
  skipped: 0,
  failed: 0,
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
/** A Library that answers the identity check, then `answer` for the media request. */
const library = (answer: () => Response | Promise<Response>) =>
  vi.fn(async (url: string) =>
    url.endsWith('/api/capture/capabilities') ? json(capture) : answer(),
  );
const problem = async (promise: Promise<unknown>) => {
  const error: unknown = await promise.then(
    () => null,
    (reason: unknown) => reason,
  );
  expect(error).toBeInstanceOf(LibraryFailure);
  return (error as LibraryFailure).problem;
};
afterEach(() => vi.unstubAllGlobals());

describe('asking your Library for media (FL-1427)', () => {
  it('asks the bound address, with this browser’s key, after confirming who answers', async () => {
    const fetch = library(() => json(operation));

    const found = await inspect(
      binding,
      'access-key',
      { urls: ['https://video.example/watch?v=1'] },
      fetch as never,
    );

    expect(fetch.mock.calls.map(([url]) => url)).toEqual([
      'https://photos.example/api/capture/capabilities',
      'https://photos.example/api/media-imports/inspect',
    ]);
    const init = (fetch.mock.calls[1] as unknown as [string, RequestInit])[1];
    expect(new Headers(init.headers).get('x-api-key')).toBe('access-key');
    expect(JSON.parse(String(init.body))).toEqual({
      urls: ['https://video.example/watch?v=1'],
    });
    // what is shown never includes a source address
    expect(JSON.stringify(found)).not.toContain('token=private');
    expect(found.items).toEqual([
      {
        id: '0190a000-0000-7000-8000-000000000002',
        title: 'A clip',
        kind: 'video',
        creator: null,
      },
    ]);
  });

  it('a Library from before media downloads is "needs an update", and saving still works', async () => {
    const old = vi.fn(async (url: string) => {
      if (url.endsWith('/api/capture/capabilities')) return json(capture);
      if (url.endsWith('/api/capture/catalog'))
        return json({ albums: [], tags: [] });
      return json({ message: 'Not Found' }, 404);
    });

    await expect(
      problem(mediaCapabilities(binding, 'access-key', old as never)),
    ).resolves.toBe('unsupported');
    // the same key and address keep listing collections for captures
    await expect(
      getCatalog(binding, 'access-key', old as never),
    ).resolves.toEqual({ albums: [], tags: [] });
  });

  it('a key that can save but was never allowed media is asked to allow it, not treated as broken', async () => {
    await expect(
      problem(
        inspect(
          binding,
          'access-key',
          { urls: ['https://video.example/'] },
          library(() =>
            json(
              {
                message: 'Missing required permission: media-import.create',
                error: 'Forbidden',
                statusCode: 403,
              },
              403,
            ),
          ) as never,
        ),
      ),
    ).resolves.toBe('grant');
  });

  it('a 403 for any other reason is that request refused, not a missing permission', async () => {
    const error = await inspect(
      binding,
      'access-key',
      { urls: ['https://video.example/'] },
      library(() =>
        json({ message: 'Use HTTPS to share site access with Library' }, 403),
      ) as never,
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ problem: 'refused', status: 403 });
  });

  it('a 404 for one inspection means it is gone, not that the Library needs an update', async () => {
    const error = await readOperation(
      binding,
      'access-key',
      ID,
      library(() => json({ message: 'Not Found' }, 404)) as never,
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ problem: 'refused', status: 404 });
  });

  it('a key the Library no longer accepts stops everything, as it does for saving', async () => {
    const error = await readOperation(
      binding,
      'access-key',
      ID,
      vi.fn(async () => json({ message: 'Unauthorized' }, 401)) as never,
    ).catch((reason: unknown) => reason);
    expect(error).toBeInstanceOf(CaptureFailure);
    expect((error as CaptureFailure).code).toBe('authorization');
  });

  it('refuses a Library that now answers as another account', async () => {
    const other = vi.fn(async () =>
      json({ ...capture, userId: '99999999-9999-4999-8999-999999999999' }),
    );
    const error = await readOperation(
      binding,
      'access-key',
      ID,
      other as never,
    ).catch((reason: unknown) => reason);
    expect((error as CaptureFailure).code).toBe('identity');
    expect(other).toHaveBeenCalledTimes(1);
  });

  it('no answer at all is "didn’t answer": the certificate or the network', async () => {
    await expect(
      problem(
        readOperation(
          binding,
          'access-key',
          ID,
          vi.fn().mockRejectedValue(new TypeError('Failed to fetch')) as never,
        ),
      ),
    ).resolves.toBe('unreachable');
  });

  it('says no for anything else the Library refuses, and keeps its answer', async () => {
    const error = await readOperation(
      binding,
      'access-key',
      ID,
      library(() => json({ message: 'Conflict' }, 409)) as never,
    ).catch((reason: unknown) => reason);
    expect(error).toMatchObject({ problem: 'refused', status: 409 });
  });

  it('only ever shares a site’s sign-in over HTTPS', async () => {
    const fetch = vi.fn();
    await expect(
      problem(
        connectSite(
          { ...binding, origin: 'http://localhost:2283' },
          'access-key',
          {
            provider: 'video.example',
            label: 'video.example',
            session: { domains: ['video.example'], cookies: [] },
          },
          fetch as never,
        ),
      ),
    ).resolves.toBe('https');
    expect(fetch).not.toHaveBeenCalled();
  });

  it('reads the Library’s reply like any outside input', () => {
    expect(() => checkedOperation({ id: 'not-an-id' })).toThrow(LibraryFailure);
    expect(
      checkedOperation({
        id: ID,
        state: 'a-state-from-a-newer-library',
        items: [{ id: 'bad' }, null, { id: ID, title: 7, kind: 'hologram' }],
        saved: -4,
      }),
    ).toEqual(
      expect.objectContaining({
        // unknown is unfinished, never finished
        state: 'queued',
        items: [{ id: ID, title: 'Untitled', kind: 'video', creator: null }],
        saved: 0,
      }),
    );
  });
});
