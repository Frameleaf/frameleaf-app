import path from 'node:path';
import { PassThrough, Readable, pipeline } from 'node:stream';
import { setTimeout as sleep } from 'node:timers/promises';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { BrokerAccessToken, type ProviderSignInBroker } from 'src/import-connectors/broker-sign-in.js';
import {
  type RemoteCursor,
  type RemoteFolder,
  type RemoteItem,
  type RemoteScanBatch,
  type RemoteSource,
  RemoteSourceAuthError,
  RemoteSourceError,
  type RemoteSourceProvider,
  type RemoteSourceSession,
  RemoteSourceUnavailableError,
} from 'src/import-connectors/remote-source.js';
import { TakeoutStagingError } from 'src/repositories/takeout-staging.repository.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/**
 * Dropbox as an import source (FL-959). It only reads: the routes below are the listing, download and
 * account routes, the sign-in holds read scopes only, and requests go to Dropbox's two API hosts and
 * nowhere else, with redirects refused. What Dropbox says in an error is never passed on.
 */
export const DROPBOX_PROVIDER = 'dropbox';

const API = 'https://api.dropboxapi.com/2';
const CONTENT = 'https://content.dropboxapi.com/2';

const PAGE_SIZE = 2000;
const REQUEST_TIMEOUT_MS = 60_000;
const DOWNLOAD_STALL_MS = 3 * 60_000;
/** Tries of one request through rate limits and passing failures. */
const MAX_ATTEMPTS = 6;
/** The longest wait the job sits through. A longer one fails the request and the pause still holds. */
const MAX_WAIT_MS = 15 * 60_000;
const CURSOR_VERSION = 1;

export type DropboxHttp = (url: string, init: RequestInit) => Promise<Response>;
export type DropboxOptions = {
  http?: DropboxHttp;
  wait?: (ms: number, signal: AbortSignal) => Promise<void>;
  now?: () => number;
};

type Entry = {
  '.tag'?: string;
  id?: unknown;
  name?: unknown;
  path_display?: unknown;
  size?: unknown;
  client_modified?: unknown;
  server_modified?: unknown;
  content_hash?: unknown;
  is_downloadable?: unknown;
  symlink_info?: unknown;
};
type Page = { entries: Entry[]; cursor: string; has_more: boolean };

/** Until when Dropbox asked an account to wait: every source of that account in this process honours it. */
const pausedUntil = new Map<string, number>();
export const forgetDropboxPauses = () => pausedUntil.clear();

/** Dropbox reads JSON from a header, which must stay ASCII. */
const headerJson = (value: unknown) =>
  JSON.stringify(value).replaceAll(
    /[^ -~]/g,
    (character) => String.raw`\u${character.codePointAt(0)!.toString(16).padStart(4, '0')}`,
  );

const relative = (value: string) => value.replace(/^\/+/, '').replace(/\/+$/, '');
const apiPath = (folder: string) => (relative(folder) ? `/${relative(folder)}` : '');

/** The folders to list: a folder inside another chosen folder is already covered by it. */
export const dropboxRoots = (roots: string[]) => {
  const cleaned = roots.map((root) => relative(root));
  if (cleaned.length === 0 || cleaned.includes('')) {
    return [''];
  }
  const unique = new Map(cleaned.map((root) => [root.toLowerCase(), root])).values().toArray();
  const lower = unique.map((root) => root.toLowerCase());
  return unique.filter((root) => lower.every((other) => !root.toLowerCase().startsWith(`${other}/`)));
};

/** Camera Uploads stays in the timeline only; every other folder is an album. */
export const dropboxAlbumHint = (filePath: string) => {
  const folder = path.posix.dirname(filePath);
  if (folder === '.' || folder.split('/', 1)[0].toLowerCase() === 'camera uploads') {
    return null;
  }
  return folder;
};

const dateOf = (...values: unknown[]) => {
  for (const value of values) {
    const date = typeof value === 'string' ? new Date(value) : undefined;
    if (date && !Number.isNaN(date.getTime())) {
      return date;
    }
  }
  return null;
};

/** A photo or video Dropbox can hand over; everything else at the source is left out of the scan. */
const toItem = (entry: Entry): RemoteItem | null => {
  if (
    entry['.tag'] !== 'file' ||
    entry.is_downloadable === false ||
    entry.symlink_info ||
    typeof entry.id !== 'string' ||
    typeof entry.path_display !== 'string' ||
    typeof entry.size !== 'number'
  ) {
    return null;
  }
  const filePath = relative(entry.path_display);
  const modifiedAt = dateOf(entry.client_modified, entry.server_modified);
  if (!modifiedAt || !mimeTypes.isAsset(path.posix.basename(filePath))) {
    return null;
  }
  return {
    remoteId: entry.id,
    path: filePath,
    size: entry.size,
    modifiedAt,
    contentHash: typeof entry.content_hash === 'string' ? entry.content_hash : undefined,
    albumHint: dropboxAlbumHint(filePath),
  };
};

const savedCursors = (cursor: RemoteCursor | null): Record<string, string> => {
  if (cursor?.version !== CURSOR_VERSION || typeof cursor.roots !== 'object' || cursor.roots === null) {
    return {};
  }
  return Object.fromEntries(
    Object.entries(cursor.roots).filter((entry): entry is [string, string] => typeof entry[1] === 'string'),
  );
};

const errorSummary = async (response: Response) => {
  try {
    const body = (await response.json()) as { error_summary?: unknown };
    return typeof body.error_summary === 'string' ? body.error_summary : '';
  } catch {
    return '';
  }
};

const discard = async (response: Response) => {
  try {
    await response.body?.cancel();
  } catch {
    // Nothing more is wanted from this answer.
  }
};

/** Fails a download that stops sending, which would otherwise hold its job for ever. */
const watched = (body: Readable) => {
  let timer: NodeJS.Timeout | undefined;
  const output = new PassThrough();
  const arm = () => {
    clearTimeout(timer);
    timer = setTimeout(
      () => output.destroy(new RemoteSourceError('Dropbox stopped sending the file')),
      DOWNLOAD_STALL_MS,
    );
    timer.unref();
  };
  const counter = new PassThrough();
  counter.on('data', arm);
  arm();
  pipeline(body, counter, output, () => clearTimeout(timer));
  return output;
};

export class DropboxSource implements RemoteSource {
  private http: DropboxHttp;
  private wait: (ms: number, signal: AbortSignal) => Promise<void>;
  private now: () => number;

  constructor(
    private tokens: Pick<BrokerAccessToken, 'get'>,
    private accountId: string,
    options: DropboxOptions = {},
  ) {
    this.http = options.http ?? ((url, init) => fetch(url, init));
    this.wait = options.wait ?? ((ms, signal) => sleep(ms, undefined, { signal }).then(() => {}));
    this.now = options.now ?? Date.now;
  }

  async listFolders(folder: string): Promise<RemoteFolder[]> {
    const signal = AbortSignal.timeout(5 * 60_000);
    const folders: RemoteFolder[] = [];
    let page = await this.list(apiPath(folder), false, signal);
    if (!page) {
      throw new RemoteSourceError('That folder is no longer in Dropbox');
    }
    for (;;) {
      for (const entry of page.entries) {
        if (entry['.tag'] === 'folder' && typeof entry.path_display === 'string' && typeof entry.name === 'string') {
          folders.push({ path: relative(entry.path_display), name: entry.name });
        }
      }
      if (!page.has_more) {
        return folders.toSorted((a, b) => a.name.localeCompare(b.name));
      }
      page = (await this.more(page.cursor, signal)) ?? { entries: [], cursor: page.cursor, has_more: false };
    }
  }

  async *scan(roots: string[], cursor: RemoteCursor | null, signal: AbortSignal): AsyncIterable<RemoteScanBatch> {
    const saved = savedCursors(cursor);
    const reached: Record<string, string> = {};
    const stamp = () => ({ version: CURSOR_VERSION, roots: { ...reached } });

    for (const root of dropboxRoots(roots)) {
      const key = root.toLowerCase();
      const from = saved[key];
      // A cursor Dropbox has invalidated means listing the folder again; the framework skips what it has seen.
      let page = (from ? await this.more(from, signal) : null) ?? (await this.list(apiPath(root), true, signal));
      while (page) {
        reached[key] = page.cursor;
        const items = page.entries.flatMap((entry) => toItem(entry) ?? []);
        yield { items, cursor: stamp() };
        if (!page.has_more) {
          break;
        }
        page = (await this.more(page.cursor, signal)) ?? (await this.list(apiPath(root), true, signal));
      }
    }
    // The last cursor names every folder that was reached, however the final one ended.
    yield { items: [], cursor: stamp() };
  }

  async open(
    remoteId: string,
    { start, contentHash }: { start: number; contentHash?: string },
    signal: AbortSignal,
  ): Promise<Readable> {
    const response = await this.send(
      `${CONTENT}/files/download`,
      {
        method: 'POST',
        headers: {
          'Dropbox-API-Arg': headerJson({ path: remoteId }),
          ...(start > 0 && { Range: `bytes=${start}-` }),
        },
      },
      signal,
      true,
    );
    if (response.status === 409) {
      const summary = await errorSummary(response);
      throw new RemoteSourceError(
        summary.startsWith('path/not_found')
          ? 'The file is no longer in Dropbox'
          : 'Dropbox would not hand over this file',
      );
    }
    if (start > 0 && response.status === 416) {
      await discard(response);
      throw new TakeoutStagingError('The file changed in Dropbox while it was downloading');
    }
    if (!response.ok || !response.body) {
      await discard(response);
      throw new RemoteSourceError('Dropbox would not hand over this file');
    }
    if (start > 0) {
      const resumedAt = /^bytes (\d+)-/.exec(response.headers.get('content-range') ?? '')?.[1];
      if (response.status !== 206 || Number(resumedAt) !== start || !this.sameVersion(response, contentHash)) {
        await discard(response);
        // Thrown as a staging failure so the partial file is dropped and the next try starts from the top.
        throw new TakeoutStagingError('The file changed in Dropbox while it was downloading');
      }
    }
    return watched(Readable.fromWeb(response.body as WebReadableStream));
  }

  private sameVersion(response: Response, expected: string | undefined) {
    if (!expected) {
      return true;
    }
    try {
      const result = JSON.parse(response.headers.get('dropbox-api-result') ?? '') as { content_hash?: unknown };
      return result.content_hash === expected;
    } catch {
      return false;
    }
  }

  /** One page of a folder. Null when the folder is not there: it has simply nothing to list. */
  private async list(folder: string, recursive: boolean, signal: AbortSignal): Promise<Page | null> {
    const response = await this.rpc(
      'files/list_folder',
      { path: folder, recursive, include_deleted: false, include_non_downloadable_files: false, limit: PAGE_SIZE },
      signal,
    );
    if (response.status === 409) {
      const summary = await errorSummary(response);
      if (summary.startsWith('path/not_found')) {
        return null;
      }
      throw new RemoteSourceError('Dropbox would not list this folder');
    }
    return this.page(response);
  }

  /** The next page after `cursor`. Null when Dropbox has reset the cursor and the folder must be listed again. */
  private async more(cursor: string, signal: AbortSignal): Promise<Page | null> {
    const response = await this.rpc('files/list_folder/continue', { cursor }, signal);
    if (response.status === 409) {
      const summary = await errorSummary(response);
      if (summary.startsWith('reset') || summary.startsWith('path/not_found')) {
        return null;
      }
      throw new RemoteSourceError('Dropbox would not list this folder');
    }
    return this.page(response);
  }

  private async page(response: Response): Promise<Page> {
    if (!response.ok) {
      await discard(response);
      throw new RemoteSourceError('Dropbox would not list this folder');
    }
    const body = (await response.json().catch(() => null)) as Partial<Page> | null;
    if (!body || !Array.isArray(body.entries) || typeof body.cursor !== 'string') {
      throw new RemoteSourceError('Dropbox sent an answer that could not be read');
    }
    return { entries: body.entries, cursor: body.cursor, has_more: body.has_more === true };
  }

  private rpc(route: string, body: unknown, signal: AbortSignal) {
    return this.send(
      `${API}/${route}`,
      { method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body) },
      signal,
      false,
    );
  }

  /** Wait out a pause Dropbox asked this account for, without sending anything meanwhile. */
  private async honourPause(signal: AbortSignal) {
    const until = pausedUntil.get(this.accountId);
    if (until === undefined) {
      return;
    }
    const remaining = until - this.now();
    if (remaining <= 0) {
      pausedUntil.delete(this.accountId);
      return;
    }
    if (remaining > MAX_WAIT_MS) {
      throw new RemoteSourceUnavailableError('Dropbox asked Frameleaf to slow down. Try again later.');
    }
    await this.wait(remaining, signal);
  }

  private pause(response: Response, attempt: number) {
    const header = response.headers.get('retry-after');
    const seconds = header && /^\d+$/.test(header.trim()) ? Number(header) : 2 ** attempt;
    const until = this.now() + seconds * 1000;
    pausedUntil.set(this.accountId, Math.max(until, pausedUntil.get(this.accountId) ?? 0));
  }

  /**
   * One request. A refused access token is renewed once. Rate limits and passing failures are retried
   * a bounded number of times, and all requests for the account wait out `Retry-After` together.
   */
  private async send(url: string, init: RequestInit, signal: AbortSignal, stream: boolean): Promise<Response> {
    let refused: string | undefined;
    for (let attempt = 1; ; attempt++) {
      signal.throwIfAborted();
      await this.honourPause(signal);
      const token = await this.tokens.get(refused);
      const deadline = new AbortController();
      const timer = setTimeout(() => deadline.abort(), REQUEST_TIMEOUT_MS);
      let response: Response;
      try {
        response = await this.http(url, {
          ...init,
          headers: { ...init.headers, Authorization: `Bearer ${token}` },
          redirect: 'error',
          // A download's body outlives this deadline and is watched for stalls instead.
          signal: stream
            ? AbortSignal.any([signal, deadline.signal])
            : AbortSignal.any([signal, AbortSignal.timeout(REQUEST_TIMEOUT_MS)]),
        });
      } catch {
        signal.throwIfAborted();
        if (attempt >= MAX_ATTEMPTS) {
          throw new RemoteSourceError('Dropbox could not be reached');
        }
        await this.wait(2 ** attempt * 1000, signal);
        continue;
      } finally {
        clearTimeout(timer);
      }

      if (response.status === 401) {
        await discard(response);
        if (refused) {
          throw new RemoteSourceAuthError('Dropbox no longer accepts this sign-in. Sign in again.');
        }
        refused = token;
        continue;
      }
      if (response.status === 429 || response.status >= 500) {
        const limited = response.status === 429 || response.headers.has('retry-after');
        if (limited) {
          this.pause(response, attempt);
        }
        await discard(response);
        if (attempt >= MAX_ATTEMPTS) {
          throw limited
            ? new RemoteSourceUnavailableError('Dropbox asked Frameleaf to slow down. Try again later.')
            : new RemoteSourceError('Dropbox is not answering right now');
        }
        if (!limited) {
          await this.wait(2 ** attempt * 1000, signal);
        }
        continue;
      }
      return response;
    }
  }
}

const accountRequest = async (http: DropboxHttp, route: string, accessToken: string) =>
  http(`${API}/${route}`, {
    method: 'POST',
    headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
    body: 'null',
    redirect: 'error',
    signal: AbortSignal.timeout(REQUEST_TIMEOUT_MS),
  });

/** Dropbox as a provider: connected only by signing in through the Frameleaf Cloud broker. */
export const dropboxRemoteSourceProvider = (
  broker: Pick<ProviderSignInBroker, 'target' | 'refresh'>,
  options: DropboxOptions = {},
): RemoteSourceProvider => {
  const http = options.http ?? ((url, init) => fetch(url, init));
  return {
    provider: DROPBOX_PROVIDER,
    credentials() {
      throw new RemoteSourceError('Connect Dropbox by signing in');
    },
    signIn: {
      service: 'dropbox',
      label: 'Dropbox',
      account: async (accessToken) => {
        let response;
        try {
          response = await accountRequest(http, 'users/get_current_account', accessToken);
        } catch {
          throw new RemoteSourceError('Dropbox could not be reached');
        }
        const body = response.ok
          ? ((await response.json().catch(() => null)) as {
              account_id?: unknown;
              name?: { display_name?: unknown };
            } | null)
          : null;
        if (typeof body?.account_id !== 'string') {
          await discard(response);
          throw new RemoteSourceError('Dropbox did not say which account signed in. Start again.');
        }
        const name = body.name?.display_name;
        return { id: body.account_id, name: typeof name === 'string' && name.trim() ? name.trim() : 'Dropbox' };
      },
    },
    // Dropbox revokes by access token, which also ends the refresh token behind it.
    async revoke(credentials) {
      if (typeof credentials.refreshToken !== 'string') {
        return;
      }
      const { accessToken } = await broker.refresh('dropbox', credentials.refreshToken);
      const response = await accountRequest(http, 'auth/token/revoke', accessToken);
      await discard(response);
      if (!response.ok) {
        throw new RemoteSourceError('Dropbox did not confirm the sign-in was revoked');
      }
    },
    open(credentials, session?: RemoteSourceSession) {
      if (typeof credentials.refreshToken !== 'string' || typeof credentials.accountId !== 'string') {
        throw new RemoteSourceAuthError('The saved sign-in can no longer be read. Sign in again.');
      }
      if (!session) {
        throw new RemoteSourceError('This Dropbox sign-in cannot be used here');
      }
      return new DropboxSource(
        new BrokerAccessToken(broker, 'dropbox', session, options.now),
        credentials.accountId,
        options,
      );
    },
  };
};
