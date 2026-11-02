import type {
  AlbumResponseDto,
  ApiKeyResponseDto,
  AssetBulkUploadCheckResponseDto,
  AssetFaceResponseDto,
  AssetMediaResponseDto,
  AssetMetadataResponseDto,
  AssetMetadataUpsertItemDto,
  AssetResponseDto,
  BulkIdResponseDto,
  CreateAlbumDto,
  MetadataSearchDto,
  PeopleResponseDto,
  PersonCreateDto,
  PersonResponseDto,
  SearchResponseDto,
  StackResponseDto,
  TagBulkAssetsResponseDto,
  TagResponseDto,
  UpdateAlbumDto,
  UpdateAssetDto,
  UserAdminResponseDto,
} from '@frameleaf/sdk';
import { createReadStream } from 'node:fs';
import { Readable } from 'node:stream';

export class MigrateHttpError extends Error {
  constructor(
    readonly status: number,
    readonly statusText: string,
    readonly body: string,
    readonly method: string,
    readonly path: string,
  ) {
    super(`${method} ${path} -> ${status} ${statusText}: ${body.slice(0, 500)}`);
    this.name = 'MigrateHttpError';
  }
}

// A File subclass that streams its bytes from disk on demand, so uploads never buffer
// a whole asset in memory. Same pattern the `upload` command uses.
class StreamFile extends File {
  /** Called for every chunk read from disk, so an upload in progress counts as activity. */
  onChunk?: () => void;

  constructor(
    private readonly filepath: string,
    size: number,
    name: string,
  ) {
    super([], name);
    // File declares `size` as a data property, so a getter override is a
    // TS2611 error — shadow it with an own property instead.
    Object.defineProperty(this, 'size', { value: size });
  }
  stream() {
    const chunks = Readable.toWeb(createReadStream(this.filepath)) as ReadableStream<Uint8Array>;
    return chunks.pipeThrough(
      new TransformStream<Uint8Array, Uint8Array>({
        transform: (chunk, controller) => {
          this.onChunk?.();
          controller.enqueue(chunk);
        },
      }),
    ) as unknown as ReadableStream;
  }
}

const RETRYABLE = new Set([429, 500, 502, 503, 504]);
// POSTs the server can safely receive twice. Any other POST (create album, person, stack…)
// may already have taken effect when the response is lost, so it is retried only on 429.
const REPEAT_SAFE_POSTS = new Set(['/search/metadata', '/assets/bulk-upload-check', '/assets']);
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

const canRetry = (method: string, path: string, status?: number) =>
  method !== 'POST' || status === 429 || REPEAT_SAFE_POSTS.has(path.split('?', 1)[0]);

/** An abort signal that fires only after `ms` without activity; `touch()` restarts the clock. */
const inactivityTimeout = (ms: number) => {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const stop = () => clearTimeout(timer);
  const touch = () => {
    stop();
    timer = setTimeout(() => controller.abort(new DOMException(`No data for ${ms / 1000}s`, 'TimeoutError')), ms);
    timer.unref?.();
  };
  touch();
  return { signal: controller.signal, touch, stop };
};

/** Re-wraps a response so every body chunk received counts as activity. */
const watchBody = (response: Response, touch: () => void, stop: () => void): Response => {
  if (!response.body) {
    stop();
    return response;
  }
  const body = response.body.pipeThrough(
    new TransformStream<Uint8Array, Uint8Array>({
      transform(chunk, controller) {
        touch();
        controller.enqueue(chunk);
      },
      flush: stop,
    }),
  );
  return new Response(body, { status: response.status, statusText: response.statusText, headers: response.headers });
};

const buildQuery = (params: Record<string, string | number | boolean | undefined>): string => {
  const usp = new URLSearchParams();
  for (const [key, value] of Object.entries(params)) {
    if (value !== undefined) {
      usp.set(key, String(value));
    }
  }
  const qs = usp.toString();
  return qs ? `?${qs}` : '';
};

/**
 * A minimal, self-contained API client for one Frameleaf server. Unlike `@frameleaf/sdk`
 * (which keeps a single global `defaults`), each instance is fully independent, so
 * SERVER A and SERVER B can be driven concurrently. Uses the SDK only for types.
 */
export class ServerClient {
  private constructor(
    readonly baseUrl: string,
    private readonly apiKey: string,
    readonly retries = 4,
    private readonly timeoutMs = 10 * 60 * 1000,
  ) {}

  /** Resolve the real API endpoint via `.well-known/immich`, then verify the key. */
  static async connect(url: string, key: string): Promise<{ client: ServerClient; user: UserAdminResponseDto }> {
    let baseUrl = url.replace(/\/+$/, '');
    try {
      const wellKnownResponse = await fetch(new URL('.well-known/immich', url));
      const wellKnown = (await wellKnownResponse.json()) as { api: { endpoint: string } };
      baseUrl = new URL(wellKnown.api.endpoint, url).href.replace(/\/+$/, '');
    } catch {
      // no well-known endpoint; use the URL as given
    }
    const client = new ServerClient(baseUrl, key);
    const config = await client.json<{ frameleaf?: { cloudConfigured?: unknown } } | null>('GET', '/server/config');
    if (typeof config?.frameleaf?.cloudConfigured !== 'boolean') {
      throw new TypeError(
        'API transfer requires Frameleaf servers. Use the offline import-immich administration command with a fresh Frameleaf database to import a supported external library.',
      );
    }
    const user = await client.getMyUser();
    return { client, user };
  }

  private async request(method: string, path: string, init: RequestInit = {}): Promise<Response> {
    let lastError: unknown;
    for (let attempt = 0; attempt <= this.retries; attempt++) {
      // Without a timeout a half-open connection hangs the whole migration indefinitely.
      // Applied per attempt, so a timeout is just another retryable network failure. It
      // measures inactivity, not total time, so large originals keep going while bytes flow.
      const timeout = inactivityTimeout(this.timeoutMs);
      const upload = init.body instanceof FormData ? init.body.get('assetData') : null;
      if (upload instanceof StreamFile) {
        upload.onChunk = timeout.touch;
      }
      try {
        const response = await fetch(`${this.baseUrl}${path}`, {
          ...init,
          method,
          redirect: 'error',
          signal: init.signal ?? timeout.signal,
          headers: { 'x-api-key': this.apiKey, Accept: 'application/json', ...init.headers },
        });
        if (response.ok) {
          return watchBody(response, timeout.touch, timeout.stop);
        }
        if (RETRYABLE.has(response.status) && attempt < this.retries && canRetry(method, path, response.status)) {
          // Release the connection now rather than when the unread body is garbage-collected.
          await response.body?.cancel();
          timeout.stop();
          await sleep(Math.min(30_000, 500 * 2 ** attempt));
          continue;
        }
        const text = await response.text();
        timeout.stop();
        throw new MigrateHttpError(response.status, response.statusText, text, method, path);
      } catch (error) {
        timeout.stop();
        lastError = error;
        // Network-level failure: back off and retry. HTTP errors we already decided to throw above.
        if (error instanceof MigrateHttpError || attempt >= this.retries || !canRetry(method, path)) {
          throw error;
        }
        await sleep(Math.min(30_000, 500 * 2 ** attempt));
      }
    }
    throw lastError;
  }

  private async json<T>(method: string, path: string, body?: unknown): Promise<T> {
    const init: RequestInit =
      body === undefined ? {} : { body: JSON.stringify(body), headers: { 'Content-Type': 'application/json' } };
    const response = await this.request(method, path, init);
    return (await response.json()) as T;
  }

  // --- identity / preflight ---
  getMyUser = () => this.json<UserAdminResponseDto>('GET', '/users/me');
  getMyApiKey = () => this.json<ApiKeyResponseDto>('GET', '/api-keys/me');

  // --- enumeration ---
  searchAssets = (dto: MetadataSearchDto) => this.json<SearchResponseDto>('POST', '/search/metadata', dto);
  /** Albums this account owns. Albums other users share with it are theirs to migrate. */
  getAllAlbums = () => this.json<AlbumResponseDto[]>('GET', `/albums${buildQuery({ isOwned: true })}`);
  getAlbumInfo = (id: string) => this.json<AlbumResponseDto>('GET', `/albums/${id}`);
  getAllTags = () => this.json<TagResponseDto[]>('GET', '/tags');
  searchStacks = () => this.json<StackResponseDto[]>('GET', '/stacks');
  /** All people, following pagination — a large library can have well over one page. */
  async getAllPeople(): Promise<PersonResponseDto[]> {
    const people: PersonResponseDto[] = [];
    for (let page = 1; ; page++) {
      const res = await this.json<PeopleResponseDto>(
        'GET',
        `/people${buildQuery({ withHidden: true, size: 500, page })}`,
      );
      people.push(...res.people);
      if (!res.hasNextPage) {
        return people;
      }
    }
  }

  // --- dedup / download ---
  checkBulkUpload = (assets: Array<{ id: string; checksum: string }>) =>
    this.json<AssetBulkUploadCheckResponseDto>('POST', '/assets/bulk-upload-check', { assets });
  getAssetInfo = (id: string) => this.json<AssetResponseDto>('GET', `/assets/${id}`);
  restoreAssets = (ids: string[]) => this.json<unknown>('POST', '/trash/restore/assets', { ids });

  /** Streamed original bytes. Caller pipes `response.body` to disk. */
  downloadOriginal = (id: string) => this.request('GET', `/assets/${id}/original`);

  // --- writes on destination ---
  async uploadAsset(params: {
    filepath: string;
    size: number;
    filename: string;
    checksum: string; // base64 SHA-256 for the canonical Frameleaf destination
    fileCreatedAt: string;
    fileModifiedAt: string;
    isFavorite: boolean;
    visibility: string;
    duration?: number | null;
  }): Promise<AssetMediaResponseDto> {
    const form = new FormData();
    form.append('assetData', new StreamFile(params.filepath, params.size, params.filename));
    form.append('filename', params.filename);
    form.append('fileCreatedAt', params.fileCreatedAt);
    form.append('fileModifiedAt', params.fileModifiedAt);
    form.append('isFavorite', String(params.isFavorite));
    form.append('visibility', params.visibility);
    if (params.duration != undefined) {
      form.append('duration', String(params.duration));
    }
    const response = await this.request('POST', '/assets', {
      body: form,
      headers: { 'x-immich-checksum': params.checksum },
    });
    return (await response.json()) as AssetMediaResponseDto;
  }

  updateAsset = (id: string, dto: UpdateAssetDto) => this.json<AssetResponseDto>('PUT', `/assets/${id}`, dto);
  getAssetMetadata = (id: string) => this.json<AssetMetadataResponseDto[]>('GET', `/assets/${id}/metadata`);
  upsertAssetMetadata = (id: string, items: AssetMetadataUpsertItemDto[]) =>
    this.json<AssetMetadataResponseDto[]>('PUT', `/assets/${id}/metadata`, { items });

  createAlbum = (dto: CreateAlbumDto) => this.json<AlbumResponseDto>('POST', '/albums', dto);
  updateAlbum = (id: string, dto: UpdateAlbumDto) => this.json<AlbumResponseDto>('PATCH', `/albums/${id}`, dto);
  addAssetsToAlbum = (id: string, ids: string[]) =>
    this.json<BulkIdResponseDto[]>('PUT', `/albums/${id}/assets`, { ids });

  upsertTags = (tags: string[]) => this.json<TagResponseDto[]>('PUT', '/tags', { tags });
  bulkTagAssets = (tagIds: string[], assetIds: string[]) =>
    this.json<TagBulkAssetsResponseDto>('PUT', '/tags/assets', { tagIds, assetIds });

  createStack = (assetIds: string[]) => this.json<StackResponseDto>('POST', '/stacks', { assetIds });

  getPerson = (id: string) => this.json<PersonResponseDto>('GET', `/people/${id}`);
  searchPerson = (name: string) =>
    this.json<PersonResponseDto[]>('GET', `/search/person${buildQuery({ name, withHidden: true })}`);
  /** Faces detected on an asset, each with the person it currently belongs to (if any). */
  getFaces = (assetId: string) => this.json<AssetFaceResponseDto[]>('GET', `/faces${buildQuery({ id: assetId })}`);
  createPerson = (dto: PersonCreateDto) => this.json<PersonResponseDto>('POST', '/people', dto);
  reassignFaces = (personId: string, data: Array<{ assetId: string; personId: string }>) =>
    this.json<PersonResponseDto>('PUT', `/people/${personId}/reassign`, { data });
}
