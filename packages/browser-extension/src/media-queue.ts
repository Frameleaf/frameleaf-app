import type { ServerBinding } from './api';
import {
  bindingCopy,
  QueueFailure,
  request,
  sameDestination,
  transaction,
} from './queue';

/**
 * FL-1427: receipts for work your Library does for you: a media download or a creator subscription.
 * They live in the saving list's own database, beside captures. A receipt holds what was asked for
 * (ids and choices), the Library's id for the work once it accepted it, and how it last stood. It
 * never holds a site's sign-in, a source address or the media itself: the Library has those.
 *
 * A receipt is bound to the server, account, address and access that made it. It is listed and
 * followed for the same server, account and address even after this browser signs in again (the
 * work is the account's, not the key's), and never for another account or server.
 */
export type MediaReceiptState =
  /** Not yet confirmed by the Library; sent again with the same key until it answers. */
  | 'submitting'
  /** The Library is working on it. */
  | 'active'
  | 'saved'
  | 'partial'
  | 'failed'
  | 'cancelled'
  | 'paused'
  /** A subscription the Library accepted. */
  | 'subscribed';
export type MediaDownloadRequest = {
  inspectionId: string;
  itemIds: string[];
  albumId: string;
  tagIds: string[];
  overrideSuppression: boolean;
};
export type MediaSubscriptionRequest = {
  inspectionId: string;
  parentId?: string;
  history: { mode: 'all' | 'new' } | { mode: 'since'; since: string };
  intervalMinutes: 15 | 60 | 360 | 1440;
};
interface ReceiptBase {
  version: 1;
  /** Made once, here. Also the key that makes sending the request again safe. */
  id: string;
  binding: ServerBinding;
  label: string;
  /** The Library's id for the download or subscription, once it accepted the request. */
  remoteId?: string;
  state: MediaReceiptState;
  /** The Library's own word for where the download is ("downloading", "assembling", …). */
  remoteState?: string;
  albumId?: string;
  saved: number;
  skipped: number;
  failed: number;
  discovered: number;
  error?: string;
  /** How many times the request was sent without a confirmed answer. */
  attempts: number;
  cancelRequested?: true;
  /** Made once per Retry, so a retry that is sent twice still happens once. */
  retryKey?: string;
  createdAt: number;
  updatedAt: number;
}
export type MediaReceipt = ReceiptBase &
  (
    | { kind: 'download'; request: MediaDownloadRequest }
    | { kind: 'subscription'; request: MediaSubscriptionRequest }
  );
export type NewMediaReceipt = { binding: ServerBinding; label: string } & (
  | { kind: 'download'; request: MediaDownloadRequest }
  | { kind: 'subscription'; request: MediaSubscriptionRequest }
);

const uuid =
  /^[\da-f]{8}-[\da-f]{4}-[1-8][\da-f]{3}-[89ab][\da-f]{3}-[\da-f]{12}$/i;
const states: MediaReceiptState[] = [
  'submitting',
  'active',
  'saved',
  'partial',
  'failed',
  'cancelled',
  'paused',
  'subscribed',
];
const invalid = () =>
  new QueueFailure(
    'This request’s details are incomplete. Start it again from the page.',
  );
const ids = (value: unknown, max: number): value is string[] =>
  Array.isArray(value) &&
  value.length <= max &&
  value.every((id) => typeof id === 'string' && uuid.test(id));

function downloadCopy(value: MediaDownloadRequest): MediaDownloadRequest {
  if (
    !value ||
    !uuid.test(value.inspectionId) ||
    !uuid.test(value.albumId) ||
    !ids(value.itemIds, 500) ||
    value.itemIds.length === 0 ||
    !ids(value.tagIds, 500)
  )
    throw invalid();
  return {
    inspectionId: value.inspectionId,
    itemIds: [...new Set(value.itemIds)],
    albumId: value.albumId,
    tagIds: [...new Set(value.tagIds)],
    // Restoring something you removed is only ever your explicit choice.
    overrideSuppression: value.overrideSuppression === true,
  };
}
function subscriptionCopy(
  value: MediaSubscriptionRequest,
): MediaSubscriptionRequest {
  const mode = value?.history?.mode;
  const since = mode === 'since' ? value.history.since : undefined;
  if (
    !value ||
    !uuid.test(value.inspectionId) ||
    !(value.parentId === undefined || uuid.test(value.parentId)) ||
    ![15, 60, 360, 1440].includes(value.intervalMinutes) ||
    // History is always a choice made by the person, never a default.
    !['all', 'since', 'new'].includes(mode) ||
    (mode === 'since' &&
      (typeof since !== 'string' || !Number.isFinite(Date.parse(since))))
  )
    throw invalid();
  return {
    inspectionId: value.inspectionId,
    ...(value.parentId && { parentId: value.parentId }),
    history:
      mode === 'since'
        ? { mode, since: new Date(since!).toISOString() }
        : { mode },
    intervalMinutes: value.intervalMinutes,
  };
}
/** A stored receipt is read like outside input; one that no longer makes sense is left out. */
function readable(value: MediaReceipt): boolean {
  try {
    if (
      value?.version !== 1 ||
      !uuid.test(value.id) ||
      !states.includes(value.state) ||
      typeof value.label !== 'string' ||
      !(value.remoteId === undefined || uuid.test(value.remoteId)) ||
      !(value.retryKey === undefined || uuid.test(value.retryKey)) ||
      !Number.isSafeInteger(value.attempts) ||
      !Number.isSafeInteger(value.createdAt)
    )
      return false;
    bindingCopy(value.binding);
    if (value.kind === 'download') downloadCopy(value.request);
    else if (value.kind === 'subscription') subscriptionCopy(value.request);
    else return false;
    return true;
  } catch {
    return false;
  }
}
export const mediaReceiptDone = (receipt: MediaReceipt) =>
  ['saved', 'partial', 'failed', 'cancelled', 'subscribed'].includes(
    receipt.state,
  );
/** Still needs the Library: unfinished, or a Cancel or Retry it has not heard yet. */
export const mediaReceiptPending = (receipt: MediaReceipt) =>
  !mediaReceiptDone(receipt) || !!receipt.cancelRequested || !!receipt.retryKey;

async function all(tx: IDBTransaction): Promise<MediaReceipt[]> {
  return (
    (await request(tx.objectStore('media').getAll())) as MediaReceipt[]
  ).filter(readable);
}
/** Finished receipts are kept for a while (the newest 50 per account), then tidied away. */
async function prune(tx: IDBTransaction, binding: ServerBinding) {
  const finished = (await all(tx))
    .filter(
      (receipt) =>
        sameDestination(receipt.binding, binding) &&
        !mediaReceiptPending(receipt),
    )
    .sort((a, b) => b.updatedAt - a.updatedAt);
  for (const receipt of finished.slice(50))
    await request(tx.objectStore('media').delete(receipt.id));
}

/** Keeps the request before anything is sent, so closing the browser cannot lose or repeat it. */
export async function addMediaReceipt(
  input: NewMediaReceipt,
  now = Date.now(),
): Promise<MediaReceipt> {
  if (typeof input.label !== 'string') throw invalid();
  const base = {
    version: 1 as const,
    id: crypto.randomUUID(),
    binding: bindingCopy(input.binding),
    label: input.label.slice(0, 300) || 'Media',
    state: 'submitting' as const,
    saved: 0,
    skipped: 0,
    failed: 0,
    discovered: 0,
    attempts: 0,
    createdAt: now,
    updatedAt: now,
  };
  const receipt: MediaReceipt =
    input.kind === 'download'
      ? { ...base, kind: 'download', request: downloadCopy(input.request) }
      : {
          ...base,
          kind: 'subscription',
          request: subscriptionCopy(input.request),
        };
  if (receipt.kind === 'download') receipt.albumId = receipt.request.albumId;
  await transaction(['media'], 'readwrite', async (tx) => {
    await request(tx.objectStore('media').add(receipt));
    await prune(tx, receipt.binding);
  });
  return receipt;
}
/** This account's receipts on this server, newest first, whichever access made them. */
export const listMediaReceipts = (
  binding: ServerBinding,
): Promise<MediaReceipt[]> =>
  transaction(['media'], 'readonly', async (tx) =>
    (await all(tx))
      .filter((receipt) => sameDestination(receipt.binding, binding))
      .sort((a, b) => b.createdAt - a.createdAt),
  );
/**
 * Changes one receipt in a single step. It is found only for its own server and account: a receipt
 * is never moved to, or changed from, another.
 */
export const changeMediaReceipt = (
  id: string,
  binding: ServerBinding,
  change: (receipt: MediaReceipt) => void,
  now = Date.now(),
): Promise<MediaReceipt> =>
  transaction(['media'], 'readwrite', async (tx) => {
    const receipt = (await request(tx.objectStore('media').get(id))) as
      MediaReceipt | undefined;
    if (
      !receipt ||
      !readable(receipt) ||
      !sameDestination(receipt.binding, binding)
    )
      throw new QueueFailure('This item isn’t in this account’s saving list.');
    change(receipt);
    receipt.updatedAt = now;
    await request(tx.objectStore('media').put(receipt));
    return receipt;
  });
export const requestMediaCancel = (id: string, binding: ServerBinding) =>
  changeMediaReceipt(id, binding, (receipt) => {
    if (mediaReceiptDone(receipt) || receipt.kind !== 'download')
      throw new QueueFailure('This item has already finished.');
    receipt.cancelRequested = true;
  });
export const requestMediaRetry = (id: string, binding: ServerBinding) =>
  changeMediaReceipt(id, binding, (receipt) => {
    if (receipt.cancelRequested)
      throw new QueueFailure('This item is being cancelled.');
    // An unconfirmed request is simply sent again with its own key.
    if (receipt.state === 'submitting' || receipt.state === 'active') return;
    if (
      receipt.kind !== 'download' ||
      !receipt.remoteId ||
      !['partial', 'failed', 'paused', 'cancelled'].includes(receipt.state)
    )
      throw new QueueFailure('There is nothing to retry for this item.');
    // Pressing Retry twice before the Library answers is still one retry.
    receipt.retryKey ??= crypto.randomUUID();
  });
