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

  it('sends one installation id, made once, with every sign-in', async () => {
    const { handleMessage } = await import('./background');
    await handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );
    await handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );

    const ids = launch.mock.calls.map(([{ url }]) =>
      new URL(url).searchParams.get('installation'),
    );
    expect(ids[0]).toMatch(/^[\da-f]{48}$/);
    expect(ids[1]).toBe(ids[0]);
    expect(values.frameleafInstallationV1).toBe(ids[0]);
  });

  it('a window that cannot open offers the key, unlike closing it', async () => {
    launch.mockRejectedValue(
      new Error('Authorization page could not be loaded.'),
    );
    const { handleMessage } = await import('./background');

    const reply = await handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );

    expect(reply).toEqual(
      expect.objectContaining({ ok: false, problem: 'window' }),
    );
  });

  it('removes the access again when it can’t be kept here', async () => {
    vi.mocked(connectServer).mockResolvedValue({
      ...binding,
      serverId: 'another-server',
    });
    const { handleMessage } = await import('./background');

    const reply = await handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );

    expect(reply).toEqual(
      expect.objectContaining({ ok: false, problem: 'failed' }),
    );
    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.example/api/browser-extension/sign-in',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'x-api-key': 'access-key' },
      }),
    );
    expect(values.frameleafConnectionV1).toBeUndefined();
  });

  it('stays signed in when the server can’t be reached to sign out, unless told to sign out here only', async () => {
    const { handleMessage } = await import('./background');
    await handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );
    const reachable = fetchMock.getMockImplementation() as (
      url: string,
      init?: RequestInit,
    ) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') throw new TypeError('offline');
      return reachable(url, init);
    });

    const failed = await handleMessage({ type: 'disconnect' }, popup);
    expect(failed).toEqual(expect.objectContaining({ ok: false }));
    expect(values.frameleafConnectionV1).toEqual(
      expect.objectContaining({ token: 'access-key' }),
    );

    // switching servers stops before the sign-in window opens
    launch.mockClear();
    const switched = await handleMessage(
      { type: 'sign-in', address: 'https://photos.example', switching: true },
      popup,
    );
    expect(switched).toEqual(
      expect.objectContaining({ ok: false, problem: 'sign-out' }),
    );
    expect(launch).not.toHaveBeenCalled();
    expect(values.frameleafConnectionV1).toEqual(
      expect.objectContaining({ token: 'access-key' }),
    );

    const local = await handleMessage(
      { type: 'disconnect', localOnly: true },
      popup,
    );
    expect(local).toEqual(expect.objectContaining({ ok: true }));
    expect(values.frameleafConnectionV1).toBeUndefined();
  });

  it('keeps a removal it couldn’t make, and makes it later', async () => {
    vi.mocked(connectServer).mockResolvedValue({
      ...binding,
      serverId: 'another-server',
    });
    const reachable = fetchMock.getMockImplementation() as (
      url: string,
      init?: RequestInit,
    ) => Promise<Response>;
    fetchMock.mockImplementation(async (url: string, init?: RequestInit) => {
      if (init?.method === 'DELETE') throw new TypeError('offline');
      return reachable(url, init);
    });
    const { handleMessage, retryRemovals } = await import('./background');

    await handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );
    expect(values.frameleafPendingRemovalsV1).toEqual([
      expect.objectContaining({
        origin: 'https://photos.example',
        token: 'access-key',
      }),
    ]);

    // still unreachable: kept
    await retryRemovals();
    expect(values.frameleafPendingRemovalsV1).toHaveLength(1);
    // reachable again: removed on the server and dropped
    fetchMock.mockImplementation(reachable);
    await retryRemovals();
    expect(values.frameleafPendingRemovalsV1).toBeUndefined();
  });

  it('drops a removal once the server says the access is already gone', async () => {
    values.frameleafPendingRemovalsV1 = [
      { origin: 'https://photos.example', token: 'old', at: Date.now() },
    ];
    fetchMock.mockResolvedValue(new Response(null, { status: 401 }));
    const { retryRemovals } = await import('./background');

    await retryRemovals();

    expect(values.frameleafPendingRemovalsV1).toBeUndefined();
  });

  it('doesn’t save a sign-in that comes back after you signed out, and removes its access', async () => {
    const { handleMessage } = await import('./background');
    await handleMessage(
      {
        type: 'connect',
        address: 'https://photos.example',
        token: 'hand-made',
      },
      popup,
    );
    let finish!: (value: string) => void;
    launch.mockImplementation(
      ({ url }: { url: string }) =>
        new Promise<string>((resolve) => {
          finish = () =>
            resolve(
              `${REDIRECT}?code=the-code&state=${new URL(url).searchParams.get('state')}`,
            );
        }),
    );

    const pending = handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );
    await vi.waitFor(() => expect(launch).toHaveBeenCalled());
    await handleMessage({ type: 'disconnect' }, popup);
    finish('');
    const reply = await pending;

    expect(reply).toEqual(expect.objectContaining({ ok: false }));
    expect(values.frameleafConnectionV1).toBeUndefined();
    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.example/api/browser-extension/sign-in',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'x-api-key': 'access-key' },
      }),
    );
    // and it isn't reported as a problem with the server
    expect(values.frameleafSignInNoticeV1).toBeUndefined();
  });

  it('signing out of a paused access still removes it on the server', async () => {
    const { handleMessage } = await import('./background');
    await handleMessage(
      { type: 'sign-in', address: 'https://photos.example' },
      popup,
    );
    const settings = await import('./settings');
    await settings.pauseConnection(binding);
    expect(await settings.credentialFor(binding).catch(() => 'refused')).toBe(
      'refused',
    );

    const reply = await handleMessage(
      { type: 'sign-in', address: 'https://photos.example', switching: true },
      popup,
    );

    expect(reply).toEqual(expect.objectContaining({ ok: true }));
    expect(fetchMock).toHaveBeenCalledWith(
      'https://photos.example/api/browser-extension/sign-in',
      expect.objectContaining({
        method: 'DELETE',
        headers: { 'x-api-key': 'access-key' },
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
