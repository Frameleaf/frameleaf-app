<script lang="ts">
  import { bulkActionTitleKey } from '$lib/frameleaf/bulk-actions';
  import type { BulkOperationRecord } from '$lib/frameleaf/library-session';
  import { t } from 'svelte-i18n';

  /**
   * The background bulk operation strip (FL-32).
   *
   * A "select everything matching" operation is not a dialog the user waits in front of: it
   * resolves its frozen scope and then works through it, so this shows what it is doing, lets the
   * user cancel it, and afterwards reports what happened per item rather than claiming success.
   * The scope shown is the operation's own frozen copy, which is why editing the filter while it
   * runs changes nothing here.
   */
  let {
    operations = [],
    onCancel,
    onRetry,
    onDismiss,
  }: {
    operations?: BulkOperationRecord[];
    onCancel?: (requestId: string) => void;
    onRetry?: (operation: BulkOperationRecord) => void;
    onDismiss?: (requestId: string) => void;
  } = $props();

  const isActive = (operation: BulkOperationRecord) =>
    operation.status === 'resolving' || operation.status === 'running';

  const percent = (operation: BulkOperationRecord) =>
    operation.total && operation.total > 0
      ? Math.min(100, Math.round((operation.processed / operation.total) * 100))
      : 0;
</script>

{#if operations.length > 0}
  <section class="operations" aria-label={$t('frameleaf_bulk_operations')}>
    {#each operations as operation (operation.requestId)}
      <article>
        <header>
          <span class="label">{$t(bulkActionTitleKey(operation.action))}</span>
          <span class="scope">{$t(`frameleaf_bulk_scope_${operation.scope.scope.kind}`)}</span>
        </header>

        <p class="line" aria-live="polite">
          {#if operation.status === 'resolving'}
            {$t('frameleaf_bulk_operation_resolving', { values: { total: operation.total ?? 0 } })}
          {:else if operation.status === 'running'}
            {$t('frameleaf_bulk_operation_running', {
              values: { processed: operation.processed, total: operation.total ?? operation.processed },
            })}
          {:else if operation.status === 'failed'}
            {$t(operation.errorKey ?? 'frameleaf_bulk_reason_failed')}
          {:else}
            {$t(
              operation.status === 'cancelled'
                ? 'frameleaf_bulk_summary_cancelled'
                : operation.failed + operation.skipped === 0
                  ? 'frameleaf_bulk_summary_done'
                  : operation.succeeded === 0
                    ? 'frameleaf_bulk_summary_none'
                    : 'frameleaf_bulk_summary_partial',
              {
                values: {
                  count: operation.succeeded,
                  failed: operation.failed,
                  skipped: operation.skipped,
                  total: operation.total ?? operation.processed,
                },
              },
            )}
          {/if}
        </p>

        {#if isActive(operation)}
          <progress max="100" value={operation.total ? percent(operation) : undefined}></progress>
        {/if}

        {#if operation.truncated}
          <p class="note">{$t('frameleaf_bulk_operation_truncated', { values: { total: operation.total ?? 0 } })}</p>
        {/if}

        {#if operation.failures.length > 0}
          <details>
            <summary>{$t('frameleaf_bulk_operation_failures', { values: { count: operation.failed } })}</summary>
            <ul>
              {#each operation.failures as failure (failure.id)}
                <li>
                  <code>{failure.id}</code>
                  <span>{failure.reasonKey ? $t(failure.reasonKey) : (failure.message ?? '')}</span>
                </li>
              {/each}
            </ul>
          </details>
        {/if}

        <footer>
          {#if isActive(operation)}
            <button type="button" onclick={() => onCancel?.(operation.requestId)}>{$t('cancel')}</button>
          {:else}
            {#if operation.failed > 0 && onRetry}
              <button type="button" onclick={() => onRetry(operation)}>{$t('retry')}</button>
            {/if}
            <button type="button" onclick={() => onDismiss?.(operation.requestId)}>{$t('dismiss')}</button>
          {/if}
        </footer>
      </article>
    {/each}
  </section>
{/if}

<style>
  .operations {
    display: grid;
    gap: 0.5rem;
  }
  article {
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-panel-radius);
    padding: 0.6rem 0.75rem;
    display: grid;
    gap: 0.35rem;
    font-size: 0.875rem;
  }
  header {
    display: flex;
    justify-content: space-between;
    gap: 0.75rem;
  }
  .label {
    font-weight: 600;
  }
  .scope,
  .note,
  .line {
    color: var(--fl-muted);
    font-size: 0.75rem;
    margin: 0;
  }
  progress {
    inline-size: 100%;
    block-size: 0.25rem;
  }
  details ul {
    list-style: none;
    margin: 0.25rem 0 0;
    padding: 0;
    max-height: 8rem;
    overflow: auto;
    display: grid;
    gap: 0.15rem;
  }
  details li {
    display: flex;
    gap: 0.5rem;
    font-size: 0.6875rem;
    color: var(--fl-muted);
  }
  summary {
    font-size: 0.75rem;
    color: var(--fl-muted);
    min-height: 0;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  footer button {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
    padding: 0 0.75rem;
    font-size: 0.8125rem;
  }
</style>
