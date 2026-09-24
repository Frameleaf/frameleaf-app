import { AssetVisibility, downloadAsset, getAssetInfo, type AssetResponseDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { t } from 'svelte-i18n';
import { get } from 'svelte/store';
import { authManager } from '$lib/managers/auth-manager.svelte';

/**
 * "Send a copy…" (FL-35, FL-54): the native share sheet (AirDrop, Messages, Mail…) with the original
 * files, ported from the template's `sendCopy` (App.jsx:818-846) and approved on September 24
 * ("Send a copy… through the native share sheet, kept separate from Frameleaf sharing").
 *
 * It never creates a link, a shared space or any server-side share: the files are fetched through
 * the ordinary download endpoint (`GET /assets/:id/original`, which checks the download permission
 * for the signed-in user or the shared link) and handed to the browser. Locked items are left out
 * before anything is downloaded, whatever the session can see (owner rule: Locked content is never
 * revealed through a share). Where the browser cannot share files the entry is not offered at all.
 */

/**
 * The most items one share takes. Every original is held in memory until the share sheet has
 * them, so an unbounded selection could exhaust the tab; the prototype has no limit (owner decision
 * recorded in the FL-35 report).
 */
export const SEND_COPY_LIMIT = 50;

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

/** Locked and trashed items are never sent. */
export const isSendable = (asset: Pick<AssetResponseDto, 'visibility' | 'isTrashed'>): boolean =>
  asset.visibility !== AssetVisibility.Locked && !asset.isTrashed;

export type SendCopyDeps = {
  getInfo: (id: string) => Promise<AssetResponseDto>;
  getOriginal: (id: string) => Promise<Blob>;
  share: (data: ShareData) => Promise<void>;
  canShare: (data: ShareData) => boolean;
};

export type PreparedCopies = {
  files: File[];
  /** Locked or trashed items left out before download. */
  skipped: number;
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

const defaultDeps = (): SendCopyDeps => ({
  getInfo: (id) => getAssetInfo({ ...authManager.params, id }),
  // Originals only: `edited` is left unset, so the endpoint serves the file as it was imported.
  getOriginal: (id) => downloadAsset({ ...authManager.params, id }),
  share: (data) => browserNavigator()?.share?.(data) ?? Promise.reject(new DOMException('', 'NotSupportedError')),
  canShare: (data) => !!browserNavigator()?.canShare?.(data),
});

/** Downloads the sendable originals. Locked items are dropped before their file is requested. */
export const prepareCopies = async (ids: readonly string[], deps: SendCopyDeps): Promise<PreparedCopies> => {
  const results = await Promise.allSettled(
    [...new Set(ids)].map(async (id) => {
      const info = await deps.getInfo(id);
      if (!isSendable(info)) {
        return null;
      }
      const blob = await deps.getOriginal(id);
      return new File([blob], info.originalFileName, {
        type: blob.type || info.originalMimeType || 'application/octet-stream',
      });
    }),
  );

  const prepared: PreparedCopies = { files: [], skipped: 0, failed: 0 };
  for (const result of results) {
    if (result.status === 'rejected') {
      prepared.failed++;
    } else if (result.value) {
      prepared.files.push(result.value);
    } else {
      prepared.skipped++;
    }
  }
  return prepared;
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
): Promise<SendCopyResult> => {
  const empty: PreparedCopies = { files: [], skipped: 0, failed: 0 };
  if (new Set(ids).size > SEND_COPY_LIMIT) {
    return { ...empty, outcome: 'too-many' };
  }
  const prepared = await prepareCopies(ids, deps);
  if (prepared.files.length === 0) {
    return { ...prepared, outcome: prepared.failed > 0 ? 'failed' : 'nothing' };
  }
  return shareFiles(prepared, deps);
};

let sending = false;

/** Reports what happened; the share sheet itself is the success feedback. */
const report = (result: SendCopyResult) => {
  const $t = get(t);
  const count = result.files.length + result.skipped + result.failed;
  switch (result.outcome) {
    case 'too-many': {
      toastManager.warning($t('frameleaf_send_copy_too_many', { values: { limit: SEND_COPY_LIMIT } }));
      return;
    }
    case 'unsupported':
    case 'failed': {
      toastManager.danger($t('frameleaf_send_copy_failed', { values: { count: Math.max(1, count) } }));
      return;
    }
    case 'needs-gesture': {
      toastManager.primary({
        description: $t('frameleaf_send_copy_ready', { values: { count: result.files.length } }),
        button: {
          label: $t('frameleaf_send_copy_send'),
          onclick: () => void result.retry?.().then(report),
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
    toastManager.info($t('frameleaf_send_copy_skipped_locked', { values: { count: result.skipped } }));
  }
  if (result.failed > 0 && result.outcome !== 'nothing') {
    toastManager.warning($t('frameleaf_send_copy_partial', { values: { count: result.failed } }));
  }
};

/** The entry points' action: one send at a time, with the outcome reported in a toast. */
export const sendCopiesWithFeedback = async (ids: readonly string[]): Promise<void> => {
  if (sending || ids.length === 0) {
    return;
  }
  sending = true;
  try {
    report(await sendCopies(ids));
  } finally {
    sending = false;
  }
};
