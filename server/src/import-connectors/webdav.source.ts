import { Readable, Transform, pipeline } from 'node:stream';
import {
  type RemoteFolder,
  type RemoteItem,
  type RemoteScanBatch,
  type RemoteSource,
  RemoteSourceError,
  type RemoteSourceProvider,
} from 'src/import-connectors/remote-source.js';
import { type WebDavFetch, checkSourceUrl, webdavRequest } from 'src/import-connectors/webdav.transport.js';
import { WEBDAV_XML_LIMITS, type WebDavEntry, readMultistatus } from 'src/import-connectors/webdav.xml.js';
import { TakeoutStagingError } from 'src/repositories/takeout-staging.repository.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/**
 * FL-944: photos from a WebDAV folder (Nextcloud, ownCloud, a NAS, Koofr, pCloud). It sends PROPFIND
 * with Depth 1 and GET, and nothing else, so nothing at the source can change. Network safety is in
 * `webdav.transport.ts`, XML safety in `webdav.xml.ts`.
 */
export const WEBDAV_PROVIDER = 'webdav';
export const WEBDAV_MAX_DEPTH = 32;
export const WEBDAV_MAX_FOLDERS = 100_000;
export const WEBDAV_MAX_ENTRIES = 1_000_000;
const PASSWORD_MIN = 8;
const BATCH_SIZE = 200;
const LISTING_TIMEOUT_MS = 60_000;

// The oc namespace name is compared as a string and never requested.

const PROPFIND_BODY =
  '<?xml version="1.0" encoding="utf-8"?><d:propfind xmlns:d="DAV:" xmlns:oc="http://owncloud.org/ns"><d:prop>' +
  '<d:resourcetype/><d:getcontentlength/><d:getlastmodified/><d:getetag/><oc:favorite/></d:prop></d:propfind>';

/** Folders that hold a server's or a NAS's own housekeeping, by exact name. Hidden names are skipped as well. */
const SKIPPED_FOLDERS = new Set([
  'files_trashbin',
  'files_versions',
  '@eadir',
  '#recycle',
  '#snapshot',
  '$recycle.bin',
  'lost+found',
  'system volume information',
]);

/** Hidden, trash, or a server's generated previews (`appdata_<id>` holds Nextcloud's). */
export const isSkippedName = (name: string, isFolder: boolean) => {
  const lower = name.toLowerCase();
  return lower.startsWith('.') || (isFolder && (SKIPPED_FOLDERS.has(lower) || lower.startsWith('appdata_')));
};

const isSafeSegment = (segment: string) =>
  segment !== '' &&
  segment !== '.' &&
  segment !== '..' &&
  !segment.includes('/') &&
  !segment.includes('\\') &&
  // eslint-disable-next-line no-control-regex
  !/[\u{0}-\u{1F}\u{7F}]/u.test(segment);

/** The decoded path segments of an href, or null when any is unsafe. The href is never requested. */
export const hrefSegments = (href: string): string[] | null => {
  const withoutOrigin = href.trim().replace(/^[a-z][a-z\d+.-]*:\/\/[^/?#]*/i, '');
  const [pathOnly] = withoutOrigin.split(/[?#]/, 1);
  if (!pathOnly.startsWith('/') || pathOnly.startsWith('//')) {
    return null;
  }
  const raw = pathOnly.slice(1).replace(/\/$/, '');
  if (raw === '') {
    return [];
  }
  const segments: string[] = [];
  for (const part of raw.split('/')) {
    let decoded: string;
    try {
      decoded = decodeURIComponent(part);
    } catch {
      return null;
    }
    if (!isSafeSegment(decoded)) {
      return null;
    }
    segments.push(decoded);
  }
  return segments;
};

/** The name of the direct child of `folder` this href points at; null for itself, a parent or anything else. */
export const childName = (href: string, folder: URL): string | null => {
  const segments = hrefSegments(href);
  const parent = hrefSegments(folder.pathname);
  if (!segments || !parent || segments.length !== parent.length + 1) {
    return null;
  }
  const same = parent.every((segment, index) => segment.normalize('NFC') === segments[index].normalize('NFC'));
  return same ? segments.at(-1)! : null;
};

const relativeSegments = (relative: string) => {
  const trimmed = relative.replaceAll(/^\/+|\/+$/g, '');
  if (trimmed === '') {
    return [];
  }
  const segments = trimmed.split('/');
  if (segments.some((segment) => !isSafeSegment(segment))) {
    throw new RemoteSourceError('This path cannot be used');
  }
  return segments;
};

const changed = () => new TakeoutStagingError('The file changed at the source while it was downloading');
const plainTag = (etag: string) => etag.replace(/^W\//, '');

/** Drops the first `count` bytes, for a server that answered a range request with the whole file. */
const skipBytes = (count: number) => {
  let remaining = count;
  return new Transform({
    transform(chunk: Buffer, _encoding, callback) {
      if (remaining >= chunk.length) {
        remaining -= chunk.length;
        callback();
        return;
      }
      const rest = chunk.subarray(remaining);
      remaining = 0;
      callback(null, rest);
    },
    flush(callback) {
      callback(remaining > 0 ? changed() : null);
    },
  });
};

export type WebDavCredentials = { url: string; username: string; password: string; allowPrivateAddress: boolean };

export class WebDavSource implements RemoteSource {
  readonly #authorization: string;
  readonly #base: string;
  readonly #policy: { allowPrivateAddress: boolean };
  readonly #fetcher?: WebDavFetch;

  constructor(credentials: WebDavCredentials, fetcher?: WebDavFetch) {
    this.#authorization = `Basic ${Buffer.from(`${credentials.username}:${credentials.password}`).toString('base64')}`;
    this.#base = credentials.url;
    this.#policy = { allowPrivateAddress: credentials.allowPrivateAddress };
    this.#fetcher = fetcher;
  }

  private urlFor(relative: string, isFolder: boolean) {
    const segments = relativeSegments(relative);
    const encoded = segments.map((segment) => encodeURIComponent(segment)).join('/');
    return `${this.#base}${encoded}${encoded && isFolder ? '/' : ''}`;
  }

  /** The direct children of a folder, each once, with hrefs that are not direct children ignored. */
  private async children(folder: string, stop?: AbortSignal) {
    const timeout = AbortSignal.timeout(LISTING_TIMEOUT_MS);
    const { response, url } = await webdavRequest(
      this.urlFor(folder, true),
      {
        method: 'PROPFIND',
        headers: { depth: '1', 'content-type': 'application/xml; charset=utf-8', 'accept-encoding': 'identity' },
        body: PROPFIND_BODY,
        signal: stop ? AbortSignal.any([stop, timeout]) : timeout,
        stop,
        authorization: this.#authorization,
        policy: this.#policy,
      },
      this.#fetcher,
    );
    if (response.status !== 207 || !response.body) {
      await response.body?.cancel();
      throw new RemoteSourceError(
        response.status === 404
          ? 'This folder is not at the source'
          : `The server did not answer as a WebDAV folder (${response.status})`,
      );
    }
    const declared = Number(response.headers.get('content-length') ?? 0);
    if (declared > WEBDAV_XML_LIMITS.maxBytes) {
      await response.body.cancel();
      throw new RemoteSourceError('The server sent a folder listing that is too large');
    }
    let entries: WebDavEntry[];
    try {
      entries = await readMultistatus(response.body);
    } catch (error) {
      if (error instanceof RemoteSourceError || stop?.aborted) {
        throw error;
      }
      throw new RemoteSourceError('The folder listing could not be read');
    }
    const seen = new Set<string>();
    const children: Array<WebDavEntry & { name: string }> = [];
    for (const entry of entries) {
      const name = childName(entry.href, url);
      if (name !== null && !seen.has(name)) {
        seen.add(name);
        children.push({ ...entry, name });
      }
    }
    return children;
  }

  async listFolders(path: string): Promise<RemoteFolder[]> {
    const prefix = relativeSegments(path).join('/');
    const children = await this.children(prefix);
    return children
      .filter(({ isCollection, name }) => isCollection && !isSkippedName(name, true))
      .map(({ name }) => ({ path: prefix ? `${prefix}/${name}` : name, name }))
      .toSorted((a, b) => (a.name < b.name ? -1 : Number(a.name > b.name)));
  }

  /** Walks one Depth 1 listing at a time. A limit stops the scan, so a partial walk never stores a cursor. */
  async *scan(roots: string[], _cursor: unknown, signal: AbortSignal): AsyncGenerator<RemoteScanBatch> {
    const starts = roots.length === 0 ? [''] : roots.map((root) => relativeSegments(root).join('/'));
    const stack = (starts.includes('') ? [''] : [...new Set(starts)]).map((path) => ({ path, depth: 0 }));
    const visited = new Set<string>();
    let entriesSeen = 0;
    let batch: RemoteItem[] = [];

    while (stack.length > 0) {
      signal.throwIfAborted();
      const { path: folder, depth } = stack.pop()!;
      if (visited.has(folder)) {
        continue;
      }
      visited.add(folder);
      if (visited.size > WEBDAV_MAX_FOLDERS) {
        throw new RemoteSourceError('This source has too many folders to import at once. Choose fewer folders.');
      }
      for (const entry of await this.children(folder, signal)) {
        if (++entriesSeen > WEBDAV_MAX_ENTRIES) {
          throw new RemoteSourceError('This source has too many files to import at once. Choose fewer folders.');
        }
        if (isSkippedName(entry.name, entry.isCollection)) {
          continue;
        }
        const path = folder ? `${folder}/${entry.name}` : entry.name;
        if (entry.isCollection) {
          if (depth + 1 > WEBDAV_MAX_DEPTH) {
            throw new RemoteSourceError('These folders are nested too deeply to import. Choose a folder further down.');
          }
          stack.push({ path, depth: depth + 1 });
        } else if (mimeTypes.isAsset(entry.name)) {
          batch.push({
            remoteId: path,
            path,
            // A missing size or date fails the framework's check, so the file is counted as rejected.
            size: entry.size ?? -1,
            modifiedAt: new Date(entry.modifiedAt ?? NaN),
            contentHash: entry.etag,
            albumHint: folder || null,
            favourite: entry.favourite,
          });
        }
        if (batch.length >= BATCH_SIZE) {
          yield { items: batch };
          batch = [];
        }
      }
    }
    yield { items: batch, cursor: { listedAt: new Date().toISOString() } };
  }

  async open(
    remoteId: string,
    { start, contentHash }: { start: number; contentHash?: string },
    signal: AbortSignal,
  ): Promise<Readable> {
    const headers: Record<string, string> = { 'accept-encoding': 'identity' };
    if (start > 0) {
      headers.range = `bytes=${start}-`;
      if (contentHash && !contentHash.startsWith('W/')) {
        headers['if-range'] = contentHash;
      }
    }
    const { response } = await webdavRequest(
      this.urlFor(remoteId, false),
      { method: 'GET', headers, signal, stop: signal, authorization: this.#authorization, policy: this.#policy },
      this.#fetcher,
    );
    const refuse = async (error: Error) => {
      await response.body?.cancel();
      throw error;
    };
    if (response.status === 404) {
      return refuse(new RemoteSourceError('The file is no longer at the source'));
    }
    if (start > 0 && response.status === 416) {
      return refuse(changed());
    }
    if ((response.status !== 200 && response.status !== 206) || !response.body) {
      return refuse(new RemoteSourceError(`The server answered ${response.status}`));
    }
    if (start === 0) {
      if (response.status === 206) {
        return refuse(new RemoteSourceError('The server sent part of a file that was asked for whole'));
      }
      return Readable.fromWeb(response.body as never);
    }

    // Resuming: the bytes must continue the same file at exactly this offset, or the download restarts.
    const encoding = response.headers.get('content-encoding');
    const etag = response.headers.get('etag');
    if (
      (encoding && encoding.toLowerCase() !== 'identity') ||
      (etag && contentHash && plainTag(etag) !== plainTag(contentHash))
    ) {
      return refuse(changed());
    }
    if (response.status === 206) {
      const range = /^bytes (\d+)-\d+\/(?:\d+|\*)$/.exec(response.headers.get('content-range')?.trim() ?? '');
      if (!range || Number(range[1]) !== start) {
        return refuse(changed());
      }
      return Readable.fromWeb(response.body as never);
    }
    return pipeline(Readable.fromWeb(response.body as never), skipBytes(start), () => {});
  }
}

const text = (value: unknown) => (typeof value === 'string' ? value : '');

export const webdavRemoteSourceProvider: RemoteSourceProvider & {
  open(credentials: Record<string, unknown>): WebDavSource;
} = {
  provider: WEBDAV_PROVIDER,
  credentials(input) {
    const username = text(input.username).trim();
    const password = text(input.password);
    const allowPrivateAddress = input.allowPrivateAddress === true;
    // eslint-disable-next-line no-control-regex
    if (!username || username.length > 256 || username.includes(':') || /[\u{0}-\u{1F}\u{7F}]/u.test(username)) {
      throw new RemoteSourceError('Enter a valid user name');
    }
    if (password.length < PASSWORD_MIN || password.length > 1024) {
      throw new RemoteSourceError(`The app password must be at least ${PASSWORD_MIN} characters`);
    }
    const url = checkSourceUrl(text(input.url).trim(), { allowPrivateAddress });
    if (url.search || url.hash) {
      throw new RemoteSourceError('Enter the address without anything after a ? or #');
    }
    let pathname = url.pathname.endsWith('/') ? url.pathname : `${url.pathname}/`;
    if (input.nextcloud === true) {
      // The name becomes a path segment, so `..` must not climb out of the files folder.
      if (!isSafeSegment(username)) {
        throw new RemoteSourceError('Enter a valid user name');
      }
      // Always this user's own files folder, also when a longer WebDAV address was pasted.
      const [install] = pathname.split('/remote.php/', 1);
      pathname = `${install.replace(/\/$/, '')}/remote.php/dav/files/${encodeURIComponent(username)}/`;
    }
    return { url: `${url.origin}${pathname}`, username, password, allowPrivateAddress };
  },
  open: (credentials) => new WebDavSource(credentials as WebDavCredentials),
};
