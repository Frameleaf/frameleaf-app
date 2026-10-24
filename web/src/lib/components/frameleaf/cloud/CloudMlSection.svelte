<script lang="ts">
  /**
   * Settings → Frameleaf Cloud → Cloud processing (FL-159, handoff §3.1; prototype FrameleafCloud.jsx
   * `Processing`, effd05ffb7). Your own computers stay the default and nothing goes to the cloud
   * without asking (§2.2):
   *
   * - the enable toggle, gated by versioned consent (CloudMlConsentDialog);
   * - the AI Wallet (CloudMlWalletCard): balance, held, available, spent today against the daily cap,
   *   add credit and automatic top-up;
   * - how cloud jobs are billed (GPU time per second by GPU class plus a start fee per worker) with the
   *   GPU rate list, the model sliders (FL-189: this server's description model, saved with the
   *   settings bar, and FL-186: the Frameleaf Cloud model per model group from the cloud's catalogue,
   *   saved apart from the routes), and a job estimate with its admission;
   * - automatic descriptions of new photos with a daily budget;
   * - describing the library in batches, estimate first (FL-163, CloudDescriptionBackfill);
   * - recent cloud jobs with their GPU time and settled cost.
   *
   * Every figure comes from the server; amounts are USD for everyone. The enable toggle and automatic
   * descriptions are settings, saved with the settings bar, as is this server's description model; a
   * Frameleaf Cloud model choice is saved at once.
   */
  import './frameleaf-cloud.css';
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import CloudDescriptionBackfill from '$lib/components/frameleaf/cloud/CloudDescriptionBackfill.svelte';
  import CloudMlConsentDialog from '$lib/components/frameleaf/cloud/CloudMlConsentDialog.svelte';
  import CloudMlSpendersCard from '$lib/components/frameleaf/cloud/CloudMlSpendersCard.svelte';
  import CloudMlWalletCard from '$lib/components/frameleaf/cloud/CloudMlWalletCard.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import Coverage from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import WorkloadModelPickers from '$lib/components/frameleaf/cloud/WorkloadModelPickers.svelte';
  import WorkloadRoutingTable from '$lib/components/frameleaf/cloud/WorkloadRoutingTable.svelte';
  import {
    cloudAdmission,
    cloudConsentNeeded,
    estimateCloudJob,
    formatDateTime,
    formatDuration,
    formatRatePerMinute,
    formatUsd,
    ROUTED_WORKLOADS,
    walletAvailable,
    workloadRoute,
  } from '$lib/frameleaf/cloud-ml';
  import {
    CLOUD_DEFAULT_MODELS,
    cloudPositions,
    gpuClasses,
    gpuClassLabelKey,
    positionById,
    startFeeRange,
    workloadUnitKey,
    type CostEstimate,
  } from '$lib/frameleaf/gpu-model-catalog';
  import { choicesByGroup, loadCloudModelData, type CloudModelData } from '$lib/frameleaf/cloud-models';
  import { localModelsFor } from '$lib/frameleaf/local-models';
  import { mlWorkloadLabelKey } from '$lib/frameleaf/ml-destinations';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { handleError } from '$lib/utils/handle-error';
  import {
    CloudMlConnection,
    getCloudMlSettlements,
    getCloudMlStatus,
    getHardwareCheck,
    reconcileCloudMlUsage,
    type CloudMlSettlementDto,
    type CloudMlStatusResponseDto,
    type HardwareCheckResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircleOutline,
    mdiCalendarTodayOutline,
    mdiCheckCircleOutline,
    mdiCloudSyncOutline,
    mdiCreationOutline,
    mdiExpansionCard,
    mdiHistory,
    mdiImagePlusOutline,
    mdiLinkVariant,
    mdiTuneVariant,
    mdiWalletOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { locale, t, type Translations } from 'svelte-i18n';

  let status = $state<CloudMlStatusResponseDto | null>(null);
  let models = $state<CloudModelData>({ catalog: null, catalogFailed: false, choices: {} });
  /** The stored Hardware & GPU check, which colours this server's model stops (FL-189). */
  let hardware = $state<HardwareCheckResponseDto | null>(null);
  let settlements = $state<CloudMlSettlementDto[]>([]);
  let loadError = $state(false);
  let notice = $state('');
  let consentOpen = $state(false);

  const settingsDraft = getSystemConfigDraft();
  const cloudMl = $derived(settingsDraft?.draft.frameleafCloud?.cloudMl);
  const baseline = $derived(settingsDraft?.baseline.frameleafCloud?.cloudMl);
  const configDisabled = $derived(featureFlagsManager.value.configFile);

  const load = async () => {
    try {
      const nextStatus = await getCloudMlStatus();
      // Apply what Frameleaf Cloud has settled before listing it; the list still shows when this fails.
      if (nextStatus.connection === CloudMlConnection.Ready && nextStatus.destination) {
        await reconcileCloudMlUsage().catch(() => {});
      }
      const nextSettlements = await getCloudMlSettlements();
      status = nextStatus;
      settlements = nextSettlements.items;
      loadError = false;
    } catch (error) {
      loadError = true;
      handleError(error, $t('admin.frameleaf_cloud_ml_error_load'));
    }
    models = await loadCloudModelData(status);
  };

  onMount(() => {
    void load();
    void getHardwareCheck()
      .then((next) => (hardware = next))
      .catch(() => (hardware = null));
  });

  const linked = $derived(
    !!status &&
      status.connection !== CloudMlConnection.NotLinked &&
      status.connection !== CloudMlConnection.NotConfigured,
  );
  const ready = $derived(status?.connection === CloudMlConnection.Ready);
  const consentCurrent = $derived(!!status && !cloudConsentNeeded(status));
  const enabled = $derived(!!cloudMl?.enabled);
  const refusal = $derived(cloudAdmission(status, enabled, null));
  const statusFor = () => {
    if (!linked) {
      return { key: 'admin.frameleaf_cloud_ml_status_not_linked', tone: 'muted' };
    }
    if (!enabled) {
      return { key: 'admin.frameleaf_cloud_ml_status_off', tone: 'muted' };
    }
    return consentCurrent
      ? { key: 'admin.frameleaf_cloud_ml_status_on', tone: 'ok' }
      : { key: 'admin.frameleaf_cloud_ml_status_review', tone: 'warning' };
  };
  const headerStatus = $derived(statusFor());
  // FL-163: the saved settings, not the draft, decide what the server accepts for a backfill
  const backfillAvailable = $derived(
    ready &&
      consentCurrent &&
      !!status?.destination &&
      !!baseline?.enabled &&
      baseline.routing.descriptions !== 'local',
  );

  /** Turning on needs the current terms first; turning off needs nothing. Saved with the settings bar. */
  const setEnabled = (value: boolean) => {
    if (!cloudMl) {
      return;
    }
    if (value && !consentCurrent) {
      cloudMl.enabled = false;
      if (status?.consent) {
        consentOpen = true;
      } else {
        notice = $t('admin.frameleaf_cloud_ml_consent_needs_cloud');
      }
      return;
    }
    cloudMl.enabled = value;
    if (!value && cloudMl.autoDescribe.enabled) {
      cloudMl.autoDescribe.enabled = false;
    }
  };

  // FL-541: the answer first (the prototype's Processing hero): on, off, credit almost gone, terms to
  // review, or a server still to link; with the credit and today's spending under it.
  const wallet = $derived(status?.wallet ?? null);
  const available = $derived(walletAvailable(wallet));
  const lowCredit = $derived(!!wallet && available < 1);
  const hero = $derived.by(() => {
    if (status && !linked) {
      return { tone: 'quiet' as const, title: $t('frameleaf_cp_hero_link'), body: $t('frameleaf_cp_hero_link_body') };
    }
    if (!enabled) {
      return { tone: 'quiet' as const, title: $t('frameleaf_cp_hero_off'), body: $t('frameleaf_cp_hero_off_body') };
    }
    if (status?.consent && !consentCurrent) {
      return {
        tone: 'warn' as const,
        title: $t('admin.frameleaf_cloud_ml_terms_changed'),
        body: $t('frameleaf_cp_hero_terms_body'),
      };
    }
    if (lowCredit) {
      return {
        tone: 'warn' as const,
        title: $t('frameleaf_cp_hero_low'),
        body: $t('frameleaf_cp_hero_low_body', { values: { amount: formatUsd(available) } }),
      };
    }
    return {
      tone: 'good' as const,
      title: $t('frameleaf_cp_hero_on'),
      body: wallet
        ? $t('frameleaf_cp_hero_on_body', {
            values: { amount: formatUsd(available), today: formatUsd(wallet.spentTodayUsd) },
          })
        : $t('frameleaf_cp_hero_on_body_unread'),
    };
  });

  /** "What these add up to": the limits said back as one sentence. */
  const limitsSaidBack = $derived.by(() => {
    if (!wallet) {
      return '';
    }
    const daily =
      wallet.dailyCapUsd === null
        ? $t('frameleaf_cp_limits_no_daily')
        : $t('frameleaf_cp_limits_daily', { values: { amount: formatUsd(wallet.dailyCapUsd) } });
    const auto =
      cloudMl?.autoDescribe.enabled && cloudMl.autoDescribe.dailyBudgetUsd
        ? ' ' +
          $t('frameleaf_cp_limits_auto', {
            values: {
              amount: formatUsd(
                wallet.dailyCapUsd === null
                  ? cloudMl.autoDescribe.dailyBudgetUsd
                  : Math.min(cloudMl.autoDescribe.dailyBudgetUsd, wallet.dailyCapUsd),
              ),
            },
          })
        : '';
    return `${daily}${auto} ${$t('frameleaf_cp_limits_never_automatic')}`;
  });

  const fees = startFeeRange();

  // Estimate a job: any cloud model, any quantity.
  const estimateModels = cloudPositions();
  let trialModel = $state(CLOUD_DEFAULT_MODELS.descriptions ?? estimateModels[0].id);
  let trialQuantity = $state('500');
  const trialItem = $derived(positionById(trialModel));
  const estimate = $derived<CostEstimate | null>(estimateCloudJob(trialModel, Number(trialQuantity)));
  const trialRefusal = $derived(estimate ? cloudAdmission(status, enabled, estimate) : null);

  const unit = (workload: string, count: number) =>
    $t(workloadUnitKey(workload as never) as Translations, { values: { count } });

  const billingSentence = (value: CostEstimate) =>
    $t(
      value.workers > 1
        ? 'admin.frameleaf_cloud_ml_billing_sentence_workers'
        : 'admin.frameleaf_cloud_ml_billing_sentence',
      {
        values: {
          rate: formatRatePerMinute(value.rate),
          gpu: $t(gpuClassLabelKey(value.gpuClass.id)),
          fee: formatUsd(value.startFee),
          seconds: value.chunkSeconds ?? 0,
          workers: value.workers,
        },
      },
    );
</script>

<div class="frameleaf-cloud">
  <Hero
    label={$t('frameleaf_cp_status')}
    tone={hero.tone}
    icon={mdiCreationOutline}
    title={hero.title}
    body={hero.body}
  >
    {#snippet actions()}
      {#if status && !linked}
        <Button variant="primary" onclick={() => goto(commandCenterUrl('cloud', 'cloud-account'))}
          >{$t('frameleaf_cp_link_server')}</Button
        >
      {:else if linked && !enabled && cloudMl && !configDisabled}
        <Button variant="primary" onclick={() => setEnabled(true)}>{$t('frameleaf_cp_turn_on')}</Button>
      {/if}
    {/snippet}
    {#if linked && enabled && wallet}
      <Coverage
        rows={[
          {
            icon: mdiWalletOutline,
            name: $t('frameleaf_cp_credit'),
            detail: $t('frameleaf_cp_credit_held', { values: { amount: formatUsd(wallet.heldUsd) } }),
            tone: lowCredit ? 'warn' : 'good',
            value: $t('frameleaf_cp_to_spend', { values: { amount: formatUsd(available) } }),
          },
          {
            icon: mdiCalendarTodayOutline,
            name: $t('frameleaf_cp_spent_today'),
            detail:
              wallet.dailyCapUsd === null
                ? $t('frameleaf_cp_no_daily_limit')
                : $t('frameleaf_cp_daily_limit', { values: { amount: formatUsd(wallet.dailyCapUsd) } }),
            tone: 'good',
            value: formatUsd(wallet.spentTodayUsd),
          },
        ]}
      />
    {/if}
  </Hero>

  {#if notice}
    <p class="fc-banner" role="status">{notice}</p>
  {/if}

  {#if status && !linked}
    <div class="fc-banner" role="status">
      <Icon icon={mdiLinkVariant} size="18" aria-hidden={true} />
      <div>
        <strong>{$t('admin.frameleaf_cloud_ml_gate_title')}</strong>
        <p>
          {$t(
            status.connection === CloudMlConnection.NotConfigured
              ? 'admin.frameleaf_cloud_ml_connection_not_configured_help'
              : 'admin.frameleaf_cloud_ml_gate_body',
          )}
        </p>
      </div>
      <a class="fc-button-link" href={commandCenterUrl('cloud')}>{$t('admin.frameleaf_cloud_ml_gate_link')}</a>
    </div>
  {/if}

  <section class="fc-card fl-continuous-corners" aria-labelledby="fc-destination-title">
    <div class="fc-card-title">
      <span class="fc-card-icon"><Icon icon={mdiCloudSyncOutline} size="20" aria-hidden={true} /></span>
      <div>
        <h2 id="fc-destination-title">{$t('admin.frameleaf_cloud_ml_title')}</h2>
        <p>{$t('admin.frameleaf_cloud_ml_description')}</p>
      </div>
      <span
        class="fc-status"
        class:is-ok={headerStatus.tone === 'ok'}
        class:is-warning={headerStatus.tone === 'warning'}>{$t(headerStatus.key as Translations)}</span
      >
    </div>
    {#if loadError && !status}
      <p class="fc-refusal" role="alert">
        <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
        {$t('admin.frameleaf_cloud_ml_error_load')}
      </p>
    {/if}
    {#if linked && enabled && status?.consent && !consentCurrent}
      <div class="fc-banner is-warning" role="status">
        <Icon icon={mdiAlertCircleOutline} size="18" aria-hidden={true} />
        <div>
          <strong>{$t('admin.frameleaf_cloud_ml_terms_changed')}</strong>
          <p>
            {$t('admin.frameleaf_cloud_ml_terms_changed_body', { values: { version: status.consent.requiredVersion } })}
          </p>
        </div>
        <Button onclick={() => (consentOpen = true)}>{$t('admin.frameleaf_cloud_ml_review_terms')}</Button>
      </div>
    {/if}
    {#if cloudMl}
      <SettingToggle
        title={$t('admin.frameleaf_cloud_ml_setting_enabled')}
        subtitle={$t('admin.frameleaf_cloud_ml_setting_enabled_description')}
        checked={cloudMl.enabled}
        disabled={configDisabled || !linked}
        isEdited={cloudMl.enabled !== baseline?.enabled}
        onToggle={setEnabled}
        policy={linked ? undefined : $t('admin.frameleaf_cloud_ml_link_first')}
      />
    {/if}
    <Notice title={$t('frameleaf_cp_leaves')}>{$t('frameleaf_cp_leaves_body')}</Notice>
    <dl class="fc-facts">
      <dt>{$t('admin.frameleaf_cloud_ml_fact_terms')}</dt>
      <dd>
        {status?.consent?.acceptedVersion
          ? $t('admin.frameleaf_cloud_ml_fact_terms_accepted', { values: { version: status.consent.acceptedVersion } })
          : $t('admin.frameleaf_cloud_ml_fact_terms_none')}
      </dd>
      <dt>{$t('admin.frameleaf_cloud_ml_fact_names')}</dt>
      <dd>
        {status?.consent?.features.identityNames
          ? $t('admin.frameleaf_cloud_ml_fact_names_sent')
          : $t('admin.frameleaf_cloud_ml_fact_names_never')}
      </dd>
      <dt>{$t('admin.frameleaf_cloud_ml_fact_medical')}</dt>
      <dd>
        {status?.consent?.features.medicalSignals
          ? $t('admin.frameleaf_cloud_ml_fact_medical_allowed')
          : $t('admin.frameleaf_cloud_ml_fact_medical_never')}
      </dd>
      <dt>{$t('admin.frameleaf_cloud_ml_smart_search_label')}</dt>
      <dd>
        {status?.consent?.features.smartSearch
          ? $t('admin.frameleaf_cloud_ml_smart_search_sent')
          : $t('admin.frameleaf_cloud_ml_smart_search_stays_home')}
      </dd>
      <dt>{$t('admin.frameleaf_cloud_ml_faces_label')}</dt>
      <dd>
        {status?.consent?.features.faceRecognition
          ? $t('admin.frameleaf_cloud_ml_faces_sent')
          : $t('admin.frameleaf_cloud_ml_faces_stay_home')}
      </dd>
    </dl>
    {#if refusal && linked}
      <p class="fc-refusal" role="status">
        <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
        {$t('admin.frameleaf_cloud_ml_cannot_start', {
          values: { reason: $t(refusal.key, { values: refusal.values }) },
        })}
      </p>
    {/if}
    {#if linked && consentCurrent && status?.consent}
      <div class="fc-actions">
        <Button onclick={() => (consentOpen = true)}>{$t('admin.frameleaf_cloud_ml_review_terms_features')}</Button>
      </div>
    {/if}
  </section>

  <WorkloadRoutingTable showModels={false} />

  <CloudMlWalletCard
    wallet={status?.wallet ?? null}
    {ready}
    onChanged={(wallet) => {
      if (status) {
        status = { ...status, wallet };
      }
    }}
  />

  <section class="fc-card fl-continuous-corners" aria-labelledby="fc-models-title">
    <div class="fc-card-title">
      <span class="fc-card-icon"><Icon icon={mdiTuneVariant} size="20" aria-hidden={true} /></span>
      <div>
        <h2 id="fc-models-title">{$t('admin.frameleaf_cloud_ml_models_title')}</h2>
        <p>{$t('admin.frameleaf_cloud_ml_models_description')}</p>
      </div>
    </div>
    <div class="fc-billing">
      <p>
        <strong>{$t('admin.frameleaf_cloud_ml_billing_title')}</strong>
        {$t('admin.frameleaf_cloud_ml_billing_body', {
          values: { min: formatUsd(fees.min), max: formatUsd(fees.max) },
        })}
      </p>
      <details class="fc-disclosure fc-rates">
        <summary
          ><Icon icon={mdiExpansionCard} size="16" aria-hidden={true} /> {$t('admin.frameleaf_cloud_ml_rates')}</summary
        >
        <dl class="fc-facts">
          {#each gpuClasses as gpu (gpu.id)}
            <dt>{$t(gpuClassLabelKey(gpu.id))}</dt>
            <dd>
              {$t('admin.frameleaf_cloud_ml_rate_per_minute', {
                values: { rate: formatRatePerMinute(gpu.customerUsdPerSec) },
              })}
            </dd>
          {/each}
        </dl>
      </details>
    </div>
    {#if cloudMl}
      {#each ROUTED_WORKLOADS as workload (workload)}
        {#if models.catalog || models.catalogFailed || localModelsFor(workload).length > 0}
          <div class="fc-model-row">
            <WorkloadModelPickers
              row={workload}
              route={workloadRoute(cloudMl.routing, workload)}
              {hardware}
              catalog={models.catalog}
              catalogFailed={models.catalogFailed}
              choices={models.choices}
              modelForLegend={false}
              onSaved={(choices, message) => {
                models = { ...models, choices: choicesByGroup(choices) };
                notice = message;
              }}
            />
          </div>
        {/if}
      {/each}
    {/if}
    <div class="fc-estimate">
      <h3>{$t('admin.frameleaf_cloud_ml_estimate_title')}</h3>
      <div class="fc-estimate-row">
        <label>
          {$t('admin.frameleaf_cloud_ml_estimate_model')}
          <select bind:value={trialModel}>
            {#each estimateModels as model (model.id)}
              <option value={model.id}>{model.name}{model.params ? ` · ${model.params}` : ''}</option>
            {/each}
          </select>
        </label>
        <label>
          {$t('admin.frameleaf_cloud_ml_estimate_quantity')}
          <input type="number" min="1" max="100000" bind:value={trialQuantity} />
          {#if trialItem}<small>{unit(trialItem.workload, Number(trialQuantity) || 0)}</small>{/if}
        </label>
      </div>
      {#if estimate}
        <p>
          {$t('admin.frameleaf_cloud_ml_estimate_range', {
            values: { p50: formatUsd(estimate.p50), p90: formatUsd(estimate.p90), hold: formatUsd(estimate.hold) },
          })}
        </p>
        <p class="fc-muted">
          {billingSentence(estimate)}
          {$t('admin.frameleaf_cloud_ml_estimate_per_unit', {
            values: { price: formatUsd(estimate.perUnit.p50), unit: unit(estimate.item.workload, 1) },
          })}
        </p>
        <p class={trialRefusal ? 'fc-refusal' : 'fc-ok'} role="status">
          <Icon icon={trialRefusal ? mdiAlertCircleOutline : mdiCheckCircleOutline} size="16" aria-hidden={true} />
          {trialRefusal
            ? $t('admin.frameleaf_cloud_ml_estimate_refused', {
                values: { reason: $t(trialRefusal.key, { values: trialRefusal.values }) },
              })
            : $t('admin.frameleaf_cloud_ml_estimate_could_start')}
        </p>
      {:else}
        <p class="fc-muted">{$t('admin.frameleaf_cloud_ml_estimate_enter')}</p>
      {/if}
    </div>
  </section>

  {#if cloudMl}
    <section class="fc-card fl-continuous-corners" aria-labelledby="fc-auto-title">
      <div class="fc-card-title">
        <span class="fc-card-icon"><Icon icon={mdiImagePlusOutline} size="20" aria-hidden={true} /></span>
        <div>
          <h2 id="fc-auto-title">{$t('admin.frameleaf_cloud_ml_auto_title')}</h2>
          <p>{$t('admin.frameleaf_cloud_ml_auto_description')}</p>
        </div>
      </div>
      <SettingToggle
        title={$t('admin.frameleaf_cloud_ml_setting_auto_describe')}
        subtitle={$t('admin.frameleaf_cloud_ml_setting_auto_describe_description')}
        bind:checked={cloudMl.autoDescribe.enabled}
        disabled={configDisabled || !cloudMl.enabled || !consentCurrent}
        isEdited={cloudMl.autoDescribe.enabled !== baseline?.autoDescribe.enabled}
        policy={cloudMl.enabled && consentCurrent ? undefined : $t('admin.frameleaf_cloud_ml_auto_needs_on')}
      />
      <label class="fc-stack">
        {$t('admin.frameleaf_cloud_ml_setting_daily_budget')}
        <span class="fc-input-unit">
          <input
            type="number"
            min="0.5"
            max="100"
            step="0.5"
            bind:value={cloudMl.autoDescribe.dailyBudgetUsd}
            aria-label={$t('admin.frameleaf_cloud_ml_setting_daily_budget')}
            disabled={configDisabled || !cloudMl.autoDescribe.enabled}
          />
          <span>USD</span>
        </span>
        <small>{$t('admin.frameleaf_cloud_ml_setting_daily_budget_description')}</small>
      </label>
      <SettingActions keys={['frameleafCloud.cloudMl']} disabled={configDisabled} />
    </section>
  {/if}

  <CloudMlSpendersCard disabled={configDisabled} />

  {#if linked && enabled && limitsSaidBack}
    <Notice title={$t('frameleaf_cp_limits')}>{limitsSaidBack}</Notice>
  {/if}

  <CloudDescriptionBackfill available={backfillAvailable} />

  <section class="fc-card fl-continuous-corners" aria-labelledby="fc-jobs-title">
    <div class="fc-card-title">
      <span class="fc-card-icon"><Icon icon={mdiHistory} size="20" aria-hidden={true} /></span>
      <div>
        <h2 id="fc-jobs-title">{$t('admin.frameleaf_cloud_ml_jobs_title')}</h2>
        <p>{$t('admin.frameleaf_cloud_ml_jobs_description')}</p>
      </div>
    </div>
    {#if settlements.length === 0}
      <p class="fc-muted">{$t('admin.frameleaf_cloud_ml_jobs_empty')}</p>
    {:else}
      <div class="fc-table-wrap">
        <table class="fc-table">
          <thead>
            <tr>
              <th scope="col">{$t('admin.frameleaf_cloud_ml_jobs_job')}</th>
              <th scope="col">{$t('admin.frameleaf_cloud_ml_jobs_model')}</th>
              <th scope="col">{$t('admin.frameleaf_cloud_ml_jobs_status')}</th>
              <th scope="col">{$t('admin.frameleaf_cloud_ml_jobs_estimate')}</th>
              <th scope="col">{$t('admin.frameleaf_cloud_ml_jobs_cost')}</th>
            </tr>
          </thead>
          <tbody>
            {#each settlements as job (job.cloudJobId)}
              <tr>
                <th scope="row">
                  {$t(mlWorkloadLabelKey(job.workload))}
                  <small>{formatDateTime(job.finishedAt, $locale)}</small>
                </th>
                <td>{positionById(job.modelSku)?.name ?? job.modelSku ?? '—'}</td>
                <td>
                  <span class="fc-status" class:is-ok={job.succeeded} class:is-warning={!job.succeeded}>
                    {job.succeeded
                      ? $t('admin.frameleaf_cloud_ml_jobs_completed')
                      : $t('admin.frameleaf_cloud_ml_jobs_failed')}
                  </span>
                </td>
                <td>{formatUsd(job.estimateUsd)}</td>
                <td>
                  {formatUsd(job.costUsd)}
                  {#if job.gpuSeconds !== null}
                    <small class="fc-muted">
                      {$t(
                        (job.workers ?? 1) > 1
                          ? 'admin.frameleaf_cloud_ml_jobs_gpu_time_workers'
                          : 'admin.frameleaf_cloud_ml_jobs_gpu_time',
                        { values: { time: formatDuration(job.gpuSeconds, $locale), workers: job.workers ?? 1 } },
                      )}
                    </small>
                  {/if}
                </td>
              </tr>
            {/each}
          </tbody>
        </table>
      </div>
    {/if}
    <div class="fc-actions">
      <a class="fc-link" href={Route.queues()}>{$t('admin.frameleaf_cloud_ml_open_jobs')}</a>
      <a class="fc-link" href={commandCenterUrl('processing', 'workers')}
        >{$t('admin.frameleaf_cloud_ml_home_computers')}</a
      >
    </div>
  </section>
</div>

{#if status?.consent}
  <CloudMlConsentDialog
    bind:open={consentOpen}
    destinationId={status.destination?.id ?? null}
    consent={status.consent}
    region={status.region}
    matchedWorkloads={status.matchedModelWorkloads ?? []}
    onRecorded={() => {
      if (cloudMl) {
        cloudMl.enabled = true;
      }
      notice = $t('admin.frameleaf_cloud_ml_consent_recorded', {
        values: { version: status?.consent?.requiredVersion ?? '' },
      });
      void load();
    }}
  />
{/if}
