import type {
  MediaImportCreateDto,
  MediaSubscriptionCreateDto,
} from '@frameleaf/sdk';
import type { ServerBinding } from './api';
import * as library from './media-api';
import { LibraryFailure, type MediaOperationView } from './media-api';
import {
  changeMediaReceipt,
  listMediaReceipts,
  mediaReceiptDone,
  mediaReceiptPending,
  type MediaReceipt,
  type MediaReceiptState,
} from './media-queue';

/**
 * FL-1427: keeps the saving list's media receipts in step with your Library. The Library does the
 * work, and carries on with the browser closed; this only (1) hands over a request the Library has
 * not confirmed yet, always with the receipt's own key so it can never start twice, (2) passes on
 * Cancel and Retry, and (3) reads how each download stands.
 */
export type MediaLibrary = Pick<
  typeof library,
  | 'startDownload'
  | 'subscribe'
  | 'readOperation'
  | 'cancelDownload'
  | 'retryDownload'
>;

const NEEDS_PERMISSION =
  'Allow media downloads again to see how this is going. Your Library carries on meanwhile.';
const WAITING = 'Waiting for your Library. This is sent again automatically.';
const REFUSED =
  'Your Library couldn’t accept this. Start it again from the page.';
const NEEDS_UPDATE =
  'Your Library needs an update for this. Update it, then start again from the page.';
const GONE = 'Your Library no longer lists this download.';
const UNSURE =
  'Cancelled here before your Library confirmed it. If it shows up in Boards anyway, stop it there.';

const stateOf = (operation: MediaOperationView): MediaReceiptState =>
  operation.state === 'saved' ||
  operation.state === 'partial' ||
  operation.state === 'failed' ||
  operation.state === 'cancelled' ||
  operation.state === 'paused'
    ? operation.state
    : 'active';
function apply(receipt: MediaReceipt, operation: MediaOperationView) {
  receipt.remoteId = operation.id;
  receipt.state = stateOf(operation);
  receipt.remoteState = operation.state;
  receipt.saved = operation.saved;
  receipt.skipped = operation.skipped;
  receipt.failed = operation.failed;
  receipt.discovered = operation.discovered;
  if (operation.albumId) receipt.albumId = operation.albumId;
  if (operation.error) receipt.error = operation.error;
  else delete receipt.error;
}
/** Whether sending the same request again later could still succeed. */
const worthRetrying = (error: LibraryFailure) =>
  error.problem === 'unreachable' ||
  (error.problem === 'refused' &&
    (error.status === undefined ||
      error.status >= 500 ||
      error.status === 408 ||
      error.status === 429));

async function settle(
  receipt: MediaReceipt,
  binding: ServerBinding,
  token: string,
  api: MediaLibrary,
) {
  const save = (change: (receipt: MediaReceipt) => void) =>
    changeMediaReceipt(receipt.id, binding, (value) => {
      value.checkedAt = Date.now();
      change(value);
    });
  if (!receipt.remoteId) {
    // Never sent: Cancel simply forgets it. A subscription that may have arrived is withdrawn here
    // too, with a note; a download that may have arrived is found (same key) and cancelled below.
    if (
      receipt.cancelRequested &&
      (receipt.attempts === 0 || receipt.kind === 'subscription')
    ) {
      const sent = receipt.attempts > 0;
      await save((value) => {
        value.state = 'cancelled';
        delete value.cancelRequested;
        if (sent) value.error = UNSURE;
        else delete value.error;
      });
      return;
    }
    // Counted before it is sent, so a restart mid-request knows it may already have arrived.
    await save((value) => {
      value.attempts++;
    });
    if (receipt.kind === 'download') {
      const operation = await api.startDownload(binding, token, {
        ...receipt.request,
        // the same words the Library uses, checked when the receipt was made
        quality: receipt.request.quality as MediaImportCreateDto['quality'],
        streamMp4: false,
        idempotencyKey: receipt.id,
      });
      const latest = await save((value) => apply(value, operation));
      // A Cancel pressed before the Library confirmed is passed on now that it has an id.
      if (latest.cancelRequested) await settle(latest, binding, token, api);
    } else {
      const made = await api.subscribe(binding, token, {
        ...receipt.request,
        history: receipt.request
          .history as MediaSubscriptionCreateDto['history'],
        quality: receipt.request
          .quality as MediaSubscriptionCreateDto['quality'],
        idempotencyKey: receipt.id,
      });
      await save((value) => {
        value.remoteId = made.id;
        value.state = 'subscribed';
        value.label = [made.creator, made.provider]
          .filter(Boolean)
          .join(' · ')
          .slice(0, 300);
        if (made.albumId) value.albumId = made.albumId;
        delete value.error;
      });
    }
    return;
  }
  if (receipt.kind !== 'download') return;
  const remoteId = receipt.remoteId;
  if (receipt.cancelRequested) {
    const operation = await api.cancelDownload(binding, token, remoteId);
    await save((value) => {
      apply(value, operation);
      delete value.cancelRequested;
      delete value.retryKey;
    });
  } else if (receipt.retryKey) {
    const operation = await api.retryDownload(
      binding,
      token,
      remoteId,
      receipt.retryKey,
    );
    await save((value) => {
      apply(value, operation);
      delete value.retryKey;
    });
  } else if (!mediaReceiptDone(receipt)) {
    const operation = await api.readOperation(binding, token, remoteId);
    await save((value) => apply(value, operation));
  }
}

/**
 * One pass over this account's unfinished receipts. Resolves to whether any is still unfinished.
 * A connection that no longer answers as this server and account throws, as saving does; anything
 * about media alone is noted on the receipt and never stops saving.
 */
export async function syncMediaReceipts(
  binding: ServerBinding,
  token: string,
  signal: AbortSignal,
  api: MediaLibrary = library,
): Promise<boolean> {
  // Longest since it was last asked about first, so a few stuck receipts never hold up the rest.
  const pending = (await listMediaReceipts(binding))
    .filter(mediaReceiptPending)
    .sort(
      (a, b) =>
        (a.checkedAt ?? 0) - (b.checkedAt ?? 0) || a.createdAt - b.createdAt,
    )
    .slice(0, 25);
  for (const receipt of pending) {
    if (signal.aborted) break;
    try {
      await settle(receipt, binding, token, api);
    } catch (error) {
      if (!(error instanceof LibraryFailure)) throw error;
      const sent = !!receipt.remoteId;
      await changeMediaReceipt(receipt.id, binding, (value) => {
        value.checkedAt = Date.now();
        // A Cancel the Library could not be asked about still ends here, rather than waiting forever.
        if (value.cancelRequested && !value.remoteId) {
          value.state = 'cancelled';
          value.error = UNSURE;
          delete value.cancelRequested;
        } else if (error.problem === 'grant') value.error = NEEDS_PERMISSION;
        else if (worthRetrying(error)) value.error = WAITING;
        else {
          // The Library said no for good: nothing more is sent for this receipt.
          value.state = 'failed';
          value.error =
            sent && error.status === 404
              ? GONE
              : error.problem === 'outdated'
                ? NEEDS_UPDATE
                : REFUSED;
          delete value.cancelRequested;
          delete value.retryKey;
        }
      }).catch(() => {});
      // No answer, or no permission: the rest would fail the same way.
      if (error.problem === 'unreachable' || error.problem === 'grant') break;
    }
  }
  return (await listMediaReceipts(binding)).some(mediaReceiptPending);
}
