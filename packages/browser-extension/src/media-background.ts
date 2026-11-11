import type { ServerBinding } from './api';
import {
  connectSite,
  disconnectSite,
  inspect,
  mediaCapabilities,
  LibraryFailure,
  readOperation,
  refreshSite,
  siteConnections,
  type MediaCapabilityView,
  type MediaOperationView,
  type SiteConnectionView,
} from './media-api';
import {
  classifyMedia,
  groupMedia,
  mediaUrl,
  MediaWatch,
  type FoundMedia,
  type SeenMedia,
} from './media-discovery';
import {
  addMediaReceipt,
  type MediaDownloadRequest,
  type MediaSubscriptionRequest,
} from './media-queue';
import { QueueFailure, sameDestination } from './queue';
import { readSiteAccess, siteOf, sitePatterns } from './site-access';

/**
 * FL-1427: what the popup's Media tab asks the background to do. Everything here is started by a
 * press in the popup, acts on the tab you are looking at, and talks only to your own Library.
 */
export type MediaMode = 'page' | 'found' | 'subscribe';
export type MediaRequest =
  | {
      type:
        | 'media-state'
        | 'media-check'
        | 'media-find'
        | 'media-watch'
        | 'media-site';
    }
  | { type: 'media-inspect'; mode: 'page' | 'subscribe' }
  | { type: 'media-inspect'; mode: 'found'; urls: string[] }
  | { type: 'media-poll'; id: string }
  | ({ type: 'media-download'; label: string } & MediaDownloadRequest)
  | ({ type: 'media-subscribe'; label: string } & MediaSubscriptionRequest)
  | { type: 'media-connect'; connectionId?: string }
  | { type: 'media-disconnect'; id: string };
export interface FoundView {
  items: FoundMedia[];
  /** This tab's requests are being listed as they happen. */
  watching: boolean;
  /** The page's own address, to ask the browser for access to. */
  origin: string;
  /** Other sites this page loads media from that the extension may not look at yet. */
  hosts: string[];
}
export interface SiteView {
  host: string;
  /** The addresses whose sign-in would be shared. */
  origins: string[];
  /** The browser has allowed reading this site's sign-in. */
  allowed: boolean;
  /** The domains your Library would keep access to. */
  domains?: string[];
  count?: number;
  reason?: 'signed-out' | 'partitioned';
  connection?: SiteConnectionView;
}
export interface MediaReplyData {
  capability?: MediaCapabilityView;
  /** This browser's access covers media downloads (a pasted key is tried and may be refused). */
  granted?: boolean;
  operation?: MediaOperationView;
  /** An inspection started a moment ago, so a reopened popup carries on with it. */
  draft?: { mode: MediaMode; label: string; operation: MediaOperationView };
  found?: FoundView;
  site?: SiteView;
}
export type MediaContext = {
  binding: ServerBinding;
  token: string;
  /** Wakes the saving list so a new receipt is handed to the Library straight away. */
  wake: () => void;
};

const uuid =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const NOT_A_PAGE = 'Open a web page in this tab, then try again.';

async function activePage() {
  const [tab] = await chrome.tabs.query({
    active: true,
    lastFocusedWindow: true,
  });
  const url = mediaUrl(tab?.url);
  if (!tab?.id || !url) throw new QueueFailure(NOT_A_PAGE);
  return {
    tabId: tab.id,
    url: url.href,
    origin: url.origin,
    title: (tab.title ?? '').trim().slice(0, 300) || url.hostname,
  };
}
const originPattern = (origin: string) => {
  const url = new URL(origin);
  return `${url.protocol}//${url.hostname}/*`;
};

/** In memory only, and gone when the browser puts the extension to sleep. */
const watch = new MediaWatch();
let listening = false;
function seen(details: {
  tabId: number;
  url: string;
  type: string;
}): undefined {
  // A new document in the tab: what the last one loaded no longer applies.
  if (details.type === 'main_frame')
    watch.documentChanged(details.tabId, details.url);
  else
    watch.record(
      details.tabId,
      details.url,
      details.type === 'media' ? 'media' : 'other',
    );
}
/** Starts listing requests. Only possible once you allowed it, and only while a tab is watched. */
function listenForMedia() {
  if (listening || !chrome.webRequest?.onBeforeRequest) return;
  listening = true;
  chrome.webRequest.onBeforeRequest.addListener(seen, {
    urls: ['http://*/*', 'https://*/*'],
    types: ['main_frame', 'media', 'xmlhttprequest', 'other'],
  });
}
export function registerMediaWatch() {
  chrome.tabs.onUpdated?.addListener((tabId, change) => {
    if (change.url) watch.navigated(tabId, change.url);
  });
  chrome.tabs.onRemoved?.addListener((tabId) => {
    if (!watch.closed(tabId) || !listening) return;
    // nothing is watched any more, so nothing is listened to
    listening = false;
    chrome.webRequest?.onBeforeRequest.removeListener(seen);
  });
}

/** What the page itself shows: runs in the tab you pressed the button on, once. */
function collectPageMedia() {
  const urls: { url: string; hint: 'media' | 'other' }[] = [];
  const add = (url: unknown, hint: 'media' | 'other') => {
    if (typeof url === 'string' && url && urls.length < 1000)
      urls.push({ url, hint });
  };
  for (const element of document.querySelectorAll('video, audio')) {
    const media = element as HTMLMediaElement;
    add(media.currentSrc || media.src, 'media');
    for (const source of media.querySelectorAll('source'))
      add(source.src, 'media');
  }
  for (const entry of performance.getEntriesByType('resource'))
    add(entry.name, 'other');
  return { documentUrl: document.URL, urls };
}
async function find(): Promise<FoundView> {
  const page = await activePage();
  const [result] = await chrome.scripting.executeScript({
    target: { tabId: page.tabId },
    world: 'ISOLATED',
    func: collectPageMedia,
  });
  const raw = result?.result as ReturnType<typeof collectPageMedia> | undefined;
  // What a page hands back is untrusted, and must be about the page that was asked.
  if (
    !result ||
    result.frameId !== 0 ||
    !raw ||
    raw.documentUrl !== page.url ||
    !Array.isArray(raw.urls)
  )
    throw new QueueFailure(
      'Could not look at this page. Go back to it and try again.',
    );
  const seen: SeenMedia[] = [];
  for (const item of raw.urls.slice(0, 1000)) {
    const media = classifyMedia(
      item?.url,
      item?.hint === 'media' ? 'media' : 'other',
    );
    if (media) seen.push(media);
  }
  seen.push(...watch.list(page.tabId, page.url));
  const others = [
    ...new Set(seen.map((item) => new URL(item.url).origin)),
  ].filter((origin) => origin !== page.origin);
  const hosts: string[] = [];
  for (const origin of others.slice(0, 10))
    if (
      !(await chrome.permissions.contains({ origins: [originPattern(origin)] }))
    )
      hosts.push(origin);
  return {
    items: groupMedia(seen),
    watching: listening && watch.watching(page.tabId, page.url),
    origin: page.origin,
    hosts,
  };
}
/** Starts listing this tab's requests. The popup asked the browser first; this checks it said yes. */
async function startWatching(): Promise<FoundView> {
  const page = await activePage();
  if (
    !(await chrome.permissions.contains({
      permissions: ['webRequest'],
      origins: [originPattern(page.origin)],
    }))
  )
    throw new QueueFailure(
      'Watching this tab wasn’t allowed. Nothing more is looked at.',
    );
  listenForMedia();
  if (!watch.watching(page.tabId, page.url)) watch.start(page.tabId, page.url);
  return find();
}

async function cookieStore(tabId: number) {
  const stores = await chrome.cookies.getAllCookieStores();
  return stores.find((store) => store.tabIds.includes(tabId))?.id;
}
const covers = (connection: SiteConnectionView, host: string) =>
  connection.domains.some(
    (domain) => host === domain || host.endsWith(`.${domain}`),
  );
async function site(context: MediaContext): Promise<{
  view: SiteView;
  tabId: number;
}> {
  const page = await activePage();
  const found = siteOf(page.url);
  if (!found)
    throw new QueueFailure(
      'A site’s sign-in can only be shared from an https:// page.',
    );
  const connection = (
    await siteConnections(context.binding, context.token)
  ).find(
    // by the tab's real host: a connection made from "www." cookies alone covers only "www."
    (item) =>
      item.status !== 'disconnected' &&
      covers(item, new URL(page.url).hostname.toLowerCase()),
  );
  const allowed = await chrome.permissions.contains({
    permissions: ['cookies'],
    origins: sitePatterns(found.origins),
  });
  return {
    tabId: page.tabId,
    view: { ...found, allowed, ...(connection && { connection }) },
  };
}
const SITE_REASONS = {
  'signed-out':
    'You don’t seem to be signed in to this site in this browser. Sign in on the page, then try again.',
  partitioned:
    'This site keeps its sign-in in a way your Library can’t use from the browser. Connect it in Boards instead.',
};

let draft:
  | {
      binding: ServerBinding;
      mode: MediaMode;
      label: string;
      id: string;
      at: number;
    }
  | undefined;
const DRAFT_MS = 10 * 60 * 1000;

export async function handleMedia(
  message: { type: string },
  context: MediaContext,
): Promise<MediaReplyData> {
  const { binding, token } = context;
  const request = message as MediaRequest;
  switch (request.type) {
    // "Retry" after a certificate problem: always a real request, never a remembered answer.
    case 'media-check':
      return { capability: await mediaCapabilities(binding, token) };
    case 'media-state': {
      const capability = await mediaCapabilities(binding, token);
      const kept =
        draft &&
        sameDestination(draft.binding, binding) &&
        Date.now() - draft.at < DRAFT_MS
          ? draft
          : undefined;
      const operation = kept
        ? await readOperation(binding, token, kept.id).catch(() => undefined)
        : undefined;
      return {
        capability,
        ...(kept &&
          operation && {
            draft: { mode: kept.mode, label: kept.label, operation },
          }),
      };
    }
    case 'media-inspect': {
      const page = await activePage();
      let urls = [page.url];
      if (request.mode === 'found') {
        // Only what you ticked is sent, and only as addresses.
        const chosen = Array.isArray(request.urls) ? request.urls : [];
        urls = [...new Set(chosen.map((url) => mediaUrl(url)?.href))].filter(
          (url): url is string => !!url,
        );
        if (urls.length === 0 || urls.length > 20 || chosen.length > 20)
          throw new QueueFailure('Choose between 1 and 20 things to check.');
      } else if (request.mode !== 'page' && request.mode !== 'subscribe')
        throw new QueueFailure(NOT_A_PAGE);
      // A site you connected is used only for addresses on that site's own domains.
      const connection = (await siteConnections(binding, token)).find(
        (item) =>
          item.status === 'connected' &&
          urls.every((url) => covers(item, new URL(url).hostname)),
      );
      const operation = await inspect(binding, token, {
        urls,
        connectionId: connection?.id,
        subscription: request.mode === 'subscribe',
      });
      draft = {
        binding,
        mode: request.mode,
        label: page.title,
        id: operation.id,
        at: Date.now(),
      };
      return { operation };
    }
    case 'media-poll': {
      if (!uuid.test(String(request.id)))
        throw new QueueFailure('Start again from the page.');
      try {
        return { operation: await readOperation(binding, token, request.id) };
      } catch (error) {
        if (error instanceof LibraryFailure && error.status === 404)
          throw new QueueFailure(
            'Your Library no longer has this check. Start again from the page.',
          );
        throw error;
      }
    }
    case 'media-download':
    case 'media-subscribe': {
      const label = typeof request.label === 'string' ? request.label : '';
      // Kept first, sent second: the saving list hands it to your Library and follows it from here.
      await (request.type === 'media-download'
        ? addMediaReceipt({
            kind: 'download',
            binding,
            label,
            request: {
              inspectionId: request.inspectionId,
              itemIds: request.itemIds,
              albumId: request.albumId,
              tagIds: request.tagIds,
              overrideSuppression: request.overrideSuppression,
            },
          })
        : addMediaReceipt({
            kind: 'subscription',
            binding,
            label,
            request: {
              inspectionId: request.inspectionId,
              parentId: request.parentId,
              history: request.history,
              intervalMinutes: request.intervalMinutes,
            },
          }));
      draft = undefined;
      context.wake();
      return {};
    }
    case 'media-find':
      return { found: await find() };
    case 'media-watch':
      return { found: await startWatching() };
    case 'media-site': {
      const { view, tabId } = await site(context);
      if (!view.allowed) return { site: view };
      const access = await readSiteAccess(
        view.origins,
        await cookieStore(tabId),
      );
      return {
        site: access.ok
          ? { ...view, domains: access.domains, count: access.count }
          : { ...view, reason: access.reason },
      };
    }
    case 'media-connect': {
      const { view, tabId } = await site(context);
      if (!view.allowed)
        throw new QueueFailure(
          'Reading this site’s sign-in wasn’t allowed, so nothing was shared.',
        );
      // Read now and handed straight to the Library; it is not kept anywhere here.
      const access = await readSiteAccess(
        view.origins,
        await cookieStore(tabId),
      );
      if (!access.ok) throw new QueueFailure(SITE_REASONS[access.reason]);
      const refreshing = request.connectionId;
      if (refreshing !== undefined && refreshing !== view.connection?.id)
        throw new QueueFailure('That connection is for a different site.');
      const connection = refreshing
        ? await refreshSite(binding, token, refreshing, access.session)
        : await connectSite(binding, token, {
            provider: access.domains[0],
            label: view.host.slice(0, 255),
            session: access.session,
          });
      return {
        site: {
          ...view,
          domains: access.domains,
          count: access.count,
          connection,
        },
      };
    }
    case 'media-disconnect': {
      if (!uuid.test(String(request.id)))
        throw new QueueFailure('Choose a connected site.');
      await disconnectSite(binding, token, request.id);
      return {};
    }
    default:
      throw new LibraryFailure('refused');
  }
}
