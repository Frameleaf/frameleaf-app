<script lang="ts">
  import Button from './Button.svelte';
  import {
    cancelWorkflowBatch,
    getWorkflowBatches,
    runWorkflow,
    type WorkflowBatchResponseDto,
    type WorkflowResponseDto,
  } from '@frameleaf/sdk';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';
  let { workflow, dirty }: { workflow: WorkflowResponseDto; dirty: boolean } = $props();
  let batches = $state<WorkflowBatchResponseDto[]>([]);
  let busy = $state(false);
  let error = $state('');
  const load = async () => {
    batches = await getWorkflowBatches({ id: workflow.id });
  };
  const perform = async (operation: () => Promise<unknown>) => {
    busy = true;
    error = '';
    try {
      await operation();
      await load();
    } catch (error_) {
      error = getServerErrorMessage(error_) ?? $t('errors.something_went_wrong');
    } finally {
      busy = false;
    }
  };
  onMount(() => {
    void perform(async () => {});
  });
</script>

<section aria-label={$t('frameleaf_workflows.batches')}>
  <h4>{$t('frameleaf_workflows.batches')}</h4>
  <p>{$t('frameleaf_workflows.run_now_help')}</p>
  {#if dirty}<p>{$t('frameleaf_workflows.save_before_run')}</p>{/if}
  <div class="buttons">
    <Button
      disabled={busy || dirty || !workflow.enabled || workflow.issues.length > 0}
      onclick={() => void perform(() => runWorkflow({ id: workflow.id }))}>{$t('frameleaf_workflows.run_now')}</Button
    >
    <Button disabled={busy} onclick={() => void perform(async () => {})}>{$t('refresh')}</Button>
  </div>
  {#if error}<p role="alert">{error}</p>{/if}
  <ul aria-live="polite" aria-busy={busy}>
    {#each batches as batch (batch.id)}
      <li>
        <span
          >{new Date(batch.createdAt).toLocaleString()} · {$t(
            `frameleaf_workflows.batch_${batch.status}` as Translations,
          )}</span
        >
        <p>
          {$t('frameleaf_workflows.batch_progress', {
            values: { total: batch.total, completed: batch.completed, skipped: batch.skipped, failed: batch.failed },
          })}
        </p>
        {#if batch.error}<p>{batch.error}</p>{/if}
        {#if batch.status === 'pending' || batch.status === 'running'}
          <Button
            disabled={busy}
            onclick={() => void perform(() => cancelWorkflowBatch({ id: workflow.id, batchId: batch.id }))}
            >{$t('cancel')}</Button
          >
        {/if}
      </li>
    {/each}
  </ul>
</section>

<style>
  section {
    border-block: 1px solid var(--fl-border);
    margin-block: 1rem;
    padding-block: 0.75rem;
  }
  .buttons {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  li {
    padding-block: 0.5rem;
  }
  p {
    color: var(--fl-muted);
    font-size: 0.8rem;
  }
</style>
