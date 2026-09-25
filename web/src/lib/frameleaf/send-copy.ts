import {
  AssetVisibility,
  downloadAsset,
  getAssetInfo,
  getPartners,
  PartnerDirection,
  type AssetResponseDto,
  type SharedLinkResponseDto,
} from '@immich/sdk';
import { toastManager, type ToastShow } from '@immich/ui';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { getSharedLink } from '$lib/utils';

/**
 * "Send a copy…" (FL-35, FL-54): the native share sheet (AirDrop, Messages, Mail…) with the original
 * files, ported from the template's `sendCopy` (App.jsx:818-846) and approved on September 24
 * ("Send a copy… through the native share sheet, kept separate from Frameleaf sharing").
 *
 * It never creates a link, a shared space or any server-side share: the files are fetched through
 * the ordinary download endpoint (`GET /assets/:id/original`, which checks the download permission
 * for the signed-in user or the shared link) and handed to the browser. Before anything is
 * downloaded it leaves out:
 * - Locked and trashed items, whatever the session can see (owner rule: Locked content is never
 *   revealed through a share);
 * - items of a partner who hides their locations from this user (`partner.shareLocation` off):
 *   an original carries its GPS in its own metadata, which only the API responses strip.
 *
 * A shared link sends copies only when it allows downloads and shows metadata, the same gate as its
 * download (an original carries all of its metadata). Where the browser cannot share files the entry
 * is not offered at all.
 */

/**
 * The most items and the most bytes one share takes. Every original is held in memory until the
 * share sheet has them, so an unbounded selection could exhaust the tab; the prototype has no
 * limit (owner decision recorded in the audit).
 */
export const SEND_COPY_LIMIT = 50;
export const SEND_COPY_MAX_BYTES = 500 * 1024 * 1024;
/** Requests in flight at once, for the metadata lookups and the downloads alike. */
export const SEND_COPY_CONCURRENCY = 4;

/**
 * The Web Share API, feature-detected: older engines the web client still supports have no
 * `share` or `canShare`, which is exactly when the entry points stay hidden.
 */
type ShareCapable = {
  share?: (data: ShareData) => Promise<void>;
  canShare?: (data: ShareData) => boolean;
};

const browserNavigator = (): ShareCapable | undefined =>
  typeof navigator === 'undefined' ? undefined : (navigator as unknown as ShareCapable);

/** True where the browser's share sheet takes files; the entry points are hidden everywhere else. */
export const canSendCopies = (nav: ShareCapable | undefined = browserNavigator()): boolean => {
  if (!nav || typeof nav.share !== 'function' || typeof nav.canShare !== 'function') {
    return false;
  }
  try {
    return nav.canShare({ files: [new File([new Uint8Array(0)], 'frameleaf.jpg', { type: 'image/jpeg' })] });
  } catch {
    return false;
  }
};

/**
 * Whether this session may send copies at all: a signed-in user, or a shared link that allows
 * downloads and shows metadata (its owner always may), as `SharedLinkDownload` and the public
 * shell gate the download.
 */
export const sendCopyPermitted = (
  sharedLink: Pick<SharedLinkResponseDto, 'allowDownload' | 'showMetadata' | 'userId'> | undefined = getSharedLink(),
): boolean => {
  const userId = authManager.authenticated ? authManager.user.id : undefined;
  if (!sharedLink) {
    return !!userId;
  }
  return sharedLink.userId === userId || (sharedLink.allowDownload && sharedLink.showMetadata);
};

/** Locked and trashed items are never sent. */
export const isSendable = (asset: Pick<AssetResponseDto, 'visibility' | 'isTrashed'>): boolean =>
  asset.visibility !== AssetVisibility.Locked && !asset.isTrashed;

export type SendCopyDeps = {
  getInfo: (id: string) => Promise<AssetResponseDto>;
  getOriginal: (id: string) => Promise<Blob>;
  /** Owners who hide their asset locations from this user (partners with `shareLocation` off). */
  getLocationHiddenOwners: () => Promise<Set<string>>;
  /** The server serves a shared link the edited file, so the copy is named after it. */
  servesEdited: boolean;
  share: (data: ShareData) => Promise<void>;
  canShare: (data: ShareData) => boolean;
  /** Called once the items are known to be sendable, before the downloads start. */
  onPreparing?: (count: number) => void;
  /** Called once the downloads have settled, before the share sheet opens. */
  onPrepared?: () => void;
  /** The byte cap; `SEND_COPY_MAX_BYTES` unless a test sets a smaller one. */
  maxBytes?: number;
};

export type PreparedCopies = {
  files: File[];
  /** Locked or trashed items left out before download. */
  skipped: number;
  /** Items of a partner who hides their locations from this user, left out before download. */
  locationHidden: number;
  /** Items the server refused or that failed to download. */
  failed: number;
};

export type SendCopyOutcome =
  /** The share sheet finished. */
  | 'sent'
  /** The person closed the share sheet. */
  | 'cancelled'
  /** Nothing in the request could be sent. */
  | 'nothing'
  | 'too-many'
  | 'too-large'
  /** The session may not send copies (a shared link without downloads or metadata). */
  | 'not-permitted'
  /** The browser cannot share these particular files. */
  | 'unsupported'
  /** The download outlasted the click that asked for it; the browser wants a fresh one. */
  | 'needs-gesture'
  | 'failed';

export type SendCopyResult = PreparedCopies & {
  outcome: SendCopyOutcome;
  /** Present for `needs-gesture`: shares the already prepared files from a new click. */
  retry?: () => Promise<SendCopyResult>;
};

const locationHiddenOwners = async (): Promise<Set<string>> => {
  if (!authManager.authenticated || getSharedLink()) {
    return new Set();
  }
  const partners = await getPartners({ direction: PartnerDirection.SharedWith });
  return new Set(partners.filter((partner) => partner.shareLocation === false).map((partner) => partner.id));
};

const defaultDeps = (): SendCopyDeps => ({
  getInfo: (id) => getAssetInfo({ ...authManager.params, id }),
  // Originals only: `edited` is left unset, so the endpoint serves the file as it was imported
  // (a shared link is always served the edited file, which `servesEdited` names).
  getOriginal: (id) => downloadAsset({ ...authManager.params, id }),
  getLocationHiddenOwners: locationHiddenOwners,
  servesEdited: !!getSharedLink(),
  share: (data) => browserNavigator()?.share?.(data) ?? Promise.reject(new DOMException('', 'NotSupportedError')),
  canShare: (data) => !!browserNavigator()?.canShare?.(data),
});

/** Runs `work` over `items` with at most `limit` in flight, settling each one. */
export const mapSettled = async <T, R>(
  items: readonly T[],
  limit: number,
  work: (item: T) => Promise<R>,
): Promise<PromiseSettledResult<R>[]> => {
  const results: PromiseSettledResult<R>[] = Array.from({ length: items.length });
  let next = 0;
  const lane = async () => {
    while (next < items.length) {
      const index = next++;
      try {
        results[index] = { status: 'fulfilled', value: await work(items[index]) };
      } catch (error) {
        results[index] = { status: 'rejected', reason: error };
      }
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, lane));
  return results;
};

const EXTENSIONS: Record<string, string> = {
  'image/jpeg': '.jpg',
  'image/png': '.png',
  'image/webp': '.webp',
  'image/avif': '.avif',
  'image/heic': '.heic',
  'image/heif': '.heif',
  'image/tiff': '.tiff',
  'video/mp4': '.mp4',
  'video/quicktime': '.mov',
};

/** The copy's name: the original's, with the served file's extension when that is the edited file. */
const fileName = (info: AssetResponseDto, blob: Blob, servesEdited: boolean) => {
  const extension = servesEdited && info.isEdited ? EXTENSIONS[blob.type] : undefined;
  if (!extension) {
    return info.originalFileName;
  }
  const dot = info.originalFileName.lastIndexOf('.');
  return (dot > 0 ? info.originalFileName.slice(0, dot) : info.originalFileName) + extension;
};

type Resolved = { outcome?: 'too-large'; prepared: PreparedCopies };

/** Looks every item up and downloads the sendable originals, a few at a time. */
export const prepareCopies = async (ids: readonly string[], deps: SendCopyDeps): Promise<Resolved> => {
  const prepared: PreparedCopies = { files: [], skipped: 0, locationHidden: 0, failed: 0 };
  const lookups = await mapSettled([...new Set(ids)], SEND_COPY_CONCURRENCY, (id) => deps.getInfo(id));
  const infos: AssetResponseDto[] = [];
  for (const lookup of lookups) {
    if (lookup.status === 'rejected') {
      prepared.failed++;
    } else if (isSendable(lookup.value)) {
      infos.push(lookup.value);
    } else {
      prepared.skipped++;
    }
  }

  const userId = authManager.authenticated ? authManager.user.id : undefined;
  const hidden = infos.some((info) => info.ownerId !== userId) ? await deps.getLocationHiddenOwners() : new Set();
  const sendable = infos.filter((info) => !hidden.has(info.ownerId));
  prepared.locationHidden = infos.length - sendable.length;

  // Known sizes are checked before anything is downloaded; an item without a recorded size is
  // counted as it arrives, and the set is abandoned as soon as the total passes the cap.
  const maxBytes = deps.maxBytes ?? SEND_COPY_MAX_BYTES;
  const known = sendable.reduce((total, info) => total + (info.exifInfo?.fileSizeInByte ?? 0), 0);
  if (known > maxBytes) {
    return { outcome: 'too-large', prepared };
  }

  if (sendable.length > 0) {
    deps.onPreparing?.(sendable.length);
  }
  let received = 0;
  let overCap = false;
  const downloads = await mapSettled(sendable, SEND_COPY_CONCURRENCY, async (info) => {
    if (overCap) {
      throw new RangeError('over the byte cap');
    }
    const blob = await deps.getOriginal(info.id);
    received += blob.size;
    if (received > maxBytes) {
      overCap = true;
      throw new RangeError('over the byte cap');
    }
    return new File([blob], fileName(info, blob, deps.servesEdited), {
      type: blob.type || info.originalMimeType || 'application/octet-stream',
    });
  });
  if (overCap) {
    deps.onPrepared?.();
    return { outcome: 'too-large', prepared };
  }
  for (const download of downloads) {
    if (download.status === 'fulfilled') {
      prepared.files.push(download.value);
    } else {
      prepared.failed++;
    }
  }
  deps.onPrepared?.();
  return { prepared };
};

const shareTitle = (files: File[]) =>
  files.length === 1 ? files[0].name : get(t)('frameleaf_send_copy_title', { values: { count: files.length } });

const shareFiles = async (prepared: PreparedCopies, deps: SendCopyDeps): Promise<SendCopyResult> => {
  const data: ShareData = { files: prepared.files, title: shareTitle(prepared.files) };
  if (!deps.canShare(data)) {
    return { ...prepared, outcome: 'unsupported' };
  }
  try {
    await deps.share(data);
    return { ...prepared, outcome: 'sent' };
  } catch (error) {
    const name = (error as { name?: string } | null)?.name;
    if (name === 'AbortError') {
      return { ...prepared, outcome: 'cancelled' };
    }
    if (name === 'NotAllowedError') {
      return { ...prepared, outcome: 'needs-gesture', retry: () => shareFiles(prepared, deps) };
    }
    return { ...prepared, outcome: 'failed' };
  }
};

/** Prepares and shares copies of `ids`. Pure apart from `deps`, so every outcome is testable. */
export const sendCopies = async (
  ids: readonly string[],
  deps: SendCopyDeps = defaultDeps(),
  permitted: boolean = sendCopyPermitted(),
): Promise<SendCopyResult> => {
  const empty: PreparedCopies = { files: [], skipped: 0, locationHidden: 0, failed: 0 };
  if (!permitted) {
    return { ...empty, outcome: 'not-permitted' };
  }
  if (new Set(ids).size > SEND_COPY_LIMIT) {
    return { ...empty, outcome: 'too-many' };
  }
  const { outcome, prepared } = await prepareCopies(ids, deps);
  if (outcome) {
    return { ...prepared, outcome };
  }
  if (prepared.files.length === 0) {
    return { ...prepared, outcome: prepared.failed > 0 ? 'failed' : 'nothing' };
  }
  return shareFiles(prepared, deps);
};

let sending = false;

/**
 * A toast that stays until closed (or until `close` is called), so an action in it cannot vanish
 * before the person reaches it.
 */
const stickyToast = (item: ToastShow) => {
  const toast: ToastShow & { onClose?: () => void } = item;
  toastManager.show(toast, { timeout: 0, closable: true });
  return () => toast.onClose?.();
};

/** Reports what happened; the share sheet itself is the success feedback. */
const report = (result: SendCopyResult) => {
  const $t = get(t);
  const count = result.files.length + result.skipped + result.locationHidden + result.failed;
  switch (result.outcome) {
    case 'too-many': {
      toastManager.warning($t('frameleaf_send_copy_too_many', { values: { limit: SEND_COPY_LIMIT } }));
      return;
    }
    case 'too-large': {
      toastManager.warning($t('frameleaf_send_copy_too_large', { values: { limit: SEND_COPY_MAX_BYTES / 1024 ** 2 } }));
      return;
    }
    case 'not-permitted':
    case 'unsupported':
    case 'failed': {
      toastManager.danger($t('frameleaf_send_copy_failed', { values: { count: Math.max(1, count) } }));
      return;
    }
    case 'needs-gesture': {
      const close = stickyToast({
        color: 'primary',
        description: $t('frameleaf_send_copy_ready', { values: { count: result.files.length } }),
        button: {
          label: $t('frameleaf_send_copy_send'),
          onclick: () => {
            close();
            void result.retry?.().then(report);
          },
        },
      });
      return;
    }
    case 'sent':
    case 'cancelled':
    case 'nothing': {
      break;
    }
  }
  if (result.skipped > 0) {
    toastManager.info($t('frameleaf_send_copy_skipped', { values: { count: result.skipped } }));
  }
  if (result.locationHidden > 0) {
    toastManager.info($t('frameleaf_send_copy_skipped_location', { values: { count: result.locationHidden } }));
  }
  if (result.failed > 0 && result.outcome !== 'nothing') {
    toastManager.warning($t('frameleaf_send_copy_partial', { values: { count: result.failed } }));
  }
};

/**
 * The entry points' action: one send at a time, with progress and the outcome in toasts. Nothing
 * fails silently: an unexpected error (a partner lookup that fails, say) is reported as a failure.
 */
export const sendCopiesWithFeedback = async (
  ids: readonly string[],
  overrides: Partial<SendCopyDeps> = {},
  permitted: boolean = sendCopyPermitted(),
): Promise<void> => {
  if (sending || ids.length === 0) {
    return;
  }
  sending = true;
  let closePreparing: (() => void) | undefined;
  try {
    const deps: SendCopyDeps = {
      ...defaultDeps(),
      onPreparing: (count) => {
        closePreparing = stickyToast({
          color: 'info',
          description: get(t)('frameleaf_send_copy_preparing', { values: { count } }),
        });
      },
      onPrepared: () => closePreparing?.(),
      ...overrides,
    };
    report(await sendCopies(ids, deps, permitted));
  } catch {
    report({ files: [], skipped: 0, locationHidden: 0, failed: ids.length, outcome: 'failed' });
  } finally {
    closePreparing?.();
    sending = false;
  }
};
