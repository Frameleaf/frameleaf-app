import type { Readable } from 'node:stream';

/**
 * Import connectors (FL-920): what a remote place photos are imported from has to offer.
 *
 * A source only ever reads. There is no method that deletes, moves, renames or writes at the source,
 * so an import cannot change it, and a file that disappears there is simply no longer listed: the
 * framework never removes anything from the library because of it.
 */

/** A folder the owner can choose to import from. */
export type RemoteFolder = {
  /** Passed back to `listFolders` and stored as a root. Opaque to the framework. */
  path: string;
  /** What the folder is called. */
  name: string;
};

/** One file at the source. */
export type RemoteItem = {
  /** The source's own stable id for the file (a path for WebDAV, a file id for Dropbox). */
  remoteId: string;
  /** Where it is, `/`-separated and relative: shown in review, and its last segment is the file name. */
  path: string;
  size: number;
  modifiedAt: Date;
  /**
   * Whatever the source offers to tell that the file changed (an ETag, Dropbox's `content_hash`).
   * Only ever compared with the value an earlier scan saw; the library's own digests are computed
   * from the downloaded bytes.
   */
  contentHash?: string;
  /**
   * The album the file belongs in: a name or a `/`-separated folder path, whose last segment names the
   * album. Null leaves it in the timeline only.
   */
  albumHint: string | null;
  /** Becomes the photo's description. */
  caption?: string;
  favourite?: boolean;
};

/** Where a scan got to, as the source wants it remembered (a delta token, ETags per folder). */
export type RemoteCursor = Record<string, unknown>;

/** Some of a scan's files, and the cursor that stands for everything listed so far. */
export type RemoteScanBatch = { items: RemoteItem[]; cursor?: RemoteCursor | null };

export interface RemoteSource {
  /** The folders directly inside `path`; an empty path is the top. */
  listFolders(path: string): Promise<RemoteFolder[]>;
  /**
   * The files under `roots`. With the `cursor` an earlier scan ended on, a source that can list only
   * what is new or changed since then; one that cannot lists everything again, and the framework
   * leaves out what it has already seen. The last batch's cursor is stored when the scan finishes.
   */
  scan(roots: string[], cursor: RemoteCursor | null, signal: AbortSignal): AsyncIterable<RemoteScanBatch>;
  /**
   * The file's bytes from `range.start` on; a download that was interrupted resumes there.
   * `range.contentHash` is what the scan saw, so a source can refuse to splice a file that changed since.
   */
  open(remoteId: string, range: { start: number; contentHash?: string }, signal: AbortSignal): Promise<Readable>;
}

/**
 * What a source may ask of the connection it reads for (FL-959). `renewCredentials` runs `renew` with
 * the connection's current credentials, one caller at a time across every worker; what it returns is
 * sealed and stored in their place, and null leaves them as they are. A provider that rotates refresh
 * tokens saves the new one here. It never changes the connection's status.
 */
export type RemoteSourceSession = {
  renewCredentials(renew: (current: Record<string, unknown>) => Promise<Record<string, unknown> | null>): Promise<void>;
};

/** A source connected by signing in through the Frameleaf Cloud broker (FL-959). */
export type RemoteSourceSignIn = {
  /** The broker's name for the provider. */
  service: string;
  /** The provider's name, for messages to the owner. */
  label: string;
  /** Who signed in: a stable account id, and a name to show. */
  account(accessToken: string): Promise<{ id: string; name: string }>;
};

/** A kind of source: `webdav`, `dropbox`. Registered once at startup by the story that adds it. */
export interface RemoteSourceProvider {
  /** Stored on the connection and named in the API. Lower-case, stable. */
  readonly provider: string;
  /**
   * Check what the owner (or a sign-in) supplied and return what is sealed and stored. Throw
   * `RemoteSourceError` with a message for the owner when it is not usable. The message must not
   * repeat a secret.
   */
  credentials(input: Record<string, unknown>): Promise<Record<string, unknown>> | Record<string, unknown>;
  /** A source that reads with these credentials. Makes no request by itself. */
  open(credentials: Record<string, unknown>, session?: RemoteSourceSession): RemoteSource;
  /** Present on a provider connected by signing in; its `credentials` then refuses typed-in details. */
  readonly signIn?: RemoteSourceSignIn;
  /** Give up the access these credentials hold, when the connection is removed. Best effort. */
  revoke?(credentials: Record<string, unknown>): Promise<void>;
}

/** The source refused or could not answer. The message is shown to the owner and must hold no secret. */
export class RemoteSourceError extends Error {}

/**
 * The source no longer accepts the stored credentials (a changed password, a revoked app). The
 * connection is marked "sign in again" and is not tried again until the owner renews it.
 */
export class RemoteSourceAuthError extends RemoteSourceError {}

const providers = new Map<string, RemoteSourceProvider>();

export const registerRemoteSource = (provider: RemoteSourceProvider) => {
  providers.set(provider.provider, provider);
};

export const unregisterRemoteSource = (provider: string) => {
  providers.delete(provider);
};

export const remoteSourceProvider = (provider: string) => providers.get(provider);

export const remoteSourceProviders = () => providers.keys().toArray().toSorted();
