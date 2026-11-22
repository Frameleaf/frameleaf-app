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
 * OneDrive as an import source (FL-972), personal and work or school. It only reads: every request is
 * a GET, the sign-in holds `Files.Read`, and requests go to Microsoft Graph and, without the token, to
 * the download hosts Microsoft documents. What Graph says in an error is never passed on.
 *
 * Graph's delta covers the whole drive and leaves paths out, so a scan keeps its own map of folders by
 * id and offers only what is under a chosen folder.
 */
export const ONEDRIVE_PROVIDER = 'onedrive';

const GRAPH = 'https://graph.microsoft.com/v1.0';
const DRIVE = `${GRAPH}/me/drive`;
const DELTA_START = `${DRIVE}/root/delta?$select=${[
  'id',
  'name',
  'size',
  'file',
  'folder',
  'package',
  'deleted',
  'remoteItem',
  'malware',
  'photo',
  'fileSystemInfo',
  'lastModifiedDateTime',
  'parentReference',
  'cTag',
  'specialFolder',
  'root',
].join(',')}`;
const CURSOR_VERSION = 1;
const MAX_DEPTH = 256;

/**
 * Where Microsoft documents file content being served: consumer OneDrive's download hosts and
 * SharePoint, which holds work and school OneDrive. A download address anywhere else is refused.
 * https://learn.microsoft.com/en-us/sharepoint/required-urls-and-ports
 * https://learn.microsoft.com/en-us/microsoft-365/enterprise/urls-and-ip-address-ranges
 */
const DOWNLOAD_HOST_SUFFIXES = [
  '.files.1drv.com',
  '.onedrive.live.com',
  '.storage.live.com',
  '.livefilestore.com',
  '.microsoftpersonalcontent.com',
  '.sharepoint.com',
];

export const isOneDriveDownloadUrl = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    const host = url.hostname.toLowerCase();
    return (
      url.protocol === 'https:' &&
      !url.username &&
      !url.password &&
      (url.port === '' || url.port === '443') &&
      DOWNLOAD_HOST_SUFFIXES.some((suffix) => host.endsWith(suffix) && host.length > suffix.length)
    );
  } catch {
    return false;
  }
};

/** A paging link Graph returned, or one saved from an earlier scan: only ever a drive route on Graph. */
const isGraphLink = (value: unknown): value is string => {
  if (typeof value !== 'string') {
    return false;
  }
  try {
    const url = new URL(value);
    return (
      url.origin === 'https://graph.microsoft.com' &&
      !url.username &&
      !url.password &&
      (url.pathname.startsWith('/v1.0/me/drive/') || url.pathname.startsWith('/v1.0/drives/'))
    );
  } catch {
    return false;
  }
};

type DriveItem = {
  id?: unknown;
  name?: unknown;
  size?: unknown;
  file?: { hashes?: Record<string, unknown> } | null;
  folder?: unknown;
  package?: unknown;
  deleted?: unknown;
  remoteItem?: unknown;
  malware?: unknown;
  photo?: { takenDateTime?: unknown } | null;
  fileSystemInfo?: { lastModifiedDateTime?: unknown } | null;
  lastModifiedDateTime?: unknown;
  parentReference?: { id?: unknown } | null;
  cTag?: unknown;
  specialFolder?: { name?: unknown } | null;
  root?: unknown;
  '@microsoft.graph.downloadUrl'?: unknown;
};
type Page = { value?: unknown; '@odata.nextLink'?: unknown; '@odata.deltaLink'?: unknown };
type Folder = { name: string; parentId: string | null; isRoot: boolean; cameraRoll: boolean };

const relative = (value: string) => value.replace(/^\/+/, '').replace(/\/+$/, '');

const itemPath = (folder: string) => {
  const segments = relative(folder).split('/');
  // `..` survives encoding and would climb out of the drive route once the URL is parsed.
  if (segments.some((segment) => ['', '.', '..'].includes(segment))) {
    throw new RemoteSourceError('That folder is no longer in OneDrive');
  }
  return segments.map((segment) => encodeURIComponent(segment)).join('/');
};

/** The folders to read: a folder inside another chosen folder is already covered by it. */
export const onedriveRoots = (roots: string[]) => {
  const cleaned = roots.map((root) => relative(root));
  if (cleaned.length === 0 || cleaned.includes('')) {
    return [''];
  }
  const unique = new Map(cleaned.map((root) => [root.toLowerCase(), root])).values().toArray();
  const lower = unique.map((root) => root.toLowerCase());
  return unique.filter((root) => lower.every((other) => !root.toLowerCase().startsWith(`${other}/`)));
};

const isUnder = (filePath: string, root: string) => {
  const file = filePath.toLowerCase();
  const folder = root.toLowerCase();
  return folder === '' || file.startsWith(`${folder}/`);
};

/** Camera Roll stays in the timeline only; every other folder is an album. */
export const onedriveAlbumHint = (filePath: string) => {
  const folder = path.posix.dirname(filePath);
  if (folder === '.') {
    return null;
  }
  const lower = `${folder.toLowerCase()}/`;
  return lower.startsWith('camera roll/') || lower.startsWith('pictures/camera roll/') ? null : folder;
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

/**
 * What says the file's content changed. The hashes come first because work accounts leave `cTag` out
 * of delta; `eTag` is not used, since it also changes when only a name does.
 */
const versionOf = (item: DriveItem) => {
  const hashes = item.file?.hashes;
  for (const value of [hashes?.quickXorHash, hashes?.sha256Hash, hashes?.sha1Hash, item.cTag]) {
    if (typeof value === 'string' && value) {
      return value;
    }
  }
};

const savedCursor = (cursor: RemoteCursor | null) => {
  if (
    cursor?.version !== CURSOR_VERSION ||
    !isGraphLink(cursor.deltaLink) ||
    !Array.isArray(cursor.roots) ||
    cursor.roots.some((root) => typeof root !== 'string')
  ) {
    return null;
  }
  return { deltaLink: cursor.deltaLink, roots: cursor.roots as string[] };
};

export class OneDriveSource implements RemoteSource {
  private http: ProviderHttp;

  constructor(tokens: Pick<BrokerAccessToken, 'get'>, accountId: string, options: ProviderHttpOptions = {}) {
    this.http = new ProviderHttp('OneDrive', tokens, accountId, options);
  }

  async listFolders(folder: string): Promise<RemoteFolder[]> {
    const signal = AbortSignal.timeout(5 * 60_000);
    const parent = relative(folder);
    const base = parent ? `${DRIVE}/root:/${itemPath(parent)}:/children` : `${DRIVE}/root/children`;
    const folders: RemoteFolder[] = [];
    let url: string | undefined = `${base}?$select=id,name,folder,package,remoteItem&$top=200`;
    while (url) {
      const response = await this.get(url, signal);
      if (response.status === 404) {
        await discard(response);
        throw new RemoteSourceError('That folder is no longer in OneDrive');
      }
      const page = await this.page(response);
      for (const item of page.items) {
        if (item.folder && !item.package && !item.remoteItem && typeof item.name === 'string') {
          folders.push({ path: parent ? `${parent}/${item.name}` : item.name, name: item.name });
        }
      }
      url = page.next;
    }
    return folders.toSorted((a, b) => a.name.localeCompare(b.name));
  }

  async *scan(roots: string[], cursor: RemoteCursor | null, signal: AbortSignal): AsyncIterable<RemoteScanBatch> {
    const chosen = onedriveRoots(roots);
    await this.requireARoot(chosen, signal);

    // A folder added since the last scan has files delta will never mention, so it means a full listing.
    const saved = savedCursor(cursor);
    const covered =
      saved && chosen.every((root) => saved.roots.some((known) => known === '' || isSameOrUnder(root, known)));
    let url = covered ? saved.deltaLink : DELTA_START;
    let incremental = !!covered;

    const folders = new Map<string, Folder>();
    const cameraRollId = await this.cameraRollId(signal);
    let restarted = false;

    for (;;) {
      const response = await this.get(url, signal);
      if (response.status === 410) {
        // The saved position has expired. Listing again is safe: the framework skips what it has seen.
        await discard(response);
        if (restarted) {
          throw new RemoteSourceError('OneDrive would not list this folder');
        }
        restarted = true;
        incremental = false;
        url = DELTA_START;
        continue;
      }
      const page = await this.page(response);
      for (const item of page.items) {
        this.remember(folders, item);
      }
      // Delta names a folder moved in but not the files inside it, and cannot say whether it just
      // arrived, so a folder under a chosen root means a full listing. What was seen is skipped as usual.
      if (incremental && (await this.hasFolderUnder(folders, page.items, chosen, cameraRollId, signal))) {
        restarted = true;
        incremental = false;
        url = DELTA_START;
        continue;
      }
      const items: RemoteItem[] = [];
      for (const item of page.items) {
        const found = await this.toItem(folders, item, chosen, cameraRollId, signal);
        if (found) {
          items.push(found);
        }
      }
      if (page.next) {
        yield { items };
        url = page.next;
        continue;
      }
      if (!page.delta) {
        throw new RemoteSourceError('OneDrive sent an answer that could not be read');
      }
      yield { items, cursor: { version: CURSOR_VERSION, deltaLink: page.delta, roots: chosen } };
      return;
    }
  }

  async open(
    remoteId: string,
    { start, contentHash }: { start: number; contentHash?: string },
    signal: AbortSignal,
  ): Promise<Readable> {
    // A download address lasts minutes, so one that has run out is asked for once more.
    for (let attempt = 0; ; attempt++) {
      const item = await this.current(remoteId, signal);
      if (start > 0 && contentHash && versionOf(item) !== contentHash) {
        throw new TakeoutStagingError('The file changed in OneDrive while it was downloading');
      }
      const address = item['@microsoft.graph.downloadUrl'];
      if (!isOneDriveDownloadUrl(address)) {
        throw new RemoteSourceError('OneDrive offered this file from an address Frameleaf does not trust');
      }
      const response = await this.http.send(
        address,
        { method: 'GET', headers: start > 0 ? { Range: `bytes=${start}-` } : {} },
        signal,
        { stream: true, authorized: false },
      );
      if ([401, 403, 410].includes(response.status) && attempt === 0) {
        await discard(response);
        continue;
      }
      if (start > 0 && response.status === 416) {
        await discard(response);
        throw new TakeoutStagingError('The file changed in OneDrive while it was downloading');
      }
      if (!response.ok || !response.body) {
        await discard(response);
        throw new RemoteSourceError('OneDrive would not hand over this file');
      }
      if (start > 0) {
        const range = /^bytes (\d+)-\d+\/(\d+)$/.exec(response.headers.get('content-range') ?? '');
        if (response.status !== 206 || Number(range?.[1]) !== start || Number(range?.[2]) !== item.size) {
          await discard(response);
          // Thrown as a staging failure so the partial file is dropped and the next try starts from the top.
          throw new TakeoutStagingError('The file changed in OneDrive while it was downloading');
        }
      }
      return watchedDownload(Readable.fromWeb(response.body as WebReadableStream), 'OneDrive');
    }
  }

  private get(url: string, signal: AbortSignal) {
    return this.http.send(url, { method: 'GET', headers: { Accept: 'application/json' } }, signal);
  }

  private async page(response: Response) {
    if (!response.ok) {
      await discard(response);
      throw new RemoteSourceError('OneDrive would not list this folder');
    }
    const body = (await response.json().catch(() => null)) as Page | null;
    if (!body || !Array.isArray(body.value)) {
      throw new RemoteSourceError('OneDrive sent an answer that could not be read');
    }
    const next = body['@odata.nextLink'];
    const delta = body['@odata.deltaLink'];
    if ((next !== undefined && !isGraphLink(next)) || (delta !== undefined && !isGraphLink(delta))) {
      throw new RemoteSourceError('OneDrive sent an answer that could not be read');
    }
    return { items: body.value as DriveItem[], next: next as string | undefined, delta: delta as string | undefined };
  }

  /** A chosen folder that has gone (or was renamed) would otherwise look like a scan that found nothing new. */
  private async requireARoot(roots: string[], signal: AbortSignal) {
    if (roots.includes('')) {
      return;
    }
    for (const root of roots) {
      const response = await this.get(`${DRIVE}/root:/${itemPath(root)}?$select=id`, signal);
      await discard(response);
      if (response.status === 404) {
        throw new RemoteSourceError('The chosen folders are no longer in OneDrive. Choose them again.');
      }
    }
  }

  private async hasFolderUnder(
    folders: Map<string, Folder>,
    items: DriveItem[],
    roots: string[],
    cameraRollId: string | null,
    signal: AbortSignal,
  ) {
    for (const item of items) {
      if (!item.folder || item.root || item.deleted || item.remoteItem || typeof item.id !== 'string') {
        continue;
      }
      const place = await this.folderPath(folders, item.id, cameraRollId, signal);
      if (place && roots.some((root) => isUnder(place.path, root))) {
        return true;
      }
    }
    return false;
  }

  /** The Camera Roll wherever it is and whatever it is called in the account's language. */
  private async cameraRollId(signal: AbortSignal) {
    const response = await this.get(`${DRIVE}/special/cameraroll?$select=id`, signal);
    if (!response.ok) {
      // With read-only access a special folder that does not exist answers 403 or 404.
      await discard(response);
      return null;
    }
    const body = (await response.json().catch(() => null)) as { id?: unknown } | null;
    return typeof body?.id === 'string' ? body.id : null;
  }

  private remember(folders: Map<string, Folder>, item: DriveItem) {
    if (typeof item.id !== 'string') {
      return;
    }
    if (item.deleted) {
      folders.delete(item.id);
      return;
    }
    if (item.folder || item.root) {
      folders.set(item.id, this.folderOf(item));
    }
  }

  private folderOf(item: DriveItem): Folder {
    const parentId = item.parentReference?.id;
    return {
      name: typeof item.name === 'string' ? item.name : '',
      parentId: typeof parentId === 'string' ? parentId : null,
      isRoot: !!item.root,
      cameraRoll: item.specialFolder?.name === 'cameraRoll',
    };
  }

  /** The folder's path from the top of the drive, asking Graph for any folder this scan has not met. */
  private async folderPath(
    folders: Map<string, Folder>,
    id: string,
    cameraRollId: string | null,
    signal: AbortSignal,
  ): Promise<{ path: string; cameraRoll: boolean } | null> {
    const names: string[] = [];
    let cameraRoll = false;
    let at: string | null = id;
    for (let depth = 0; depth < MAX_DEPTH && at; depth++) {
      let folder = folders.get(at);
      if (!folder) {
        const response = await this.get(
          `${DRIVE}/items/${encodeURIComponent(at)}?$select=id,name,folder,root,parentReference,specialFolder`,
          signal,
        );
        if (!response.ok) {
          await discard(response);
          if (response.status === 404) {
            return null;
          }
          throw new RemoteSourceError('OneDrive would not list this folder');
        }
        const body = (await response.json().catch(() => null)) as DriveItem | null;
        if (!body) {
          throw new RemoteSourceError('OneDrive sent an answer that could not be read');
        }
        folder = this.folderOf(body);
        folders.set(at, folder);
      }
      cameraRoll ||= folder.cameraRoll || at === cameraRollId;
      if (folder.isRoot) {
        return { path: names.toReversed().join('/'), cameraRoll };
      }
      if (!folder.name) {
        return null;
      }
      names.push(folder.name);
      at = folder.parentId;
    }
    return null;
  }

  /** A photo or video under a chosen folder; everything else in the drive is left out of the scan. */
  private async toItem(
    folders: Map<string, Folder>,
    item: DriveItem,
    roots: string[],
    cameraRollId: string | null,
    signal: AbortSignal,
  ): Promise<RemoteItem | null> {
    if (
      !item.file ||
      item.folder ||
      item.package ||
      item.deleted ||
      item.remoteItem ||
      item.malware ||
      typeof item.id !== 'string' ||
      typeof item.name !== 'string' ||
      typeof item.size !== 'number' ||
      typeof item.parentReference?.id !== 'string' ||
      !mimeTypes.isAsset(item.name)
    ) {
      return null;
    }
    // Used only where the file has no date of its own: the date inside the file always wins at import.
    const modifiedAt = dateOf(
      item.photo?.takenDateTime,
      item.fileSystemInfo?.lastModifiedDateTime,
      item.lastModifiedDateTime,
    );
    if (!modifiedAt) {
      return null;
    }
    const parent = await this.folderPath(folders, item.parentReference.id, cameraRollId, signal);
    if (!parent) {
      return null;
    }
    const filePath = parent.path ? `${parent.path}/${item.name}` : item.name;
    if (roots.every((root) => !isUnder(filePath, root))) {
      return null;
    }
    return {
      remoteId: item.id,
      path: filePath,
      size: item.size,
      modifiedAt,
      contentHash: versionOf(item),
      albumHint: parent.cameraRoll ? null : onedriveAlbumHint(filePath),
    };
  }

  private async current(remoteId: string, signal: AbortSignal): Promise<DriveItem> {
    const response = await this.get(
      `${DRIVE}/items/${encodeURIComponent(remoteId)}?$select=id,size,file,cTag,@microsoft.graph.downloadUrl`,
      signal,
    );
    if (response.status === 404) {
      await discard(response);
      throw new RemoteSourceError('The file is no longer in OneDrive');
    }
    if (!response.ok) {
      await discard(response);
      throw new RemoteSourceError('OneDrive would not hand over this file');
    }
    const body = (await response.json().catch(() => null)) as DriveItem | null;
    if (!body) {
      throw new RemoteSourceError('OneDrive sent an answer that could not be read');
    }
    return body;
  }
}

const isSameOrUnder = (root: string, known: string) => {
  const folder = root.toLowerCase();
  const parent = known.toLowerCase();
  return folder === parent || folder.startsWith(`${parent}/`);
};

/** OneDrive as a provider: connected only by signing in through the Frameleaf Cloud broker. */
export const onedriveRemoteSourceProvider = (
  broker: Pick<ProviderSignInBroker, 'target' | 'refresh'>,
  options: ProviderHttpOptions = {},
): RemoteSourceProvider => {
  const http = options.http ?? ((url, init) => fetch(url, init));
  return {
    provider: ONEDRIVE_PROVIDER,
    credentials() {
      throw new RemoteSourceError('Connect OneDrive by signing in');
    },
    // No `revoke`: Microsoft has no revocation for these tokens. Removing a connection deletes the only copy.
    signIn: {
      service: 'microsoft-files',
      label: 'OneDrive',
      // The drive, not `/me`: reading the profile would need a scope this sign-in does not ask for.
      account: async (accessToken) => {
        let response;
        try {
          response = await http(`${DRIVE}?$select=id,owner`, {
            headers: { Authorization: `Bearer ${accessToken}`, Accept: 'application/json' },
            redirect: 'error',
            signal: AbortSignal.timeout(60_000),
          });
        } catch {
          throw new RemoteSourceError('OneDrive could not be reached');
        }
        const body = response.ok
          ? ((await response.json().catch(() => null)) as {
              id?: unknown;
              owner?: { user?: { displayName?: unknown } };
            } | null)
          : null;
        if (typeof body?.id !== 'string') {
          await discard(response);
          throw new RemoteSourceError('OneDrive did not say which account signed in. Start again.');
        }
        const name = body.owner?.user?.displayName;
        return { id: body.id, name: typeof name === 'string' && name.trim() ? name.trim() : 'OneDrive' };
      },
    },
    open(credentials, session?: RemoteSourceSession) {
      if (typeof credentials.refreshToken !== 'string' || typeof credentials.accountId !== 'string') {
        throw new RemoteSourceAuthError('The saved sign-in can no longer be read. Sign in again.');
      }
      if (!session) {
        throw new RemoteSourceError('This OneDrive sign-in cannot be used here');
      }
      return new OneDriveSource(
        new BrokerAccessToken(broker, 'microsoft-files', session, options.now),
        credentials.accountId,
        options,
      );
    },
  };
};
