import { serverVersion } from 'src/constants.js';
import { configureUserAgent } from 'src/utils/fetch.js';

describe('fetch', () => {
  afterEach(() => vi.unstubAllGlobals());

  it('should set the default user-agent header', async () => {
    const spy = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', spy);

    configureUserAgent();
    await fetch('https://test.local');

    const headers: Headers = spy.mock.calls[0][1].headers;
    expect(headers.get('User-Agent')).toBe(`frameleaf-server/${serverVersion}`);
  });

  it.each([undefined, { headers: undefined }])(
    'preserves Request headers without consuming its body: %s',
    async (providedInit) => {
      const spy = vi.fn().mockResolvedValue(new Response());
      vi.stubGlobal('fetch', spy);
      const request = new Request('https://test.local', {
        method: 'POST',
        headers: { Authorization: 'Bearer fixture-only', 'Content-Type': 'text/plain' },
        body: 'fixture body',
      });

      configureUserAgent();
      await fetch(request, providedInit);

      const [input, init] = spy.mock.calls[0];
      expect(input).toBe(request);
      expect(init.headers.get('Authorization')).toBe('Bearer fixture-only');
      expect(init.headers.get('Content-Type')).toBe('text/plain');
      expect(init.headers.get('User-Agent')).toBe(`frameleaf-server/${serverVersion}`);
      expect(request.headers.has('User-Agent')).toBe(false);
      expect(request.bodyUsed).toBe(false);
      expect(await request.text()).toBe('fixture body');
    },
  );

  it('preserves a user-agent supplied in a Request', async () => {
    const spy = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', spy);
    const request = new Request('https://test.local', { headers: { 'User-Agent': 'fixture-client' } });

    configureUserAgent();
    await fetch(request);

    expect(spy.mock.calls[0][1].headers.get('User-Agent')).toBe('fixture-client');
  });

  it.each<[HeadersInit]>([
    [{}],
    [{ Authorization: 'Bearer replacement-only' }],
    [new Headers({ 'User-Agent': 'fixture-override' })],
  ])('replaces Request headers when explicit headers are supplied: %s', async (headers) => {
    const spy = vi.fn().mockResolvedValue(new Response());
    vi.stubGlobal('fetch', spy);
    const request = new Request('https://test.local', {
      headers: { Authorization: 'Bearer original-only', 'X-Request-Only': 'original' },
    });
    const signal = new AbortController().signal;

    configureUserAgent();
    await fetch(request, { headers, signal, redirect: 'manual' });

    const init = spy.mock.calls[0][1];
    expect(init.headers.get('X-Request-Only')).toBeNull();
    expect(init.headers.get('Authorization')).toBe(new Headers(headers).get('Authorization'));
    expect(init.headers.get('User-Agent')).toBe(
      new Headers(headers).get('User-Agent') ?? `frameleaf-server/${serverVersion}`,
    );
    expect(init.signal).toBe(signal);
    expect(init.redirect).toBe('manual');
    expect(request.headers.get('Authorization')).toBe('Bearer original-only');
    expect(new Headers(headers).has('User-Agent')).toBe(headers instanceof Headers);
  });
});
