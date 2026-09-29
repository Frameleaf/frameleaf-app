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
        () =>
          new Promise<Response>((resolve) => {
            resolvers.push(resolve);
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

  it('can still cancel a request whose response is streaming', async () => {
    const first = handleFetch(url('d'));
    const signal = vi.mocked(fetch).mock.calls[0][1]!.signal!;
    resolvers[0](new Response('body'));
    await first;

    handleCancel(url('d'));
    expect(signal.aborted).toBe(true);
  });
});
