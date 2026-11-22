import path from 'node:path';
import { Readable } from 'node:stream';
import type { ReadableStream as WebReadableStream } from 'node:stream/web';
import { BrokerAccessToken, type ProviderSignInBroker } from 'src/import-connectors/broker-sign-in.js';
import {
  ProviderHttp,
  type ProviderHttpOptions,
  discard,
  watchedDownload,
} from 'src/import-connectors/provider-http.js';
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
} from 'src/import-connectors/remote-source.js';
import { TakeoutStagingError } from 'src/repositories/takeout-staging.repository.js';
import { mimeTypes } from 'src/utils/mime-types.js';

/**
 * Google Drive as an import source (FL-974), on the `drive.file` scope with Google's own picker (owner
 * decision FL-896). A connection's roots are the ids of the items the person picked in Google's window.
 *
 * Google's documentation does not say whether picking a folder grants its contents or files added to
 * it later, so nothing here assumes it: a scan reads what the API actually returns for each picked id,
 * and a picked folder showing nothing is an error the owner can read rather than an empty success.
 *
 * It only reads: every request is a GET to `www.googleapis.com`, redirects are refused, and what Google
 * says in an error is never passed on.
 */
export const GOOGLE_DRIVE_PROVIDER = 'google-drive';

const API = 'https://www.googleapis.com/drive/v3';
const FOLDER = 'application/vnd.google-apps.folder';
const SHORTCUT = 'application/vnd.google-apps.shortcut';
const GOOGLE_APPS = 'application/vnd.google-apps.';
const FILE_FIELDS =
  'id,name,mimeType,size,modifiedTime,createdTime,md5Checksum,sha256Checksum,headRevisionId,trashed,parents,' +
  'shortcutDetails(targetId,targetMimeType),capabilities(canDownload)';
const PAGE_SIZE = 1000;
const CURSOR_VERSION = 1;
const MAX_DEPTH = 256;
/** Reasons Google gives on a 403 that mean "slow down". https://developers.google.com/workspace/drive/api/guides/handle-errors */
const RATE_LIMIT_REASONS = new Set(['rateLimitExceeded', 'userRateLimitExceeded']);

export const NOTHING_VISIBLE =
  'Google Drive showed Frameleaf nothing inside the folders you picked. Open Google’s picker and select the photos and videos themselves.';
const PICKED_GONE = 'Google Drive no longer shows Frameleaf the items you picked. Pick them again.';
const NOTHING_PICKED = 'Choose what to import in Google’s picker first.';

export type GooglePicker = { apiKey: string; appId: string };
export type GoogleDriveOptions = ProviderHttpOptions & { picker?: () => GooglePicker | null };

type DriveFile = {
  id?: unknown;
  name?: unknown;
  mimeType?: unknown;
  size?: unknown;
  modifiedTime?: unknown;
  createdTime?: unknown;
  md5Checksum?: unknown;
  sha256Checksum?: unknown;
  headRevisionId?: unknown;
  trashed?: unknown;
  parents?: unknown;
  shortcutDetails?: { targetId?: unknown; targetMimeType?: unknown } | null;
  capabilities?: { canDownload?: unknown } | null;
};
type Listed = DriveFile & { id: string; name: string; mimeType: string };
type Location = { path: string; albumHint: string | null };

/** Drive's ids are URL-safe. Anything else is never put in a query or a URL. */
export const isDriveId = (value: unknown): value is string =>
  typeof value === 'string' && /^[A-Za-z0-9_-]{1,256}$/.test(value);

/** The picked ids, each once. */
export const googleDriveRoots = (roots: string[]) => [...new Set(roots.filter((root) => isDriveId(root)))];

const isListed = (file: DriveFile): file is Listed =>
  isDriveId(file.id) && typeof file.name === 'string' && typeof file.mimeType === 'string';

/** Drive allows a `/` in a name; here it would read as a folder. */
const segment = (name: string) => name.replaceAll('/', '_');

const versionOf = (file: DriveFile) => {
  for (const value of [file.md5Checksum, file.sha256Checksum, file.headRevisionId]) {
    if (typeof value === 'string' && value) {
      return value;
    }
  }
};

const sizeOf = (file: DriveFile) => {
  const size = typeof file.size === 'string' && /^\d+$/.test(file.size) ? Number(file.size) : NaN;
  return Number.isSafeInteger(size) ? size : null;
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

/** A photo or video Drive can hand over; Docs, Sheets and everything else are left out. */
const toItem = (file: Listed, location: Location): RemoteItem | null => {
  const size = sizeOf(file);
  const modifiedAt = dateOf(file.modifiedTime, file.createdTime);
  if (
    file.mimeType.startsWith(GOOGLE_APPS) ||
    file.trashed === true ||
    file.capabilities?.canDownload === false ||
    size === null ||
    !modifiedAt ||
    !mimeTypes.isAsset(path.posix.basename(location.path))
  ) {
    return null;
  }
  return {
    remoteId: file.id,
    path: location.path,
    size,
    modifiedAt,
    contentHash: versionOf(file),
    albumHint: location.albumHint,
  };
};

const reasonOf = async (response: Response) => {
  try {
    const body = (await response.clone().json()) as { error?: { errors?: Array<{ reason?: unknown }> } };
    const reason = body.error?.errors?.[0]?.reason;
    return typeof reason === 'string' ? reason : '';
  } catch {
    return '';
  }
};

const rateLimited = async (response: Response) =>
  response.status === 403 && RATE_LIMIT_REASONS.has(await reasonOf(response));

const savedCursor = (cursor: RemoteCursor | null) => {
  if (
    cursor?.version !== CURSOR_VERSION ||
    typeof cursor.pageToken !== 'string' ||
    !cursor.pageToken ||
    !Array.isArray(cursor.roots) ||
    cursor.roots.some((root) => typeof root !== 'string')
  ) {
    return null;
  }
  return { pageToken: cursor.pageToken, roots: cursor.roots as string[] };
};

export class GoogleDriveSource implements RemoteSource {
  private http: ProviderHttp;

  constructor(tokens: Pick<BrokerAccessToken, 'get'>, accountId: string, options: ProviderHttpOptions = {}) {
    this.http = new ProviderHttp('Google Drive', tokens, accountId, options);
  }

  /** The folders the API shows this app: at the top, whatever was granted; inside a folder, its visible folders. */
  async listFolders(folder: string): Promise<RemoteFolder[]> {
    const signal = AbortSignal.timeout(5 * 60_000);
    if (folder && !isDriveId(folder)) {
      throw new RemoteSourceError('That folder is no longer in Google Drive');
    }
    const query = folder
      ? `'${folder}' in parents and mimeType='${FOLDER}' and trashed=false`
      : `mimeType='${FOLDER}' and trashed=false`;
    const folders: RemoteFolder[] = [];
    for await (const page of this.pages(query, signal)) {
      for (const file of page) {
        folders.push({ path: file.id, name: file.name });
      }
    }
    return folders.toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async *scan(roots: string[], cursor: RemoteCursor | null, signal: AbortSignal): AsyncIterable<RemoteScanBatch> {
    const picked = googleDriveRoots(roots);
    if (picked.length === 0) {
      throw new RemoteSourceError(NOTHING_PICKED);
    }
    const known = new Map<string, Listed>();
    const visibleRoots: Listed[] = [];
    for (const id of picked) {
      const file = await this.file(id, signal);
      if (file && file.trashed !== true) {
        known.set(id, file);
        visibleRoots.push(file);
      }
    }
    if (visibleRoots.length === 0) {
      throw new RemoteSourceError(PICKED_GONE);
    }

    const saved = savedCursor(cursor);
    if (saved && picked.every((root) => saved.roots.includes(root))) {
      const next = yield* this.changes(saved.pageToken, picked, known, signal);
      if (next) {
        yield { items: [], cursor: { version: CURSOR_VERSION, pageToken: next, roots: picked } };
        return;
      }
      // Google refused the saved position. Listing again is safe: the framework skips what it has seen.
    }

    // Taken before the listing, so a change made while it runs is seen by the next scan.
    const pageToken = await this.startToken(signal);
    const seen = new Set<string>();
    let visible = 0;
    let folders = 0;
    for (const root of visibleRoots) {
      if (root.mimeType === FOLDER || root.shortcutDetails?.targetMimeType === FOLDER) {
        folders++;
      }
      for await (const batch of this.walkEntry(root, null, seen, 0, signal)) {
        visible += batch.visible;
        yield { items: batch.items };
      }
    }
    // A picked file counts as visible through its own entry, so this is only ever about folders.
    if (folders > 0 && visible === 0) {
      throw new RemoteSourceError(NOTHING_VISIBLE);
    }
    yield { items: [], cursor: { version: CURSOR_VERSION, pageToken, roots: picked } };
  }

  async open(
    remoteId: string,
    { start, contentHash }: { start: number; contentHash?: string },
    signal: AbortSignal,
  ): Promise<Readable> {
    if (!isDriveId(remoteId)) {
      throw new RemoteSourceError('The file is no longer in Google Drive');
    }
    let expectedSize: number | null = null;
    if (start > 0) {
      const current = await this.file(remoteId, signal);
      if (!current) {
        throw new RemoteSourceError('The file is no longer in Google Drive');
      }
      if (contentHash && versionOf(current) !== contentHash) {
        throw new TakeoutStagingError('The file changed in Google Drive while it was downloading');
      }
      expectedSize = sizeOf(current);
    }
    const response = await this.http.send(
      `${API}/files/${remoteId}?alt=media`,
      { method: 'GET', headers: start > 0 ? { Range: `bytes=${start}-` } : {} },
      signal,
      { stream: true, limited: rateLimited },
    );
    if (response.status === 404) {
      await discard(response);
      throw new RemoteSourceError('The file is no longer in Google Drive');
    }
    if (start > 0 && response.status === 416) {
      await discard(response);
      throw new TakeoutStagingError('The file changed in Google Drive while it was downloading');
    }
    if (!response.ok || !response.body) {
      const daily = (await reasonOf(response)) === 'dailyLimitExceeded';
      await discard(response);
      throw new RemoteSourceError(
        daily
          ? 'Google Drive’s daily limit was reached. Try again tomorrow.'
          : 'Google Drive would not hand over this file',
      );
    }
    if (start > 0) {
      const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
      if (response.status !== 206 || Number(range?.[1]) !== start || Number(range?.[2]) !== expectedSize) {
        await discard(response);
        // Thrown as a staging failure so the partial file is dropped and the next try starts from the top.
        throw new TakeoutStagingError('The file changed in Google Drive while it was downloading');
      }
    }
    return watchedDownload(Readable.fromWeb(response.body as WebReadableStream), 'Google Drive');
  }

  private get(url: string, signal: AbortSignal) {
    return this.http.send(url, { method: 'GET', headers: { Accept: 'application/json' } }, signal, {
      limited: rateLimited,
    });
  }

  private async refused(response: Response): Promise<never> {
    const daily = (await reasonOf(response)) === 'dailyLimitExceeded';
    await discard(response);
    throw new RemoteSourceError(
      daily ? 'Google Drive’s daily limit was reached. Try again tomorrow.' : 'Google Drive would not list this folder',
    );
  }

  /** One item, or null when the API does not show it to this app. */
  private async file(id: string, signal: AbortSignal): Promise<Listed | null> {
    const response = await this.get(`${API}/files/${id}?fields=${encodeURIComponent(FILE_FIELDS)}`, signal);
    if (response.status === 404) {
      await discard(response);
      return null;
    }
    if (!response.ok) {
      return this.refused(response);
    }
    const body = (await response.json().catch(() => null)) as DriveFile | null;
    if (!body || !isListed(body)) {
      throw new RemoteSourceError('Google Drive sent an answer that could not be read');
    }
    return body;
  }

  private async startToken(signal: AbortSignal) {
    const response = await this.get(`${API}/changes/startPageToken?fields=startPageToken`, signal);
    if (!response.ok) {
      return this.refused(response);
    }
    const body = (await response.json().catch(() => null)) as { startPageToken?: unknown } | null;
    if (typeof body?.startPageToken !== 'string' || !body.startPageToken) {
      throw new RemoteSourceError('Google Drive sent an answer that could not be read');
    }
    return body.startPageToken;
  }

  /** Every page of a `files.list` query, only ever what Google returns for this app. */
  private async *pages(query: string, signal: AbortSignal): AsyncGenerator<Listed[]> {
    let pageToken: string | undefined;
    do {
      const parameters = new URLSearchParams({
        q: query,
        spaces: 'drive',
        corpora: 'user',
        pageSize: String(PAGE_SIZE),
        fields: `nextPageToken,incompleteSearch,files(${FILE_FIELDS})`,
      });
      if (pageToken) {
        parameters.set('pageToken', pageToken);
      }
      const response = await this.get(`${API}/files?${parameters}`, signal);
      if (!response.ok) {
        await this.refused(response);
      }
      const body = (await response.json().catch(() => null)) as {
        files?: unknown;
        nextPageToken?: unknown;
        incompleteSearch?: unknown;
      } | null;
      // A partial answer must not become a stored position that skips what it left out.
      if (!body || !Array.isArray(body.files) || body.incompleteSearch === true) {
        throw new RemoteSourceError('Google Drive sent an answer that could not be read');
      }
      yield (body.files as DriveFile[]).filter((file) => isListed(file));
      pageToken = typeof body.nextPageToken === 'string' && body.nextPageToken ? body.nextPageToken : undefined;
    } while (pageToken);
  }

  /**
   * One entry and what is under it. `folder` is the path of the folder it sits in, null for a picked
   * item. A shortcut is followed only when the API shows this app its target.
   */
  private async *walkEntry(
    entry: Listed,
    folder: string | null,
    seen: Set<string>,
    depth: number,
    signal: AbortSignal,
  ): AsyncGenerator<{ items: RemoteItem[]; visible: number }> {
    let file = entry;
    if (entry.mimeType === SHORTCUT) {
      const target = entry.shortcutDetails?.targetId;
      const resolved = isDriveId(target) ? await this.file(target, signal) : null;
      if (!resolved || resolved.trashed === true || resolved.mimeType === SHORTCUT) {
        return;
      }
      file = { ...resolved, name: resolved.mimeType === FOLDER ? entry.name : resolved.name };
    }
    if (seen.has(file.id) || depth > MAX_DEPTH) {
      return;
    }
    seen.add(file.id);
    const name = segment(file.name);
    const here = folder ? `${folder}/${name}` : name;
    if (file.mimeType !== FOLDER) {
      const item = toItem(file, { path: here, albumHint: folder });
      yield { items: item ? [item] : [], visible: 0 };
      return;
    }
    for await (const page of this.pages(`'${file.id}' in parents and trashed=false`, signal)) {
      const items: RemoteItem[] = [];
      const below: Listed[] = [];
      for (const child of page) {
        if (child.mimeType === FOLDER || child.mimeType === SHORTCUT) {
          below.push(child);
        } else if (!seen.has(child.id)) {
          seen.add(child.id);
          const item = toItem(child, { path: `${here}/${segment(child.name)}`, albumHint: here });
          if (item) {
            items.push(item);
          }
        }
      }
      yield { items, visible: page.length };
      for (const child of below) {
        yield* this.walkEntry(child, here, seen, depth + 1, signal);
      }
    }
  }

  /** Where a changed file sits under a picked folder, or null when it is not under one. */
  private async locate(file: Listed, picked: Set<string>, known: Map<string, Listed>, signal: AbortSignal) {
    if (picked.has(file.id)) {
      return { folder: null };
    }
    const names: string[] = [];
    let parent = Array.isArray(file.parents) ? (file.parents[0] as unknown) : undefined;
    for (let depth = 0; depth < MAX_DEPTH && isDriveId(parent); depth++) {
      let folder = known.get(parent) ?? null;
      if (!folder) {
        folder = await this.file(parent, signal);
        if (!folder) {
          return null;
        }
        known.set(parent, folder);
      }
      names.push(segment(folder.name));
      if (picked.has(parent)) {
        return { folder: names.toReversed().join('/') };
      }
      parent = Array.isArray(folder.parents) ? (folder.parents[0] as unknown) : undefined;
    }
    return null;
  }

  /**
   * What changed since `from`, under the picked items. Returns the position to store, or null when
   * Google no longer accepts `from`.
   */
  private async *changes(
    from: string,
    roots: string[],
    known: Map<string, Listed>,
    signal: AbortSignal,
  ): AsyncGenerator<RemoteScanBatch, string | null> {
    const picked = new Set(roots);
    const seen = new Set<string>();
    let pageToken = from;
    for (;;) {
      const parameters = new URLSearchParams({
        pageToken,
        pageSize: String(PAGE_SIZE),
        spaces: 'drive',
        includeRemoved: 'false',
        fields: `nextPageToken,newStartPageToken,changes(fileId,removed,file(${FILE_FIELDS}))`,
      });
      const response = await this.get(`${API}/changes?${parameters}`, signal);
      if ([400, 404, 410].includes(response.status)) {
        await discard(response);
        return null;
      }
      if (!response.ok) {
        await this.refused(response);
      }
      const body = (await response.json().catch(() => null)) as {
        changes?: unknown;
        nextPageToken?: unknown;
        newStartPageToken?: unknown;
      } | null;
      if (!body || !Array.isArray(body.changes)) {
        throw new RemoteSourceError('Google Drive sent an answer that could not be read');
      }
      const items: RemoteItem[] = [];
      for (const change of body.changes as Array<{ removed?: unknown; file?: DriveFile }>) {
        const file = change.file;
        if (change.removed === true || !file || !isListed(file) || file.trashed === true) {
          continue;
        }
        const place = await this.locate(file, picked, known, signal);
        if (!place) {
          continue;
        }
        // A folder moved in brings files the change list will not name, so it is read whole.
        for await (const batch of this.walkEntry(file, place.folder, seen, 0, signal)) {
          items.push(...batch.items);
        }
      }
      yield { items };
      if (typeof body.nextPageToken === 'string' && body.nextPageToken) {
        pageToken = body.nextPageToken;
        continue;
      }
      if (typeof body.newStartPageToken === 'string' && body.newStartPageToken) {
        return body.newStartPageToken;
      }
      throw new RemoteSourceError('Google Drive sent an answer that could not be read');
    }
  }
}

/** Google Drive as a provider: connected only by signing in through the Frameleaf Cloud broker. */
export const googleDriveRemoteSourceProvider = (
  broker: Pick<ProviderSignInBroker, 'target' | 'refresh' | 'revoke'>,
  options: GoogleDriveOptions = {},
): RemoteSourceProvider => {
  const http = options.http ?? ((url, init) => fetch(url, init));
  return {
    provider: GOOGLE_DRIVE_PROVIDER,
    credentials() {
      throw new RemoteSourceError('Connect Google Drive by signing in');
    },
    signIn: {
      service: 'google-drive',
      label: 'Google Drive',
      picker: () => options.picker?.() ?? null,
      account: async (accessToken) => {
        let response;
        try {
          response = await http(`${API}/about?fields=${encodeURIComponent('user(permissionId,displayName)')}`, {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(60_000),
          });
        } catch {
          throw new RemoteSourceError('Google Drive could not be reached');
        }
        const body = response.ok
          ? ((await response.json().catch(() => null)) as {
              user?: { permissionId?: unknown; displayName?: unknown };
            } | null)
          : null;
        const id = body?.user?.permissionId;
        if (typeof id !== 'string' || !id) {
          await discard(response);
          throw new RemoteSourceError('Google Drive did not say which account signed in. Start again.');
        }
        const name = body?.user?.displayName;
        return { id, name: typeof name === 'string' && name.trim() ? name.trim() : 'Google Drive' };
      },
    },
    async revoke(credentials) {
      if (typeof credentials.refreshToken === 'string') {
        await broker.revoke('google-drive', credentials.refreshToken);
      }
    },
    open(credentials, session?: RemoteSourceSession) {
      if (typeof credentials.refreshToken !== 'string' || typeof credentials.accountId !== 'string') {
        throw new RemoteSourceAuthError('The saved sign-in can no longer be read. Sign in again.');
      }
      if (!session) {
        throw new RemoteSourceError('This Google Drive sign-in cannot be used here');
      }
      return new GoogleDriveSource(
        new BrokerAccessToken(broker, 'google-drive', session, options.now),
        credentials.accountId,
        options,
      );
    },
  };
};
