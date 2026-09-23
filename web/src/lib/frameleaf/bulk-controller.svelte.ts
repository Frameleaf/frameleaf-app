import type { MediaOperationDto } from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { activitySession } from '$lib/frameleaf/activity-session.svelte';
import type { BulkActionId } from '$lib/frameleaf/bulk-actions';
import {
  bulkResultSummary,
  countMatching,
  createBulkGateway,
  durableBulkAction,
  durableBulkParts,
  removesFromView,
  resolveMatchingIds,
  runBulkAction,
  runBulkOperation,
  shouldRunDurably,
  submitDurableBulk,
  type BulkGateway,
  type BulkPayload,
  type BulkResult,
  type BulkRunContext,
} from '$lib/frameleaf/bulk-operations';
import { durableBulkTracker, type DurableBulkTracker } from '$lib/frameleaf/durable-bulk-tracker.svelte';
import type { BulkOperationRecord, LibrarySessionAction, LibraryViewState } from '$lib/frameleaf/library-session';
import { downloadArchive } from '$lib/utils/asset-utils';
import { handleError } from '$lib/utils/handle-error';
import { getFormatter } from '$lib/utils/i18n';

/**
 * The one place a Frameleaf bulk action is actually run (FL-32).
 *
 * The selection bar collects an action and its payload; this coordinator runs it, reports it, and
 * keeps the undo entry. It is what makes the session's operation records real: it dispatches
 * `operation-start`, `operation-progress` and `operation-finish`, and it holds the `AbortController`
 * that the cancel control uses.
 *
 * A small selected-id action runs immediately against those ids and offers undo. A selection above
 * `DURABLE_BULK_THRESHOLD`, and every "select everything matching" action the server can run, is
 * resolved here once and handed to the server as a durable job over that frozen id list: it keeps
 * going when this tab closes, and Activity is where it is followed, cancelled and retried. A filter
 * edit afterwards cannot change what it touches, because nothing is ever resolved again.
 */
export type BulkUndoEntry = {
  /** The past-tense summary of what will be reversed. */
  label: string;
  run: () => Promise<void>;
};

const requestKey = () =>
  globalThis.crypto?.randomUUID?.() ?? `fl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

export class BulkController {
  #dispatch: (action: LibrarySessionAction) => void;
  #gateway: BulkGateway;
  #context: () => BulkRunContext;
  #running = new Map<string, AbortController>();
  #queued: () => void;
  #tracker: Pick<DurableBulkTracker, 'track'>;

  /** The undo offered after the last reversible action, or null. */
  undo = $state<BulkUndoEntry | null>(null);
  /** True while a selected-id action is in flight, for disabling repeat clicks. */
  busy = $state(false);

  constructor({
    dispatch,
    gateway = createBulkGateway((fileName, options) => downloadArchive(fileName, options)),
    context = () => ({}),
    queued = () => void activitySession.refresh(),
    tracker = durableBulkTracker,
  }: {
    dispatch: (action: LibrarySessionAction) => void;
    gateway?: BulkGateway;
    context?: () => BulkRunContext;
    /** Called once a durable job has been accepted, so Activity shows it without waiting a poll. */
    queued?: () => void;
    /** Follows accepted durable jobs item by item, for the tile loaders. */
    tracker?: Pick<DurableBulkTracker, 'track'>;
  }) {
    this.#dispatch = dispatch;
    this.#gateway = gateway;
    this.#context = context;
    this.#queued = queued;
    this.#tracker = tracker;
  }

  /**
   * Put a loader on every tile the accepted jobs cover (owner decision, September 22, 2026). The
   * items stay on the page while the server works; the tracker takes each one off, out of the view
   * or into a failure mark, as the job answers for it.
   */
  #follow(action: BulkActionId, ids: readonly string[], created: readonly MediaOperationDto[]) {
    const parts = durableBulkParts(ids);
    for (const [index, operation] of created.entries()) {
      const part = parts[index];
      if (operation?.id && part) {
        this.#tracker.track(action, operation.id, part);
      }
    }
  }

  /** Tell the person the job is the server's now, and where to follow it. */
  async #announceQueued(action: BulkActionId, count: number) {
    const $t = await getFormatter();
    toastManager.primary(
      $t('frameleaf_bulk_queued', { values: { action: $t(`frameleaf_bulk_${action.replaceAll('-', '_')}`), count } }),
    );
    this.undo = null;
    this.#queued();
  }

  /** Assets that left the page, so the session can drop its references to them. */
  #removed(action: BulkActionId, result: BulkResult): string[] {
    return removesFromView(action) ? result.succeeded : [];
  }

  async #report(action: BulkActionId, result: BulkResult) {
    const $t = await getFormatter();
    const { key, values } = bulkResultSummary(result);
    const message = `${$t(`frameleaf_bulk_${action.replaceAll('-', '_')}`)}: ${$t(key, { values })}`;
    if (result.succeeded.length === 0 && result.failed.length > 0) {
      toastManager.danger(message);
    } else {
      toastManager.primary(message);
    }

    const removed = this.#removed(action, result);
    if (removed.length > 0) {
      this.#dispatch({ type: 'mutated', removedIds: removed });
    }

    // Trash undoes through restore; every other reversible action reverses itself.
    this.undo = result.undo
      ? {
          label: $t(`frameleaf_bulk_${result.undo.action.replaceAll('-', '_')}`),
          run: async () => {
            const entry = result.undo!;
            this.undo = null;
            await this.run(entry.action, entry.ids, entry.payload);
          },
        }
      : null;
  }

  /**
   * Run an action over an explicit selection.
   *
   * Returns the result for an action run here, and null for one handed to the server: its outcome
   * arrives in Activity, not in this call.
   */
  async run(action: BulkActionId, ids: string[], payload?: BulkPayload): Promise<BulkResult | null> {
    if (ids.length === 0) {
      return null;
    }
    if (shouldRunDurably(action, ids.length)) {
      await this.#queue(action, ids, payload);
      return null;
    }
    this.busy = true;
    try {
      const result = await runBulkAction(action, ids, {
        payload,
        context: this.#context(),
        gateway: this.#gateway,
      });
      await this.#report(action, result);
      return result;
    } catch (error) {
      const $t = await getFormatter();
      handleError(error, $t('frameleaf_bulk_reason_failed'));
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** Hand a large explicit selection to the server. There is no undo; Activity reports the outcome. */
  async #queue(action: BulkActionId, ids: string[], payload?: BulkPayload) {
    this.busy = true;
    try {
      const created = await submitDurableBulk(action, ids, { payload, submittedTotal: ids.length }, this.#gateway);
      this.#follow(action, ids, created);
      await this.#announceQueued(action, ids.length);
    } catch (error) {
      const $t = await getFormatter();
      handleError(error, $t('frameleaf_bulk_reason_failed'));
    } finally {
      this.busy = false;
    }
  }

  /** The count the "Select all n" control offers for the current view. */
  async count(scope: LibraryViewState): Promise<number | null> {
    try {
      return await countMatching(scope, this.#gateway);
    } catch {
      return null;
    }
  }

  /**
   * Run an action over everything matching a frozen view state, in the background. The request key
   * is the idempotency key: a retry reuses it, so the operation stays one record.
   */
  async runMatching(
    action: BulkActionId,
    scope: LibraryViewState,
    {
      payload,
      submittedTotal = null,
      requestId = requestKey(),
    }: {
      payload?: BulkPayload;
      submittedTotal?: number | null;
      requestId?: string;
    } = {},
  ): Promise<void> {
    const controller = new AbortController();
    this.#running.set(requestId, controller);
    this.#dispatch({ type: 'operation-start', requestId, action, scope, submittedTotal });
    if (durableBulkAction(action)) {
      try {
        await this.#handOff(requestId, action, scope, controller.signal, { payload, submittedTotal });
      } finally {
        this.#running.delete(requestId);
      }
      return;
    }
    try {
      const outcome = await runBulkOperation(
        { requestId, action, scope, payload, submittedTotal },
        {
          gateway: this.#gateway,
          signal: controller.signal,
          context: this.#context(),
          onProgress: ({ processed, total, phase }) =>
            this.#dispatch({
              type: 'operation-progress',
              requestId,
              processed,
              total,
              status: phase === 'resolving' ? 'resolving' : 'running',
            }),
        },
      );
      this.#dispatch({
        type: 'operation-finish',
        requestId,
        succeeded: outcome.succeeded.length,
        failed: outcome.failed.length,
        skipped: outcome.skipped.length,
        failures: outcome.failed.map(({ id, reasonKey, message }) => ({ id, reasonKey, message })),
        cancelled: outcome.cancelled,
        truncated: outcome.truncated,
      });
      const removed = this.#removed(action, outcome);
      if (removed.length > 0) {
        this.#dispatch({ type: 'mutated', removedIds: removed });
      }
    } catch (error) {
      // The scope itself was refused (an unsupported scope or query): nothing ran.
      const reasonKey = error instanceof Error ? error.message : 'frameleaf_bulk_reason_failed';
      this.#dispatch({
        type: 'operation-finish',
        requestId,
        succeeded: 0,
        failed: 0,
        skipped: 0,
        errorKey: reasonKey.startsWith('frameleaf_bulk_reason_') ? reasonKey : 'frameleaf_bulk_reason_failed',
      });
    } finally {
      this.#running.delete(requestId);
    }
  }

  /**
   * Resolve the frozen scope in this tab, then give the server the exact ids.
   *
   * The session record covers only the part this tab does — finding the matching set. Once the
   * server has accepted the job the record is dropped and Activity takes over, so the same work is
   * never shown twice. A refused scope, a cancel while resolving or a rejected submit leave the
   * record in place, failed or cancelled, where Retry can run it again under the same key.
   */
  async #handOff(
    requestId: string,
    action: BulkActionId,
    scope: LibraryViewState,
    signal: AbortSignal,
    { payload, submittedTotal }: { payload?: BulkPayload; submittedTotal: number | null },
  ) {
    const finishWith = (patch: { cancelled?: boolean; errorKey?: string; truncated?: boolean }) =>
      this.#dispatch({ type: 'operation-finish', requestId, succeeded: 0, failed: 0, skipped: 0, ...patch });

    try {
      const resolved = await resolveMatchingIds(scope, {
        gateway: this.#gateway,
        signal,
        onProgress: (found, total) =>
          this.#dispatch({
            type: 'operation-progress',
            requestId,
            processed: found,
            total: total ?? submittedTotal,
            status: 'resolving',
          }),
      });
      if (resolved.cancelled || signal.aborted) {
        finishWith({ cancelled: true });
        return;
      }
      if (resolved.ids.length === 0) {
        finishWith({ truncated: resolved.truncated });
        return;
      }

      const created = await submitDurableBulk(
        action,
        resolved.ids,
        {
          payload,
          submittedTotal: submittedTotal ?? resolved.total,
          truncated: resolved.truncated,
          scope,
          requestId,
        },
        this.#gateway,
      );
      this.#follow(action, resolved.ids, created);
      this.#dispatch({ type: 'operation-dismiss', requestId });
      await this.#announceQueued(action, resolved.ids.length);
    } catch (error) {
      const reasonKey = error instanceof Error ? error.message : '';
      finishWith({
        errorKey: reasonKey.startsWith('frameleaf_bulk_reason_') ? reasonKey : 'frameleaf_bulk_reason_failed',
      });
    }
  }

  /** Stop an operation between batches. Work the server already accepted stays done. */
  cancel(requestId: string) {
    this.#running.get(requestId)?.abort();
  }

  /** Retry an operation under its own request key, so the record is resumed, not duplicated. */
  async retry(operation: BulkOperationRecord) {
    await this.runMatching(operation.action, operation.scope, {
      submittedTotal: operation.submittedTotal,
      requestId: operation.requestId,
    });
  }

  dismiss(requestId: string) {
    this.#dispatch({ type: 'operation-dismiss', requestId });
  }
}
