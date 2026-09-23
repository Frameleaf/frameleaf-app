<script lang="ts">
  /**
   * The durable job behind a preservation package or restoration (FL-74), with the controls every
   * media operation offers: pause and resume at the next item, cancel, and — after a failure that
   * used its automatic retry — retry. The same job is listed in Activity; this is a view of it,
   * not a second copy of its state.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { isOperationActive } from '$lib/frameleaf/preservation';
  import { handleError } from '$lib/utils/handle-error';
  import {
    cancelMediaOperation,
    MediaOperationStatus,
    pauseMediaOperation,
    resumeMediaOperation,
    retryMediaOperation,
    type MediaOperationDto,
  } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  type Props = {
    operation: MediaOperationDto;
    /** Offer Retry on a failed job; a restoration and an export offer their own instead. */
    retryable?: boolean;
    onChanged?: (operation: MediaOperationDto) => void;
  };

  let { operation, retryable = false, onChanged }: Props = $props();
  let busy = $state(false);

  const active = $derived(isOperationActive(operation));
  const paused = $derived(operation.status === MediaOperationStatus.Paused);
  const pausing = $derived(!!operation.pauseRequestedAt && !paused);
  const retrying = $derived(operation.status === MediaOperationStatus.Queued && operation.autoRetries > 0);
  const counted = $derived(Number(operation.totalUnits ?? 0) > 0);
  const ended = $derived(
    operation.status === MediaOperationStatus.Failed || operation.status === MediaOperationStatus.Cancelled,
  );
  const working = $derived(
    [MediaOperationStatus.Preparing, MediaOperationStatus.Rendering, MediaOperationStatus.Validating].includes(
      operation.status,
    ),
  );

  const control = async (action: 'pause' | 'resume' | 'cancel' | 'retry') => {
    busy = true;
    try {
      const id = operation.id;
      const next =
        action === 'pause'
          ? await pauseMediaOperation({ id })
          : action === 'resume'
            ? await resumeMediaOperation({ id })
            : action === 'cancel'
              ? await cancelMediaOperation({ id })
              : await retryMediaOperation({ id });
      onChanged?.(next);
    } catch (error) {
      handleError(error, $t('frameleaf_preservation_job_control_error'));
    } finally {
      busy = false;
    }
  };
</script>

<div class="job" aria-live="polite">
  <p class="line">
    <span>{$t(`frameleaf_activity_kind_${operation.kind}`)}</span>
    <span class="status">
      {#if pausing}
        {$t('frameleaf_activity_status_pausing')}
      {:else if retrying}
        {$t('frameleaf_activity_status_retrying')}
      {:else if working}
        {$t('frameleaf_activity_bulk_running')}
      {:else}
        {$t(`frameleaf_activity_status_${operation.status}`)}
      {/if}
    </span>
    {#if counted}
      <span class="count">
        {$t('frameleaf_preservation_job_count', {
          values: { done: Number(operation.processedUnits), total: Number(operation.totalUnits) },
        })}
      </span>
    {/if}
  </p>
  {#if active}
    <progress
      max="100"
      value={counted ? operation.progress : undefined}
      aria-label={$t('frameleaf_preservation_job_progress')}
    ></progress>
  {/if}
  {#if operation.error && (retrying || operation.status === MediaOperationStatus.Failed)}
    <p class="error">{operation.error}</p>
  {/if}
  <div class="actions">
    {#if operation.pausable && active && operation.status !== MediaOperationStatus.Cancelling}
      {#if paused || pausing}
        <Button disabled={busy} onclick={() => control('resume')}>{$t('resume')}</Button>
      {:else}
        <Button disabled={busy} onclick={() => control('pause')}>{$t('pause')}</Button>
      {/if}
    {/if}
    {#if active && operation.status !== MediaOperationStatus.Cancelling}
      <Button disabled={busy} onclick={() => control('cancel')}>{$t('cancel')}</Button>
    {/if}
    {#if retryable && ended}
      <Button disabled={busy} onclick={() => control('retry')}>{$t('retry')}</Button>
    {/if}
  </div>
</div>

<style>
  .job {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    font-size: var(--fl-font-small);
  }
  .line {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin: 0;
  }
  .status {
    color: var(--fl-muted);
  }
  .count {
    margin-inline-start: auto;
    color: var(--fl-muted);
  }
  progress {
    width: 100%;
    height: 0.375rem;
    accent-color: var(--fl-accent);
  }
  .error {
    margin: 0;
    color: var(--fl-danger);
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.375rem;
  }
  .actions:empty {
    display: none;
  }
</style>
