import { Readable } from 'node:stream';
import {
  type RemoteItem,
  type RemoteSource,
  RemoteSourceAuthError,
  RemoteSourceError,
  type RemoteSourceProvider,
} from 'src/import-connectors/remote-source.js';

/**
 * An in-memory source for tests (FL-920). It is registered by specs, and by a server started with
 * `FRAMELEAF_ENV=testing` (the e2e stack), never by a normal server.
 *
 * Its "credentials" are the remote itself: a token and the files it holds, so an e2e test describes a
 * remote through the API. The token `expired` is refused the way a revoked sign-in is.
 */
export type FakeRemoteFile = {
  path: string;
  /** The file's bytes, base64. */
  data: string;
  modifiedAt?: string;
  albumHint?: string | null;
  caption?: string;
  favourite?: boolean;
};

export const FAKE_PROVIDER = 'fake';

const folderOf = (filePath: string) => filePath.split('/').slice(0, -1).join('/');

export class FakeRemoteSource implements RemoteSource {
  /** Every `open`, so a spec can see a download resume. */
  readonly opened: Array<{ remoteId: string; start: number }> = [];
  /** Set to cut each download short after this many bytes, once. */
  failAfterBytes?: number;

  constructor(
    public files: FakeRemoteFile[],
    private token = 'ok',
  ) {}

  private check() {
    if (this.token === 'expired') {
      throw new RemoteSourceAuthError('The fake source no longer accepts this sign-in');
    }
  }

  listFolders(path: string) {
    this.check();
    const prefix = path ? `${path}/` : '';
    const names = new Set<string>();
    for (const file of this.files) {
      const folder = folderOf(file.path);
      if (folder.startsWith(prefix) && folder.length > prefix.length) {
        names.add(folder.slice(prefix.length).split('/', 1)[0]);
      }
    }
    return Promise.resolve([...names].toSorted().map((name) => ({ path: prefix + name, name })));
  }

  // eslint-disable-next-line @typescript-eslint/require-await
  async *scan(roots: string[]) {
    this.check();
    const inRoots = (filePath: string) =>
      roots.length === 0 || roots.some((root) => root === '' || filePath.startsWith(`${root}/`));
    const items: RemoteItem[] = this.files
      .filter((file) => inRoots(file.path))
      .map((file) => {
        const bytes = Buffer.from(file.data, 'base64');
        return {
          remoteId: file.path,
          path: file.path,
          size: bytes.length,
          modifiedAt: new Date(file.modifiedAt ?? '2024-01-01T00:00:00.000Z'),
          contentHash: `${bytes.length}-${file.modifiedAt ?? ''}`,
          albumHint: file.albumHint === undefined ? folderOf(file.path) || null : file.albumHint,
          caption: file.caption,
          favourite: file.favourite,
        };
      });
    yield { items, cursor: { scans: 1 } };
  }

  open(remoteId: string, range: { start: number }) {
    this.check();
    this.opened.push({ remoteId, start: range.start });
    const file = this.files.find((candidate) => candidate.path === remoteId);
    if (!file) {
      return Promise.reject(new RemoteSourceError('The file is no longer at the source'));
    }
    const bytes = Buffer.from(file.data, 'base64').subarray(range.start);
    if (this.failAfterBytes !== undefined && this.failAfterBytes < bytes.length) {
      const head = bytes.subarray(0, this.failAfterBytes);
      this.failAfterBytes = undefined;
      return Promise.resolve(
        Readable.from(
          (async function* () {
            yield head;
            // Long enough for what was sent to reach the disk, as a real connection drop is.
            await new Promise((resolve) => setTimeout(resolve, 50));
            throw new RemoteSourceError('The connection dropped');
          })(),
        ),
      );
    }
    return Promise.resolve(Readable.from([bytes]));
  }
}

export const fakeRemoteSourceProvider: RemoteSourceProvider = {
  provider: FAKE_PROVIDER,
  credentials(input) {
    if (typeof input.token !== 'string' || !Array.isArray(input.files)) {
      throw new RemoteSourceError('The fake source needs a token and a list of files');
    }
    return { token: input.token, files: input.files };
  },
  open: (credentials) => new FakeRemoteSource(credentials.files as FakeRemoteFile[], credentials.token as string),
};
