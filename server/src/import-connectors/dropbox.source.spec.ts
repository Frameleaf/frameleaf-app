import { text } from 'node:stream/consumers';
import type { BrokerAccessToken } from 'src/import-connectors/broker-sign-in.js';
import {
  DropboxSource,
  dropboxAlbumHint,
  dropboxRemoteSourceProvider,
  dropboxRoots,
  forgetDropboxPauses,
} from 'src/import-connectors/dropbox.source.js';
import { type RemoteItem, RemoteSourceAuthError, RemoteSourceError } from 'src/import-connectors/remote-source.js';
import { TakeoutStagingError } from 'src/repositories/takeout-staging.repository.js';

type Call = { url: string; body: any; headers: Record<string, string>; redirect?: string };
type Handler = (call: Call) => Response;

const json = (body: unknown, status = 200, headers: Record<string, string> = {}) =>
  Response.json(body, { status, headers: { 'content-type': 'application/json', ...headers } });

const file = (name: string, extra: Record<string, unknown> = {}) => ({
  '.tag': 'file',
  id: `id:${name}`,
  name: name.split('/').at(-1),
  path_display: `/${name}`,
  size: 10,
  client_modified: '2024-05-01T10:00:00Z',
  server_modified: '2024-06-01T10:00:00Z',
  content_hash: `hash-${name}`,
  is_downloadable: true,
  ...extra,
});

/** A Dropbox that answers from a queue of handlers, in order, and records every request. */
const fakeDropbox = (...queue: Handler[]) => {
  const calls: Call[] = [];
  const http = (url: string, init: RequestInit) => {
    const call: Call = {
      url,
      body: typeof init.body === 'string' ? JSON.parse(init.body) : undefined,
      headers: init.headers as Record<string, string>,
      redirect: init.redirect,
    };
    calls.push(call);
    const next = queue.shift();
    if (!next) {
      throw new Error(`unexpected request to ${url}`);
    }
    return Promise.resolve(next(call));
  };
  return { calls, http };
};

const tokenSource = () => {
  const get = vi.fn((refused?: string) => Promise.resolve(refused ? 'token-2' : 'token-1'));
  return { get } as unknown as Pick<BrokerAccessToken, 'get'> & { get: typeof get };
};

const collect = async (source: DropboxSource, roots: string[], cursor: Record<string, unknown> | null = null) => {
  const items: RemoteItem[] = [];
  let last: unknown;
  for await (const batch of source.scan(roots, cursor, new AbortController().signal)) {
    items.push(...batch.items);
    last = batch.cursor;
  }
  return { items, cursor: last as { version: number; roots: Record<string, string> } };
};

const setup = (...queue: Handler[]) => {
  const dropbox = fakeDropbox(...queue);
  const waits: number[] = [];
  let clock = 1_000_000;
  const tokens = tokenSource();
  const source = new DropboxSource(tokens, 'dbid:account', {
    http: dropbox.http,
    now: () => clock,
    wait: (ms) => {
      waits.push(ms);
      clock += ms;
      return Promise.resolve();
    },
  });
  return { ...dropbox, source, tokens, waits };
};

describe('Dropbox source', () => {
  beforeEach(() => forgetDropboxPauses());

  it('maps Camera Uploads to the timeline and other folders to albums', () => {
    expect(dropboxAlbumHint('Camera Uploads/a.jpg')).toBeNull();
    expect(dropboxAlbumHint('camera uploads/2024/a.jpg')).toBeNull();
    expect(dropboxAlbumHint('a.jpg')).toBeNull();
    expect(dropboxAlbumHint('Trips/Spain/a.jpg')).toBe('Trips/Spain');
  });

  it('drops a chosen folder that another chosen folder already covers', () => {
    expect(dropboxRoots(['Trips', 'trips/Spain', '/Family/'])).toEqual(['Trips', 'Family']);
    expect(dropboxRoots([])).toEqual(['']);
    expect(dropboxRoots(['Trips', ''])).toEqual(['']);
  });

  it('pages through a recursive listing and keeps only photos and videos it can download', async () => {
    const { source, calls } = setup(
      () =>
        json({
          entries: [
            file('Trips/a.jpg'),
            { '.tag': 'folder', id: 'id:f', name: 'Trips', path_display: '/Trips' },
            file('Trips/notes.txt'),
            file('Trips/doc.jpg', { is_downloadable: false }),
            file('Trips/link.jpg', { symlink_info: { target: '/x' } }),
            { '.tag': 'deleted', name: 'gone.jpg', path_display: '/Trips/gone.jpg' },
          ],
          cursor: 'c1',
          has_more: true,
        }),
      () => json({ entries: [file('Camera Uploads/b.mp4')], cursor: 'c2', has_more: false }),
    );
    const { items, cursor } = await collect(source, []);
    expect(items.map((item) => [item.remoteId, item.path, item.albumHint])).toEqual([
      ['id:Trips/a.jpg', 'Trips/a.jpg', 'Trips'],
      ['id:Camera Uploads/b.mp4', 'Camera Uploads/b.mp4', null],
    ]);
    expect(items[0].modifiedAt).toEqual(new Date('2024-05-01T10:00:00Z'));
    expect(items[0].contentHash).toBe('hash-Trips/a.jpg');
    expect(cursor).toEqual({ version: 1, roots: { '': 'c2' } });
    expect(calls[0].url).toBe('https://api.dropboxapi.com/2/files/list_folder');
    expect(calls[0].body).toMatchObject({ path: '', recursive: true, include_deleted: false });
    expect(calls[0].redirect).toBe('error');
    expect(calls[1].url).toBe('https://api.dropboxapi.com/2/files/list_folder/continue');
    expect(calls[1].body).toEqual({ cursor: 'c1' });
  });

  it('continues from the saved cursor on the next scan', async () => {
    const { source, calls } = setup(() => json({ entries: [file('New/c.jpg')], cursor: 'c3', has_more: false }));
    const { items, cursor } = await collect(source, ['New'], { version: 1, roots: { new: 'c2' } });
    expect(items).toHaveLength(1);
    expect(calls).toHaveLength(1);
    expect(calls[0].body).toEqual({ cursor: 'c2' });
    expect(cursor.roots).toEqual({ new: 'c3' });
  });

  it('lists the folder again when Dropbox resets the cursor', async () => {
    const { source, calls } = setup(
      () => json({ error_summary: 'reset/..', error: { '.tag': 'reset' } }, 409),
      () => json({ entries: [file('New/c.jpg')], cursor: 'fresh', has_more: false }),
    );
    const { items, cursor } = await collect(source, ['New'], { version: 1, roots: { new: 'old' } });
    expect(items).toHaveLength(1);
    expect(calls[1].body).toMatchObject({ path: '/New', recursive: true });
    expect(cursor.roots).toEqual({ new: 'fresh' });
  });

  it('treats a chosen folder that is gone as empty and still reads the others', async () => {
    const { source } = setup(
      () => json({ error_summary: 'path/not_found/..' }, 409),
      () => json({ entries: [file('Kept/a.jpg')], cursor: 'k', has_more: false }),
    );
    const { items, cursor } = await collect(source, ['Gone', 'Kept']);
    expect(items).toHaveLength(1);
    expect(cursor.roots).toEqual({ kept: 'k' });
  });

  it('renews a refused access token once and repeats the request', async () => {
    const { source, calls, tokens } = setup(
      () => json({ error: { '.tag': 'expired_access_token' } }, 401),
      () => json({ entries: [], cursor: 'c', has_more: false }),
    );
    await collect(source, []);
    expect(tokens.get).toHaveBeenLastCalledWith('token-1');
    expect(calls[0].headers.Authorization).toBe('Bearer token-1');
    expect(calls[1].headers.Authorization).toBe('Bearer token-2');
  });

  it('asks for a new sign-in when the renewed token is refused too', async () => {
    const { source, calls } = setup(
      () => json({ error: { '.tag': 'invalid_access_token' } }, 401),
      () => json({ error: { '.tag': 'invalid_access_token' } }, 401),
    );
    await expect(collect(source, [])).rejects.toBeInstanceOf(RemoteSourceAuthError);
    expect(calls).toHaveLength(2);
  });

  it('waits for Retry-After on a 429 before asking again', async () => {
    const { source, calls, waits } = setup(
      () => json({ error_summary: 'too_many_requests/..' }, 429, { 'retry-after': '7' }),
      () => json({ entries: [], cursor: 'c', has_more: false }),
    );
    await collect(source, []);
    expect(waits).toEqual([7000]);
    expect(calls).toHaveLength(2);
  });

  it('makes every source of the account wait out a rate limit, without a request', async () => {
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

  it('never passes on what Dropbox said in an error', async () => {
    const { source } = setup(() => json({ error_summary: 'secret detail' }, 400));
    await expect(collect(source, [])).rejects.toThrow('Dropbox would not list this folder');
  });

  describe('open', () => {
    const signal = new AbortController().signal;
    const result = (hash: string) => ({ 'dropbox-api-result': JSON.stringify({ content_hash: hash }) });

    it('downloads from the content host by file id', async () => {
      const { source, calls } = setup(() => new Response('whole file', { status: 200 }));
      await expect(text(await source.open('id:é', { start: 0 }, signal))).resolves.toBe('whole file');
      expect(calls[0].url).toBe('https://content.dropboxapi.com/2/files/download');
      expect(calls[0].headers['Dropbox-API-Arg']).toBe('{"path":"id:é"}');
      expect(calls[0].headers.Range).toBeUndefined();
    });

    it('resumes with a Range when the file is the version the scan saw', async () => {
      const { source, calls } = setup(
        () =>
          new Response('rest', {
            status: 206,
            headers: { 'content-range': 'bytes 6-9/10', ...result('hash') },
          }),
      );
      await expect(text(await source.open('id:a', { start: 6, contentHash: 'hash' }, signal))).resolves.toBe('rest');
      expect(calls[0].headers.Range).toBe('bytes=6-');
    });

    it.each([
      ['a newer version', 206, { 'content-range': 'bytes 6-9/10', ...result('other') }],
      ['a whole file instead of the range', 200, result('hash')],
      ['a range from elsewhere', 206, { 'content-range': 'bytes 0-9/10', ...result('hash') }],
    ])('refuses to join %s onto a partial download', async (_name, status, headers) => {
      const { source } = setup(() => new Response('bytes', { status, headers }));
      await expect(source.open('id:a', { start: 6, contentHash: 'hash' }, signal)).rejects.toBeInstanceOf(
        TakeoutStagingError,
      );
    });

    it('says when the file is gone', async () => {
      const { source } = setup(() => json({ error_summary: 'path/not_found/..' }, 409));
      await expect(source.open('id:a', { start: 0 }, signal)).rejects.toThrow('no longer in Dropbox');
    });
  });

  describe('provider', () => {
    const broker = {
      target: vi.fn(),
      refresh: vi.fn().mockResolvedValue({ accessToken: 'access', expiresInSec: 14_400 }),
    };

    it('refuses typed-in credentials', () => {
      const provider = dropboxRemoteSourceProvider(broker);
      expect(() => provider.credentials({ refreshToken: 'x' })).toThrow('signing in');
    });

    it('reads the account name from Dropbox', async () => {
      const { http, calls } = fakeDropbox(() =>
        json({ account_id: 'dbid:1', name: { display_name: 'Sam' }, email: 'sam@example.com' }),
      );
      const provider = dropboxRemoteSourceProvider(broker, { http });
      await expect(provider.signIn!.account('access')).resolves.toEqual({ id: 'dbid:1', name: 'Sam' });
      expect(calls[0].url).toBe('https://api.dropboxapi.com/2/users/get_current_account');
    });

    it('revokes with an access token at Dropbox itself', async () => {
      const { http, calls } = fakeDropbox(() => new Response('null', { status: 200 }));
      const provider = dropboxRemoteSourceProvider(broker, { http });
      await provider.revoke!({ refreshToken: 'refresh' });
      expect(broker.refresh).toHaveBeenCalledWith('dropbox', 'refresh');
      expect(calls[0].url).toBe('https://api.dropboxapi.com/2/auth/token/revoke');
      expect(calls[0].headers.Authorization).toBe('Bearer access');
    });
  });
});
