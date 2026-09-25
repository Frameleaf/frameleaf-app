import {
  ArchiveOperationPrepareScope,
  isHttpError,
  type ArchiveOperationResponseDto,
  type MediaOperationDto,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import type { Translations } from 'svelte-i18n';
import { activitySession } from '$lib/frameleaf/activity-session.svelte';
import {
  isCurrentSession,
  ARCHIVE_OPERATION_MAX_ITEMS,
  ARCHIVE_UNDO_RESTORE_MS,
  archiveGateway,
  isExpiredSelection,
  type ArchiveGateway,
} from '$lib/frameleaf/archive-operations';
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
 *
 * An archive that runs in the background is a transactional archive operation (FL-32): the frozen
 * ids — or, for the unfiltered library, every matching Timeline item counted by the server and
 * confirmed at that exact count — become one operation whose durable job Activity follows, and its
 * Undo is kept by the server, so it survives a reload and never overwrites a newer change.
 */
export type BulkUndoEntry = {
  /** The past-tense summary of what will be reversed. */
  label: string;
  run: () => Promise<void>;
};

/** How long the result toast keeps its Undo, as the prototype's undo toast does. */
const UNDO_TOAST_TIMEOUT_MS = 8000;

const requestKey = (): string =>
  globalThis.crypto?.randomUUID?.() ?? `fl-${Date.now().toString(36)}-${Math.random().toString(36).slice(2)}`;

/** Archives this page load has already announced, so moving between library pages never repeats one. */
const announcedArchives = new Set<string>();

export class BulkController {
  #dispatch: (action: LibrarySessionAction) => void;
  #gateway: BulkGateway;
  #context: () => BulkRunContext;
  #running = new Map<string, AbortController>();
  #queued: () => void;
  #tracker: Pick<DurableBulkTracker, 'track'>;
  #applied: (action: BulkActionId, ids: string[], payload?: BulkPayload) => void;
  #archive: ArchiveGateway;

  /** The undo offered after the last reversible action, or null. */
  undo = $state.raw<BulkUndoEntry | null>(null);
  /** True while a selected-id action is in flight, for disabling repeat clicks. */
  busy = $state(false);

  constructor({
    dispatch,
    gateway = createBulkGateway((fileName, options) => downloadArchive(fileName, options)),
    context = () => ({}),
    queued = () => void activitySession.refresh(),
    tracker = durableBulkTracker,
    applied = () => {},
    archive = archiveGateway,
  }: {
    dispatch: (action: LibrarySessionAction) => void;
    gateway?: BulkGateway;
    context?: () => BulkRunContext;
    /** Called once a durable job has been accepted, so Activity shows it without waiting a poll. */
    queued?: () => void;
    /** Follows accepted durable jobs item by item, for the tile loaders. */
    tracker?: Pick<DurableBulkTracker, 'track'>;
    /**
     * Called with the items an immediate action changed, so the page can show the change at once
     * (a favorite's badge, an archived item leaving the library) without waiting for a reload.
     */
    applied?: (action: BulkActionId, ids: string[], payload?: BulkPayload) => void;
    /** The transactional archive endpoints (FL-32). */
    archive?: ArchiveGateway;
  }) {
    this.#dispatch = dispatch;
    this.#gateway = gateway;
    this.#context = context;
    this.#queued = queued;
    this.#tracker = tracker;
    this.#applied = applied;
    this.#archive = archive;
  }

  /**
   * Put a loader on every tile the accepted jobs cover (owner decision, September 22, 2026). The
   * items stay on the page while the server works; the tracker takes each one off, out of the view
   * or into a failure mark, as the job answers for it.
   */
  #follow(action: BulkActionId, ids: readonly string[], created: readonly MediaOperationDto[]) {
    const parts = durableBulkParts(ids);
    const view = this.#context().view;
    for (const [index, operation] of created.entries()) {
      const part = parts[index];
      if (!operation?.id || !part) {
        continue;
      }
      // the view decides what leaves it when an item finishes (FL-34)
      if (view) {
        this.#tracker.track(action, operation.id, part, view);
      } else {
        this.#tracker.track(action, operation.id, part);
      }
    }
  }

  /** Tell the person the job is the server's now, and where to follow it. */
  async #announceQueued(action: BulkActionId, count: number) {
    const translate = await getFormatter();
    toastManager.primary(
      translate('frameleaf_bulk_queued', {
        values: { action: translate(`frameleaf_bulk_${action.replaceAll('-', '_')}` as Translations), count },
      }),
    );
    this.undo = null;
    this.#queued();
  }

  /** Assets that left the page, so the session can drop its references to them. */
  #removed(action: BulkActionId, result: BulkResult): string[] {
    return removesFromView(action, this.#context().view) ? result.succeeded : [];
  }

  async #report(action: BulkActionId, result: BulkResult, payload?: BulkPayload) {
    const translate = await getFormatter();
    const { key, values } = bulkResultSummary(result);
    const message = `${translate(`frameleaf_bulk_${action.replaceAll('-', '_')}` as Translations)}: ${translate(key, { values })}`;
    if (result.succeeded.length > 0) {
      this.#applied(action, result.succeeded, payload);
    }

    // Trash undoes through restore; every other reversible action reverses itself.
    this.undo = result.undo
      ? {
          label: translate(`frameleaf_bulk_${result.undo.action.replaceAll('-', '_')}` as Translations),
          run: async () => {
            const entry = result.undo!;
            this.undo = null;
            await this.run(entry.action, entry.ids, entry.payload);
          },
        }
      : null;

    if (result.succeeded.length === 0 && result.failed.length > 0) {
      toastManager.danger(message);
    } else if (this.undo) {
      // The prototype's toast carries Undo. It matters most when the action emptied the selection
      // (trash, restore, remove from album): the bar and its own Undo button close with it, so the
      // toast is the only place left to reverse the action.
      // The bar's Undo and the toast's Undo share one entry; whichever runs first consumes it, so
      // a reversal can never fire twice.
      const undo = this.undo;
      toastManager.primary(
        {
          description: message,
          button: (close) => ({
            label: translate('undo'),
            onclick: () => {
              close();
              if (this.undo === undo) {
                void undo.run();
              }
            },
          }),
        },
        { timeout: UNDO_TOAST_TIMEOUT_MS },
      );
    } else {
      toastManager.primary(message);
    }

    const removed = this.#removed(action, result);
    if (removed.length > 0) {
      this.#dispatch({ type: 'mutated', removedIds: removed });
    }
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
    if (shouldRunDurably(action, ids.length, payload)) {
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
      await this.#report(action, result, payload);
      return result;
    } catch (error) {
      const translate = await getFormatter();
      handleError(error, translate('frameleaf_bulk_reason_failed'));
      return null;
    } finally {
      this.busy = false;
    }
  }

  /**
   * Hand a large explicit selection to the server; Activity reports the outcome. Only an archive
   * keeps an undo, because its operation records what it changed (FL-32).
   */
  async #queue(action: BulkActionId, ids: string[], payload?: BulkPayload) {
    this.busy = true;
    try {
      if (action === 'archive') {
        if (!this.#archivesAsOperation(ids)) {
          await this.#refuseTooMany();
          return;
        }
        await this.#archiveIds(ids);
        return;
      }
      const created = await submitDurableBulk(action, ids, { payload, submittedTotal: ids.length }, this.#gateway);
      this.#follow(action, ids, created);
      await this.#announceQueued(action, ids.length);
    } catch (error) {
      const translate = await getFormatter();
      handleError(error, translate('frameleaf_bulk_reason_failed'));
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
        errorKey: reasonKey.startsWith('frameleaf_bulk_reason_')
          ? (reasonKey as Translations)
          : 'frameleaf_bulk_reason_failed',
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
    const finishWith = (patch: { cancelled?: boolean; errorKey?: Translations; truncated?: boolean }) =>
      this.#dispatch({ type: 'operation-finish', requestId, succeeded: 0, failed: 0, skipped: 0, ...patch });

    try {
      // A hand-off Retry after the archive was accepted but its answer was lost sends the same
      // selection under the same key, so the server answers with the operation it already has.
      const handedOff = action === 'archive' ? this.#archiveSelections.get(requestId) : undefined;
      if (handedOff) {
        await this.#archiveIds(handedOff, requestId, () => this.#dispatch({ type: 'operation-dismiss', requestId }));
        return;
      }

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

      if (action === 'archive') {
        // The same limit the server-counted archive has: a matching set larger than one operation is
        // refused rather than archived short, since its Undo could not cover what was left out.
        if (resolved.truncated || !this.#archivesAsOperation(resolved.ids)) {
          finishWith({ errorKey: 'frameleaf_bulk_reason_archive_too_many', truncated: resolved.truncated });
          return;
        }
        this.#archiveSelections.set(requestId, resolved.ids);
        await this.#archiveIds(resolved.ids, requestId, () => this.#dispatch({ type: 'operation-dismiss', requestId }));
        this.#archiveSelections.delete(requestId);
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
        errorKey: reasonKey.startsWith('frameleaf_bulk_reason_')
          ? (reasonKey as Translations)
          : 'frameleaf_bulk_reason_failed',
      });
    }
  }

  /* ------------------------------------------------------------------------ */
  /* Transactional archive (FL-32)                                             */
  /* ------------------------------------------------------------------------ */

  /** Hand-offs whose archive was submitted, by request key, until the server has answered. */
  #archiveSelections = new Map<string, string[]>();

  #archivesAsOperation(ids: readonly string[]) {
    return new Set(ids).size <= ARCHIVE_OPERATION_MAX_ITEMS;
  }

  async #refuseTooMany() {
    const translate = await getFormatter();
    toastManager.warning(translate('frameleaf_bulk_reason_archive_too_many'));
  }

  /**
   * Archive a frozen id list as one operation. The request key is the idempotency key: a retried
   * hand-off finds the same operation and job instead of starting another.
   */
  async #archiveIds(ids: readonly string[], requestId = requestKey(), accepted?: () => void) {
    const selection = [...new Set(ids)];
    const operation = await this.#archive.createArchiveOperation({
      archiveOperationCreateDto: { requestKey: requestId, assetIds: selection },
    });
    // Tile loaders read the job's cursor against these ids, so they only follow a job that holds
    // exactly this selection; when the server left some out, Activity still follows it.
    if (operation.archiveJobId && operation.pending === selection.length) {
      const view = this.#context().view;
      if (view) {
        this.#tracker.track('archive', operation.archiveJobId, selection, view);
      } else {
        this.#tracker.track('archive', operation.archiveJobId, selection);
      }
    }
    accepted?.();
    await this.#announceArchive(operation);
  }

  /**
   * Count and freeze every matching item of the owner's Timeline on the server, without changing
   * anything. The answer is the exact count the person confirms (`confirmArchive`).
   */
  async prepareArchive(): Promise<ArchiveOperationResponseDto | null> {
    this.busy = true;
    try {
      return await this.#archive.prepareArchiveOperation({
        archiveOperationPrepareDto: {
          requestKey: requestKey(),
          scope: ArchiveOperationPrepareScope.MatchingOwnedTimeline,
        },
      });
    } catch (error) {
      const translate = await getFormatter();
      handleError(error, translate('frameleaf_bulk_reason_failed'));
      return null;
    } finally {
      this.busy = false;
    }
  }

  /** Archive exactly the prepared selection. Returns false when nothing was started. */
  async confirmArchive(prepared: ArchiveOperationResponseDto): Promise<boolean> {
    this.busy = true;
    try {
      const operation = await this.#archive.confirmArchiveOperation({
        id: prepared.id,
        archiveOperationConfirmDto: { requestKey: prepared.requestKey },
      });
      await this.#announceArchive(operation);
      return true;
    } catch (error) {
      const translate = await getFormatter();
      if (isExpiredSelection(error) || (isHttpError(error) && error.status === 404)) {
        toastManager.warning(translate('frameleaf_bulk_archive_expired'));
      } else {
        handleError(error, translate('frameleaf_bulk_reason_failed'));
      }
      return false;
    } finally {
      this.busy = false;
    }
  }

  /** The prototype's toast: what was queued, with Undo on it. */
  async #announceArchive(operation: ArchiveOperationResponseDto) {
    const translate = await getFormatter();
    if (!operation.archiveJobId) {
      // nothing was queued: none of the items could be archived from here
      this.undo = null;
      toastManager.primary(translate('frameleaf_bulk_archive_nothing_selected'));
      return;
    }
    this.undo = operation.undoable ? await this.#archiveUndo(operation) : null;
    announcedArchives.add(operation.id);
    this.#toastArchive(
      translate('frameleaf_bulk_queued', {
        values: { action: translate('frameleaf_bulk_archive'), count: operation.count },
      }),
      this.undo,
      translate('undo'),
    );
    this.#queued();
  }

  /** A toast in the prototype's shape (`setToast({ text, action })`): the message, and Undo on it. */
  #toastArchive(description: string, undo: BulkUndoEntry | null, undoLabel: string) {
    toastManager.primary({
      description,
      ...(undo && {
        button: (close: () => void) => ({
          label: undoLabel,
          onclick: () => {
            close();
            void undo.run();
          },
        }),
      }),
    });
  }

  async #archiveUndo(operation: ArchiveOperationResponseDto): Promise<BulkUndoEntry> {
    const translate = await getFormatter();
    // One key per Undo offer: a second click, or a retry after a lost answer, is the same undo.
    const undoKey = requestKey();
    let running: Promise<void> | null = null;
    const entry: BulkUndoEntry = {
      label: translate('frameleaf_bulk_archive'),
      run: () =>
        (running ??= (async () => {
          if (this.undo === entry) {
            this.undo = null;
          }
          try {
            await this.#archive.undoArchiveOperation({
              id: operation.id,
              archiveOperationUndoDto: { requestKey: undoKey },
            });
            toastManager.primary(translate('frameleaf_bulk_archive_undo_queued'));
            this.#queued();
          } catch (error) {
            handleError(error, translate('frameleaf_bulk_archive_undo_failed'));
            // still on offer, under the same key
            this.undo ??= entry;
            running = null;
          }
        })()),
    };
    return entry;
  }

  /**
   * Offer the Undo of the latest archive again after a reload: in the selection bar, and once per
   * page load as the prototype's toast, so it is reachable without selecting anything. The server
   * keeps what the archive changed, so the offer is only an entry point; the undo itself is still
   * guarded item by item.
   */
  async restoreArchiveUndo(now = Date.now()) {
    if (this.undo) {
      return;
    }
    try {
      const operations = await this.#archive.getArchiveOperations();
      // only this session's own archives: another device's Undo is not offered here (Activity lists all)
      const latest = operations.find(
        (operation) =>
          operation.undoable &&
          isCurrentSession(operation) &&
          now - Date.parse(operation.createdAt) <= ARCHIVE_UNDO_RESTORE_MS,
      );
      if (latest && !this.undo) {
        const undo = await this.#archiveUndo(latest);
        this.undo = undo;
        if (!announcedArchives.has(latest.id)) {
          announcedArchives.add(latest.id);
          const translate = await getFormatter();
          this.#toastArchive(
            translate('frameleaf_bulk_archive_undo_available', { values: { count: latest.archived } }),
            undo,
            translate('undo'),
          );
        }
      }
    } catch {
      // nothing to offer: the archive and its record are unaffected
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
