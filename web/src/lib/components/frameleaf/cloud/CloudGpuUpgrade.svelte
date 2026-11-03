<script lang="ts">
  import './cloud-job.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { activitySession } from '$lib/frameleaf/activity-session.svelte';
  import { billingValues, estimateLive, estimateRange } from '$lib/frameleaf/cloud-jobs';
  import { formatUsd } from '$lib/frameleaf/cloud-ml';
  import { estimateCloudMlJobUpgrade, upgradeCloudMlJob, type CloudMlJobUpgradeEstimateDto } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  let { operationId }: { operationId: string } = $props();
  let open = $state(false);
  let quote = $state<CloudMlJobUpgradeEstimateDto | null>(null);
  let agreed = $state(false);
  let loading = $state(false);
  let submitting = $state(false);
  let notice = $state('');
  let turn = 0;

  const estimate = async () => {
    const current = ++turn;
    agreed = false;
    loading = true;
    quote = null;
    notice = '';
    try {
      const next = await estimateCloudMlJobUpgrade({ id: operationId });
      if (current === turn && open) {
        quote = next;
      }
    } catch {
      if (current === turn && open) {
        notice = $t('frameleaf_cloud_gpu_upgrade_error');
      }
    } finally {
      if (current === turn) {
        loading = false;
      }
    }
  };

  const show = () => {
    open = true;
    void estimate();
  };

  const confirm = async () => {
    if (!quote || !agreed || !quote.permission.canConfirm || quote.refusal || submitting) {
      return;
    }
    if (!estimateLive(quote)) {
      await estimate();
      notice = $t('frameleaf_cloud_job_estimate_expired');
      return;
    }
    submitting = true;
    try {
      await upgradeCloudMlJob({
        id: operationId,
        cloudMlJobUpgradeDto: { estimateId: quote.estimateId, acknowledgeMaximum: true },
      });
      open = false;
      await activitySession.refresh();
    } catch {
      notice = $t('frameleaf_cloud_gpu_upgrade_error');
    } finally {
      submitting = false;
    }
  };
</script>

<Button onclick={show}>{$t('frameleaf_cloud_gpu_upgrade')}</Button>

<Dialog title={$t('frameleaf_cloud_gpu_upgrade')} closeLabel={$t('close')} bind:open>
  <div class="fcj">
    <p class="fcj-note">{$t('frameleaf_cloud_gpu_upgrade_waiting')}</p>
    {#if loading}
      <p class="fcj-note" role="status" aria-busy="true">{$t('frameleaf_cloud_job_estimating')}</p>
    {:else if quote}
      <dl class="fcj-facts">
        <dt>{$t('frameleaf_cloud_gpu_upgrade_incurred')}</dt>
        <dd>{formatUsd(quote.incurredUsd)}</dd>
        <dt>{$t('frameleaf_cloud_gpu_upgrade_remaining')}</dt>
        <dd>{estimateRange(quote.remainingP50Usd, quote.remainingP90Usd)}</dd>
        <dt>{$t('frameleaf_cloud_job_fact_billed')}</dt>
        <dd>{$t('frameleaf_cloud_job_billing', { values: billingValues(quote) })}</dd>
        <dt>{$t('frameleaf_cloud_gpu_upgrade_maximum')}</dt>
        <dd><strong>{formatUsd(quote.approvedMaximumUsd)}</strong></dd>
      </dl>
      <p class="fcj-note">{$t('frameleaf_cloud_gpu_upgrade_preserves')}</p>
      {#if !quote.permission.canConfirm || quote.refusal}
        <p class="fcj-refusal" role="alert">
          {quote.refusal?.message ??
            $t(
              quote.permission.reason === 'monthly-cap'
                ? 'frameleaf_cloud_gpu_upgrade_limit'
                : 'frameleaf_cloud_job_not_allowed',
            )}
        </p>
      {:else}
        <label class="fcj-consent">
          <input type="checkbox" bind:checked={agreed} disabled={submitting} />
          <span
            >{$t('frameleaf_cloud_gpu_upgrade_approve', {
              values: { amount: formatUsd(quote.approvedMaximumUsd) },
            })}</span
          >
        </label>
      {/if}
    {/if}
    {#if notice}<p class="fcj-refusal" role="alert">{notice}</p>{/if}
  </div>
  {#snippet actions()}
    <Button
      onclick={() => {
        open = false;
      }}>{$t('frameleaf_cloud_gpu_upgrade_keep')}</Button
    >
    {#if notice}<Button disabled={loading || submitting} onclick={() => void estimate()}>{$t('retry')}</Button>{/if}
    {#if quote && quote.permission.canConfirm && !quote.refusal}
      <Button variant="primary" disabled={!agreed || submitting || loading} onclick={() => void confirm()}>
        {$t('frameleaf_cloud_gpu_upgrade_confirm')}
      </Button>
    {/if}
  {/snippet}
</Dialog>
