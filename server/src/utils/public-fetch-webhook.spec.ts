import { PublicFetchError, isWebhookAddressAllowed, sendWebhook } from 'src/utils/public-fetch.js';

const { fetchMock } = vi.hoisted(() => ({ fetchMock: vi.fn() }));

vi.mock('undici', async (importOriginal) => ({
  ...(await importOriginal<typeof import('undici')>()),
  fetch: fetchMock,
}));

/** FL-819: the webhook step of a workflow that runs on a Frameleaf event. */
describe('isWebhookAddressAllowed', () => {
  it.each(['93.184.216.34', '2606:4700:4700::1111', '::ffff:8.8.8.8'])('allows public %s', (address) => {
    expect(isWebhookAddressAllowed(address, false)).toBe(true);
  });

  it.each(['10.0.0.5', '172.16.4.1', '192.168.1.20', '100.64.0.9', 'fd12::1', '::ffff:192.168.1.20'])(
    'allows home address %s only when the administrator allows it',
    (address) => {
      expect(isWebhookAddressAllowed(address, false)).toBe(false);
      expect(isWebhookAddressAllowed(address, true)).toBe(true);
    },
  );

  it.each(['127.0.0.1', '::1', '169.254.169.254', 'fe80::1', '0.0.0.0', '224.0.0.1', '::ffff:7f00:1', '::'])(
    'never allows %s, even with the home network allowed',
    (address) => {
      expect(isWebhookAddressAllowed(address, false)).toBe(false);
      expect(isWebhookAddressAllowed(address, true)).toBe(false);
    },
  );
});

describe('sendWebhook', () => {
  const message = { method: 'POST', headers: new Headers({ 'content-type': 'application/json' }), body: '{}' };

  beforeEach(() => {
    fetchMock.mockReset();
  });

  it.each([
    ['http://example.com/hook', false],
    ['https://user:pass@example.com/hook', false],
    ['https://192.168.1.20/hook', false],
    ['https://homeassistant.local:8123/api/webhook/x', false],
    ['https://homeassistant/api/webhook/x', false],
    ['http://127.0.0.1:8123/hook', true],
    ['http://[::1]/hook', true],
    ['http://169.254.169.254/latest/meta-data/', true],
    ['http://localhost:8123/hook', true],
    ['ftp://example.com/hook', true],
  ])('refuses %s before connecting (home network allowed: %s)', async (address, allowHomeNetwork) => {
    await expect(sendWebhook(address, message, { allowHomeNetwork })).rejects.toBeInstanceOf(PublicFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it('reaches a home address over http once the administrator allows it', async () => {
    fetchMock.mockResolvedValue(new Response('ok'));
    await expect(
      sendWebhook('http://192.168.1.20:8123/api/webhook/x', message, { allowHomeNetwork: true }),
    ).resolves.toEqual({ ok: true, status: 200, body: 'ok' });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('http://192.168.1.20:8123/api/webhook/x'),
      expect.objectContaining({ method: 'POST', redirect: 'manual', body: '{}' }),
    );
  });

  it('never follows a redirect', async () => {
    fetchMock.mockResolvedValue(new Response(null, { status: 302, headers: { location: 'http://169.254.169.254/' } }));
    await expect(sendWebhook('https://example.com/hook', message, { allowHomeNetwork: false })).resolves.toEqual({
      ok: false,
      status: 302,
      body: '',
    });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it('refuses methods other than POST and PUT, and oversized messages', async () => {
    await expect(
      sendWebhook('https://example.com/hook', { ...message, method: 'GET' }, { allowHomeNetwork: false }),
    ).rejects.toBeInstanceOf(PublicFetchError);
    await expect(
      sendWebhook('https://example.com/hook', { ...message, body: 'x'.repeat(300_000) }, { allowHomeNetwork: false }),
    ).rejects.toBeInstanceOf(PublicFetchError);
    expect(fetchMock).not.toHaveBeenCalled();
  });
});
