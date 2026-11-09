<script lang="ts">
  /**
   * Confirmation for one Frameleaf Cloud restoration or Smooth motion job (FL-162; prototype
   * CloudJobDialog.jsx and cloud-job.css): the model on its slider, the server's estimate as a p50–p90
   * range with how it is billed (metered GPU time × rate + a start fee per worker, never a fixed
   * price), and the amount held from AI credit. There is one confirmation per job: the terms were agreed
   * when Cloud was set up, so what leaves this server is said here as a plain line. A refusal replaces
   * the submit button and opens the set-up sheet, and the job is estimated again when that is done.
   * Routed GPU pricing changes require a separate approval. Once confirmed, the dialog
   * follows the same durable job Activity shows, so the two always agree; closing it leaves the job
   * running.
   *
   * An estimate is sealed for a short while. When it lapses, the model is withdrawn, or the terms
   * change before the job is confirmed, the dialog estimates again and asks for a fresh confirmation.
   */
  import './cloud-job.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import CloudGpuUpgrade from '$lib/components/frameleaf/cloud/CloudGpuUpgrade.svelte';
  import CloudMlModelSlider from '$lib/components/frameleaf/cloud/CloudMlModelSlider.svelte';
  import { activityCloudJob, mediaOperationStage } from '$lib/frameleaf/activity';
  import { activitySession } from '$lib/frameleaf/activity-session.svelte';
  import {
    billingValues,
    upscaleFact,
    cloudCostFacts,
    cloudJobRefusal,
    estimateLive,
    estimateRange,
    isEndedStage,
    preparingRetryMs,
    runHeadKey,
  } from '$lib/frameleaf/cloud-jobs';
  import { pausedRefusalMessage } from '$lib/frameleaf/cloud-paused';
  import { formatUsd } from '$lib/frameleaf/cloud-ml';
  import { handleError } from '$lib/utils/handle-error';
  import {
    CloudMlJobPurpose,
    CloudMlJobStage,
    createCloudMlJob,
    estimateCloudMlJob,
    type CloudMlJobEstimateRequestDto,
    type CloudMlJobEstimateResponseDto,
    type CloudMlJobResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAlertCircleOutline, mdiCloudOutline, mdiCloudUploadOutline } from '@mdi/js';
  import { onDestroy, untrack } from 'svelte';
  import { locale, t } from 'svelte-i18n';
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';

  type Props = {
    open?: boolean;
    title: string;
    /** What to estimate; the model is chosen here. */
    request: Omit<CloudMlJobEstimateRequestDto, 'modelSku'>;
    /** A short description of the work ("Preview · centre of the frame"). */
    summary?: string;
    /** The catalogue model the slider it was opened from named; left out, the chosen or recommended one. */
    initialModelSku?: string | null;
    onSubmitted?: (job: CloudMlJobResponseDto) => void;
  };

  let { open = $bindable(false), title, request, summary = '', initialModelSku = null, onSubmitted }: Props = $props();

  let estimate = $state<CloudMlJobEstimateResponseDto | null>(null);
  let modelSku = $state<string | null>(null);
  let estimating = $state(false);
  let estimateError = $state(false);
  /** FC-62: Frameleaf Cloud paused new jobs in this region; its own message is shown in place of the error. */
  let pausedMessage = $state<string | null>(null);
  let submitting = $state(false);
  let notice = $state('');
  let job = $state<CloudMlJobResponseDto | null>(null);
  /** A whole video is being prepared for its estimate on the server; the dialog asks again shortly. */
  let preparing = $state(false);
  let stopWatching: (() => void) | undefined;
  let retryTimer: ReturnType<typeof setTimeout> | undefined;
  /** Only the latest estimate request may answer: a slower earlier one never overwrites it. */
  let estimateTurn = 0;

  const runEstimate = async (sku: string | null) => {
    const turn = ++estimateTurn;
    clearTimeout(retryTimer);
    estimating = true;
    estimateError = false;
    pausedMessage = null;
    try {
      const next = await estimateCloudMlJob({
        cloudMlJobEstimateRequestDto: { ...request, ...(sku && { modelSku: sku }) },
      });
      if (turn !== estimateTurn) {
        return;
      }
      estimate = next;
      modelSku = next.model.sku;
      preparing = false;
    } catch (error) {
      if (turn !== estimateTurn) {
        return;
      }
      estimate = null;
      if (cloudJobRefusal(error) === 'preparing') {
        // not an error: the estimate follows once the video is ready
        preparing = true;
        retryTimer = setTimeout(() => {
          if (open && turn === estimateTurn) {
            void runEstimate(sku);
          }
        }, preparingRetryMs(error));
        return;
      }
      preparing = false;
      estimateError = true;
      pausedMessage = pausedRefusalMessage(error);
      if (!pausedMessage) {
        handleError(error, $t('frameleaf_cloud_job_estimate_error'));
      }
    } finally {
      if (turn === estimateTurn) {
        estimating = false;
      }
    }
  };

  /** Forget the previous opening: its estimate, its consent and the job it followed. */
  const reset = () => {
    estimateTurn++;
    clearTimeout(retryTimer);
    stopWatching?.();
    stopWatching = undefined;
    job = null;
    estimate = null;
    modelSku = null;
    notice = '';
    preparing = false;
    estimateError = false;
    estimating = false;
  };

  // Every opening starts afresh, from a new estimate on the recommended model; closing stops asking.
  let wasOpen = false;
  $effect(() => {
    const isOpen = open;
    untrack(() => {
      if (isOpen && !wasOpen) {
        reset();
        void runEstimate(initialModelSku);
      } else if (!isOpen && wasOpen) {
        estimateTurn++;
        clearTimeout(retryTimer);
      }
      wasOpen = isOpen;
    });
  });

  const chooseModel = (sku: string) => {
    if (sku === modelSku) {
      return;
    }
    modelSku = sku;
    notice = '';
    void runEstimate(sku);
  };

  const submit = async () => {
    if (!estimate || estimate.refusal || !estimate.permission.canConfirm || submitting) {
      return;
    }
    if (!estimateLive(estimate)) {
      notice = $t('frameleaf_cloud_job_estimate_expired');
      await runEstimate(modelSku);
      return;
    }
    submitting = true;
    try {
      job = await createCloudMlJob({
        cloudMlJobCreateDto: {
          estimateId: estimate.estimateId,
          consentVersion: estimate.consent.version,
          acknowledgeDataLeaves: true,
        },
      });
      // watching reads the job list at once and then keeps it current, as Activity does
      stopWatching = activitySession.watch();
      onSubmitted?.(job);
    } catch (error) {
      switch (cloudJobRefusal(error)) {
        case 'model': {
          notice = $t('frameleaf_cloud_job_model_mismatch');
          await runEstimate(null);
          break;
        }
        case 'estimate': {
          notice = $t('frameleaf_cloud_job_estimate_expired');
          await runEstimate(modelSku);
          break;
        }
        case 'paused': {
          notice = pausedRefusalMessage(error) ?? '';
          break;
        }
        default: {
          handleError(error, $t('frameleaf_cloud_job_submit_error'));
        }
      }
    } finally {
      submitting = false;
    }
  };

  onDestroy(() => {
    clearTimeout(retryTimer);
    stopWatching?.();
  });

  /* The running job, as Activity has it ---------------------------------- */
  const operation = $derived(
    job ? (activitySession.operations.find((candidate) => candidate.id === job?.operationId) ?? null) : null,
  );
  const stage = $derived(operation ? mediaOperationStage(operation) : 'queued');
  const cloud = $derived(operation?.cloudJob ? activityCloudJob(operation.cloudJob) : null);
  const ended = $derived(isEndedStage(stage));
  const measured = $derived(
    (stage === 'running' || stage === 'paused') && !!operation && Number(operation.totalUnits ?? 0) > 0,
  );
  const progress = $derived(
    stage === 'done' ? 100 : measured && operation ? Math.max(0, Math.min(100, Math.round(operation.progress))) : null,
  );

  const workLabel = $derived(
    request.purpose === CloudMlJobPurpose.SmoothMotion
      ? $t('frameleaf_cloud_job_work_smooth_motion')
      : $t('frameleaf_cloud_job_work_restoration'),
  );
  const upscale = $derived(estimate ? upscaleFact(estimate) : null);
  const expiresAt = $derived(
    estimate ? new Date(estimate.expiresAt).toLocaleTimeString($locale ?? undefined, { timeStyle: 'short' }) : '',
  );

  const close = () => {
    open = false;
  };
</script>

<Dialog {title} closeLabel={$t('close')} bind:open>
  <div class="fcj">
    <p class="fcj-summary">
      <Icon icon={mdiCloudOutline} size="16" aria-hidden={true} />
      <span>{[workLabel, summary].filter(Boolean).join(' · ')}</span>
    </p>

    {#if !job}
      {#if notice}
        <p class="fcj-note" role="status">{notice}</p>
      {/if}
      {#if estimate && estimate.models.length > 1}
        <CloudMlModelSlider
          models={estimate.models}
          value={modelSku}
          label={$t('frameleaf_cloud_job_model_label')}
          disabled={estimating || submitting}
          onChange={chooseModel}
        />
      {/if}

      {#if preparing && !estimate}
        <p class="fcj-note" role="status" aria-busy="true">{$t('frameleaf_cloud_job_preparing')}</p>
      {:else if estimating && !estimate}
        <p class="fcj-note" aria-busy="true">{$t('frameleaf_cloud_job_estimating')}</p>
      {:else if estimateError && !estimate}
        <p class="fcj-refusal" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
          <span>{pausedMessage ?? $t('frameleaf_cloud_job_estimate_error')}</span>
        </p>
      {:else if estimate}
        <dl class="fcj-facts" aria-busy={estimating}>
          {#if estimate.models.length <= 1}
            <!-- one model on offer (a full render runs the model its preview was reviewed with) -->
            <dt>{$t('frameleaf_cloud_job_fact_model')}</dt>
            <dd>
              {estimate.model.label}
              {#if request.stage === CloudMlJobStage.Full}
                <small>{$t('frameleaf_cloud_job_fact_model_help')}</small>
              {/if}
            </dd>
          {/if}
          {#if upscale}
            <!-- FC-46: the 64 MP output cap may lower a photo's factor; shown before confirming, since it is what is paid for -->
            <dt>{$t('frameleaf_cloud_job_fact_upscale')}</dt>
            <dd class:fcj-lowered={!!upscale.helpKey} data-testid="cloud-job-upscale">
              {$t(upscale.valueKey, { values: upscale.values })}
              {#if upscale.helpKey}
                <small role="note">{$t(upscale.helpKey, { values: upscale.values })}</small>
              {/if}
            </dd>
          {/if}
          <dt>{$t('frameleaf_cloud_job_fact_estimate')}</dt>
          <dd>
            <strong>{estimateRange(estimate.p50Usd, estimate.p90Usd)}</strong>
            <small>{$t('frameleaf_cloud_job_fact_estimate_help')}</small>
          </dd>
          <dt>{$t('frameleaf_cloud_job_fact_billed')}</dt>
          <dd>
            {$t('frameleaf_cloud_job_billing', { values: billingValues(estimate) })}
            <small>
              {estimate.model.gpu}{estimate.plannedWorkers > 1
                ? ` · ${$t('frameleaf_cloud_job_billing_workers', { values: { workers: estimate.plannedWorkers } })}`
                : ''}
            </small>
          </dd>
          <dt>{$t('frameleaf_cloud_job_fact_per_unit', { values: { unit: estimate.perUnit.unit } })}</dt>
          <dd>
            {$t('frameleaf_cloud_job_per_unit', {
              values: {
                range: estimateRange(estimate.perUnit.p50Usd, estimate.perUnit.p90Usd),
                unit: estimate.perUnit.unit,
              },
            })}
            <small>{$t('frameleaf_cloud_job_per_unit_help')}</small>
          </dd>
          <dt>{$t('frameleaf_cloud_job_fact_held')}</dt>
          <dd>
            {formatUsd(estimate.holdUsd)}
            <small>{$t('frameleaf_cloud_job_fact_held_help')}</small>
          </dd>
          {#if estimate.approvedMaximumUsd !== undefined}
            <dt>{$t('frameleaf_cloud_job_authorized_maximum')}</dt>
            <dd>
              {formatUsd(estimate.approvedMaximumUsd)}<small>{$t('frameleaf_cloud_job_authorized_maximum_help')}</small>
            </dd>
          {/if}
          <dt>{$t('frameleaf_cloud_job_fact_available')}</dt>
          <dd class:fcj-short={estimate.refusal?.code === 'insufficient-credits'}>
            {formatUsd(estimate.availableUsd)}
          </dd>
        </dl>
        <p class="fcj-note">{$t('frameleaf_cloud_job_expires', { values: { time: expiresAt } })}</p>

        {#if !estimate.permission.canConfirm}
          <!-- FL-162 owner decision: only administrators and people they allow may spend the AI Wallet -->
          <p class="fcj-refusal" role="alert">
            <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
            <span>
              {estimate.permission.reason === 'monthly-cap'
                ? $t('frameleaf_cloud_job_monthly_cap', {
                    values: {
                      cap: formatUsd(estimate.permission.monthlyCapUsd),
                      spent: formatUsd(estimate.permission.spentThisMonthUsd),
                    },
                  })
                : $t('frameleaf_cloud_job_not_allowed')}
            </span>
          </p>
        {:else if estimate.refusal}
          <p class="fcj-refusal" role="alert">
            <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
            <span>{$t('frameleaf_cloud_job_refusal', { values: { message: estimate.refusal.message } })}</span>
          </p>
        {:else}
          <p class="fcj-note">{$t('frameleaf_cloud_job_disclosure')}</p>
        {/if}
      {/if}
      <p class="fcj-note">
        {$t(
          estimate?.approvedMaximumUsd !== undefined
            ? 'frameleaf_cloud_job_never_fallback'
            : 'frameleaf_cloud_job_legacy_price_tolerance',
        )}
      </p>
    {:else}
      <div class="fcj-run" aria-live="polite">
        <div class="fcj-run-head">
          <strong>{$t(runHeadKey(stage))}</strong>
          {#if cloud}<span>{cloud.model}</span>{/if}
        </div>
        {#if progress === null}
          {#if !ended}
            <div
              class="fcj-progress is-indeterminate"
              role="progressbar"
              aria-label={$t('frameleaf_cloud_job_progress')}
            >
              <span></span>
            </div>
          {/if}
        {:else}
          <div
            class="fcj-progress"
            role="progressbar"
            aria-valuemin={0}
            aria-valuemax={100}
            aria-valuenow={progress}
            aria-label={$t('frameleaf_cloud_job_progress')}
          >
            <span style:width="{progress}%"></span>
          </div>
        {/if}
        {#if operation?.error && stage === 'failed'}
          <p class="fcj-note">{operation.error}</p>
        {/if}
        {#if cloud && stage === 'starting'}
          <p class="fcj-note">
            {$t('frameleaf_activity_cloud_start_note', { values: { workers: cloud.plannedWorkers } })}
          </p>
        {/if}
        {#if cloud}
          <dl class="fcj-facts">
            {#each cloudCostFacts(cloud, stage) as fact (fact.labelKey)}
              <dt>{$t(fact.labelKey)}</dt>
              <dd>{fact.valueKey ? $t(fact.valueKey) : fact.value}</dd>
            {/each}
          </dl>
        {/if}
        <p class="fcj-note">
          {#if !ended}
            {$t('frameleaf_cloud_job_keeps_going')}
          {:else if stage === 'done'}
            {$t('frameleaf_cloud_job_deleted_done')}
          {:else}
            {$t('frameleaf_cloud_job_ended_note')}
          {/if}
        </p>
      </div>
    {/if}
  </div>

  {#snippet actions()}
    {#if !job}
      <Button onclick={close}>{$t('cancel')}</Button>
      {#if estimate?.refusal?.code === 'insufficient-credits'}
        <!-- FL-544: one button that fixes it, instead of a sentence; the job is estimated again after -->
        <Button
          variant="primary"
          onclick={() =>
            getCloudManager.open('processing', {
              topUpUrl: estimate?.refusal?.topUpUrl ?? null,
              creditNeeded: estimate?.holdUsd ?? null,
              onDone: () => void runEstimate(modelSku),
            })}
        >
          {$t('frameleaf_add_ai_credit')}
        </Button>
      {:else if estimateError && !pausedMessage}
        <Button
          variant="primary"
          onclick={() =>
            getCloudManager.open('processing', { onDone: () => void runEstimate(modelSku ?? initialModelSku) })}
        >
          {$t('frameleaf_model_cloud_set_up')}
        </Button>
      {/if}
      {#if !estimate?.refusal && estimate?.permission.canConfirm !== false}
        <Button variant="primary" disabled={!estimate || estimating || submitting} onclick={() => void submit()}>
          <Icon icon={mdiCloudUploadOutline} size="1.125rem" aria-hidden={true} />
          {submitting
            ? $t('frameleaf_cloud_job_submitting')
            : $t('frameleaf_cloud_job_submit', { values: { amount: formatUsd(estimate?.holdUsd ?? 0) } })}
        </Button>
      {/if}
    {:else if !ended}
      {#if cloud?.routing?.upgradeAvailable && job}
        <CloudGpuUpgrade operationId={job.operationId} />
      {/if}
      <Button onclick={close}>{$t('frameleaf_cloud_job_continue_in_activity')}</Button>
    {:else}
      <Button variant="primary" onclick={close}>{$t('done')}</Button>
    {/if}
  {/snippet}
</Dialog>
