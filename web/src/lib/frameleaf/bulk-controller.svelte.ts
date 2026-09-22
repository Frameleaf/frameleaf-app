import { toastManager } from '@immich/ui';
import type { BulkActionId } from '$lib/frameleaf/bulk-actions';
import {
  bulkResultSummary,
  countMatching,
  createBulkGateway,
  runBulkAction,
  runBulkOperation,
  type BulkGateway,
  type BulkPayload,
  type BulkResult,
  type BulkRunContext,
} from '$lib/frameleaf/bulk-operations';
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
 * A selected-id action runs immediately against those ids. A "select everything matching" action
 * runs as a background operation over the scope frozen at submit, so a filter edit while it runs
 * cannot change what it touches.
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

  /** The undo offered after the last reversible action, or null. */
  undo = $state<BulkUndoEntry | null>(null);
  /** True while a selected-id action is in flight, for disabling repeat clicks. */
  busy = $state(false);

  constructor({
    dispatch,
    gateway = createBulkGateway((fileName, options) => downloadArchive(fileName, options)),
    context = () => ({}),
  }: {
    dispatch: (action: LibrarySessionAction) => void;
    gateway?: BulkGateway;
    context?: () => BulkRunContext;
  }) {
    this.#dispatch = dispatch;
    this.#gateway = gateway;
    this.#context = context;
  }

  /** Assets that left the page, so the session can drop its references to them. */
  #removed(action: BulkActionId, result: BulkResult): string[] {
    return ['delete', 'delete-permanently', 'restore', 'remove-from-album'].includes(action) ? result.succeeded : [];
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

  /** Run an action over an explicit selection. */
  async run(action: BulkActionId, ids: string[], payload?: BulkPayload): Promise<BulkResult | null> {
    if (ids.length === 0) {
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
