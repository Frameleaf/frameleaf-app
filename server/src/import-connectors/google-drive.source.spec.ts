import { text } from 'node:stream/consumers';
import { BrokerAccessToken } from 'src/import-connectors/broker-sign-in.js';
import {
  GoogleDriveSource,
  NOTHING_VISIBLE,
  googleDriveRemoteSourceProvider,
  googleDriveRoots,
  isDriveId,
} from 'src/import-connectors/google-drive.source.js';
import { forgetProviderPauses } from 'src/import-connectors/provider-http.js';
import { type RemoteItem, RemoteSourceAuthError, RemoteSourceError } from 'src/import-connectors/remote-source.js';
import { TakeoutStagingError } from 'src/repositories/takeout-staging.repository.js';

/** Every Drive answer here is a hand-written fixture shaped from Google's documentation, not a recording. */
const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';

type Call = { url: string; headers: Record<string, string>; redirect?: string; method?: string };
type Handler = (call: Call) => Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers });
const reason = (name: string, status = 403) => json({ error: { code: status, errors: [{ reason: name }] } }, status);

const folder = (id: string, name: string, parent?: string) => ({
  id,
  name,
  mimeType: FOLDER,
  ...(parent && { parents: [parent] }),
});
const file = (id: string, name: string, parent = 'trips', extra: Record<string, unknown> = {}) => ({
  id,
  name,
  mimeType: 'image/jpeg',
  size: '10',
  modifiedTime: '2024-06-01T10:00:00Z',
  md5Checksum: `md5-${id}`,
  parents: [parent],
  ...extra,
});
const listing = (files: unknown[], nextPageToken?: string) => json({ files, ...(nextPageToken && { nextPageToken }) });
const startToken = () => json({ startPageToken: 'start-1' });

const setup = (...queue: Handler[]) => {
  const calls: Call[] = [];
  const waits: number[] = [];
  let clock = 1_000_000;
  const http = (url: string, init: RequestInit) => {
    calls.push({ url, headers: init.headers as Record<string, string>, redirect: init.redirect, method: init.method });
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
  return { calls, waits, tokens, http, source: new GoogleDriveSource(tokens, 'perm-1', options) };
};

const collect = async (source: GoogleDriveSource, roots: string[], cursor: Record<string, unknown> | null = null) => {
  const items: RemoteItem[] = [];
  let last: unknown;
  for await (const batch of source.scan(roots, cursor, new AbortController().signal)) {
    items.push(...batch.items);
    if (batch.cursor !== undefined) {
      last = batch.cursor;
    }
  }
  return { items, cursor: last as { version: number; pageToken: string; roots: string[] } };
};
const query = (call: Call) => new URL(call.url).searchParams;

describe('Google Drive source', () => {
  const signal = new AbortController().signal;

  beforeEach(() => forgetProviderPauses());

  it('keeps only well-formed picked ids, each once', () => {
    expect(googleDriveRoots(['a_1-B', 'a_1-B', "x' or name='y", '../up'])).toEqual(['a_1-B']);
    expect(isDriveId("x' or '1'='1")).toBe(false);
  });

  it('walks a picked folder tree, pages, and makes albums per folder', async () => {
    const { source, calls } = setup(
      () => json(folder('trips', 'Trips')),
      startToken,
      () =>
        listing(
          [
            file('a', 'a.jpg'),
            file('doc', 'plan.jpg', 'trips', { mimeType: 'application/vnd.google-apps.document' }),
            file('notes', 'notes.txt', 'trips', { mimeType: 'text/plain' }),
            file('locked', 'locked.jpg', 'trips', { capabilities: { canDownload: false } }),
            folder('spain', 'Spain', 'trips'),
          ],
          'page-2',
        ),
      () => listing([file('b', 'b.mp4', 'spain', { mimeType: 'video/mp4' })]),
      () => listing([file('c', 'c.jpg')]),
    );
    const { items, cursor } = await collect(source, ['trips']);
    expect(items.map((item) => [item.remoteId, item.path, item.albumHint])).toEqual([
      ['a', 'Trips/a.jpg', 'Trips'],
      ['b', 'Trips/Spain/b.mp4', 'Trips/Spain'],
      ['c', 'Trips/c.jpg', 'Trips'],
    ]);
    expect(items[0].contentHash).toBe('md5-a');
    expect(cursor).toEqual({ version: 2, pageToken: 'start-1', roots: ['trips'] });
    expect(query(calls[2]).get('q')).toBe("'trips' in parents and trashed=false");
    expect(calls.every((call) => call.method === 'GET' && call.redirect === 'manual')).toBe(true);
    expect(calls.every((call) => call.url.startsWith(`${API}/`))).toBe(true);
  });

  it('takes the change position before listing, so nothing changed meanwhile is lost', async () => {
    const { source, calls } = setup(() => json(file('a', 'a.jpg')), startToken);
    await collect(source, ['a']);
    expect(calls[1].url).toContain('/changes/startPageToken');
  });

  it('imports a picked file on its own, in the timeline', async () => {
    const { source } = setup(() => json(file('a', 'a.jpg')), startToken);
    const { items } = await collect(source, ['a']);
    expect(items.map((item) => [item.path, item.albumHint])).toEqual([['a.jpg', null]]);
  });

  it('never asks about an id that was not picked or returned', async () => {
    const { source, calls } = setup(
      () => json(folder('trips', 'Trips')),
      startToken,
      () => listing([file('a', 'a.jpg')]),
    );
    await collect(source, ['trips', "bad' or 'x"]);
    expect(calls).toHaveLength(3);
    expect(calls.some((call) => decodeURIComponent(call.url).includes('bad'))).toBe(false);
  });

  it('says so when a picked folder shows nothing, rather than succeeding empty', async () => {
    const { source } = setup(
      () => json(folder('trips', 'Trips')),
      startToken,
      () => listing([]),
    );
    await expect(collect(source, ['trips'])).rejects.toThrow(NOTHING_VISIBLE);
  });

  it('stores no position when a picked folder shows nothing', async () => {
    const { source } = setup(
      () => json(folder('trips', 'Trips')),
      startToken,
      () => listing([]),
    );
    const cursors: unknown[] = [];
    await expect(
      (async () => {
        for await (const batch of source.scan(['trips'], null, signal)) {
          if (batch.cursor !== undefined) {
            cursors.push(batch.cursor);
          }
        }
      })(),
    ).rejects.toThrow(NOTHING_VISIBLE);
    expect(cursors).toEqual([]);
  });

  it('still imports from a folder that shows files when another shows none', async () => {
    const { source } = setup(
      () => json(folder('empty', 'Empty')),
      () => json(folder('trips', 'Trips')),
      startToken,
      () => listing([]),
      () => listing([file('a', 'a.jpg')]),
    );
    const { items } = await collect(source, ['empty', 'trips']);
    expect(items).toHaveLength(1);
  });

  it('says so when a picked shortcut to a folder shows nothing', async () => {
    const shortcut = file('link', 'Trips', 'top', {
      mimeType: 'application/vnd.google-apps.shortcut',
      shortcutDetails: { targetId: 'trips', targetMimeType: FOLDER },
    });
    const { source } = setup(
      () => json(shortcut),
      startToken,
      () => json(folder('trips', 'Trips')),
      () => listing([]),
    );
    await expect(collect(source, ['link'])).rejects.toThrow(NOTHING_VISIBLE);
  });

  it('says so when no picked item is visible any more', async () => {
    const { source } = setup(() => json({}, 404));
    await expect(collect(source, ['trips'])).rejects.toThrow('Pick them again');
  });

  it('asks for a pick first when there is none', async () => {
    const { source, calls } = setup();
    await expect(collect(source, [])).rejects.toThrow('picker');
    expect(calls).toHaveLength(0);
  });

  it('follows a shortcut only when the API shows its target', async () => {
    const { source } = setup(
      () => json(folder('trips', 'Trips')),
      startToken,
      () =>
        listing([
          file('link', 'seen.jpg', 'trips', {
            mimeType: 'application/vnd.google-apps.shortcut',
            shortcutDetails: { targetId: 'target', targetMimeType: 'image/jpeg' },
          }),
          file('hidden', 'hidden.jpg', 'trips', {
            mimeType: 'application/vnd.google-apps.shortcut',
            shortcutDetails: { targetId: 'nope', targetMimeType: 'image/jpeg' },
          }),
        ]),
      () => json(file('target', 'seen.jpg', 'elsewhere')),
      () => json({}, 404),
    );
    const { items } = await collect(source, ['trips']);
    expect(items.map((item) => item.remoteId)).toEqual(['target']);
  });

  it('a re-scan reads changes and offers only what changed under a picked folder', async () => {
    const { source, calls } = setup(
      () => json(folder('trips', 'Trips')),
      () =>
        json({
          changes: [
            { fileId: 'new', removed: false, file: file('new', 'new.jpg') },
            { fileId: 'gone', removed: true },
            { fileId: 'bin', removed: false, file: file('bin', 'bin.jpg', 'trips', { trashed: true }) },
            { fileId: 'out', removed: false, file: file('out', 'out.jpg', 'elsewhere') },
          ],
          newStartPageToken: 'token-3',
        }),
      () => json({}, 404),
    );
    const { items, cursor } = await collect(source, ['trips'], { version: 2, pageToken: 'token-2', roots: ['trips'] });
    expect(items.map((item) => [item.remoteId, item.path])).toEqual([['new', 'Trips/new.jpg']]);
    expect(query(calls[1]).get('pageToken')).toBe('token-2');
    expect(cursor.pageToken).toBe('token-3');
  });

  it('lists again when an item was picked since the last scan', async () => {
    const { source, calls } = setup(
      () => json(folder('family', 'Family')),
      startToken,
      () => listing([file('f', 'f.jpg', 'family')]),
    );
    await collect(source, ['family'], { version: 2, pageToken: 'token-2', roots: ['trips'] });
    expect(calls[1].url).toContain('/changes/startPageToken');
  });

  it('lists again when Google refuses the saved position', async () => {
    const { source, calls } = setup(
      () => json(folder('trips', 'Trips')),
      () => reason('invalid', 400),
      startToken,
      () => listing([file('a', 'a.jpg')]),
    );
    const { items, cursor } = await collect(source, ['trips'], { version: 2, pageToken: 'old', roots: ['trips'] });
    expect(items).toHaveLength(1);
    expect(cursor.pageToken).toBe('start-1');
    expect(calls).toHaveLength(4);
  });

  it('does not store a position from a partial answer', async () => {
    const { source } = setup(
      () => json(folder('trips', 'Trips')),
      startToken,
      () => json({ files: [file('a', 'a.jpg')], incompleteSearch: true }),
    );
    await expect(collect(source, ['trips'])).rejects.toThrow('could not be read');
  });

  it('renews a refused token once and repeats the request', async () => {
    const { source, calls, tokens } = setup(
      () => json({}, 401),
      () => json(file('a', 'a.jpg')),
      startToken,
    );
    await collect(source, ['a']);
    expect(tokens.get).toHaveBeenCalledWith('token-1');
    expect(calls[1].headers.Authorization).toBe('Bearer token-2');
  });

  it('asks for a new sign-in when the renewed token is refused too', async () => {
    const { source } = setup(
      () => json({}, 401),
      () => json({}, 401),
    );
    await expect(collect(source, ['a'])).rejects.toBeInstanceOf(RemoteSourceAuthError);
  });

  it('waits for Retry-After on a 429', async () => {
    const { source, waits } = setup(
      () => json({}, 429, { 'retry-after': '7' }),
      () => json(file('a', 'a.jpg')),
      startToken,
    );
    await collect(source, ['a']);
    expect(waits).toEqual([7000]);
  });

  it.each(['rateLimitExceeded', 'userRateLimitExceeded'])('backs off on a 403 %s', async (name) => {
    const { source, waits, calls } = setup(
      () => reason(name),
      () => json(file('a', 'a.jpg')),
      startToken,
    );
    await collect(source, ['a']);
    expect(waits).toEqual([2000]);
    expect(calls).toHaveLength(3);
  });

  it('does not retry the daily limit, and says what it is', async () => {
    const { source, calls } = setup(() => reason('dailyLimitExceeded'));
    await expect(collect(source, ['a'])).rejects.toThrow('daily limit');
    expect(calls).toHaveLength(1);
  });

  it('never passes on what Google said in an error', async () => {
    const { source } = setup(() => json({ error: { message: 'secret detail' } }, 400));
    await expect(collect(source, ['a'])).rejects.toThrow('Google Drive would not list this folder');
  });

  it('lists the folders the API shows, by id', async () => {
    const { source, calls } = setup(() => listing([folder('z', 'Zoo'), folder('a', 'Art')]));
    await expect(source.listFolders('')).resolves.toEqual([
      { path: 'a', name: 'Art' },
      { path: 'z', name: 'Zoo' },
    ]);
    expect(query(calls[0]).get('q')).toBe(`mimeType='${FOLDER}' and trashed=false`);
    await expect(source.listFolders("x' or '1'='1")).rejects.toBeInstanceOf(RemoteSourceError);
  });

  describe('open', () => {
    it('downloads from the API host with alt=media', async () => {
      const { source, calls } = setup(() => new Response('whole file'));
      await expect(text(await source.open('a', { start: 0 }, signal))).resolves.toBe('whole file');
      expect(calls[0].url).toBe(`${API}/files/a?alt=media`);
      expect(calls[0].redirect).toBe('manual');
    });

    it('does not follow a redirect, so the token never reaches another host', async () => {
      const { source, calls } = setup(
        () => new Response(null, { status: 302, headers: { location: 'https://evil.example/file' } }),
      );
      await expect(source.open('a', { start: 0 }, signal)).rejects.toThrow('would not hand over');
      expect(calls).toHaveLength(1);
    });

    it('resumes with a Range when the file is the version the scan saw', async () => {
      const { source, calls } = setup(
        () => json(file('a', 'a.jpg', 'trips', { md5Checksum: 'hash' })),
        () => new Response('rest', { status: 206, headers: { 'content-range': 'bytes 6-9/10' } }),
      );
      await expect(text(await source.open('a', { start: 6, contentHash: 'hash' }, signal))).resolves.toBe('rest');
      expect(calls[1].headers.Range).toBe('bytes=6-');
    });

    it('restarts rather than splice a file that changed', async () => {
      const { source, calls } = setup(() => json(file('a', 'a.jpg', 'trips', { md5Checksum: 'other' })));
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
        () => json(file('a', 'a.jpg', 'trips', { md5Checksum: 'hash' })),
        () => new Response('bytes', { status, headers }),
      );
      await expect(source.open('a', { start: 6, contentHash: 'hash' }, signal)).rejects.toBeInstanceOf(
        TakeoutStagingError,
      );
    });

    it('says when the file is gone', async () => {
      const { source } = setup(() => json({}, 404));
      await expect(source.open('a', { start: 0 }, signal)).rejects.toThrow('no longer in Google Drive');
    });

    it('refuses an id that is not a Drive id, without a request', async () => {
      const { source, calls } = setup();
      await expect(source.open('../about', { start: 0 }, signal)).rejects.toBeInstanceOf(RemoteSourceError);
      expect(calls).toHaveLength(0);
    });
  });

  describe('provider', () => {
    const broker = {
      target: vi.fn().mockResolvedValue({ api: 'https://api.example', token: 'dpop' }),
      refresh: vi.fn(),
      revoke: vi.fn().mockResolvedValue('revoked'),
    };

    it('refuses typed-in credentials', () => {
      expect(() => googleDriveRemoteSourceProvider(broker).credentials({ refreshToken: 'x' })).toThrow('signing in');
    });

    it('signs in through the google-drive service and names the account', async () => {
      const { http, calls } = setup(() => json({ user: { permissionId: 'perm-1', displayName: 'Sam' } }));
      const provider = googleDriveRemoteSourceProvider(broker, { http });
      expect(provider.signIn!.service).toBe('google-drive');
      await expect(provider.signIn!.account('access')).resolves.toEqual({ id: 'perm-1', name: 'Sam' });
      expect(calls[0].url).toContain(`${API}/about`);
    });

    it('offers the picker settings only when they are set', () => {
      expect(googleDriveRemoteSourceProvider(broker).signIn!.picker!()).toBeNull();
      const picker = { apiKey: 'browser-key', appId: '123' };
      expect(googleDriveRemoteSourceProvider(broker, { picker: () => picker }).signIn!.picker!()).toEqual(picker);
    });

    it('revokes through the broker', async () => {
      await googleDriveRemoteSourceProvider(broker).revoke!({ refreshToken: 'refresh' });
      expect(broker.revoke).toHaveBeenCalledWith('google-drive', 'refresh');
    });

    it('saves a rotated refresh token through the session', async () => {
      broker.refresh.mockResolvedValue({ accessToken: 'access', expiresInSec: 3600, refreshToken: 'rotated' });
      let saved: Record<string, unknown> | null = null;
      const session = {
        renewCredentials: async (
          renew: (current: Record<string, unknown>) => Promise<Record<string, unknown> | null>,
        ) => {
          saved = await renew({ refreshToken: 'old', accountId: 'perm-1' });
        },
      };
      await expect(new BrokerAccessToken(broker, 'google-drive', session).get()).resolves.toBe('access');
      expect(saved).toEqual({ refreshToken: 'rotated', accountId: 'perm-1' });
    });
  });
});
