<script lang="ts">
  /**
   * Cloud processing → Describe your library (FL-163, `CLD-203`): the description backfill on
   * Frameleaf Cloud. The estimate comes first and queues nothing: GPU time of the chosen description
   * model as a p50–p90 range, per photo, the start fee each batch pays and the AI Wallet balance, with
   * the 72B-class guidance when batches are too small for that model. Only "Describe" queues the
   * batches, one owner per batch and one cloud job per batch; the server refuses when the wallet or a
   * budget cannot cover them, and nothing is ever sent to another destination instead.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { formatUsd } from '$lib/frameleaf/cloud-ml';
  import { handleError } from '$lib/utils/handle-error';
  import {
    estimateCloudMlDescriptionBackfill,
    startCloudMlDescriptionBackfill,
    type CloudMlDescriptionEstimateResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiTextBoxSearchOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  let {
    available,
  }: {
    /** Cloud processing is on, linked and consented, and descriptions may run on Frameleaf Cloud. */
    available: boolean;
  } = $props();

  let estimate = $state<CloudMlDescriptionEstimateResponseDto | null>(null);
  let busy = $state(false);
  let queued = $state('');

  const estimateNow = async () => {
    busy = true;
    queued = '';
    try {
      estimate = await estimateCloudMlDescriptionBackfill();
    } catch (error) {
      estimate = null;
      handleError(error, $t('admin.frameleaf_cloud_ml_backfill_error'));
    } finally {
      busy = false;
    }
  };

  const describe = async () => {
    if (!estimate || estimate.photos === 0 || estimate.refusal) {
      return;
    }
    busy = true;
    try {
      const result = await startCloudMlDescriptionBackfill({
        cloudMlDescriptionBatchCreateDto: {
          modelId: estimate.modelId,
          perPhotoP90Usd: estimate.perPhotoP90Usd,
          startupUsd: estimate.startupUsd,
          maxTotalUsd: estimate.p90Usd,
        },
      });
      queued = $t('admin.frameleaf_cloud_ml_backfill_queued', { values: { batches: result.batches } });
      estimate = null;
    } catch (error) {
      handleError(error, $t('admin.frameleaf_cloud_ml_backfill_error_start'));
    } finally {
      busy = false;
    }
  };
</script>

<section class="fc-card fl-continuous-corners" aria-labelledby="fc-backfill-title">
  <div class="fc-card-title">
    <span class="fc-card-icon"><Icon icon={mdiTextBoxSearchOutline} size="20" aria-hidden={true} /></span>
    <div>
      <h2 id="fc-backfill-title">{$t('admin.frameleaf_cloud_ml_backfill_title')}</h2>
      <p>{$t('admin.frameleaf_cloud_ml_backfill_description')}</p>
    </div>
  </div>

  {#if !available}
    <p class="fc-muted">{$t('admin.frameleaf_cloud_ml_backfill_unavailable')}</p>
  {:else}
    <div class="fc-actions">
      <Button disabled={busy} onclick={() => void estimateNow()}>
        {busy && !estimate
          ? $t('admin.frameleaf_cloud_ml_backfill_estimating')
          : $t('admin.frameleaf_cloud_ml_backfill_estimate')}
      </Button>
    </div>

    {#if queued}
      <p class="fc-ok" role="status">{queued}</p>
    {/if}

    {#if estimate}
      <div class="fc-estimate" role="status" data-testid="backfill-estimate">
        {#if estimate.photos === 0}
          <p>{$t('admin.frameleaf_cloud_ml_backfill_none')}</p>
        {:else}
          <p>
            {$t('admin.frameleaf_cloud_ml_backfill_summary', {
              values: { photos: estimate.photos, batches: estimate.batches, model: estimate.modelName },
            })}
          </p>
          <p>
            {$t('admin.frameleaf_cloud_ml_backfill_cost', {
              values: {
                p50: formatUsd(estimate.p50Usd),
                p90: formatUsd(estimate.p90Usd),
                hold: formatUsd(estimate.holdUsd),
              },
            })}
          </p>
          <p class="fc-muted">
            {$t('admin.frameleaf_cloud_ml_backfill_per_photo', {
              values: {
                p50: formatUsd(estimate.perPhotoP50Usd),
                p90: formatUsd(estimate.perPhotoP90Usd),
                fee: formatUsd(estimate.startupUsd),
              },
            })}
            {#if estimate.basis === 'modelled'}
              {$t('admin.frameleaf_cloud_ml_backfill_basis_modelled')}
            {/if}
          </p>
          <p class="fc-muted">
            {$t('admin.frameleaf_cloud_ml_backfill_wallet', {
              values: { available: formatUsd(estimate.availableUsd) },
            })}
          </p>
          {#if estimate.truncated}
            <p class="fc-muted">{$t('admin.frameleaf_cloud_ml_backfill_truncated')}</p>
          {/if}
          {#if estimate.guidance}
            <p class="fc-muted" data-testid="backfill-guidance">
              {$t('admin.frameleaf_cloud_ml_backfill_guidance', {
                values: { minimum: estimate.guidance.minimumBatch },
              })}
              {#if estimate.guidance.suggestedModelName}
                {$t('admin.frameleaf_cloud_ml_backfill_guidance_suggestion', {
                  values: { model: estimate.guidance.suggestedModelName },
                })}
              {/if}
            </p>
          {/if}
          {#if estimate.refusal}
            <p class="fc-refusal">
              <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
              {estimate.refusal}
            </p>
          {/if}
          <div class="fc-actions">
            <Button variant="primary" disabled={busy || !!estimate.refusal} onclick={() => void describe()}>
              {$t('admin.frameleaf_cloud_ml_backfill_confirm', { values: { photos: estimate.photos } })}
            </Button>
          </div>
        {/if}
      </div>
    {/if}
  {/if}
</section>
