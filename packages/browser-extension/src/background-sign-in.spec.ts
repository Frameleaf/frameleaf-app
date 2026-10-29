import { beforeEach, describe, expect, it, vi } from 'vitest';
import { connectServer, getCatalog } from './api';
vi.mock('./delivery', () => ({
  wakeDelivery: vi.fn().mockResolvedValue(undefined),
  stopDelivery: vi.fn(),
  deliveryError: vi.fn().mockReturnValue(null),
}));
vi.mock('./api', async (original) => ({
  ...(await original<typeof import('./api')>()),
  connectServer: vi.fn(),
  getCatalog: vi.fn(),
}));

/** FL-655: signing in from the popup, end to end in the background, with the browser mocked. */
const REDIRECT = 'https://abcdefghijklmnopabcdefghijklmnop.chromiumapp.org/';
const binding = {
  serverId: 'server-a',
  userId: '11111111-1111-4111-8111-111111111111',
  origin: 'https://photos.example',
  credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
  userName: 'Taylor',
};
const popup = {
  id: 'frameleaf',
  url: 'chrome-extension://frameleaf/popup.html',
};
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
let values: Record<string, unknown>;
let launch: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;

beforeEach(() => {
  vi.resetModules();
  vi.clearAllMocks();
  values = {};
  const event = () => ({ addListener: vi.fn() });
  launch = vi.fn(async ({ url }: { url: string }) => {
    const state = new URL(url).searchParams.get('state');
    return `${REDIRECT}?code=the-code&state=${state}`;
  });
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'frameleaf',
      openOptionsPage: vi.fn(),
      getURL: (path: string) => `chrome-extension://frameleaf/${path}`,
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
    },
    identity: { getRedirectURL: () => REDIRECT, launchWebAuthFlow: launch },
    storage: {
      local: {
        setAccessLevel: vi.fn().mockResolvedValue(undefined),
        get: vi.fn(async (key: string) => ({
          [key]: structuredClone(values[key]),
        })),
        set: vi.fn(async (input: Record<string, unknown>) => {
          Object.assign(values, structuredClone(input));
        }),
        remove: vi.fn(async (key: string) => {
          delete values[key];
        }),
      },
    },
    permissions: {
      contains: vi.fn().mockResolvedValue(true),
      onRemoved: event(),
    },
    tabs: { create: vi.fn() },
    contextMenus: {
      removeAll: vi.fn((callback) => callback?.()),
      create: vi.fn(),
      onClicked: event(),
    },
    alarms: { create: vi.fn().mockResolvedValue(undefined), onAlarm: event() },
  });
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    if (url.endsWith('/api/server/ping')) return json({ res: 'pong' });
    if (
      url.endsWith('/api/browser-extension/sign-in') &&
      init?.method === 'DELETE'
    )
      return new Response(null, { status: 204 });
    if (url.endsWith('/api/browser-extension/sign-in'))
      return json({ version: 1 });
    if (url.endsWith('/exchange'))
      return json({
        secret: 'access-key',
        apiKeyId: 'access-1',
        userId: binding.userId,
        serverId: 'server-a',
      });
    return json({}, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  vi.mocked(connectServer).mockResolvedValue(binding);
  vi.mocked(getCatalog).mockResolvedValue({ albums: [], tags: [] });
});

describe('Sign in with your Frameleaf account (FL-655)', () => {
  it('signs in through the browser’s window, keeps the access and says so next time', async () => {
    const { handleMessage } = await import('./background');
    const reply = await handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );

    expect(reply).toEqual(expect.objectContaining({ ok: true }));
    const opened = new URL(launch.mock.calls[0][0].url);
    expect(opened.origin + opened.pathname).toBe(
      'https://photos.example/auth/allow-extension',
    );
    expect(launch.mock.calls[0][0].interactive).toBe(true);
    const exchange = fetchMock.mock.calls.find(([url]) =>
      String(url).endsWith('/exchange'),
    )!;
    const body = JSON.parse(String(exchange[1].body));
    expect(body.code).toBe('the-code');
    expect(body.redirectUri).toBe(REDIRECT);
    // the verifier is never in the sign-in window's address, only its challenge
    expect(opened.href).not.toContain(body.codeVerifier);
    expect(vi.mocked(connectServer)).toHaveBeenCalledWith(
      'https://photos.example',
      'access-key',
      {
        allowLocalhost: false,
      },
    );
    const state = await handleMessage({ type: 'sign-in-state' }, popup);
    expect(state).toEqual(
      expect.objectContaining({
        ok: true,
        notice: { kind: 'welcome' },
        connection: expect.objectContaining({
          status: 'connected',
          method: 'sign-in',
        }),
        recent: [
          expect.objectContaining({
            origin: 'https://photos.example',
            account: 'Taylor',
          }),
        ],
      }),
    );
  });

  it('closing the window is cancelling, and nothing is saved', async () => {
    launch.mockRejectedValue(new Error('The user did not approve access.'));
    const { handleMessage } = await import('./background');

    const reply = await handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );

    expect(reply).toEqual(
      expect.objectContaining({ ok: false, problem: 'cancelled' }),
    );
    expect(values.frameleafConnectionV1).toBeUndefined();
    expect(
      (await handleMessage({ type: 'sign-in-state' }, popup)).ok &&
        values.frameleafSignInNoticeV1,
    ).toEqual({
      kind: 'problem',
      problem: 'cancelled',
      origin: 'https://photos.example',
    });
  });

  it('a server too old to sign in offers the key instead, without opening a window', async () => {
    fetchMock.mockImplementation(async (url: string) =>
      url.endsWith('/ping')
        ? json({ res: 'pong' })
        : json({ message: 'Not Found' }, 404),
    );
    const { handleMessage } = await import('./background');

    const reply = await handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );

    expect(reply).toEqual(
      expect.objectContaining({ ok: false, problem: 'old-server' }),
    );
    expect(launch).not.toHaveBeenCalled();
  });

  it('a return for another sign-in is refused', async () => {
    launch.mockResolvedValue(`${REDIRECT}?code=the-code&state=forged`);
    const { handleMessage } = await import('./background');

    const reply = await handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );

    expect(reply).toEqual(
      expect.objectContaining({ ok: false, problem: 'failed' }),
    );
    expect(
      fetchMock.mock.calls.some(([url]) => String(url).endsWith('/exchange')),
    ).toBe(false);
  });

  it('sign out removes the access on the server and forgets it here', async () => {
    const { handleMessage } = await import('./background');
    await handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );

    await handleMessage({ type: 'disconnect' }, popup);

    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.example/api/browser-extension/sign-in',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'x-api-key': 'access-key' },
      }),
    );
    expect(values.frameleafConnectionV1).toBeUndefined();
  });

  it('a key pasted by hand is only forgotten on sign out', async () => {
    const { handleMessage } = await import('./background');
    await handleMessage(
      {
        type: 'connect',
        address: 'https://photos.example',
        token: 'hand-made',
      },
      popup,
    );

    await handleMessage({ type: 'disconnect' }, popup);

    expect(
      fetchMock.mock.calls.some(([, init]) => init?.method === 'DELETE'),
    ).toBe(false);
    expect(values.frameleafConnectionV1).toBeUndefined();
  });

  it('only the popup and options page can start a sign-in', async () => {
    const { handleMessage } = await import('./background');
    const page = {
      id: 'frameleaf',
      url: 'chrome-extension://frameleaf/capture.html',
    };
    expect(
      (
        await handleMessage(
          { type: 'sign-in', address: 'https://photos.example' },
          page,
        )
      ).ok,
    ).toBe(false);
    expect(launch).not.toHaveBeenCalled();
  });
});
