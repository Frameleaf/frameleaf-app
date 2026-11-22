/* eslint-disable unicorn/prefer-https -- plain http addresses are what these tests refuse */
import { createServer } from 'node:http';
import { Readable } from 'node:stream';
import { text as readText } from 'node:stream/consumers';
import { Response, fetch as undiciFetch } from 'undici';
import type { AddressInfo } from 'node:net';
import { RemoteSourceAuthError, RemoteSourceError } from 'src/import-connectors/remote-source.js';
import {
  WEBDAV_MAX_DEPTH,
  WebDavSource,
  childName,
  hrefSegments,
  isSkippedName,
  webdavRemoteSourceProvider as provider,
} from 'src/import-connectors/webdav.source.js';
import {
  type WebDavFetch,
  type WebDavFetchInit,
  checkSourceUrl,
  isSourceAddressAllowed,
  serverNetworks,
} from 'src/import-connectors/webdav.transport.js';
import { readMultistatus } from 'src/import-connectors/webdav.xml.js';
import { TakeoutStagingError } from 'src/repositories/takeout-staging.repository.js';

vi.mock('node:dns', async (importOriginal) => {
  const dns = await importOriginal<typeof import('node:dns')>();
  const answers: Record<string, string> = {
    'rebind.example.com': '127.0.0.1',
    'metadata-alias.example.com': '169.254.169.254',
    'nas.example.com': '192.168.1.20',
    'public.example.com': '93.184.216.34',
  };
  return {
    ...dns,
    lookup: (hostname: string, options: unknown, callback: (...args: unknown[]) => void) =>
      answers[hostname]
        ? callback(null, [{ address: answers[hostname], family: 4 }])
        : dns.lookup(hostname, options as never, callback as never),
  };
});

// The machine running the spec may itself sit on one of the private networks used below.
vi.mock('node:os', async (importOriginal) => ({
  ...(await importOriginal<typeof import('node:os')>()),
  networkInterfaces: () => ({}),
}));

const PASSWORD = 'correct-horse-battery';
const BASE = 'https://cloud.example.com/remote.php/dav/files/ana/';
const BASE_PATH = '/remote.php/dav/files/ana/';
const credentials = { url: BASE, username: 'ana', password: PASSWORD, allowPrivateAddress: false };
const AUTH = `Basic ${Buffer.from(`ana:${PASSWORD}`).toString('base64')}`;
const signal = new AbortController().signal;

/**
 * PROPFIND answers below are HAND-WRITTEN from the WebDAV (RFC 4918) and Nextcloud response formats;
 * they were not recorded from a live server.
 */
const folder = (href: string) => `<d:response><d:href>${href}</d:href><d:propstat><d:prop>
  <d:resourcetype><d:collection/></d:resourcetype><d:getetag>&quot;dir&quot;</d:getetag>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat>
  <d:propstat><d:prop><d:getcontentlength/></d:prop><d:status>HTTP/1.1 404 Not Found</d:status></d:propstat></d:response>`;
const file = (href: string, { size = 10, etag = '&quot;e1&quot;', favourite = '0' } = {}) =>
  `<d:response><d:href>${href}</d:href><d:propstat><d:prop><d:resourcetype/>
  <d:getcontentlength>${size}</d:getcontentlength><d:getlastmodified>Sat, 06 Jan 2024 10:00:00 GMT</d:getlastmodified>
  <d:getetag>${etag}</d:getetag><oc:favorite>${favourite}</oc:favorite>
  </d:prop><d:status>HTTP/1.1 200 OK</d:status></d:propstat></d:response>`;
const multistatus = (...responses: string[]) =>
  `<?xml version="1.0"?><d:multistatus xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns">${responses.join('')}</d:multistatus>`;
const listing = (...responses: string[]) => new Response(multistatus(...responses), { status: 207 });

type Call = { url: string; init: WebDavFetchInit };
const seam = (answer: (url: string, init: WebDavFetchInit) => Response) => {
  const calls: Call[] = [];
  const fetcher: WebDavFetch = (url, init) => {
    calls.push({ url: url.href, init });
    return Promise.resolve(answer(url.href, init));
  };
  return { calls, fetcher };
};
const collect = async (source: WebDavSource, roots: string[] = []) => {
  const items = [];
  let cursor: unknown;
  for await (const batch of source.scan(roots, null, signal)) {
    items.push(...batch.items);
    cursor = batch.cursor ?? cursor;
  }
  return { items, cursor };
};

const tree: Record<string, string[]> = {
  [BASE]: [
    folder(BASE_PATH),
    folder(`${BASE_PATH}Trips/`),
    folder(`${BASE_PATH}.trash/`),
    folder(`${BASE_PATH}appdata_oc123/`),
    folder(`${BASE_PATH}files_trashbin/`),
    file(`${BASE_PATH}top.jpg`),
    file(`${BASE_PATH}.hidden.jpg`),
    file(`${BASE_PATH}notes.txt`),
  ],
  [`${BASE}Trips/`]: [
    folder(`${BASE_PATH}Trips/`),
    // a server listing its parent or the same entry again must not make the walk loop
    folder(BASE_PATH),
    folder(`${BASE_PATH}Trips/Rome%202024/`),
    file(`${BASE_PATH}Trips/a.jpg`, { favourite: '1', etag: '&quot;fav&quot;' }),
    file(`${BASE_PATH}Trips/a.jpg`),
  ],
  [`${BASE}Trips/Rome%202024/`]: [
    folder(`${BASE_PATH}Trips/Rome%202024/`),
    file(`${BASE_PATH}Trips/Rome%202024/b%20c.jpg`),
  ],
};
const walk = () => seam((url) => (tree[url] ? listing(...tree[url]) : new Response('', { status: 404 })));

describe('webdav credentials', () => {
  const input = { url: 'https://cloud.example.com/dav', username: 'ana', password: PASSWORD };

  it('keeps a plain WebDAV address, with a trailing slash', () => {
    expect(provider.credentials(input)).toMatchObject({
      url: 'https://cloud.example.com/dav/',
      allowPrivateAddress: false,
    });
  });

  it('builds the Nextcloud path with the user name encoded', () => {
    expect(
      provider.credentials({
        ...input,
        url: 'https://example.com/nextcloud/',
        username: 'ana b@x.io',
        nextcloud: true,
      }),
    ).toMatchObject({ url: 'https://example.com/nextcloud/remote.php/dav/files/ana%20b%40x.io/' });
  });

  it('does not let a Nextcloud user name climb out of the files folder', () => {
    expect(() => provider.credentials({ ...input, username: '..', nextcloud: true })).toThrow(RemoteSourceError);
  });

  it('enforces an 8 character password without repeating it', () => {
    const error = (() => {
      try {
        void provider.credentials({ ...input, password: 'short12' });
      } catch (error_) {
        return error_ as Error;
      }
    })();
    expect(error).toBeInstanceOf(RemoteSourceError);
    expect(error?.message).not.toContain('short12');
    expect(() => provider.credentials({ ...input, password: '12345678' })).not.toThrow();
  });

  it.each([
    ['credentials in the address', 'https://ana:secret@example.com/'],
    ['another scheme', 'ftp://example.com/'],
    ['a query', 'https://example.com/?a=1'],
    ['plain http to a public name', 'http://example.com/'],
    ['a private address without the allowance', 'https://192.168.1.20/'],
  ])('refuses %s', (_name, url) => {
    expect(() => provider.credentials({ ...input, url })).toThrow(RemoteSourceError);
  });

  it('allows plain http on a private address only with the allowance', () => {
    expect(
      provider.credentials({ ...input, url: 'http://192.168.1.20:5005/', allowPrivateAddress: true }),
    ).toMatchObject({
      url: 'http://192.168.1.20:5005/',
      allowPrivateAddress: true,
    });
    expect(() => provider.credentials({ ...input, url: 'http://192.168.1.20/', allowPrivateAddress: 'true' })).toThrow(
      RemoteSourceError,
    );
  });
});

describe('webdav address guard', () => {
  const allowed = { allowPrivateAddress: true };
  const noNetworks = serverNetworks({}, false);

  it.each([
    '127.0.0.1',
    '::1',
    '169.254.169.254',
    'fe80::1',
    '0.0.0.0',
    '100.100.100.200',
    'fd00:ec2::254',
    '::ffff:127.0.0.1',
    '::ffff:a9fe:a9fe',
    '0:0:0:0:0:ffff:7f00:1',
    '224.0.0.1',
  ])('refuses %s even with the allowance', (address) => {
    expect(isSourceAddressAllowed(address, allowed, false, noNetworks)).toBe(false);
  });

  it.each([
    'http://localhost/',
    'http://127.0.0.1/',
    'http://[::1]/',
    'http://169.254.169.254/',
    'http://metadata.google.internal/',
    'http://2130706433/',
  ])('refuses %s with the allowance, before connecting', (url) => {
    expect(() => checkSourceUrl(url, allowed)).toThrow(RemoteSourceError);
  });

  it('needs the allowance for a LAN address and never allows plain http to a public one', () => {
    expect(isSourceAddressAllowed('192.168.1.20', { allowPrivateAddress: false }, false, noNetworks)).toBe(false);
    expect(isSourceAddressAllowed('192.168.1.20', allowed, true, noNetworks)).toBe(true);
    expect(isSourceAddressAllowed('93.184.216.34', allowed, false, noNetworks)).toBe(true);
    expect(isSourceAddressAllowed('93.184.216.34', allowed, true, noNetworks)).toBe(false);
  });

  it("refuses the container's own networks even with the allowance, and still reaches the LAN", () => {
    const interfaces = {
      eth0: [
        {
          address: '172.18.0.5',
          netmask: '255.255.0.0',
          family: 'IPv4',
          mac: '02:42:ac:12:00:05',
          internal: false,
          cidr: '172.18.0.5/16',
        } as const,
      ],
    };
    const inContainer = serverNetworks(interfaces, true);
    expect(isSourceAddressAllowed('172.18.0.2', allowed, false, inContainer)).toBe(false);
    expect(isSourceAddressAllowed('172.18.0.1', allowed, true, inContainer)).toBe(false);
    expect(isSourceAddressAllowed('192.168.1.20', allowed, true, inContainer)).toBe(true);
    // outside a container the same subnet is the LAN; only the server's own address stays refused
    const bareMetal = serverNetworks(interfaces, false);
    expect(isSourceAddressAllowed('172.18.0.2', allowed, false, bareMetal)).toBe(true);
    expect(isSourceAddressAllowed('172.18.0.5', allowed, false, bareMetal)).toBe(false);
  });

  it('refuses plain http to a name that resolves to a public address, at connection time', async () => {
    const source = new WebDavSource({
      ...credentials,
      url: 'http://public.example.com/dav/',
      allowPrivateAddress: true,
    });
    await expect(source.listFolders('')).rejects.toThrow('This address cannot be used for an import');
  });

  it.each([
    ['rebind.example.com', true],
    ['metadata-alias.example.com', true],
    ['nas.example.com', false],
  ])('refuses %s at connection time (allowance %s)', async (host, allowPrivateAddress) => {
    const source = new WebDavSource({ ...credentials, url: `https://${host}/dav/`, allowPrivateAddress });
    const error = await source.listFolders('').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(RemoteSourceError);
    expect((error as Error).message).not.toContain(PASSWORD);
    expect((error as Error).message).not.toContain(host);
  });
});

describe('webdav hrefs', () => {
  it.each(['/a/../b', '/a/%2e%2e/b', '/a/%2E%2E%2Fb', '/a/%zz', '/a/b%00c', '//evil.example/x', 'relative/x', '/a//b'])(
    'refuses %s',
    (href) => expect(hrefSegments(href)).toBeNull(),
  );

  it('decodes once, so an encoded %2e stays a literal name', () => {
    expect(hrefSegments('/a/%252e%252e/b%20c')).toEqual(['a', '%2e%2e', 'b c']);
  });

  it('takes only a direct child of the folder', () => {
    const parent = new URL('https://x.example/dav/a/');
    expect(childName('/dav/a/b.jpg', parent)).toBe('b.jpg');
    expect(childName('https://proxy.internal/dav/a/b/', parent)).toBe('b');
    expect(childName('/dav/a/', parent)).toBeNull();
    expect(childName('/dav/', parent)).toBeNull();
    expect(childName('/dav/other/b.jpg', parent)).toBeNull();
    expect(childName('/dav/a/b/c.jpg', parent)).toBeNull();
  });

  it('skips hidden, trash and preview folders but not a folder merely called Preview', () => {
    for (const name of ['.trash', '.git', 'appdata_oc1', 'files_trashbin', 'files_versions', '@eaDir', '#recycle']) {
      expect(isSkippedName(name, true)).toBe(true);
    }
    expect(isSkippedName('Preview', true)).toBe(false);
    expect(isSkippedName('appdata_notes.jpg', false)).toBe(false);
  });
});

describe('webdav walking', () => {
  it('walks nested folders with Depth 1, skipping what it should, each file once', async () => {
    const { calls, fetcher } = walk();
    const { items, cursor } = await collect(new WebDavSource(credentials, fetcher));

    expect(items.map(({ path }) => path).toSorted()).toEqual(['Trips/Rome 2024/b c.jpg', 'Trips/a.jpg', 'top.jpg']);
    expect(calls.map(({ url }) => url).toSorted()).toEqual([BASE, `${BASE}Trips/`, `${BASE}Trips/Rome%202024/`]);
    expect(calls.every(({ init }) => init.method === 'PROPFIND' && init.headers.depth === '1')).toBe(true);
    expect(cursor).toEqual({ listedAt: expect.any(String) });
  });

  it('reads the album hint, favourite and ETag', async () => {
    const { fetcher } = walk();
    const { items } = await collect(new WebDavSource(credentials, fetcher));
    const byPath = new Map(items.map((item) => [item.path, item]));

    expect(byPath.get('top.jpg')).toMatchObject({ albumHint: null, favourite: false, size: 10 });
    expect(byPath.get('Trips/a.jpg')).toMatchObject({ albumHint: 'Trips', favourite: true, contentHash: '"fav"' });
    expect(byPath.get('Trips/Rome 2024/b c.jpg')).toMatchObject({ albumHint: 'Trips/Rome 2024' });
  });

  it('lists folders without the skipped ones', async () => {
    const { fetcher } = walk();
    await expect(new WebDavSource(credentials, fetcher).listFolders('')).resolves.toEqual([
      { path: 'Trips', name: 'Trips' },
    ]);
  });

  it('refuses a path with .. before sending anything', async () => {
    const { calls, fetcher } = walk();
    await expect(new WebDavSource(credentials, fetcher).listFolders('Trips/../..')).rejects.toBeInstanceOf(
      RemoteSourceError,
    );
    await expect(
      new WebDavSource(credentials, fetcher).open('../secret.jpg', { start: 0 }, signal),
    ).rejects.toBeInstanceOf(RemoteSourceError);
    expect(calls).toEqual([]);
  });

  it('stops without a cursor at the depth cap', async () => {
    const { fetcher } = seam((url) => {
      const path = new URL(url).pathname;
      return listing(folder(path), folder(`${path}d/`));
    });
    const seen: unknown[] = [];
    const run = (async () => {
      for await (const batch of new WebDavSource(credentials, fetcher).scan([], null, signal)) {
        seen.push(batch.cursor);
      }
    })();
    await expect(run).rejects.toThrow(/nested too deeply/);
    expect(seen).toEqual([]);
    expect(WEBDAV_MAX_DEPTH).toBe(32);
  });
});

describe('webdav XML', () => {
  const read = (xml: string | Buffer, limits?: { maxBytes: number; maxEntries: number }) =>
    readMultistatus(Readable.from([Buffer.from(xml)]), limits);

  it.each([
    [
      'a DOCTYPE with an entity bomb',
      `<!DOCTYPE x [<!ENTITY a "aaaa"><!ENTITY b "&a;&a;&a;">]>${multistatus(file('/f&b;.jpg'))}`,
    ],
    ['an external entity', `<!DOCTYPE x [<!ENTITY e SYSTEM "file:///etc/passwd">]>${multistatus(file('/&e;.jpg'))}`],
    ['an undeclared entity', multistatus(file('/&nope;.jpg'))],
    ['broken XML', '<d:multistatus xmlns:d="DAV:"><d:response>'],
    ['another root', '<html><body>login</body></html>'],
    ['an empty answer', ''],
    ['an unbound prefix', '<d:multistatus></d:multistatus>'],
    [
      'elements nested too deeply',
      `<d:multistatus xmlns:d="DAV:">${'<d:x>'.repeat(40)}${'</d:x>'.repeat(40)}</d:multistatus>`,
    ],
  ])('refuses %s', async (_name, xml) => {
    await expect(read(xml)).rejects.toBeInstanceOf(RemoteSourceError);
  });

  it('refuses invalid UTF-8', async () => {
    await expect(read(Buffer.from([0x3c, 0xff, 0xfe, 0x3e]))).rejects.toBeInstanceOf(RemoteSourceError);
  });

  it('caps size, entries and text', async () => {
    const two = multistatus(file('/a.jpg'), file('/b.jpg'));
    await expect(read(two, { maxBytes: 100, maxEntries: 10 })).rejects.toThrow(/too large/);
    await expect(read(two, { maxBytes: 1_000_000, maxEntries: 1 })).rejects.toThrow(/too large/);
    await expect(read(multistatus(file(`/${'a'.repeat(9000)}.jpg`)))).rejects.toThrow(/too large/);
  });

  it('refuses an oversized listing by its declared length', async () => {
    const { fetcher } = seam(
      () => new Response(multistatus(), { status: 207, headers: { 'content-length': String(64 * 1024 * 1024) } }),
    );
    await expect(new WebDavSource(credentials, fetcher).listFolders('')).rejects.toThrow(/too large/);
  });
});

describe('webdav requests', () => {
  it.each([401, 403])('maps %s to a sign-in error', async (status) => {
    const { calls, fetcher } = seam(() => new Response('', { status }));
    const error = await new WebDavSource(credentials, fetcher).listFolders('').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(RemoteSourceAuthError);
    expect((error as Error).message).not.toContain(PASSWORD);
    expect(calls).toHaveLength(1);
  });

  it('goes past a refused or failing folder below a root and keeps the rest', async () => {
    for (const status of [403, 404, 503]) {
      const { fetcher } = seam((url) =>
        url === `${BASE}Trips/Rome%202024/` ? new Response('', { status }) : listing(...tree[url]),
      );
      const { items, cursor } = await collect(new WebDavSource(credentials, fetcher));
      expect(items.map((item) => item.path)).toEqual(expect.arrayContaining(['top.jpg', 'Trips/a.jpg']));
      expect(items.map((item) => item.path)).not.toContain('Trips/Rome 2024/b c.jpg');
      expect(cursor).toBeDefined();
    }
  });

  it('fails the scan when a chosen root itself is refused, without calling it a dead sign-in', async () => {
    const { fetcher } = seam(() => new Response('', { status: 403 }));
    const error = await collect(new WebDavSource(credentials, fetcher), ['Trips']).catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(RemoteSourceError);
    expect(error).not.toBeInstanceOf(RemoteSourceAuthError);
  });

  it('refuses a listing that is about another address instead of reading it as empty', async () => {
    const { fetcher } = seam(() => listing(folder('/somewhere/else/'), file('/somewhere/else/a.jpg')));
    await expect(new WebDavSource(credentials, fetcher).listFolders('')).rejects.toThrow('different address');
  });

  it('sends the sign-in to its own origin', async () => {
    const { calls, fetcher } = seam(() => listing(folder(BASE_PATH)));
    await new WebDavSource(credentials, fetcher).listFolders('');
    expect(calls[0].init.headers.authorization).toBe(AUTH);
  });

  const redirect = (location: string) => new Response(null, { status: 307, headers: { location } });

  it('keeps the sign-in on a same-origin redirect', async () => {
    const { calls, fetcher } = seam((url) =>
      url === BASE ? redirect('/moved/') : listing(folder('/moved/'), folder('/moved/Inside/')),
    );
    await expect(new WebDavSource(credentials, fetcher).listFolders('')).resolves.toEqual([
      { path: 'Inside', name: 'Inside' },
    ]);
    expect(calls[1].init.headers.authorization).toBe(AUTH);
    expect(calls[1].init.method).toBe('PROPFIND');
  });

  it('drops the sign-in on a cross-origin redirect', async () => {
    const { calls, fetcher } = seam((url) =>
      url === BASE ? redirect('https://other.example.com/dav/') : listing(folder('/dav/')),
    );
    await new WebDavSource(credentials, fetcher).listFolders('');
    expect(calls[1].url).toBe('https://other.example.com/dav/');
    expect(calls[1].init.headers.authorization).toBeUndefined();
  });

  it('does not mark the sign-in bad when another origin refuses without it', async () => {
    const { fetcher } = seam((url) =>
      url === BASE ? redirect('https://other.example.com/') : new Response('', { status: 401 }),
    );
    const error = await new WebDavSource(credentials, fetcher).listFolders('').catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(RemoteSourceError);
    expect(error).not.toBeInstanceOf(RemoteSourceAuthError);
  });

  it.each([
    ['a private address', 'https://192.168.1.20/', false],
    ['loopback, with the allowance', 'http://127.0.0.1/', true],
    ['the metadata address, with the allowance', 'http://169.254.169.254/latest/meta-data/', true],
    ['credentials in the target', 'https://a:b@other.example.com/', false],
    ['https down to http', 'http://192.168.1.20/', true],
    ['another scheme', 'file:///etc/passwd', false],
  ])('refuses a redirect to %s without requesting it', async (_name, location, allowPrivateAddress) => {
    const { calls, fetcher } = seam(() => redirect(location));
    await expect(
      new WebDavSource({ ...credentials, allowPrivateAddress }, fetcher).listFolders(''),
    ).rejects.toBeInstanceOf(RemoteSourceError);
    expect(calls).toHaveLength(1);
  });

  it('caps redirects', async () => {
    let hop = 0;
    const { calls, fetcher } = seam(() => redirect(`/hop${++hop}/`));
    await expect(new WebDavSource(credentials, fetcher).listFolders('')).rejects.toThrow(/too many/);
    expect(calls).toHaveLength(4);
  });

  it('never quotes a failed request', async () => {
    const fetcher: WebDavFetch = () => Promise.reject(new TypeError(`failed ${AUTH} ${BASE}`));
    const error = (await new WebDavSource(credentials, fetcher)
      .listFolders('')
      .catch((error_: unknown) => error_)) as Error;
    expect(error).toBeInstanceOf(RemoteSourceError);
    expect(error.message).toBe('The server could not be reached');
  });
});

describe('webdav downloads', () => {
  const bytes = 'abcdefghij';
  const etag = '"e1"';
  const open = (
    answer: (url: string, init: WebDavFetchInit) => Response,
    start: number,
    contentHash: string | undefined = etag,
  ) => {
    const { calls, fetcher } = seam(answer);
    return {
      calls,
      stream: new WebDavSource(credentials, fetcher).open('Trips/a b.jpg', { start, contentHash }, signal),
    };
  };

  it('asks for the whole file with GET, uncompressed', async () => {
    const { calls, stream } = open(() => new Response(bytes), 0);
    await expect(readText(await stream)).resolves.toBe(bytes);
    expect(calls[0].url).toBe(`${BASE}Trips/a%20b.jpg`);
    expect(calls[0].init).toMatchObject({ method: 'GET', headers: { 'accept-encoding': 'identity' } });
    expect(calls[0].init.headers.range).toBeUndefined();
  });

  it('resumes with Range and If-Range', async () => {
    const { calls, stream } = open(
      () => new Response(bytes.slice(4), { status: 206, headers: { 'content-range': 'bytes 4-9/10', etag } }),
      4,
    );
    await expect(readText(await stream)).resolves.toBe('efghij');
    expect(calls[0].init.headers).toMatchObject({ range: 'bytes=4-', 'if-range': etag });
  });

  it.each([
    ['a weak ETag', 'W/"e1"'],
    ['no ETag', undefined],
  ])('starts again rather than resume on %s', async (_name, hash) => {
    const { calls, fetcher } = seam(() => new Response(bytes));
    await expect(
      new WebDavSource(credentials, fetcher).open('a.jpg', { start: 4, contentHash: hash }, signal),
    ).rejects.toBeInstanceOf(TakeoutStagingError);
    expect(calls).toHaveLength(0);
  });

  it('refuses a resume whose answer has no ETag, or a different total size', async () => {
    const noTag = open(
      () => new Response(bytes.slice(4), { status: 206, headers: { 'content-range': 'bytes 4-9/10' } }),
      4,
    );
    await expect(noTag.stream).rejects.toBeInstanceOf(TakeoutStagingError);
    const { fetcher } = seam(
      () => new Response(bytes.slice(4), { status: 206, headers: { 'content-range': 'bytes 4-9/99', etag } }),
    );
    await expect(
      new WebDavSource(credentials, fetcher).open('a.jpg', { start: 4, contentHash: etag, size: 10 }, signal),
    ).rejects.toBeInstanceOf(TakeoutStagingError);
  });

  it('reports a 403 on one file as that file, not as a dead sign-in', async () => {
    const { stream } = open(() => new Response('', { status: 403 }), 0);
    const error = await stream.catch((error_: unknown) => error_);
    expect(error).toBeInstanceOf(RemoteSourceError);
    expect(error).not.toBeInstanceOf(RemoteSourceAuthError);
  });

  it('drops the bytes it already has when the server ignores Range', async () => {
    const { stream } = open(() => new Response(bytes, { status: 200, headers: { etag } }), 4);
    await expect(readText(await stream)).resolves.toBe('efghij');
  });

  it('fails rather than splices when a full answer is shorter than the offset', async () => {
    const { stream } = open(() => new Response('abc', { status: 200, headers: { etag } }), 4);
    await expect(readText(await stream)).rejects.toBeInstanceOf(TakeoutStagingError);
  });

  it.each([
    ['a different ETag', () => new Response(bytes, { status: 200, headers: { etag: '"new"' } })],
    [
      'the wrong offset',
      () => new Response(bytes, { status: 206, headers: { 'content-range': 'bytes 0-9/10', etag } }),
    ],
    ['no Content-Range', () => new Response(bytes, { status: 206, headers: { etag } })],
    ['a compressed answer', () => new Response(bytes, { status: 200, headers: { etag, 'content-encoding': 'gzip' } })],
    ['416', () => new Response('', { status: 416 })],
  ])('restarts the file on %s', async (_name, answer) => {
    await expect(open(answer, 4).stream).rejects.toBeInstanceOf(TakeoutStagingError);
  });

  it('maps 401 and 404', async () => {
    await expect(open(() => new Response('', { status: 401 }), 0).stream).rejects.toBeInstanceOf(RemoteSourceAuthError);
    await expect(open(() => new Response('', { status: 404 }), 0).stream).rejects.toThrow(/no longer/);
  });

  it('works over real HTTP, for PROPFIND, a server that honours Range and one that ignores it', async () => {
    const methods: string[] = [];
    const depths: unknown[] = [];
    let honourRange = true;
    const server = createServer((request, response) => {
      methods.push(request.method ?? '');
      if (request.method === 'PROPFIND') {
        depths.push(request.headers.depth);
        response.writeHead(207, { 'content-type': 'application/xml' });
        response.end(multistatus(folder(BASE_PATH), folder(`${BASE_PATH}Inside/`)));
        return;
      }
      const range = /^bytes=(\d+)-$/.exec(request.headers.range ?? '');
      if (range && honourRange) {
        const start = Number(range[1]);
        response.writeHead(206, { 'content-range': `bytes ${start}-9/10`, etag });
        response.end(bytes.slice(start));
        return;
      }
      response.writeHead(200, { etag });
      response.end(bytes);
    });
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    const { port } = server.address() as AddressInfo;
    // The address guard refuses loopback, so this seam dials the test server directly.
    const fetcher: WebDavFetch = (url, init) =>
      undiciFetch(`http://127.0.0.1:${port}${url.pathname}`, { ...init, redirect: 'manual' });
    try {
      const source = new WebDavSource(credentials, fetcher);
      await expect(readText(await source.open('a.jpg', { start: 6, contentHash: etag }, signal))).resolves.toBe('ghij');
      honourRange = false;
      await expect(readText(await source.open('a.jpg', { start: 6, contentHash: etag }, signal))).resolves.toBe('ghij');
      await expect(source.listFolders('')).resolves.toEqual([{ path: 'Inside', name: 'Inside' }]);
      expect(depths).toEqual(['1']);
      expect(new Set(methods)).toEqual(new Set(['GET', 'PROPFIND']));
    } finally {
      await new Promise((resolve) => server.close(resolve));
    }
  });
});
