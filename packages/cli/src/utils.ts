import {
  ApiKeyResponseDto,
  getMyApiKey,
  getMyUser,
  init,
  isHttpError,
  isMalformedResponseError,
  Permission,
} from '@frameleaf/sdk';
import { convertPathToPattern, glob } from 'fast-glob';
import { createHash } from 'node:crypto';
import { createReadStream } from 'node:fs';
import { lstat, readFile, realpath, stat, writeFile } from 'node:fs/promises';
import { platform } from 'node:os';
import { dirname, join, resolve, sep } from 'node:path';
import yaml from 'yaml';

export interface BaseOptions {
  configDirectory: string;
  key?: string;
  url?: string;
}

export type AuthDto = { url: string; key: string };

export const authenticate = async (options: BaseOptions): Promise<AuthDto> => {
  const { configDirectory: configDir, url, key } = options;

  // provided in command
  if (url && key) {
    return connect(url, key);
  }

  // fallback to auth file
  const config = await readAuthFile(configDir);
  const auth = await connect(config.url, config.key);
  if (auth.url !== config.url) {
    await writeAuthFile(configDir, auth);
  }

  return auth;
};

export const s = (count: number) => (count === 1 ? '' : 's');

/** Every permission a key holds; the server lists design permissions in their own field. */
export const keyPermissions = (key: Pick<ApiKeyResponseDto, 'permissions' | 'designPermissions' | 'mediaPermissions'>): Permission[] => [
  ...(key.permissions as string[] as Permission[]),
  ...((key.designPermissions ?? []) as string[] as Permission[]),
  ...((key.mediaPermissions ?? []) as string[] as Permission[]),
];

export const requirePermissions = async (permissions: Permission[]) => {
  const granted = keyPermissions(await getMyApiKey());
  if (granted.includes(Permission.All)) {
    return;
  }

  const missing = permissions.filter((permission) => !granted.includes(permission));

  if (missing.length > 0) {
    const combined = missing.map((permission) => `"${permission}"`).join(', ');
    console.log(
      `Missing required permission${s(missing.length)}: ${combined}.
Please make sure your API key has the correct permissions.`,
    );
    process.exit(1);
  }
};

/**
 * The API endpoint `.well-known/immich` at `url` names, or null when there is none or it points at
 * another origin. The API key is sent to the endpoint and the endpoint is saved to `auth.yml`, so a
 * document that named a different host (a compromised proxy, a domain that changed hands) would hand
 * the key to a third party for good; only an endpoint on the origin the person typed is taken.
 */
export const discoverEndpoint = async (url: string): Promise<string | undefined> => {
  const wellKnownUrl = new URL('.well-known/immich', url);
  let endpoint: URL;
  try {
    // eslint-disable-next-line unicorn/prefer-await
    const wellKnown = (await fetch(wellKnownUrl).then((response) => response.json())) as { api: { endpoint: string } };
    endpoint = new URL(wellKnown.api.endpoint, url);
  } catch {
    return;
  }
  if (endpoint.origin !== new URL(url).origin) {
    console.warn(
      `Ignoring the API endpoint ${endpoint.origin} that ${wellKnownUrl.origin}/.well-known/immich names: it is on a different origin`,
    );
    return;
  }
  return endpoint.href;
};

export const connect = async (url: string, key: string) => {
  const endpoint = await discoverEndpoint(url);
  if (endpoint && endpoint !== url) {
    console.debug(`Discovered API at ${endpoint}`);
  }
  url = endpoint ?? url;

  init({ baseUrl: url, apiKey: key });

  const [error] = await withError(getMyUser());
  if (error) {
    logError(error, `Failed to connect to server ${url}`);
    process.exit(1);
  }

  return { url, key };
};

export const logError = (error: unknown, message: string) => {
  if (isHttpError(error)) {
    console.error(`${message}: ${error.status}`);
    console.error(JSON.stringify(error.data, undefined, 2));
  } else if (isMalformedResponseError(error)) {
    console.error(`${message}: ${error.message}`);
    console.error(
      'Check that the URL points at the Frameleaf API, and that nothing in front of it (reverse proxy, SSO portal) is answering instead.',
    );
  } else {
    console.error(`${message} - ${error}`);
  }
};

export const getAuthFilePath = (dir: string) => join(dir, 'auth.yml');

export const readAuthFile = async (dir: string) => {
  try {
    const data = await readFile(getAuthFilePath(dir));
    const auth: unknown = yaml.parse(data.toString());
    if (!auth || typeof auth !== 'object' || Array.isArray(auth)) {
      throw new Error('Invalid authentication file');
    }
    const values = auth as Record<string, unknown>;
    const { url, key } = values.instanceUrl && values.apiKey ? { url: values.instanceUrl, key: values.apiKey } : values;
    if (typeof url !== 'string' || !url.trim() || typeof key !== 'string' || !key.trim()) {
      throw new Error('Invalid authentication file');
    }
    return { url, key };
  } catch (error: Error | any) {
    if (error.code === 'ENOENT' || error.code === 'ENOTDIR') {
      console.log('No auth file exists. Please login first.');
      process.exit(1);
    }
    throw error;
  }
};

export const writeAuthFile = async (dir: string, auth: AuthDto) =>
  writeFile(getAuthFilePath(dir), yaml.stringify(auth), { mode: 0o600 });

export const withError = async <T>(promise: Promise<T>): Promise<[Error, undefined] | [undefined, T]> => {
  try {
    const result = await promise;
    return [undefined, result];
  } catch (error: Error | any) {
    return [error, undefined];
  }
};

export interface CrawlOptions {
  pathsToCrawl: string[];
  recursive?: boolean;
  includeHidden?: boolean;
  exclusionPattern?: string;
  extensions: string[];
}

const convertPathToPatternOnWin = (path: string) => {
  return platform() === 'win32' ? convertPathToPattern(path) : path;
};

export const crawl = async (options: CrawlOptions): Promise<string[]> => {
  const { extensions: extensionsWithPeriod, recursive, pathsToCrawl, exclusionPattern, includeHidden } = options;
  const extensions = extensionsWithPeriod.map((extension) => extension.replace('.', ''));
  // Preserve glob escapes while converting native Windows separators.
  const ignorePattern =
    platform() === 'win32' ? exclusionPattern?.replaceAll(/\\(?![!()+@[\]{}])/g, '/') : exclusionPattern;

  if (pathsToCrawl.length === 0) {
    return [];
  }

  const patterns: string[] = [];
  /** The folders behind `patterns`, as named (not glob-escaped), for the linked-folder check. */
  const roots: string[] = [];
  const crawledFiles: string[] = [];

  for await (const currentPath of pathsToCrawl) {
    try {
      const absolutePath = resolve(currentPath);
      // lstat, not stat: a path named on the command line may itself be a link. A link to a file is
      // uploaded through the link; a link to a folder was named on purpose, so it is crawled, but
      // folders linked from inside a crawled folder are never entered (see `insideRoots` below).
      const stats = await lstat(absolutePath);
      if (stats.isFile()) {
        crawledFiles.push(absolutePath);
      } else if (stats.isSymbolicLink()) {
        let target;
        try {
          target = await stat(absolutePath);
        } catch {
          // a dangling link: uploaded (and reported) as a file
        }
        if (target?.isDirectory()) {
          patterns.push(convertPathToPatternOnWin(absolutePath));
          roots.push(absolutePath);
        } else {
          crawledFiles.push(absolutePath);
        }
      } else {
        patterns.push(convertPathToPatternOnWin(absolutePath));
        roots.push(absolutePath);
      }
    } catch (error: any) {
      if (error.code === 'ENOENT') {
        patterns.push(convertPathToPatternOnWin(currentPath));
        // a wildcard pattern: its literal prefix is the folder the crawl may not leave through a link
        const base = globBase(resolve(currentPath));
        if (base) {
          roots.push(base);
        }
      } else {
        throw error;
      }
    }
  }

  if (patterns.length === 0) {
    return crawledFiles;
  }

  const searchPatterns = patterns.map((pattern) => {
    let escapedPattern = pattern.replaceAll("'", "[']").replaceAll('"', '["]').replaceAll('`', '[`]');
    if (recursive) {
      escapedPattern += '/**';
    }
    return `${escapedPattern}/*.{${extensions.join(',')}}`;
  });

  const globbedFiles = await glob(searchPatterns, {
    absolute: true,
    caseSensitiveMatch: false,
    dot: includeHidden,
    ignore: [`**/${ignorePattern}`],
  });
  const files = await insideRoots(globbedFiles, roots);
  files.push(...crawledFiles);
  return files.toSorted();
};

/**
 * The files among `files` that live under one of `roots` without passing through a linked folder.
 * A linked file is kept: it is uploaded through the link and `--delete` removes only the link. A
 * folder linked from inside a root leads elsewhere (a NAS share, another library), so the files
 * behind it are neither uploaded nor, with `--delete`, removed.
 */
/**
 * The folder a glob pattern starts from: everything before its first wildcard, cut at a separator.
 * A filesystem root (`/` or `D:\\`) keeps its separator.
 */
export const globBase = (pattern: string): string | undefined => {
  const magic = pattern.search(/[*?[\]{}()!]/);
  if (magic < 0) {
    return undefined;
  }
  const literal = pattern.slice(0, magic);
  const cut = Math.max(literal.lastIndexOf('/'), literal.lastIndexOf('\\'));
  if (cut < 0) {
    return undefined;
  }
  const folder = literal.slice(0, cut);
  return folder === '' || /^[A-Za-z]:$/.test(folder) ? literal.slice(0, cut + 1) : folder;
};

/** Whether `path` is `root` or lies under it; a filesystem root already ends in a separator. */
const isUnder = (path: string, root: string) =>
  path === root || path.startsWith(root.endsWith(sep) ? root : root + sep);

const insideRoots = async (files: string[], roots: string[]): Promise<string[]> => {
  const realRoots = new Map<string, string>();
  for (const root of roots) {
    try {
      realRoots.set(root, await realpath(root));
    } catch {
      // a glob pattern or a path that no longer exists: nothing to compare against
    }
  }
  if (realRoots.size === 0) {
    // no root could be resolved, so no globbed file can be checked against one
    return [];
  }
  // '' marks a folder whose real path could not be resolved: such files are left out
  const realFolders = new Map<string, string>();
  const kept: string[] = [];
  for (const file of files) {
    const nativeFile = resolve(file);
    // fast-glob reports forward-slash paths on Windows; compare native forms on every platform.
    // The deepest root wins: a linked folder named on purpose inside another named root is crawled.
    let root: string | undefined;
    for (const candidate of realRoots.keys()) {
      const nativeRoot = resolve(candidate);
      if (isUnder(nativeFile, nativeRoot) && (!root || nativeRoot.length > resolve(root).length)) {
        root = candidate;
      }
    }
    if (!root) {
      // every pattern has a root; a file none of them covers cannot be vouched for
      continue;
    }
    const folder = dirname(nativeFile);
    let real = realFolders.get(folder);
    if (real === undefined) {
      try {
        real = await realpath(folder);
      } catch {
        real = '';
      }
      realFolders.set(folder, real);
    }
    const realRoot = realRoots.get(root)!;
    if (real !== '' && isUnder(real, realRoot)) {
      kept.push(file);
    }
  }
  return kept;
};

export const sha1 = (filepath: string) => {
  const hash = createHash('sha1');
  return new Promise<string>((resolve, reject) => {
    const rs = createReadStream(filepath);
    rs.on('error', reject);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest('hex')));
  });
};

/**
 * Compute the SHA-1 and SHA-256 digests of a file in a single read pass.
 *
 * The server stores SHA-256 for assets uploaded after the SHA-256 transition and
 * SHA-1 for legacy rows (see `asset.checksumAlgorithm`), and duplicate checks
 * compare the client-supplied digest byte-for-byte. Clients therefore have to
 * offer both digests to detect duplicates against either kind of row.
 */
export const hashFile = (filepath: string) => {
  const sha1Hash = createHash('sha1');
  const sha256Hash = createHash('sha256');
  return new Promise<{ sha1: string; sha256: string }>((resolve, reject) => {
    const rs = createReadStream(filepath);
    rs.on('error', reject);
    rs.on('data', (chunk) => {
      sha1Hash.update(chunk);
      sha256Hash.update(chunk);
    });
    rs.on('end', () => resolve({ sha1: sha1Hash.digest('hex'), sha256: sha256Hash.digest('hex') }));
  });
};

// The server stores SHA-256 for all new uploads, so migration dedup/audit must match on SHA-256.
export const sha256 = (filepath: string, encoding: 'hex' | 'base64' = 'base64') => {
  const hash = createHash('sha256');
  return new Promise<string>((resolve, reject) => {
    const rs = createReadStream(filepath);
    rs.on('error', reject);
    rs.on('data', (chunk) => hash.update(chunk));
    rs.on('end', () => resolve(hash.digest(encoding)));
  });
};

/**
 * Batches items and calls onBatch to process them
 * when the batch size is reached or the debounce time has passed.
 */
export class Batcher<T = unknown> {
  private items: T[] = [];
  private readonly batchSize: number;
  private readonly debounceTimeMs?: number;
  private readonly onBatch: (items: T[]) => Promise<void>;
  private debounceTimer?: NodeJS.Timeout;

  constructor({
    batchSize,
    debounceTimeMs,
    onBatch,
  }: {
    batchSize: number;
    debounceTimeMs?: number;
    onBatch: (items: T[]) => Promise<void>;
  }) {
    this.batchSize = batchSize;
    this.debounceTimeMs = debounceTimeMs;
    this.onBatch = onBatch;
  }

  add(item: T) {
    this.items.push(item);
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    if (this.items.length >= this.batchSize) {
      this.dispatch();
    } else if (this.debounceTimeMs) {
      this.debounceTimer = setTimeout(() => this.dispatch(), this.debounceTimeMs);
    }
  }

  private dispatch() {
    void this.flush().catch((error) => console.error('Batch failed:', error));
  }

  async flush(): Promise<void> {
    clearTimeout(this.debounceTimer);
    this.debounceTimer = undefined;
    if (this.items.length === 0) {
      return;
    }

    const items = this.items;
    this.items = [];
    await this.onBatch(items);
  }
}
