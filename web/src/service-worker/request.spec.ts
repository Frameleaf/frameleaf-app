import { handleCancel, handleFetch } from './request';

/**
 * FL-137: the service worker only shares a thumbnail or original between requests that are in flight
 * together. Once a response has arrived, a new request goes to the server again, so a revoked share,
 * a newly Locked item or another person signed in on this browser never gets the earlier response.
 */
const url = (id: string) => new URL(`https://frameleaf.test/api/assets/${id}/thumbnail?size=preview`);

const text = async (response: Promise<Response>) => {
  const settled = await response;
  return settled.text();
};

describe('service worker asset requests', () => {
  let resolvers: Array<(response: Response) => void>;

  beforeEach(() => {
    vi.useFakeTimers();
    resolvers = [];
    vi.stubGlobal(
      'fetch',
      vi.fn(
        (_input: unknown, init?: RequestInit) =>
          new Promise<Response>((resolve, reject) => {
            resolvers.push(resolve);
            // like a real fetch: aborting rejects with the abort reason
            init?.signal?.addEventListener('abort', () => reject(init.signal!.reason));
          }),
      ),
    );
  });

  afterEach(() => {
    vi.useRealTimers();
    vi.unstubAllGlobals();
  });

  it('shares one server request between requests in flight together', async () => {
    const first = handleFetch(url('a'));
    const second = handleFetch(url('a'));
    expect(fetch).toHaveBeenCalledTimes(1);

    resolvers[0](new Response('image'));
    await expect(text(first)).resolves.toBe('image');
    await expect(text(second)).resolves.toBe('image');
  });

  it('goes back to the server once the earlier response has arrived', async () => {
    const first = handleFetch(url('b'));
    resolvers[0](new Response('allowed'));
    await expect(text(first)).resolves.toBe('allowed');

    // e.g. the share was revoked, or someone else signed in: the server now refuses
    const second = handleFetch(url('b'));
    expect(fetch).toHaveBeenCalledTimes(2);
    resolvers[1](new Response('denied', { status: 400 }));
    const response = await second;
    expect(response.status).toBe(400);
    await expect(response.text()).resolves.toBe('denied');
  });

  it.each(['thumbnail', 'original'])('reauthorizes a cached %s after revocation or Lock', async (media) => {
    for (const change of ['revoked', 'Locked']) {
      const request = new Request(`https://frameleaf.test/api/assets/${change}/${media}`);
      // happy-dom omits Request.cache; supply the browser property in this HTTP-cache model.
      if (request.cache === undefined) {
        Object.defineProperty(request, 'cache', { value: 'default' });
      }
      let isAllowed = true;
      let cached: Response | undefined;
      let authorizations = 0;
      // Model a fresh private HTTP-cache entry: default requests reuse it without reaching the server.
      // Revalidation must reach current authorization even when the body and URL have not changed.
      vi.stubGlobal(
        'fetch',
        vi.fn(async (_input: unknown, init?: RequestInit) => {
          if (cached && !['no-cache', 'no-store', 'reload'].includes(init?.cache ?? request.cache)) {
            return cached.clone();
          }
          authorizations++;
          if (!isAllowed) {
            return new Response('denied', { status: 403 });
          }
          cached = new Response('private media', { headers: { 'Cache-Control': 'private, max-age=86400' } });
          return cached.clone();
        }),
      );
      expect(request.cache).toBe('default');
      await expect(text(handleFetch(request))).resolves.toBe('private media');
      isAllowed = false;
      const denied = await handleFetch(request);
      expect(denied.status).toBe(403);
      expect(authorizations).toBe(2);
      await expect(denied.text()).resolves.toBe('denied');
    }
  });

  it('preserves a caller that forbids storing the response', async () => {
    const request = new Request(url('no-store'), { cache: 'no-store' });
    // happy-dom omits Request.cache, including an explicitly supplied cache policy.
    if (request.cache === undefined) {
      Object.defineProperty(request, 'cache', { value: 'no-store' });
    }
    const response = handleFetch(request);
    expect(vi.mocked(fetch).mock.calls[0][1]?.cache).toBe('no-store');
    resolvers[0](new Response('private media'));
    await expect(text(response)).resolves.toBe('private media');
  });

  it('keeps the newer request when the earlier entry expires', async () => {
    const first = handleFetch(url('c'));
    resolvers[0](new Response('old'));
    await first;
    const second = handleFetch(url('c'));

    await vi.advanceTimersByTimeAsync(5 * 60 * 1000);
    const third = handleFetch(url('c'));
    // the pending newer request is still shared, not dropped by the earlier entry's cleanup
    expect(fetch).toHaveBeenCalledTimes(2);
    resolvers[1](new Response('new'));
    await expect(text(second)).resolves.toBe('new');
    await expect(text(third)).resolves.toBe('new');
  });

  it("never lets an earlier caller's cancel blank a newer load of the same image", async () => {
    // component A loads the image; later component B loads it again while A is still mounted
    const first = handleFetch(url('e'));
    resolvers[0](new Response('old'));
    await expect(text(first)).resolves.toBe('old');
    const second = handleFetch(url('e'));
    const signal = vi.mocked(fetch).mock.calls[1][1]!.signal!;

    // A is destroyed and cancels by URL: B's load must go on
    handleCancel(url('e'));
    expect(signal.aborted).toBe(false);
    resolvers[1](new Response('new'));
    await expect(text(second)).resolves.toBe('new');

    // B's own cancel still works
    const third = handleFetch(url('e'));
    const thirdSignal = vi.mocked(fetch).mock.calls[2][1]!.signal!;
    handleCancel(url('e')); // absorbed: owed by B, which loaded the settled second response
    handleCancel(url('e'));
    expect(thirdSignal.aborted).toBe(true);
    await expect(third).resolves.toMatchObject({ status: 204 });
  });

  it('keeps a shared load running until its last caller cancels', async () => {
    // two tiles ask for the same thumbnail while it is still loading; one is then destroyed
    const first = handleFetch(url('g'));
    const second = handleFetch(url('g'));
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    expect(fetch).toHaveBeenCalledTimes(1);

    handleCancel(url('g'));
    expect(signal.aborted).toBe(false);
    resolvers[0](new Response('shared'));
    await expect(text(first)).resolves.toBe('shared');
    await expect(text(second)).resolves.toBe('shared');

    // the remaining caller's cancel still stops the body
    handleCancel(url('g'));
    expect(signal.aborted).toBe(true);
  });

  it('still aborts a load every caller of which has cancelled', async () => {
    const first = handleFetch(url('f'));
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    handleCancel(url('f'));
    expect(signal.aborted).toBe(true);
    await expect(first).resolves.toMatchObject({ status: 204 });
  });

  it('can still cancel a request whose response is streaming', async () => {
    const first = handleFetch(url('d'));
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    resolvers[0](new Response('body'));
    await first;

    handleCancel(url('d'));
    expect(signal.aborted).toBe(true);
  });
});
