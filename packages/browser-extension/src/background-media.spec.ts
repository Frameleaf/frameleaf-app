import { beforeEach, describe, expect, it, vi } from 'vitest';
import { IDBFactory } from 'fake-indexeddb';
import { wakeDelivery } from './delivery';
vi.mock('./delivery', () => ({
  wakeDelivery: vi.fn().mockResolvedValue(undefined),
  stopDelivery: vi.fn(),
  deliveryError: vi.fn().mockReturnValue(null),
}));

/** FL-1427: the popup's media requests, end to end in the background, with the browser mocked. */
const binding = {
  serverId: 'server-a',
  userId: '11111111-1111-4111-8111-111111111111',
  origin: 'https://photos.example',
  credentialId: 'aaaaaaaa-aaaa-4aaa-8aaa-aaaaaaaaaaaa',
};
const popup = {
  id: 'frameleaf',
  url: 'chrome-extension://frameleaf/popup.html',
};
const options = {
  id: 'frameleaf',
  url: 'chrome-extension://frameleaf/options.html',
};
const INSPECTION = '0190a000-0000-7000-8000-000000000001';
const ITEM = '0190a000-0000-7000-8000-000000000002';
const ALBUM = '33333333-3333-4333-8333-333333333333';
const CONNECTION = '0190a000-0000-7000-8000-0000000000cc';
const json = (value: unknown, status = 200) =>
  new Response(JSON.stringify(value), {
    status,
    headers: { 'content-type': 'application/json' },
  });
const operation = (state = 'inspecting') => ({
  id: INSPECTION,
  state,
  kind: 'item',
  provider: 'example',
  creator: null,
  complete: true,
  limitation: null,
  error: null,
  albumId: null,
  items: [{ id: ITEM, title: 'A clip', kind: 'video', creator: null }],
  discovered: 1,
  saved: 0,
  skipped: 0,
  failed: 0,
});
const connected = {
  id: CONNECTION,
  provider: 'video.example',
  label: 'video.example',
  domains: ['video.example'],
  status: 'connected',
  revision: 1,
  updatedAt: '2026-11-10T00:00:00.000Z',
};
const siteCookie = {
  name: 'session',
  value: 'cookie-secret-value',
  domain: '.video.example',
  path: '/',
  secure: true,
  httpOnly: true,
  hostOnly: false,
  session: false,
  sameSite: 'lax',
  storeId: '0',
  expirationDate: 1_900_000_000,
};
let values: Record<string, unknown>;
let contains: ReturnType<typeof vi.fn>;
let fetchMock: ReturnType<typeof vi.fn>;
let cookies: ReturnType<typeof vi.fn>;
let media: Record<string, (init?: RequestInit) => Response>;
let connections: unknown[];
let tab: { id: number; url: string; title: string };
let handleMessage: typeof import('./background').handleMessage;

const signedIn = (grant?: 'capture' | 'media', method = 'sign-in') => {
  values.frameleafConnectionV1 = {
    version: 1,
    binding,
    token: 'access-key',
    status: 'connected',
    catalog: null,
    method,
    ...(grant && { grant }),
  };
};
const mediaCalls = () =>
  fetchMock.mock.calls
    .map(([url, init]) => ({
      path: new URL(String(url)).pathname,
      method: (init as RequestInit | undefined)?.method ?? 'GET',
      body: (init as RequestInit | undefined)?.body,
    }))
    .filter((call) => call.path.startsWith('/api/media-'));

beforeEach(async () => {
  vi.resetModules();
  vi.clearAllMocks();
  values = {};
  connections = [];
  tab = { id: 7, url: 'https://www.video.example/watch?v=1', title: 'A clip' };
  contains = vi.fn().mockResolvedValue(true);
  cookies = vi.fn().mockResolvedValue([siteCookie]);
  const event = () => ({ addListener: vi.fn() });
  vi.stubGlobal('indexedDB', new IDBFactory());
  vi.stubGlobal('chrome', {
    runtime: {
      id: 'frameleaf',
      openOptionsPage: vi.fn(),
      getURL: (path: string) => `chrome-extension://frameleaf/${path}`,
      onMessage: event(),
      onInstalled: event(),
      onStartup: event(),
    },
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
    permissions: { contains, onRemoved: event() },
    tabs: {
      create: vi.fn(),
      query: vi.fn(async () => [tab]),
      onUpdated: event(),
      onRemoved: event(),
    },
    scripting: { executeScript: vi.fn() },
    cookies: {
      getAll: cookies,
      getAllCookieStores: vi.fn().mockResolvedValue([{ id: '0', tabIds: [7] }]),
    },
    webRequest: {
      onBeforeRequest: { addListener: vi.fn(), removeListener: vi.fn() },
    },
    contextMenus: {
      removeAll: vi.fn((callback) => callback?.()),
      create: vi.fn(),
      onClicked: event(),
    },
    alarms: { create: vi.fn().mockResolvedValue(undefined), onAlarm: event() },
  });
  media = {
    'GET /api/media-imports/capabilities': () =>
      json({
        version: 1,
        available: true,
        reason: null,
        authentication: ['cookies', 'credentials', 'token'],
      }),
    'GET /api/media-connections': () => json({ connections }),
    'POST /api/media-imports/inspect': () => json(operation()),
    'POST /api/media-subscriptions/preview': () => json(operation()),
    [`GET /api/media-imports/${INSPECTION}`]: () => json(operation('ready')),
    'POST /api/media-connections': () => json(connected, 201),
  };
  fetchMock = vi.fn(async (url: string, init?: RequestInit) => {
    const path = new URL(url).pathname;
    if (path === '/api/capture/capabilities')
      return json({
        version: 1,
        captureSupported: true,
        serverId: binding.serverId,
        userId: binding.userId,
        maxFileBytes: 104857600,
      });
    const answer = media[`${init?.method ?? 'GET'} ${path}`];
    return answer ? answer(init) : json({ message: 'Not Found' }, 404);
  });
  vi.stubGlobal('fetch', fetchMock);
  ({ handleMessage } = await import('./background'));
});

describe('media downloads from the popup (FL-1427)', () => {
  it('is only for the popup, and only while signed in', async () => {
    signedIn('media');
    await expect(
      handleMessage({ type: 'media-inspect', mode: 'page' }, options),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
    values = {};
    await expect(
      handleMessage({ type: 'media-inspect', mode: 'page' }, popup),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
    expect(mediaCalls()).toEqual([]);
  });

  it('an access that can only save is asked to allow media first, and nothing is sent', async () => {
    signedIn('capture');
    for (const request of [
      { type: 'media-inspect', mode: 'page' },
      { type: 'media-find' },
      { type: 'media-site' },
      { type: 'media-connect' },
      {
        type: 'media-download',
        label: 'A clip',
        inspectionId: INSPECTION,
        itemIds: [ITEM],
        albumId: ALBUM,
        tagIds: [],
        overrideSuppression: false,
      },
    ])
      await expect(handleMessage(request, popup)).resolves.toEqual(
        expect.objectContaining({ ok: false, mediaProblem: 'grant' }),
      );
    expect(fetchMock).not.toHaveBeenCalled();
    expect(cookies).not.toHaveBeenCalled();
    // an access from before grants existed is the same
    signedIn();
    await expect(handleMessage({ type: 'media-find' }, popup)).resolves.toEqual(
      expect.objectContaining({ mediaProblem: 'grant' }),
    );
    // it can still see whether the Library has media downloads at all, and is still signed in
    await expect(
      handleMessage({ type: 'media-state' }, popup),
    ).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        media: expect.objectContaining({
          granted: false,
          capability: { available: true, cookies: true },
        }),
        connection: expect.objectContaining({ status: 'connected' }),
      }),
    );
  });

  it('a Library from before media downloads says so, and stays signed in for saving', async () => {
    signedIn('capture');
    media = {};

    const reply = await handleMessage({ type: 'media-state' }, popup);

    expect(reply).toEqual(
      expect.objectContaining({
        ok: false,
        mediaProblem: 'unsupported',
        connection: expect.objectContaining({ status: 'connected' }),
      }),
    );
    await expect(handleMessage({ type: 'status' }, popup)).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        connection: expect.objectContaining({ status: 'connected' }),
      }),
    );
  });

  it('Retry after a certificate problem makes a real request every time', async () => {
    signedIn('media');
    fetchMock.mockRejectedValue(new TypeError('Failed to fetch'));

    for (let attempt = 1; attempt <= 2; attempt++) {
      await expect(
        handleMessage({ type: 'media-check' }, popup),
      ).resolves.toEqual(
        expect.objectContaining({ ok: false, mediaProblem: 'unreachable' }),
      );
      // each press reached for the Library's own address again; no answer was remembered
      expect(fetchMock).toHaveBeenCalledTimes(attempt);
    }
    expect(String(fetchMock.mock.calls[0][0])).toBe(
      'https://photos.example/api/capture/capabilities',
    );
    // and nothing was saved that could make a later request skip the check
    expect(Object.keys(values)).toEqual(['frameleafConnectionV1']);

    // once the browser trusts the certificate, the same press goes through
    fetchMock.mockReset();
    fetchMock.mockImplementation(async (url: string) =>
      new URL(url).pathname === '/api/capture/capabilities'
        ? json({
            version: 1,
            captureSupported: true,
            serverId: binding.serverId,
            userId: binding.userId,
            maxFileBytes: 1,
          })
        : media['GET /api/media-imports/capabilities'](),
    );
    await expect(
      handleMessage({ type: 'media-check' }, popup),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    expect(fetchMock).toHaveBeenCalledTimes(2);
  });

  it('Download this page asks the Library about this tab’s address only', async () => {
    signedIn('media');

    const reply = await handleMessage(
      { type: 'media-inspect', mode: 'page' },
      popup,
    );

    expect(reply).toEqual(
      expect.objectContaining({
        ok: true,
        media: expect.objectContaining({
          operation: expect.objectContaining({ id: INSPECTION }),
        }),
      }),
    );
    const sent = mediaCalls().find((call) => call.method === 'POST')!;
    expect(sent.path).toBe('/api/media-imports/inspect');
    expect(JSON.parse(String(sent.body))).toEqual({
      urls: ['https://www.video.example/watch?v=1'],
    });
    // the page itself was not read
    expect(chrome.scripting.executeScript).not.toHaveBeenCalled();
    expect(cookies).not.toHaveBeenCalled();
  });

  it('uses a connected site only for addresses on that site’s own domains', async () => {
    signedIn('media');
    connections = [connected];
    await handleMessage({ type: 'media-inspect', mode: 'page' }, popup);
    await handleMessage(
      {
        type: 'media-inspect',
        mode: 'found',
        urls: ['https://cdn.elsewhere.example/v/master.m3u8'],
      },
      popup,
    );

    const bodies = mediaCalls()
      .filter((call) => call.method === 'POST')
      .map((call) => JSON.parse(String(call.body)));
    expect(bodies).toEqual([
      {
        urls: ['https://www.video.example/watch?v=1'],
        connectionId: CONNECTION,
      },
      { urls: ['https://cdn.elsewhere.example/v/master.m3u8'] },
    ]);
  });

  it('Find media sends only what was ticked, and refuses anything that is not a web address', async () => {
    signedIn('media');
    await expect(
      handleMessage(
        {
          type: 'media-inspect',
          mode: 'found',
          urls: ['file:///etc/passwd', 'blob:https://x.example/1'],
        },
        popup,
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
    expect(mediaCalls().some((call) => call.method === 'POST')).toBe(false);
  });

  it('lists what the page plays without watching, and watches only once the browser allowed it', async () => {
    signedIn('media');
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([
      {
        frameId: 0,
        documentId: 'doc',
        result: {
          documentUrl: tab.url,
          urls: [
            { url: 'https://cdn.example/v/master.m3u8', hint: 'other' },
            { url: 'https://cdn.example/v/seg-1.ts', hint: 'other' },
            { url: 'https://www.video.example/app.js', hint: 'other' },
          ],
        },
      },
    ] as never);
    // the page's own site is allowed; its media host and watching are not
    contains.mockImplementation(
      async (wanted: chrome.permissions.Permissions) =>
        !wanted.permissions?.length &&
        !wanted.origins?.some((origin) => origin.includes('cdn.example')),
    );

    const found = await handleMessage({ type: 'media-find' }, popup);
    expect(found).toEqual(
      expect.objectContaining({
        ok: true,
        media: {
          found: {
            items: [expect.objectContaining({ kind: 'stream', parts: 1 })],
            watching: false,
            origin: 'https://www.video.example',
            hosts: ['https://cdn.example'],
          },
        },
      }),
    );
    // looking at the page does not start listening to anything
    expect(
      chrome.webRequest.onBeforeRequest.addListener,
    ).not.toHaveBeenCalled();

    // pressing Watch after the browser said no starts nothing
    await expect(
      handleMessage({ type: 'media-watch' }, popup),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
    expect(contains).toHaveBeenCalledWith({
      permissions: ['webRequest'],
      origins: ['https://www.video.example/*'],
    });

    // allowed: this tab is watched, and a request it makes is listed until it navigates
    contains.mockResolvedValue(true);
    await expect(
      handleMessage({ type: 'media-watch' }, popup),
    ).resolves.toEqual(
      expect.objectContaining({
        media: { found: expect.objectContaining({ watching: true }) },
      }),
    );
    const [seen] = vi.mocked(chrome.webRequest.onBeforeRequest.addListener).mock
      .calls[0] as unknown as [(details: object) => void];
    seen({ tabId: 7, type: 'media', url: 'https://cdn.example/extra.mp4' });
    seen({ tabId: 8, type: 'media', url: 'https://cdn.example/other-tab.mp4' });
    const names = async () =>
      (
        (await handleMessage({ type: 'media-find' }, popup)) as {
          media: { found: { items: { name: string }[] } };
        }
      ).media.found.items.map((item) => item.name);
    expect(await names()).toEqual(['master.m3u8', 'extra.mp4']);

    seen({ tabId: 7, type: 'main_frame', url: tab.url });
    expect(await names()).toEqual(['master.m3u8']);

    // closing the watched tab stops listening altogether
    const [closed] = vi.mocked(chrome.tabs.onRemoved.addListener).mock
      .calls[0] as unknown as [(tabId: number) => void];
    closed(8);
    expect(
      chrome.webRequest.onBeforeRequest.removeListener,
    ).not.toHaveBeenCalled();
    closed(7);
    expect(
      chrome.webRequest.onBeforeRequest.removeListener,
    ).toHaveBeenCalledWith(seen);
  });

  it('refuses what a page says about a different page', async () => {
    signedIn('media');
    vi.mocked(chrome.scripting.executeScript).mockResolvedValue([
      {
        frameId: 0,
        documentId: 'doc',
        result: { documentUrl: 'https://elsewhere.example/', urls: [] },
      },
    ] as never);
    await expect(handleMessage({ type: 'media-find' }, popup)).resolves.toEqual(
      expect.objectContaining({ ok: false }),
    );
  });

  it('Connect this site reads nothing until the browser allowed it for that site', async () => {
    signedIn('media');
    contains.mockImplementation(
      async (wanted: chrome.permissions.Permissions) =>
        !wanted.permissions?.includes('cookies'),
    );

    await expect(handleMessage({ type: 'media-site' }, popup)).resolves.toEqual(
      expect.objectContaining({
        ok: true,
        media: {
          site: {
            host: 'video.example',
            origins: ['https://www.video.example'],
            allowed: false,
          },
        },
      }),
    );
    await expect(
      handleMessage({ type: 'media-connect' }, popup),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));

    expect(contains).toHaveBeenCalledWith({
      permissions: ['cookies'],
      origins: ['https://www.video.example/*'],
    });
    expect(cookies).not.toHaveBeenCalled();
    expect(mediaCalls().some((call) => call.method === 'POST')).toBe(false);
  });

  it('shows the domains first, then sends the sign-in straight to the Library and keeps no copy', async () => {
    signedIn('media');
    const shown = await handleMessage({ type: 'media-site' }, popup);
    expect(shown).toEqual(
      expect.objectContaining({
        media: {
          site: expect.objectContaining({
            allowed: true,
            domains: ['video.example'],
            count: 1,
          }),
        },
      }),
    );
    // what the popup is shown never includes the sign-in itself
    expect(JSON.stringify(shown)).not.toContain('cookie-secret-value');
    expect(mediaCalls().some((call) => call.method === 'POST')).toBe(false);

    const reply = await handleMessage({ type: 'media-connect' }, popup);

    expect(reply).toEqual(
      expect.objectContaining({
        ok: true,
        media: {
          site: expect.objectContaining({
            connection: expect.objectContaining({ id: CONNECTION }),
          }),
        },
      }),
    );
    expect(cookies).toHaveBeenLastCalledWith({
      url: 'https://www.video.example/',
      storeId: '0',
    });
    const sent = fetchMock.mock.calls.find(
      ([url, init]) =>
        String(url).endsWith('/api/media-connections') &&
        (init as RequestInit).method === 'POST',
    )!;
    expect(String(sent[0])).toBe(
      'https://photos.example/api/media-connections',
    );
    expect(JSON.parse(String((sent[1] as RequestInit).body))).toEqual({
      provider: 'video.example',
      label: 'video.example',
      session: {
        domains: ['video.example'],
        cookies: [
          {
            name: 'session',
            value: 'cookie-secret-value',
            domain: '.video.example',
            path: '/',
            secure: true,
            httpOnly: true,
            hostOnly: false,
            expires: 1_900_000_000,
            storeId: '0',
          },
        ],
      },
    });
    // nowhere else: not the reply, not extension storage, not the saving list
    expect(JSON.stringify(reply)).not.toContain('cookie-secret-value');
    expect(JSON.stringify(values)).not.toContain('cookie-secret-value');
    const queue = await import('./media-queue');
    expect(await queue.listMediaReceipts(binding)).toEqual([]);
    expect(chrome.storage.local.set).not.toHaveBeenCalled();
  });

  it('refreshes only the connection that is for this site', async () => {
    signedIn('media');
    connections = [connected];
    await expect(
      handleMessage(
        {
          type: 'media-connect',
          connectionId: '0190a000-0000-7000-8000-0000000000dd',
        },
        popup,
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
    expect(mediaCalls().some((call) => call.method === 'POST')).toBe(false);

    media[`POST /api/media-connections/${CONNECTION}/refresh`] = () =>
      json({ ...connected, revision: 2 });
    await expect(
      handleMessage({ type: 'media-connect', connectionId: CONNECTION }, popup),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
  });

  it('keeps a download as a receipt, wakes the saving list and shows it there', async () => {
    signedIn('media');

    const reply = await handleMessage(
      {
        type: 'media-download',
        label: 'A clip',
        inspectionId: INSPECTION,
        itemIds: [ITEM],
        albumId: ALBUM,
        tagIds: [],
        overrideSuppression: false,
      },
      popup,
    );

    expect(reply).toEqual(expect.objectContaining({ ok: true }));
    expect(wakeDelivery).toHaveBeenCalled();
    // the Library is asked by the saving list, with the receipt's key, not from the popup's request
    expect(mediaCalls()).toEqual([]);
    const list = await handleMessage({ type: 'queue' }, popup);
    expect(list).toEqual(
      expect.objectContaining({
        ok: true,
        queue: expect.objectContaining({
          unfinished: 1,
          items: [
            expect.objectContaining({
              kind: 'media',
              label: 'A clip',
              state: 'queued',
              detail: 'Sending to your Library',
              canCancel: true,
            }),
          ],
        }),
      }),
    );
    const { id } = (list as unknown as { queue: { items: { id: string }[] } })
      .queue.items[0];
    await expect(
      handleMessage({ type: 'cancel-capture', id }, popup),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    const after = await handleMessage({ type: 'queue' }, popup);
    expect(
      (after as unknown as { queue: { items: object[] } }).queue.items[0],
    ).toEqual(expect.objectContaining({ cancelling: true, canCancel: false }));
  });

  it('a subscription needs the history you chose', async () => {
    signedIn('media');
    await expect(
      handleMessage(
        {
          type: 'media-subscribe',
          label: 'Someone',
          inspectionId: INSPECTION,
          intervalMinutes: 60,
        },
        popup,
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: false }));
    await expect(
      handleMessage(
        {
          type: 'media-subscribe',
          label: 'Someone',
          inspectionId: INSPECTION,
          history: { mode: 'new' },
          intervalMinutes: 60,
        },
        popup,
      ),
    ).resolves.toEqual(expect.objectContaining({ ok: true }));
    const list = await handleMessage({ type: 'queue' }, popup);
    expect(
      (list as unknown as { queue: { items: object[] } }).queue.items,
    ).toEqual([expect.objectContaining({ kind: 'subscription' })]);
  });
});
