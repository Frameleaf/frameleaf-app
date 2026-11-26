import { createECDH, randomBytes } from 'node:crypto';
import {
  UNIFIED_PUSH_MAX_RETRY_AFTER_SEC,
  UnifiedPushRepository,
  parseRetryAfter,
  unifiedPushTopicOf,
} from 'src/repositories/unified-push.repository.js';
import { decryptWebPush } from 'src/utils/web-push.js';

const { fetchMock, lookupMock } = vi.hoisted(() => ({ fetchMock: vi.fn(), lookupMock: vi.fn() }));

vi.mock('node:dns', () => ({ lookup: lookupMock }));

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: fetchMock,
  Agent: class {
    constructor(readonly options: { connect: { lookup: typeof lookupMock } }) {}
  },
}));

const ENDPOINT = 'https://ntfy.example.net/upAbCdEfGhIjKl?up=1';

const newDevice = () => {
  const ecdh = createECDH('prime256v1');
  ecdh.generateKeys();
  return {
    privateKey: ecdh.getPrivateKey(),
    p256dh: ecdh.getPublicKey().toString('base64url'),
    auth: randomBytes(16).toString('base64url'),
  };
};

const answer = (status: number, headers: Record<string, string> = {}) => ({
  ok: status >= 200 && status < 300,
  status,
  headers: new Headers(headers),
  body: null,
});

const message = { plaintext: Buffer.from('{"v":1}'), ttlSec: 3600, urgency: 'high' as const, topic: 'album-update/1' };

describe(UnifiedPushRepository.name, () => {
  const sut = new UnifiedPushRepository();

  beforeEach(() => {
    fetchMock.mockReset();
    lookupMock.mockReset();
  });

  it('POSTs the message Web Push encrypted (aes128gcm) with the delivery headers', async () => {
    const device = newDevice();
    fetchMock.mockResolvedValue(answer(201));

    await expect(sut.send({ endpoint: ENDPOINT, ...device }, message, { allowLocalTargets: false })).resolves.toEqual({
      status: 'sent',
    });

    const [url, init] = fetchMock.mock.calls[0];
    expect(String(url)).toBe(ENDPOINT);
    expect(init).toMatchObject({ method: 'POST', redirect: 'manual' });
    expect(init.headers).toMatchObject({
      'content-encoding': 'aes128gcm',
      'content-type': 'application/octet-stream',
      ttl: '3600',
      urgency: 'high',
      topic: unifiedPushTopicOf('album-update/1'),
    });
    expect(init.headers).not.toHaveProperty('authorization');
    expect(decryptWebPush(Buffer.from(init.body), device).equals(message.plaintext)).toBe(true);
  });

  it.each([404, 410])('reports %s as gone', async (status) => {
    fetchMock.mockResolvedValue(answer(status));
    await expect(
      sut.send({ endpoint: ENDPOINT, ...newDevice() }, message, { allowLocalTargets: false }),
    ).resolves.toEqual({
      status: 'gone',
    });
  });

  it('asks to retry after a 429 by its Retry-After, and after a server error or a network failure', async () => {
    const subscription = { endpoint: ENDPOINT, ...newDevice() };
    fetchMock.mockResolvedValueOnce(answer(429, { 'retry-after': '120' }));
    await expect(sut.send(subscription, message, { allowLocalTargets: false })).resolves.toEqual({
      status: 'retry',
      retryAfterSec: 120,
    });
    fetchMock.mockResolvedValueOnce(answer(503));
    await expect(sut.send(subscription, message, { allowLocalTargets: false })).resolves.toEqual({ status: 'retry' });
    fetchMock.mockRejectedValueOnce(new TypeError('fetch failed'));
    await expect(sut.send(subscription, message, { allowLocalTargets: false })).resolves.toEqual({ status: 'retry' });
  });

  it('refuses, never retrying, other answers and redirects', async () => {
    const subscription = { endpoint: ENDPOINT, ...newDevice() };
    fetchMock.mockResolvedValueOnce(answer(413));
    await expect(sut.send(subscription, message, { allowLocalTargets: false })).resolves.toMatchObject({
      status: 'refused',
    });
    fetchMock.mockResolvedValueOnce(answer(302, { location: 'https://127.0.0.1/' }));
    await expect(sut.send(subscription, message, { allowLocalTargets: false })).resolves.toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('redirect'),
    });
    fetchMock.mockResolvedValueOnce(answer(401));
    await expect(sut.send(subscription, message, { allowLocalTargets: false })).resolves.toMatchObject({
      status: 'refused',
      reason: expect.stringContaining('VAPID'),
    });
  });

  it('refuses a private, loopback or link-local address before connecting', async () => {
    const device = newDevice();
    for (const endpoint of [
      'https://10.0.0.7/up',
      'https://127.0.0.1/up',
      'https://[::1]/up',
      'https://169.254.169.254/up',
      'https://localhost/up',
      // eslint-disable-next-line unicorn/prefer-https -- the test checks that plain http to a public host is refused
      'http://ntfy.example.net/up',
    ]) {
      await expect(sut.send({ endpoint, ...device }, message, { allowLocalTargets: false })).resolves.toMatchObject({
        status: 'refused',
        reason: expect.stringContaining('not at a public https address'),
      });
    }
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('refuses a name that resolves to this network while connecting, unless local push servers are allowed', async () => {
    fetchMock.mockImplementation(
      async (_url, init: { dispatcher: { options: { connect: { lookup: typeof lookupMock } } } }) => {
        const error = await new Promise<Error | null>((resolve) =>
          init.dispatcher.options.connect.lookup('ntfy.home.example', {}, (failure: Error | null) => resolve(failure)),
        );
        if (error) {
          throw new TypeError('fetch failed', { cause: error });
        }
        return answer(200);
      },
    );
    lookupMock.mockImplementation((_host, _options, callback) =>
      callback(null, [{ address: '192.168.1.20', family: 4 }]),
    );
    const subscription = { endpoint: 'https://ntfy.home.example/upAbCdEfGhIjKl', ...newDevice() };

    await expect(sut.send(subscription, message, { allowLocalTargets: false })).resolves.toMatchObject({
      status: 'refused',
    });
    await expect(sut.send(subscription, message, { allowLocalTargets: true })).resolves.toEqual({ status: 'sent' });

    lookupMock.mockImplementation((_host, _options, callback) => callback(null, [{ address: '127.0.0.1', family: 4 }]));
    await expect(sut.send(subscription, message, { allowLocalTargets: true })).resolves.toMatchObject({
      status: 'refused',
    });
  });

  it('checks an endpoint at registration with the same rules', () => {
    expect(() => sut.checkEndpoint(ENDPOINT, { allowLocalTargets: false })).not.toThrow();
    expect(() => sut.checkEndpoint('https://192.168.1.20/up', { allowLocalTargets: false })).toThrow('public https');
    expect(() => sut.checkEndpoint('http://192.168.1.20:8080/up', { allowLocalTargets: true })).not.toThrow();
    expect(() => sut.checkEndpoint('https://127.0.0.1/up', { allowLocalTargets: true })).toThrow('public https');
    expect(() => sut.checkEndpoint('not a url', { allowLocalTargets: true })).toThrow('public https');
  });
});

describe('parseRetryAfter', () => {
  const now = Date.parse('2026-11-15T12:00:00Z');

  it('reads seconds or an HTTP date, clamped to 1 s .. 6 h', () => {
    expect(parseRetryAfter('120', now)).toBe(120);
    expect(parseRetryAfter('0', now)).toBe(1);
    expect(parseRetryAfter('99999999', now)).toBe(UNIFIED_PUSH_MAX_RETRY_AFTER_SEC);
    expect(parseRetryAfter('Sun, 15 Nov 2026 12:05:00 GMT', now)).toBe(300);
    expect(parseRetryAfter('soon', now)).toBeUndefined();
    expect(parseRetryAfter(null, now)).toBeUndefined();
  });
});

describe('unifiedPushTopicOf', () => {
  it('keeps a short URL-safe collapse id and hashes anything else to 32 characters', () => {
    expect(unifiedPushTopicOf('render-1')).toBe('render-1');
    expect(unifiedPushTopicOf('album-update/1')).toMatch(/^[\da-f]{32}$/);
    expect(unifiedPushTopicOf('a'.repeat(40))).toMatch(/^[\da-f]{32}$/);
    expect(unifiedPushTopicOf(undefined)).toBeUndefined();
  });
});
