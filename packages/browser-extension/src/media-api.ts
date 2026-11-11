import {
  cancelMediaImport,
  createMediaConnection,
  createMediaImport,
  createMediaSubscription,
  disconnectMediaConnection,
  getMediaCapabilities,
  getMediaConnections,
  getMediaImport,
  inspectMedia,
  previewMediaSubscription,
  refreshMediaConnection,
  retryMediaImport,
  type MediaConnectionCreateDto,
  type MediaImportCreateDto,
  type MediaSubscriptionCreateDto,
} from '@frameleaf/sdk';
import { boundOptions, CaptureFailure, type ServerBinding } from './api';

/**
 * FL-1427: media downloads, connected sites and creator subscriptions run on your Library. The
 * extension only asks for them and reads back how they are going. Every call first confirms the
 * address still answers as the same server and account (`boundOptions`), exactly as saving does.
 */

/** Why a media request did not go through, in terms the popup can act on. */
export type MediaProblem =
  /** No answer at all: the Library is off, unreachable, or its certificate isn't trusted. */
  | 'unreachable'
  /** This browser's access doesn't cover media downloads yet. */
  | 'grant'
  /** The Library is from before media downloads. Saving is unaffected. */
  | 'unsupported'
  /** The Library answered and said no. */
  | 'refused'
  /** FL-1449: the Library is from before what this download or follow asks for. */
  | 'outdated'
  /** Site access is only ever sent over HTTPS. */
  | 'https';
const messages: Record<MediaProblem, string> = {
  unreachable:
    'Your Library didn’t answer. Check that it’s turned on and that this browser trusts its certificate.',
  grant:
    'Save to Frameleaf needs your permission for media downloads on your Library.',
  unsupported:
    'Your Library needs an update before it can download media. Saving images, links and screenshots still works.',
  refused: 'Your Library couldn’t do that. Check the details and try again.',
  outdated:
    'Your Library needs an update for this. Saving images, links and screenshots still works.',
  https:
    'Site access can only be shared with a Library opened over HTTPS. Sign in using its https:// address.',
};
export class LibraryFailure extends Error {
  constructor(
    readonly problem: MediaProblem,
    /** The Library's answer, when it gave one. */
    readonly status?: number,
  ) {
    super(messages[problem]);
  }
}

type Options = Awaited<ReturnType<typeof boundOptions>>;
const defaultFetch = () => globalThis.fetch.bind(globalThis);

async function call<T>(
  binding: ServerBinding,
  token: string,
  fetch: typeof globalThis.fetch,
  run: (options: Options) => Promise<T>,
): Promise<T> {
  /** The answer to the media request itself (the identity check before it is not one). */
  let status: number | undefined;
  let capabilities = false;
  /** The Library said this access lacks the permission, as opposed to refusing for another reason. */
  let notAllowed = false;
  /** The Library did not understand a new download or follow: it predates what was asked for. */
  let notUnderstood = false;
  const transport: typeof globalThis.fetch = async (input, init) => {
    const response = await fetch(input, init);
    const path = new URL(String(input)).pathname;
    if (/\/api\/media-/.test(path)) {
      status = response.status;
      capabilities = path.endsWith('/api/media-imports/capabilities');
      const said = async () =>
        (
          await response
            .clone()
            .text()
            .catch(() => '')
        ).slice(0, 2000);
      if (status === 403)
        notAllowed = /Missing required permission/i.test(await said());
      // Only the two requests that start work carry choices an older Library may not know
      // (quality, a recent reach, what to save, no collection).
      notUnderstood =
        status === 400 &&
        init?.method === 'POST' &&
        /\/api\/media-(imports|subscriptions)$/.test(path) &&
        /"message"\s*:\s*"Validation failed"/.test(await said());
    }
    return response;
  };
  try {
    return await run(await boundOptions(binding, token, transport));
  } catch (error) {
    if (error instanceof LibraryFailure) throw error;
    if (!(error instanceof CaptureFailure)) throw new LibraryFailure('refused');
    // A key that can save but was never allowed media is not a broken key. Any other 403 (say,
    // site access sent without HTTPS) is the Library saying no to this one request.
    if (status === 403 && notAllowed) throw new LibraryFailure('grant', status);
    // Only the question "do you have media downloads?" can be answered "no such thing"; a 404 for
    // one download or inspection means that one is gone.
    if (status === 404 && capabilities)
      throw new LibraryFailure('unsupported', status);
    if (notUnderstood) throw new LibraryFailure('outdated', status);
    if (status !== undefined && status !== 401)
      throw new LibraryFailure('refused', status);
    if (error.code === 'connection') throw new LibraryFailure('unreachable');
    throw error;
  }
}

const uuid =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const text = (value: unknown, max: number) =>
  typeof value === 'string' ? value.slice(0, max) : null;
const count = (value: unknown) =>
  typeof value === 'number' && Number.isSafeInteger(value) && value >= 0
    ? value
    : 0;

export const MEDIA_STATES = [
  'inspecting',
  'ready',
  'queued',
  'downloading',
  'assembling',
  'importing',
  'saved',
  'partial',
  'failed',
  'cancelled',
  'paused',
] as const;
export type MediaState = (typeof MEDIA_STATES)[number];
export interface MediaEntryView {
  id: string;
  title: string;
  kind: 'image' | 'video' | 'audio';
  creator: string | null;
}
/** What the popup shows of an inspection or a download. Never a source address or a credential. */
export interface MediaOperationView {
  id: string;
  state: MediaState;
  kind: 'item' | 'feed' | null;
  provider: string | null;
  creator: string | null;
  /** The site's own public name for the account (a channel id or handle), when it has one. */
  creatorId: string | null;
  complete: boolean;
  limitation: string | null;
  error: string | null;
  albumId: string | null;
  items: MediaEntryView[];
  discovered: number;
  saved: number;
  skipped: number;
  failed: number;
}
/** A reply from the Library is checked like any other outside input before it is shown or kept. */
export function checkedOperation(value: unknown): MediaOperationView {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || !uuid.test(String(raw.id)))
    throw new LibraryFailure('refused');
  const items = Array.isArray(raw.items) ? raw.items.slice(0, 500) : [];
  return {
    id: String(raw.id),
    // A state from a newer Library is unfinished work, never a finished one.
    state: MEDIA_STATES.includes(raw.state as MediaState)
      ? (raw.state as MediaState)
      : 'queued',
    kind: raw.kind === 'item' || raw.kind === 'feed' ? raw.kind : null,
    provider: text(raw.provider, 100),
    creator: text(raw.creator, 300),
    creatorId: text(raw.creatorId, 300),
    complete: raw.complete === true,
    limitation: text(raw.limitation, 1000),
    error: text(raw.error, 1000),
    albumId: uuid.test(String(raw.albumId)) ? String(raw.albumId) : null,
    items: items
      .filter(
        (item): item is Record<string, unknown> =>
          !!item && typeof item === 'object' && uuid.test(String(item.id)),
      )
      .map((item) => ({
        id: String(item.id),
        title: text(item.title, 300) || 'Untitled',
        kind:
          item.kind === 'image' || item.kind === 'audio' ? item.kind : 'video',
        creator: text(item.creator, 300),
      })),
    discovered: count(raw.discovered),
    saved: count(raw.saved),
    skipped: count(raw.skipped),
    failed: count(raw.failed),
  };
}

export interface MediaCapabilityView {
  available: boolean;
  /** Sites can be connected with the browser's own sign-in. */
  cookies: boolean;
}
export const mediaCapabilities = (
  binding: ServerBinding,
  token: string,
  fetch = defaultFetch(),
): Promise<MediaCapabilityView> =>
  call(binding, token, fetch, async (options) => {
    const found = await getMediaCapabilities(options);
    if (!found || found.version !== 1) throw new LibraryFailure('unsupported');
    return {
      available: found.available === true,
      cookies:
        Array.isArray(found.authentication) &&
        found.authentication.some((method) => method === 'cookies'),
    };
  });

/** Asks the Library what is at these addresses. Nothing is downloaded yet. */
export const inspect = (
  binding: ServerBinding,
  token: string,
  request: { urls: string[]; connectionId?: string; subscription?: boolean },
  fetch = defaultFetch(),
): Promise<MediaOperationView> =>
  call(binding, token, fetch, async (options) => {
    const mediaInspectDto = {
      urls: request.urls,
      ...(request.connectionId && { connectionId: request.connectionId }),
    };
    return checkedOperation(
      await (request.subscription
        ? previewMediaSubscription({ mediaInspectDto }, options)
        : inspectMedia({ mediaInspectDto }, options)),
    );
  });
export const readOperation = (
  binding: ServerBinding,
  token: string,
  id: string,
  fetch = defaultFetch(),
): Promise<MediaOperationView> =>
  call(binding, token, fetch, async (options) =>
    checkedOperation(await getMediaImport({ id }, options)),
  );
export const startDownload = (
  binding: ServerBinding,
  token: string,
  mediaImportCreateDto: MediaImportCreateDto,
  fetch = defaultFetch(),
): Promise<MediaOperationView> =>
  call(binding, token, fetch, async (options) =>
    checkedOperation(
      await createMediaImport({ mediaImportCreateDto }, options),
    ),
  );
export const cancelDownload = (
  binding: ServerBinding,
  token: string,
  id: string,
  fetch = defaultFetch(),
): Promise<MediaOperationView> =>
  call(binding, token, fetch, async (options) =>
    checkedOperation(await cancelMediaImport({ id }, options)),
  );
export const retryDownload = (
  binding: ServerBinding,
  token: string,
  id: string,
  idempotencyKey: string,
  fetch = defaultFetch(),
): Promise<MediaOperationView> =>
  call(binding, token, fetch, async (options) =>
    checkedOperation(
      await retryMediaImport(
        { id, mediaRetryDto: { idempotencyKey } },
        options,
      ),
    ),
  );

export interface MediaSubscriptionView {
  id: string;
  creator: string;
  provider: string;
  albumId: string | null;
}
export const subscribe = (
  binding: ServerBinding,
  token: string,
  mediaSubscriptionCreateDto: MediaSubscriptionCreateDto,
  fetch = defaultFetch(),
): Promise<MediaSubscriptionView> =>
  call(binding, token, fetch, async (options) => {
    const made = await createMediaSubscription(
      { mediaSubscriptionCreateDto },
      options,
    );
    if (!made || !uuid.test(String(made.id)))
      throw new LibraryFailure('refused');
    return {
      id: made.id,
      creator: text(made.creator, 300) || 'Creator',
      provider: text(made.provider, 100) || '',
      albumId: uuid.test(String(made.albumId)) ? made.albumId : null,
    };
  });

export interface SiteConnectionView {
  id: string;
  provider: string;
  label: string;
  domains: string[];
  status: 'connected' | 'expired' | 'disconnected';
}
function checkedConnection(value: unknown): SiteConnectionView {
  const raw = value as Record<string, unknown> | null;
  if (!raw || typeof raw !== 'object' || !uuid.test(String(raw.id)))
    throw new LibraryFailure('refused');
  return {
    id: String(raw.id),
    provider: text(raw.provider, 100) || '',
    label: text(raw.label, 255) || '',
    domains: (Array.isArray(raw.domains) ? raw.domains : [])
      .filter((domain): domain is string => typeof domain === 'string')
      .slice(0, 20),
    status:
      raw.status === 'connected' || raw.status === 'expired'
        ? raw.status
        : 'disconnected',
  };
}
/** Connected sites as the Library lists them: names and domains, never what was shared. */
export const siteConnections = (
  binding: ServerBinding,
  token: string,
  fetch = defaultFetch(),
): Promise<SiteConnectionView[]> =>
  call(binding, token, fetch, async (options) => {
    const found = await getMediaConnections(options);
    return (Array.isArray(found?.connections) ? found.connections : [])
      .slice(0, 200)
      .map(checkedConnection);
  });
const overHttps = (binding: ServerBinding) => {
  if (!binding.origin.startsWith('https://')) throw new LibraryFailure('https');
};
/**
 * Shares a site's sign-in with the Library: straight to the bound HTTPS address, in this one
 * request. It is never written to the saving list, to storage or to a log.
 */
export const connectSite = async (
  binding: ServerBinding,
  token: string,
  mediaConnectionCreateDto: MediaConnectionCreateDto,
  fetch = defaultFetch(),
): Promise<SiteConnectionView> => {
  overHttps(binding);
  return call(binding, token, fetch, async (options) =>
    checkedConnection(
      await createMediaConnection({ mediaConnectionCreateDto }, options),
    ),
  );
};
export const refreshSite = async (
  binding: ServerBinding,
  token: string,
  id: string,
  session: MediaConnectionCreateDto['session'],
  fetch = defaultFetch(),
): Promise<SiteConnectionView> => {
  overHttps(binding);
  return call(binding, token, fetch, async (options) =>
    checkedConnection(
      await refreshMediaConnection(
        { id, mediaConnectionRefreshDto: { session } },
        options,
      ),
    ),
  );
};
export const disconnectSite = (
  binding: ServerBinding,
  token: string,
  id: string,
  fetch = defaultFetch(),
): Promise<SiteConnectionView> =>
  call(binding, token, fetch, async (options) =>
    checkedConnection(await disconnectMediaConnection({ id }, options)),
  );
