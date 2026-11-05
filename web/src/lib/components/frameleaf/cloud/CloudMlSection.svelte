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
  import Coverage from '$lib/components/frameleaf/settings/kit/Coverage.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Facts, { type Fact } from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import HistoryList from '$lib/components/frameleaf/settings/kit/HistoryList.svelte';
  import HistoryRow from '$lib/components/frameleaf/settings/kit/HistoryRow.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Switch from '$lib/components/frameleaf/settings/kit/Switch.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import WorkloadModelPickers from '$lib/components/frameleaf/cloud/WorkloadModelPickers.svelte';
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
    workloadNameKey,
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
  import { motionScrollBehavior } from '$lib/frameleaf/motion';
  import { mlWorkloadLabelKey } from '$lib/frameleaf/ml-destinations';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { gateButtonKey, type CloudLack } from '$lib/frameleaf/cloud-rules';
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
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
    mdiChevronRight,
    mdiCreationOutline,
    mdiLinkVariant,
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
  let topUpOpen = $state(false);

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
  // FL-544: what the Get Frameleaf Cloud sheet would have to add before cloud work can start
  const lacks = $derived<CloudLack[]>([
    ...(linked ? [] : (['link'] as const)),
    ...(status?.entitled === false ? (['licence'] as const) : []),
    ...(status?.wallet && status.wallet.availableUsd <= 0 ? (['credit'] as const) : []),
  ]);
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
    return wallet.autoTopUp ? `${daily}${auto}` : `${daily}${auto} ${$t('frameleaf_cp_limits_never_automatic')}`;
  });

  /** "What may use the cloud": the routes chosen on Computers & background work, said back. */
  const mayUse = $derived.by((): Fact[] => {
    const names = (ids: readonly string[]) => ids.map((id) => $t(workloadNameKey(id as never))).join(', ');
    const inCloud = ROUTED_WORKLOADS.filter((id) => workloadRoute(cloudMl?.routing, id) !== 'local');
    const atHome = ROUTED_WORKLOADS.filter((id) => workloadRoute(cloudMl?.routing, id) === 'local');
    return [
      {
        label: $t('frameleaf_cp_may_use_cloud'),
        value: $t('frameleaf_cp_kinds', { values: { count: inCloud.length } }),
        detail: inCloud.length > 0 ? names(inCloud) : undefined,
      },
      {
        label: $t('frameleaf_cp_may_use_home'),
        value: $t('frameleaf_cp_kinds', { values: { count: atHome.length } }),
        detail: atHome.length > 0 ? names(atHome) : undefined,
      },
      {
        label: $t('frameleaf_cp_may_use_always'),
        value: $t('frameleaf_cp_kinds', { values: { count: 3 } }),
        detail: $t('frameleaf_cp_may_use_always_detail'),
      },
    ];
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

<KitPage>
  <div class="frameleaf-cloud is-wide">
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
        {:else if linked && enabled && wallet}
          <Button
            variant={lowCredit ? 'primary' : 'default'}
            disabled={!ready || !wallet.topUpUrl}
            onclick={() => (topUpOpen = true)}>{$t('admin.frameleaf_cloud_ml_wallet_add_credit')}</Button
          >
          {#if backfillAvailable}
            <Button
              onclick={() =>
                document
                  .querySelector('#describe-library')
                  ?.scrollIntoView({ behavior: motionScrollBehavior(), block: 'start' })}
              >{$t('frameleaf_cp_describe_library')}</Button
            >
          {/if}
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

    <!-- Unlinked, the hero's "Link this server" is the one way on: it says no plan is needed, so a second
         card offering "Get Frameleaf Cloud" (the plan) would contradict it. Only a server that cannot
         reach Frameleaf Cloud at all is told why. -->
    {#if status && !linked && status.connection === CloudMlConnection.NotConfigured}
      <Notice icon={mdiLinkVariant} title={$t('frameleaf_gate_processing')}>
        {$t('admin.frameleaf_cloud_ml_connection_not_configured_help')}
      </Notice>
    {/if}

    <Section
      title={$t('frameleaf_cc_section_cloud_processing')}
      description={$t('admin.frameleaf_cloud_ml_description')}
    >
      {#snippet action()}
        <span
          class="fc-status"
          class:is-ok={headerStatus.tone === 'ok'}
          class:is-warning={headerStatus.tone === 'warning'}>{$t(headerStatus.key as Translations)}</span
        >
      {/snippet}
      {#if loadError && !status}
        <p class="fc-refusal" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
          {$t('admin.frameleaf_cloud_ml_error_load')}
        </p>
      {/if}
      {#if linked && enabled && status?.consent && !consentCurrent}
        <Notice tone="warn" title={$t('admin.frameleaf_cloud_ml_terms_changed')}>
          {$t('admin.frameleaf_cloud_ml_terms_changed_body', { values: { version: status.consent.requiredVersion } })}
          {#snippet action()}
            <Button onclick={() => (consentOpen = true)}>{$t('admin.frameleaf_cloud_ml_review_terms')}</Button>
          {/snippet}
        </Notice>
      {/if}
      {#if cloudMl}
        <Row
          label={$t('admin.frameleaf_cloud_ml_setting_enabled')}
          help={linked
            ? $t('admin.frameleaf_cloud_ml_setting_enabled_description')
            : `${$t('admin.frameleaf_cloud_ml_setting_enabled_description')} ${$t('admin.frameleaf_cloud_ml_link_first')}`}
        >
          <Switch
            label={$t('admin.frameleaf_cloud_ml_setting_enabled')}
            checked={cloudMl.enabled}
            held={configDisabled || !linked}
            onChange={setEnabled}
          />
        </Row>
      {/if}
      <div class="leaves">
        <Notice title={$t('frameleaf_cp_leaves')}>{$t('frameleaf_cp_leaves_body')}</Notice>
      </div>
      {#if refusal && linked && enabled}
        <p class="fc-refusal cannot-start" role="status">
          <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
          {$t('admin.frameleaf_cloud_ml_cannot_start', {
            values: { reason: $t(refusal.key, { values: refusal.values }) },
          })}
        </p>
        {#if lacks.length > 0}
          <div class="fc-actions">
            <Button onclick={() => getCloudManager.open('processing', { onDone: () => setEnabled(true) })}
              >{$t(gateButtonKey(lacks))}</Button
            >
          </div>
        {/if}
      {/if}
      <Advanced summary={$t('frameleaf_cp_what_is_sent')}>
        <dl class="fc-facts">
          <dt>{$t('admin.frameleaf_cloud_ml_fact_terms')}</dt>
          <dd>
            {status?.consent?.acceptedVersion
              ? $t('admin.frameleaf_cloud_ml_fact_terms_accepted', {
                  values: { version: status.consent.acceptedVersion },
                })
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
        {#if linked && consentCurrent && status?.consent}
          <div class="fc-actions">
            <Button onclick={() => (consentOpen = true)}>{$t('admin.frameleaf_cloud_ml_review_terms_features')}</Button>
          </div>
        {/if}
      </Advanced>
    </Section>

    {#if linked && enabled}
      <Section title={$t('frameleaf_cp_may_use')} description={$t('frameleaf_cp_may_use_description')}>
        {#snippet action()}
          <a class="fl-control button" href={commandCenterUrl('processing', 'computers')}
            >{$t('frameleaf_cp_change_where')}<Icon icon={mdiChevronRight} size="16" aria-hidden /></a
          >
        {/snippet}
        <Facts rows={mayUse} />
      </Section>

      <Section title={$t('frameleaf_cp_quality')} description={$t('frameleaf_cp_quality_description')}>
        {#if cloudMl}
          {#each ROUTED_WORKLOADS as workload (workload)}
            {#if workloadRoute(cloudMl.routing, workload) !== 'local' && (models.catalog || models.catalogFailed || localModelsFor(workload).length > 0)}
              <div class="model-row">
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
        <Row
          label={$t('frameleaf_cp_estimate')}
          help={estimate
            ? `${$t('admin.frameleaf_cloud_ml_estimate_range', {
                values: { p50: formatUsd(estimate.p50), p90: formatUsd(estimate.p90), hold: formatUsd(estimate.hold) },
              })} ${$t('admin.frameleaf_cloud_ml_estimate_per_unit', {
                values: { price: formatUsd(estimate.perUnit.p50), unit: unit(estimate.item.workload, 1) },
              })} ${
                trialRefusal
                  ? $t('admin.frameleaf_cloud_ml_estimate_refused', {
                      values: { reason: $t(trialRefusal.key, { values: trialRefusal.values }) },
                    })
                  : $t('admin.frameleaf_cloud_ml_estimate_could_start')
              }`
            : $t('admin.frameleaf_cloud_ml_estimate_enter')}
        >
          <select
            class="fl-control estimate-model"
            aria-label={$t('admin.frameleaf_cloud_ml_estimate_model')}
            bind:value={trialModel}
          >
            {#each estimateModels as model (model.id)}
              <option value={model.id}>{model.name}{model.params ? ` · ${model.params}` : ''}</option>
            {/each}
          </select>
          <span class="fc-input-unit">
            <input
              class="fc-kit-number"
              type="number"
              min="1"
              max="100000"
              aria-label={$t('admin.frameleaf_cloud_ml_estimate_quantity')}
              bind:value={trialQuantity}
            />
            {#if trialItem}<span>{unit(trialItem.workload, Number(trialQuantity) || 0)}</span>{/if}
          </span>
        </Row>
        <Advanced summary={$t('frameleaf_cp_models_prices')}>
          <p class="hint">
            {$t('admin.frameleaf_cloud_ml_billing_body', {
              values: { min: formatUsd(fees.min), max: formatUsd(fees.max) },
            })}
            {#if estimate}{billingSentence(estimate)}{/if}
          </p>
          <p class="hint">{$t('admin.frameleaf_cloud_ml_models_description')}</p>
          <Facts
            rows={gpuClasses.map((gpu) => ({
              label: $t(gpuClassLabelKey(gpu.id)),
              value: $t('admin.frameleaf_cloud_ml_rate_per_minute', {
                values: { rate: formatRatePerMinute(gpu.customerUsdPerSec) },
              }),
            }))}
          />
        </Advanced>
      </Section>
    {/if}

    {#if linked}
      <Section title={$t('frameleaf_cp_spending')} description={$t('frameleaf_cp_spending_description')}>
        <CloudMlWalletCard
          wallet={status?.wallet ?? null}
          {ready}
          bind:topUpOpen
          onChanged={(wallet) => {
            if (status) {
              status = { ...status, wallet };
            }
          }}
        />
        {#if cloudMl}
          <Row
            label={$t('admin.frameleaf_cloud_ml_setting_auto_describe')}
            help={cloudMl.enabled && consentCurrent
              ? $t('admin.frameleaf_cloud_ml_setting_auto_describe_description')
              : `${$t('admin.frameleaf_cloud_ml_setting_auto_describe_description')} ${$t('admin.frameleaf_cloud_ml_auto_needs_on')}`}
          >
            <Switch
              label={$t('admin.frameleaf_cloud_ml_setting_auto_describe')}
              checked={cloudMl.autoDescribe.enabled}
              held={configDisabled || !cloudMl.enabled || !consentCurrent}
              onChange={(value) => {
                if (cloudMl) {
                  cloudMl.autoDescribe.enabled = value;
                }
              }}
            />
          </Row>
          {#if cloudMl.autoDescribe.enabled}
            <Row
              label={$t('admin.frameleaf_cloud_ml_setting_daily_budget')}
              help={$t('admin.frameleaf_cloud_ml_setting_daily_budget_description')}
            >
              <span class="fc-input-unit">
                <input
                  class="fc-kit-number"
                  type="number"
                  min="0.5"
                  max="100"
                  step="0.5"
                  bind:value={cloudMl.autoDescribe.dailyBudgetUsd}
                  aria-label={$t('admin.frameleaf_cloud_ml_setting_daily_budget')}
                  disabled={configDisabled || !cloudMl.autoDescribe.enabled}
                />
                <span>{$t('frameleaf_cp_usd_day')}</span>
              </span>
            </Row>
          {/if}
        {/if}
        <CloudMlSpendersCard disabled={configDisabled} />
        {#if enabled && limitsSaidBack}
          <div class="said">
            <Notice title={$t('frameleaf_cp_limits')}>{limitsSaidBack}</Notice>
          </div>
        {/if}
      </Section>
    {/if}

    {#if linked && enabled}
      <CloudDescriptionBackfill available={backfillAvailable} />
    {/if}

    {#if linked}
      <Section title={$t('frameleaf_cp_recent')} description={$t('admin.frameleaf_cloud_ml_jobs_description')}>
        {#snippet action()}
          <a class="fl-control button" href={Route.queues()}
            >{$t('admin.frameleaf_cloud_ml_open_jobs')}<Icon icon={mdiChevronRight} size="16" aria-hidden /></a
          >
        {/snippet}
        {#if settlements.length === 0}
          <p class="empty">{$t('admin.frameleaf_cloud_ml_jobs_empty')}</p>
        {:else}
          <HistoryList>
            {#each settlements as job (job.cloudJobId)}
              <HistoryRow
                when={formatDateTime(job.finishedAt, $locale)}
                datetime={job.finishedAt}
                what={$t(mlWorkloadLabelKey(job.workload))}
                detail={[
                  positionById(job.modelSku)?.name ?? job.modelSku,
                  $t('frameleaf_cp_recent_estimate', { values: { amount: formatUsd(job.estimateUsd) } }),
                  job.gpuSeconds === null
                    ? ''
                    : $t(
                        (job.workers ?? 1) > 1
                          ? 'admin.frameleaf_cloud_ml_jobs_gpu_time_workers'
                          : 'admin.frameleaf_cloud_ml_jobs_gpu_time',
                        { values: { time: formatDuration(job.gpuSeconds, $locale), workers: job.workers ?? 1 } },
                      ),
                ]
                  .filter(Boolean)
                  .join(' · ')}
              >
                <Pill tone={job.succeeded ? 'good' : 'warn'}
                  >{job.succeeded ? formatUsd(job.costUsd) : $t('admin.frameleaf_cloud_ml_jobs_failed')}</Pill
                >
              </HistoryRow>
            {/each}
          </HistoryList>
        {/if}
      </Section>
    {/if}

    {#if linked}
      <!-- Nothing here can change until the server is linked, so there is nothing to reset before then. -->
      <SettingActions keys={['frameleafCloud.cloudMl']} disabled={configDisabled} />
    {/if}
  </div>
</KitPage>

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

<style>
  /* In the kit's column: the cards below keep the page's width, as the plain-words pages do. */
  .frameleaf-cloud.is-wide {
    max-width: none;
    gap: var(--fl-space-6);
  }
  .leaves {
    padding-bottom: var(--fl-space-4);
  }
  .frameleaf-cloud :global(.kit-advanced .fc-facts) {
    margin-bottom: var(--fl-space-4);
  }
  a.button {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: var(--fl-space-1);
    text-decoration: none;
    white-space: nowrap;
  }
  .model-row {
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  .estimate-model {
    max-width: 280px;
  }
  .hint {
    max-width: 720px;
    margin: 0 0 var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .cannot-start {
    margin: 0;
    padding-bottom: var(--fl-space-4);
  }
  .said {
    padding: var(--fl-space-2) 0 var(--fl-space-5);
  }
  .empty {
    margin: 0;
    padding: var(--fl-space-4) 0 var(--fl-space-5);
    border-top: 1px solid var(--fl-border);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
</style>
