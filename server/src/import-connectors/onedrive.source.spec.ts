import { text } from 'node:stream/consumers';
import { BrokerAccessToken } from 'src/import-connectors/broker-sign-in.js';
import {
  OneDriveSource,
  isOneDriveDownloadUrl,
  onedriveAlbumHint,
  onedriveRemoteSourceProvider,
  onedriveRoots,
} from 'src/import-connectors/onedrive.source.js';
import { forgetProviderPauses, retryAfterMs } from 'src/import-connectors/provider-http.js';
import { type RemoteItem, RemoteSourceAuthError, RemoteSourceError } from 'src/import-connectors/remote-source.js';
import { TakeoutStagingError } from 'src/repositories/takeout-staging.repository.js';

/** Every Graph answer here is a hand-written fixture shaped from Microsoft's documentation, not a recording. */
const GRAPH = 'https://graph.microsoft.com/v1.0/me/drive';
const DOWNLOAD = 'https://public.dm.files.1drv.com/y4m-signed';

type Call = { url: string; headers: Record<string, string>; redirect?: string; method?: string };
type Handler = (call: Call) => Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });

const rootItem = { id: 'root', name: 'root', root: {}, folder: {} };
const folder = (id: string, name: string, parent = 'root', extra: Record<string, unknown> = {}) => ({
  id,
  name,
  folder: {},
  parentReference: { id: parent },
  ...extra,
});
const file = (id: string, name: string, parent: string, extra: Record<string, unknown> = {}) => ({
  id,
  name,
  size: 10,
  file: { hashes: { quickXorHash: `hash-${id}` } },
  parentReference: { id: parent },
  fileSystemInfo: { lastModifiedDateTime: '2024-06-01T10:00:00Z' },
  ...extra,
});
const noCameraRoll: Handler = () => json({ error: { code: 'accessDenied' } }, 403);
const delta = (value: unknown[], link = `${GRAPH}/root/delta?token=next`) => json({ value, '@odata.deltaLink': link });

const setup = (...queue: Handler[]) => {
  const calls: Call[] = [];
  const waits: number[] = [];
  let clock = 1_000_000;
  const http = (url: string, init: RequestInit) => {
    calls.push({
      url,
      headers: init.headers as Record<string, string>,
      redirect: init.redirect,
      method: init.method,
    });
    const next = queue.shift();
    if (!next) {
      throw new Error(`unexpected request to ${url}`);
    }
    return Promise.resolve(next(calls.at(-1)!));
  };
  const options = {
    http,
    now: () => clock,
    wait: (ms: number) => {
      waits.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  };
  const tokens = { get: vi.fn((refused?: string) => Promise.resolve(refused ? 'token-2' : 'token-1')) };
  return { calls, waits, tokens, http, source: new OneDriveSource(tokens, 'drive-1', options) };
};

const collect = async (source: OneDriveSource, roots: string[], cursor: Record<string, unknown> | null = null) => {
  const items: RemoteItem[] = [];
  let last: unknown;
  for await (const batch of source.scan(roots, cursor, new AbortController().signal)) {
    items.push(...batch.items);
    if (batch.cursor !== undefined) {
      last = batch.cursor;
    }
  }
  return { items, cursor: last as { version: number; deltaLink: string; roots: string[] } };
};

describe('OneDrive source', () => {
  const signal = new AbortController().signal;

  beforeEach(() => forgetProviderPauses());

  it('keeps Camera Roll in the timeline and makes other folders albums', () => {
    expect(onedriveAlbumHint('Pictures/Camera Roll/a.jpg')).toBeNull();
    expect(onedriveAlbumHint('camera roll/2024/a.jpg')).toBeNull();
    expect(onedriveAlbumHint('a.jpg')).toBeNull();
    expect(onedriveAlbumHint('Pictures/Spain/a.jpg')).toBe('Pictures/Spain');
  });

  it('drops a chosen folder another chosen folder covers', () => {
    expect(onedriveRoots(['Trips', 'trips/Spain', '/Family/'])).toEqual(['Trips', 'Family']);
    expect(onedriveRoots([])).toEqual(['']);
  });

  it('accepts only the documented download hosts, over https', () => {
    expect(isOneDriveDownloadUrl(DOWNLOAD)).toBe(true);
    expect(isOneDriveDownloadUrl('https://contoso-my.sharepoint.com/personal/a/download.aspx')).toBe(true);
    for (const bad of [
      // eslint-disable-next-line unicorn/prefer-https -- the plain-http address is what is being refused
      'http://public.dm.files.1drv.com/x',
      'https://files.1drv.com.example.org/x',
      'https://evilsharepoint.com/x',
      'https://user@contoso.sharepoint.com/x',
      'https://contoso.sharepoint.com:8443/x',
      'https://my.microsoftpersonalcontent.com/x',
      'https://169.254.169.254/x',
      undefined,
    ]) {
      expect(isOneDriveDownloadUrl(bad)).toBe(false);
    }
  });

  it('pages through delta and keeps only photos and videos under a chosen folder', async () => {
    const { source, calls } = setup(
      () => json({ id: 'trips' }),
      noCameraRoll,
      () =>
        json({
          value: [
            rootItem,
            folder('trips', 'Trips'),
            folder('other', 'Other'),
            file('a', 'a.jpg', 'trips'),
            file('notes', 'notes.txt', 'trips'),
            file('virus', 'virus.jpg', 'trips', { malware: {} }),
            file('shared', 'shared.jpg', 'trips', { remoteItem: { id: 'x' } }),
            file('note', 'book.jpg', 'trips', { package: { type: 'oneNote' } }),
            { id: 'gone', name: 'gone.jpg', deleted: {}, parentReference: { id: 'trips' } },
            file('outside', 'outside.jpg', 'other'),
          ],
          '@odata.nextLink': `${GRAPH}/root/delta?token=page2`,
        }),
      () => delta([file('b', 'b.mp4', 'trips')]),
    );
    const { items, cursor } = await collect(source, ['Trips']);
    expect(items.map((item) => [item.remoteId, item.path, item.albumHint])).toEqual([
      ['a', 'Trips/a.jpg', 'Trips'],
      ['b', 'Trips/b.mp4', 'Trips'],
    ]);
    expect(items[0].contentHash).toBe('hash-a');
    expect(cursor).toEqual({ version: 1, deltaLink: `${GRAPH}/root/delta?token=next`, roots: ['Trips'] });
    expect(calls.every((call) => call.method === 'GET' && call.redirect === 'manual')).toBe(true);
    expect(calls[3].url).toBe(`${GRAPH}/root/delta?token=page2`);
  });

  it('a re-scan reads from the delta link and offers only what it returns', async () => {
    const { source, calls } = setup(
      () => json({ id: 'trips' }),
      noCameraRoll,
      () => delta([rootItem, folder('trips', 'Trips'), file('new', 'new.jpg', 'trips')], `${GRAPH}/root/delta?token=3`),
    );
    const { items, cursor } = await collect(source, ['Trips'], {
      version: 1,
      deltaLink: `${GRAPH}/root/delta?token=2`,
      roots: ['Trips'],
    });
    expect(items.map((item) => item.remoteId)).toEqual(['new']);
    expect(calls[2].url).toBe(`${GRAPH}/root/delta?token=2`);
    expect(cursor.deltaLink).toBe(`${GRAPH}/root/delta?token=3`);
  });

  it('lists everything again when a folder was added since the last scan', async () => {
    const { source, calls } = setup(
      () => json({ id: 'family' }),
      noCameraRoll,
      () => delta([rootItem]),
    );
    await collect(source, ['Family'], { version: 1, deltaLink: `${GRAPH}/root/delta?token=2`, roots: ['Trips'] });
    expect(calls[2].url).toContain('/root/delta?$select=');
  });

  it('never follows a saved or returned link off Graph', async () => {
    const stored = setup(noCameraRoll, () => delta([rootItem]));
    await collect(stored.source, [], { version: 1, deltaLink: 'https://evil.example/delta', roots: [''] });
    expect(stored.calls[1].url).toContain('https://graph.microsoft.com/');

    const returned = setup(noCameraRoll, () => json({ value: [], '@odata.nextLink': 'https://evil.example/next' }));
    await expect(collect(returned.source, [])).rejects.toThrow('could not be read');
    expect(returned.calls).toHaveLength(2);
  });

  it('starts over when Graph says the delta token has expired', async () => {
    const { source, calls } = setup(
      noCameraRoll,
      () => json({ error: { code: 'resyncChangesApplyDifferences' } }, 410, { location: 'https://evil.example/x' }),
      () => delta([rootItem, file('a', 'a.jpg', 'root')]),
    );
    const { items } = await collect(source, [], {
      version: 1,
      deltaLink: `${GRAPH}/root/delta?token=old`,
      roots: [''],
    });
    expect(items).toHaveLength(1);
    expect(calls[2].url).toContain('/root/delta?$select=');
  });

  it('asks for a parent delta did not include, and uses the Camera Roll id whatever its name', async () => {
    const { source, calls } = setup(
      () => json({ id: 'roll' }),
      () => delta([file('p', 'p.jpg', 'roll')]),
      () => json(folder('roll', 'Álbum de cámara', 'pics')),
      () => json(folder('pics', 'Imágenes', 'root')),
      () => json(rootItem),
    );
    const { items } = await collect(source, []);
    expect(items[0].path).toBe('Imágenes/Álbum de cámara/p.jpg');
    expect(items[0].albumHint).toBeNull();
    expect(calls).toHaveLength(5);
  });

  it("uses OneDrive's taken date as the file date, which only applies when the file has none", async () => {
    const { source } = setup(noCameraRoll, () =>
      delta([
        rootItem,
        file('taken', 'taken.jpg', 'root', { photo: { takenDateTime: '2019-03-04T05:06:07Z' } }),
        file('plain', 'plain.jpg', 'root'),
      ]),
    );
    const { items } = await collect(source, []);
    expect(items[0].modifiedAt).toEqual(new Date('2019-03-04T05:06:07Z'));
    expect(items[1].modifiedAt).toEqual(new Date('2024-06-01T10:00:00Z'));
  });

  it('says so when every chosen folder has gone, rather than finding nothing', async () => {
    const { source } = setup(() => json({}, 404));
    await expect(collect(source, ['Gone'])).rejects.toThrow('no longer in OneDrive');
  });

  it('renews a refused token once and repeats the request', async () => {
    const { source, calls, tokens } = setup(
      () => json({}, 401),
      noCameraRoll,
      () => delta([rootItem]),
    );
    await collect(source, []);
    expect(tokens.get).toHaveBeenCalledWith('token-1');
    expect(calls[0].headers.Authorization).toBe('Bearer token-1');
    expect(calls[1].headers.Authorization).toBe('Bearer token-2');
  });

  it('asks for a new sign-in when the renewed token is refused too', async () => {
    const { source, calls } = setup(
      () => json({}, 401),
      () => json({}, 401),
    );
    await expect(collect(source, [])).rejects.toBeInstanceOf(RemoteSourceAuthError);
    expect(calls).toHaveLength(2);
  });

  it.each([429, 503])('waits for Retry-After on a %i', async (status) => {
    const { source, calls, waits } = setup(
      noCameraRoll,
      () => json({}, status, { 'retry-after': '7' }),
      () => delta([rootItem]),
    );
    await collect(source, []);
    expect(waits).toEqual([7000]);
    expect(calls).toHaveLength(3);
  });

  it('reads Retry-After as seconds or as a date', () => {
    expect(retryAfterMs('12', 0)).toBe(12_000);
    expect(retryAfterMs('Thu, 01 Jan 1970 00:00:30 GMT', 10_000)).toBe(20_000);
    expect(retryAfterMs('soon', 0)).toBeUndefined();
    expect(retryAfterMs(null, 0)).toBeUndefined();
  });

  it('makes every source of the account wait out a long rate limit, without a request', async () => {
    const first = setup(() => json({}, 429, { 'retry-after': '100000' }));
    await expect(collect(first.source, [])).rejects.toThrow('slow down');
    const second = setup();
    await expect(collect(second.source, [])).rejects.toThrow('slow down');
    expect(second.calls).toHaveLength(0);
  });

  it('gives up after a bounded number of rate-limited tries', async () => {
    const limited = () => json({}, 429, { 'retry-after': '1' });
    const { source, calls } = setup(limited, limited, limited, limited, limited, limited);
    await expect(collect(source, [])).rejects.toBeInstanceOf(RemoteSourceError);
    expect(calls).toHaveLength(6);
  });

  it('never passes on what Graph said in an error', async () => {
    const { source } = setup(noCameraRoll, () => json({ error: { message: 'secret detail' } }, 400));
    await expect(collect(source, [])).rejects.toThrow('OneDrive would not list this folder');
  });

  it('lists the folders inside a folder, without files, shared items or notebooks', async () => {
    const { source, calls } = setup(() =>
      json({
        value: [
          folder('z', 'Zoo', 'p'),
          folder('a', 'Art', 'p'),
          file('f', 'f.jpg', 'p'),
          folder('s', 'Shared', 'p', { remoteItem: { id: 'r' } }),
          folder('n', 'Notes', 'p', { package: { type: 'oneNote' } }),
        ],
      }),
    );
    await expect(source.listFolders('My Pics')).resolves.toEqual([
      { path: 'My Pics/Art', name: 'Art' },
      { path: 'My Pics/Zoo', name: 'Zoo' },
    ]);
    expect(calls[0].url).toContain('/root:/My%20Pics:/children');
  });

  describe('open', () => {
    const meta = (extra: Record<string, unknown> = {}) =>
      json({
        id: 'a',
        size: 10,
        file: { hashes: { quickXorHash: 'hash' } },
        '@microsoft.graph.downloadUrl': DOWNLOAD,
        ...extra,
      });

    it('sends the token to Graph and never to the download host', async () => {
      const { source, calls } = setup(
        () => meta(),
        () => new Response('whole file'),
      );
      await expect(text(await source.open('a', { start: 0 }, signal))).resolves.toBe('whole file');
      expect(calls[0].headers.Authorization).toBe('Bearer token-1');
      expect(calls[1].url).toBe(DOWNLOAD);
      expect(calls[1].headers.Authorization).toBeUndefined();
      expect(calls[1].redirect).toBe('manual');
    });

    it('refuses a download address on any other host, without a request to it', async () => {
      const { source, calls } = setup(() => meta({ '@microsoft.graph.downloadUrl': 'https://evil.example/file' }));
      await expect(source.open('a', { start: 0 }, signal)).rejects.toThrow('does not trust');
      expect(calls).toHaveLength(1);
    });

    it('does not follow a redirect from the download host', async () => {
      const { source, calls } = setup(
        () => meta(),
        () => new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } }),
      );
      await expect(source.open('a', { start: 0 }, signal)).rejects.toThrow('would not hand over');
      expect(calls).toHaveLength(2);
    });

    it('resumes with a Range when the file is the version the scan saw', async () => {
      const { source, calls } = setup(
        () => meta(),
        () => new Response('rest', { status: 206, headers: { 'content-range': 'bytes 6-9/10' } }),
      );
      await expect(text(await source.open('a', { start: 6, contentHash: 'hash' }, signal))).resolves.toBe('rest');
      expect(calls[1].headers.Range).toBe('bytes=6-');
    });

    it('restarts rather than splice a file that changed', async () => {
      const { source, calls } = setup(() => meta({ file: { hashes: { quickXorHash: 'other' } } }));
      await expect(source.open('a', { start: 6, contentHash: 'hash' }, signal)).rejects.toBeInstanceOf(
        TakeoutStagingError,
      );
      expect(calls).toHaveLength(1);
    });

    it.each([
      ['a whole file instead of the range', 200, {}],
      ['a range from elsewhere', 206, { 'content-range': 'bytes 0-9/10' }],
      ['a file of another size', 206, { 'content-range': 'bytes 6-19/20' }],
    ])('refuses to join %s onto a partial download', async (_name, status, headers) => {
      const { source } = setup(
        () => meta(),
        () => new Response('bytes', { status, headers }),
      );
      await expect(source.open('a', { start: 6, contentHash: 'hash' }, signal)).rejects.toBeInstanceOf(
        TakeoutStagingError,
      );
    });

    it('asks for a fresh address once when the first has run out', async () => {
      const { source, calls } = setup(
        () => meta(),
        () => new Response(null, { status: 403 }),
        () => meta(),
        () => new Response('file'),
      );
      await expect(text(await source.open('a', { start: 0 }, signal))).resolves.toBe('file');
      expect(calls).toHaveLength(4);
    });

    it('says when the file is gone', async () => {
      const { source } = setup(() => json({}, 404));
      await expect(source.open('a', { start: 0 }, signal)).rejects.toThrow('no longer in OneDrive');
    });
  });

  describe('provider', () => {
    const broker = {
      target: vi.fn().mockResolvedValue({ api: 'https://api.example', token: 'dpop' }),
      refresh: vi.fn(),
    };

    it('refuses typed-in credentials', () => {
      expect(() => onedriveRemoteSourceProvider(broker).credentials({ refreshToken: 'x' })).toThrow('signing in');
    });

    it('signs in through the Microsoft files service and names the account from the drive', async () => {
      const { http, calls } = setup(() => json({ id: 'drive-1', owner: { user: { displayName: 'Sam' } } }));
      const provider = onedriveRemoteSourceProvider(broker, { http });
      expect(provider.signIn!.service).toBe('microsoft-files');
      await expect(provider.signIn!.account('access')).resolves.toEqual({ id: 'drive-1', name: 'Sam' });
      expect(calls[0].url).toBe(`${GRAPH}?$select=id,owner`);
    });

    it('saves a rotated refresh token through the session', async () => {
      broker.refresh.mockResolvedValue({ accessToken: 'access', expiresInSec: 3600, refreshToken: 'rotated' });
      let saved: Record<string, unknown> | null = null;
      const session = {
        renewCredentials: async (
          renew: (current: Record<string, unknown>) => Promise<Record<string, unknown> | null>,
        ) => {
          saved = await renew({ refreshToken: 'old', accountId: 'drive-1' });
        },
      };
      await expect(new BrokerAccessToken(broker, 'microsoft-files', session).get()).resolves.toBe('access');
      expect(broker.refresh).toHaveBeenCalledWith('microsoft-files', 'old', expect.anything());
      expect(saved).toEqual({ refreshToken: 'rotated', accountId: 'drive-1' });
    });

    it('needs a readable sign-in to open', () => {
      const provider = onedriveRemoteSourceProvider(broker);
      expect(() => provider.open({}, { renewCredentials: vi.fn() })).toThrow(RemoteSourceAuthError);
    });
  });
});
