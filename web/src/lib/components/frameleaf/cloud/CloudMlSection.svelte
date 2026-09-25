<script lang="ts">
  /**
   * Compute & jobs → Frameleaf Cloud (FL-159). This section takes the place of the prototype's
   * provider manager (`RunPodManager`, JobsManager.jsx:1388-1759, CommandCenter.jsx:951-958) and
   * keeps its layout: a state strip (`.jm-provider-state`), a two-column grid of the destination and
   * the money (`.jm-provider-grid`), and the history below (`.jm-history`). What changes is what
   * those places hold, because there is no hardware to launch any more:
   *
   * - the state strip reports whether this server is linked to Frameleaf Cloud and whether it answered;
   * - the destination card adds Frameleaf Cloud (no URL or token: requests use short-lived tokens
   *   this server signs) and records consent through the review sheet (`ProviderReview` →
   *   CloudMlConsentDialog);
   * - the compute estimate becomes the AI Wallet the cloud reports;
   * - GPU pickers become the catalogue model each routed workload uses;
   * - "Provider action history" becomes the consent and settlement history.
   *
   * Every figure is read from the server. Nothing is ever routed here automatically, and a refusal
   * (no consent, empty wallet, cloud unreachable) never sends work anywhere else.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import CloudMlConsentDialog from '$lib/components/frameleaf/cloud/CloudMlConsentDialog.svelte';
  import CloudMlModelPicker from '$lib/components/frameleaf/cloud/CloudMlModelPicker.svelte';
  import CloudMlWalletCard from '$lib/components/frameleaf/cloud/CloudMlWalletCard.svelte';
  import SettingActions from '$lib/components/frameleaf/settings/SettingActions.svelte';
  import SettingField from '$lib/components/frameleaf/settings/SettingField.svelte';
  import SettingSelect from '$lib/components/frameleaf/settings/SettingSelect.svelte';
  import SettingToggle from '$lib/components/frameleaf/settings/SettingToggle.svelte';
  import { SettingInputFieldType } from '$lib/constants';
  import { Route } from '$lib/route';
  import {
    cloudConnectionHelpKey,
    cloudConnectionLabelKey,
    cloudConsentNeeded,
    cloudHistory,
    cloudWorkloads,
    formatDateTime,
    formatUsd,
    modelsFor,
  } from '$lib/frameleaf/cloud-ml';
  import { mlRefusalLabelKey, mlWorkloadLabelKey, parseOptionalNumber } from '$lib/frameleaf/ml-destinations';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import {
    CloudMlConnection,
    MlWorkload,
    createCloudMlDestination,
    getCloudMlCatalog,
    getCloudMlConsentHistory,
    getCloudMlSettlements,
    getCloudMlStatus,
    getCloudMlWallet,
    getMlWorkloadRoutes,
    probeMlDestination,
    reconcileCloudMlUsage,
    revokeMlDestinationConsent,
    type CloudMlCatalogResponseDto,
    type CloudMlStatusResponseDto,
    type MlWorkloadRouteDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCloudOutline, mdiHistory, mdiShieldCheckOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  let status = $state<CloudMlStatusResponseDto | null>(null);
  let catalog = $state<CloudMlCatalogResponseDto | null>(null);
  let routes = $state<MlWorkloadRouteDto[]>([]);
  let history = $state<ReturnType<typeof cloudHistory>>([]);
  let loadError = $state(false);
  let busy = $state<string | null>(null);
  let notice = $state('');
  let consentOpen = $state(false);

  const settingsDraft = getSystemConfigDraft();
  const configToEdit = $derived(settingsDraft?.draft);
  const baseline = $derived(settingsDraft?.baseline);
  const configDisabled = $derived(featureFlagsManager.value.configFile);

  const ready = $derived(status?.connection === CloudMlConnection.Ready);
  const destination = $derived(status?.destination ?? null);
  const consentNeeded = $derived(status ? cloudConsentNeeded(status) : false);
  const routedWorkloads = $derived(
    destination
      ? cloudWorkloads().filter((workload) =>
          routes.some((route) => route.workload === workload && route.destinationId === destination.id),
        )
      : [],
  );

  /** The catalogue's models for the settings' default-model choices; "none chosen" is the empty id. */
  const defaultModelOptions = (workloads: MlWorkload[]) => [
    { value: '', text: $t('admin.frameleaf_cloud_ml_model_cloud_default') },
    ...(catalog ? workloads.flatMap((workload) => modelsFor(catalog!.models, workload)) : []).map((model) => ({
      value: model.id,
      text: model.name,
    })),
  ];

  const load = async () => {
    try {
      const [nextStatus, nextRoutes, consent, settlements] = await Promise.all([
        getCloudMlStatus(),
        getMlWorkloadRoutes(),
        getCloudMlConsentHistory(),
        getCloudMlSettlements(),
      ]);
      status = nextStatus;
      routes = nextRoutes.routes;
      history = cloudHistory(consent.records, settlements.items);
      // The catalogue is the cloud's; it is only asked for once the cloud answered.
      catalog = nextStatus.connection === CloudMlConnection.Ready ? await getCloudMlCatalog().catch(() => null) : null;
      loadError = false;
    } catch (error) {
      loadError = true;
      handleError(error, $t('admin.frameleaf_cloud_ml_error_load'));
    }
  };

  onMount(() => {
    void load();
  });

  const run = async (key: string, action: () => Promise<unknown>, failure: string, done?: string) => {
    busy = key;
    try {
      await action();
      await load();
      if (done) {
        notice = done;
      }
    } catch (error) {
      handleError(error, failure);
    } finally {
      busy = null;
    }
  };

  /* ---------------- adding the destination ---------------- */

  let chosen = $state<MlWorkload[]>(cloudWorkloads());
  let budget = $state('');
  let addError = $state<string | null>(null);

  const toggleChosen = (workload: MlWorkload, checked: boolean) => {
    chosen = checked ? [...new Set([...chosen, workload])] : chosen.filter((entry) => entry !== workload);
  };

  const addDestination = async () => {
    const budgetLimitUsd = parseOptionalNumber(budget);
    if (budgetLimitUsd === undefined) {
      addError = $t('admin.frameleaf_ml_destinations_error_limits');
      return;
    }
    if (chosen.length === 0) {
      addError = $t('admin.frameleaf_cloud_ml_add_error_workloads');
      return;
    }
    addError = null;
    await run(
      'add',
      () => createCloudMlDestination({ cloudMlDestinationCreateDto: { workloads: chosen, budgetLimitUsd } }),
      $t('admin.frameleaf_cloud_ml_add_error'),
      $t('admin.frameleaf_cloud_ml_added'),
    );
  };

  /* ---------------- destination actions ---------------- */

  const check = () =>
    destination &&
    run(
      'check',
      () => probeMlDestination({ id: destination.id }),
      $t('admin.frameleaf_ml_destinations_error_probe'),
      $t('admin.frameleaf_cloud_ml_checked'),
    );

  const revoke = () =>
    destination &&
    run(
      'revoke',
      () => revokeMlDestinationConsent({ id: destination.id }),
      $t('admin.frameleaf_ml_destinations_error_consent'),
      $t('admin.frameleaf_cloud_ml_consent_revoked'),
    );

  const refreshWallet = () => run('wallet', () => getCloudMlWallet(), $t('admin.frameleaf_cloud_ml_wallet_error'));

  const settle = () =>
    run(
      'settle',
      () => reconcileCloudMlUsage(),
      $t('admin.frameleaf_cloud_ml_settle_error'),
      $t('admin.frameleaf_cloud_ml_settled'),
    );
</script>

<section class="cloud-ml" aria-labelledby="cloud-ml-heading">
  <header class="head">
    <div>
      <h2 id="cloud-ml-heading">{$t('admin.frameleaf_cloud_ml_title')}</h2>
      <p>{$t('admin.frameleaf_cloud_ml_description')}</p>
    </div>
    <div class="head-actions">
      <a class="link-button" href={Route.systemProcessingDestinations()}>{$t('admin.frameleaf_cloud_ml_routes_link')}</a
      >
      <Button onclick={() => void load()} disabled={busy !== null}>{$t('refresh')}</Button>
    </div>
  </header>

  {#if loadError && !status}
    <p class="message error" role="alert">{$t('admin.frameleaf_cloud_ml_error_load')}</p>
  {:else if !status}
    <p class="message" role="status" aria-busy="true">{$t('loading')}</p>
  {:else}
    {@const help = cloudConnectionHelpKey(status.connection)}
    <div class="state fl-continuous-corners">
      <span class="state-icon"><Icon icon={mdiCloudOutline} size="18" aria-hidden={true} /></span>
      <div>
        <strong>{$t(cloudConnectionLabelKey(status.connection))}</strong>
        <span>
          {status.region
            ? $t('admin.frameleaf_cloud_ml_region', { values: { region: status.region } })
            : $t('admin.frameleaf_cloud_ml_region_unknown')}
          · {status.enabled ? $t('admin.frameleaf_cloud_ml_enabled_on') : $t('admin.frameleaf_cloud_ml_enabled_off')}
        </span>
      </div>
      <span class="state-badge">
        {status.entitled === false
          ? $t('admin.frameleaf_cloud_ml_not_entitled')
          : status.entitled
            ? $t('admin.frameleaf_cloud_ml_entitled')
            : $t('admin.frameleaf_cloud_ml_entitlement_unknown')}
      </span>
    </div>
    {#if help}
      <p class="message">
        <Icon icon={mdiShieldCheckOutline} size="16" aria-hidden={true} />
        {$t(help)}{status.detail ? ` ${status.detail}` : ''}
      </p>
    {/if}
    {#if notice}
      <p class="message" role="status">{notice}</p>
    {/if}

    {#if configToEdit?.frameleafCloud}
      <div class="settings">
        <SettingToggle
          title={$t('admin.frameleaf_cloud_ml_setting_enabled')}
          subtitle={$t('admin.frameleaf_cloud_ml_setting_enabled_description')}
          disabled={configDisabled}
          bind:checked={configToEdit.frameleafCloud.cloudMl.enabled}
          isEdited={configToEdit.frameleafCloud.cloudMl.enabled !== baseline?.frameleafCloud?.cloudMl.enabled}
        />
        <SettingToggle
          title={$t('admin.frameleaf_cloud_ml_setting_descriptions')}
          subtitle={$t('admin.frameleaf_cloud_ml_setting_descriptions_description')}
          disabled={configDisabled || !configToEdit.frameleafCloud.cloudMl.enabled}
          bind:checked={configToEdit.frameleafCloud.cloudMl.descriptions.enabled}
          isEdited={configToEdit.frameleafCloud.cloudMl.descriptions.enabled !==
            baseline?.frameleafCloud?.cloudMl.descriptions.enabled}
        />
        <SettingToggle
          title={$t('admin.frameleaf_cloud_ml_setting_auto_batch')}
          subtitle={$t('admin.frameleaf_cloud_ml_setting_auto_batch_description')}
          disabled={configDisabled ||
            !configToEdit.frameleafCloud.cloudMl.enabled ||
            !configToEdit.frameleafCloud.cloudMl.descriptions.enabled}
          bind:checked={configToEdit.frameleafCloud.cloudMl.descriptions.autoBatch}
          isEdited={configToEdit.frameleafCloud.cloudMl.descriptions.autoBatch !==
            baseline?.frameleafCloud?.cloudMl.descriptions.autoBatch}
        />
        <SettingField
          inputType={SettingInputFieldType.NUMBER}
          label={$t('admin.frameleaf_cloud_ml_setting_daily_budget')}
          description={$t('admin.frameleaf_cloud_ml_setting_daily_budget_description')}
          min={0}
          step="0.01"
          disabled={configDisabled || !configToEdit.frameleafCloud.cloudMl.enabled}
          bind:value={configToEdit.frameleafCloud.cloudMl.descriptions.dailyBudgetUsd}
          isEdited={configToEdit.frameleafCloud.cloudMl.descriptions.dailyBudgetUsd !==
            baseline?.frameleafCloud?.cloudMl.descriptions.dailyBudgetUsd}
        />
        {#if catalog}
          <SettingSelect
            label={$t('admin.frameleaf_cloud_ml_setting_descriptions_model')}
            desc={$t('admin.frameleaf_cloud_ml_setting_descriptions_model_description')}
            name="cloud-ml-descriptions-model"
            options={defaultModelOptions([MlWorkload.Enrichment])}
            disabled={configDisabled || !configToEdit.frameleafCloud.cloudMl.enabled}
            bind:value={configToEdit.frameleafCloud.cloudMl.descriptions.defaultModel}
            isEdited={configToEdit.frameleafCloud.cloudMl.descriptions.defaultModel !==
              baseline?.frameleafCloud?.cloudMl.descriptions.defaultModel}
          />
        {/if}
        <SettingToggle
          title={$t('admin.frameleaf_cloud_ml_setting_restoration')}
          subtitle={$t('admin.frameleaf_cloud_ml_setting_restoration_description')}
          disabled={configDisabled || !configToEdit.frameleafCloud.cloudMl.enabled}
          bind:checked={configToEdit.frameleafCloud.cloudMl.restoration.enabled}
          isEdited={configToEdit.frameleafCloud.cloudMl.restoration.enabled !==
            baseline?.frameleafCloud?.cloudMl.restoration.enabled}
        />
        {#if catalog}
          <SettingSelect
            label={$t('admin.frameleaf_cloud_ml_setting_restoration_model')}
            desc={$t('admin.frameleaf_cloud_ml_setting_restoration_model_description')}
            name="cloud-ml-restoration-model"
            options={defaultModelOptions([
              MlWorkload.RestorationFaithful,
              MlWorkload.RestorationCreative,
              MlWorkload.Upscale,
            ])}
            disabled={configDisabled || !configToEdit.frameleafCloud.cloudMl.enabled}
            bind:value={configToEdit.frameleafCloud.cloudMl.restoration.defaultModel}
            isEdited={configToEdit.frameleafCloud.cloudMl.restoration.defaultModel !==
              baseline?.frameleafCloud?.cloudMl.restoration.defaultModel}
          />
        {/if}
        <p class="policy">{$t('admin.frameleaf_cloud_ml_faces_policy')}</p>
        <SettingActions keys={['frameleafCloud']} disabled={configDisabled} />
      </div>
    {/if}

    <div class="grid">
      <article class="card fl-continuous-corners" aria-labelledby="cloud-ml-destination-heading">
        <h3 id="cloud-ml-destination-heading">{$t('admin.frameleaf_cloud_ml_destination_title')}</h3>
        {#if !destination}
          <p>{$t('admin.frameleaf_cloud_ml_add_description')}</p>
          <fieldset disabled={!ready || busy !== null}>
            <legend>{$t('admin.frameleaf_ml_destinations_allowed_workloads')}</legend>
            {#each cloudWorkloads() as workload (workload)}
              <label class="check">
                <input
                  type="checkbox"
                  checked={chosen.includes(workload)}
                  onchange={(event) => toggleChosen(workload, event.currentTarget.checked)}
                />
                {$t(mlWorkloadLabelKey(workload))}
              </label>
            {/each}
          </fieldset>
          <label class="field">
            {$t('admin.frameleaf_ml_destinations_budget_limit')}
            <input type="number" min="0" step="0.01" bind:value={budget} inputmode="decimal" disabled={!ready} />
          </label>
          {#if addError}
            <p class="error" role="alert">{addError}</p>
          {/if}
          <div class="buttons">
            <Button variant="primary" onclick={addDestination} disabled={!ready || busy !== null}>
              {$t('admin.frameleaf_cloud_ml_add')}
            </Button>
          </div>
          {#if !ready}
            <p class="muted">{$t('admin.frameleaf_cloud_ml_add_needs_link')}</p>
          {/if}
        {:else}
          <dl class="facts">
            <div>
              <dt>{$t('admin.frameleaf_ml_destinations_consent')}</dt>
              <dd>
                {#if status.consent?.outdated}
                  {$t('admin.frameleaf_cloud_ml_consent_state_outdated', {
                    values: { version: status.consent.acceptedVersion ?? '' },
                  })}
                {:else if destination.consent.acknowledgedAt}
                  {$t('admin.frameleaf_cloud_ml_consent_state_recorded', {
                    values: {
                      version: destination.consent.version ?? '',
                      date: formatDateTime(destination.consent.acknowledgedAt, $locale),
                    },
                  })}
                {:else}
                  {$t('admin.frameleaf_ml_destinations_consent_needed')}
                {/if}
              </dd>
            </div>
            <div>
              <dt>{$t('admin.frameleaf_ml_destinations_budget')}</dt>
              <dd>
                {destination.costControls.budgetLimitUsd === null
                  ? $t('admin.frameleaf_ml_destinations_no_limit')
                  : $t('admin.frameleaf_ml_destinations_budget_spent', {
                      values: {
                        spent: formatUsd(destination.costControls.spentUsd, $locale),
                        limit: formatUsd(destination.costControls.budgetLimitUsd, $locale),
                        days: destination.costControls.budgetWindowDays,
                      },
                    })}
              </dd>
            </div>
            <div>
              <dt>{$t('admin.frameleaf_ml_destinations_last_probe')}</dt>
              <dd>
                {destination.health.probedAt
                  ? formatDateTime(destination.health.probedAt, $locale)
                  : $t('admin.frameleaf_ml_destinations_never_probed')}
              </dd>
            </div>
            {#if destination.cloud?.refusal}
              <div>
                <dt>{$t('admin.frameleaf_cloud_ml_last_refusal')}</dt>
                <dd>{$t(mlRefusalLabelKey(destination.cloud.refusal))}</dd>
              </div>
            {/if}
            <div>
              <dt>{$t('admin.frameleaf_ml_destinations_allowed_workloads')}</dt>
              <dd>{destination.workloads.map((workload) => $t(mlWorkloadLabelKey(workload))).join(', ')}</dd>
            </div>
          </dl>
          {#if consentNeeded}
            <p class="warning" role="status">{$t('admin.frameleaf_cloud_ml_consent_needed')}</p>
          {/if}
          <div class="buttons">
            {#if status.consent}
              <Button
                variant={consentNeeded ? 'primary' : 'default'}
                onclick={() => (consentOpen = true)}
                disabled={busy !== null}
              >
                {consentNeeded
                  ? $t('admin.frameleaf_cloud_ml_consent_review')
                  : $t('admin.frameleaf_cloud_ml_consent_review_again')}
              </Button>
            {/if}
            {#if destination.consent.acknowledgedAt}
              <Button onclick={() => void revoke()} disabled={busy !== null}>
                {$t('admin.frameleaf_ml_destinations_revoke_consent')}
              </Button>
            {/if}
            <Button onclick={() => void check()} disabled={busy !== null}>
              {busy === 'check'
                ? $t('admin.frameleaf_ml_destinations_probing')
                : $t('admin.frameleaf_ml_destinations_probe')}
            </Button>
          </div>
          {#if !status.consent && !ready}
            <p class="muted">{$t('admin.frameleaf_cloud_ml_consent_needs_cloud')}</p>
          {/if}
        {/if}
      </article>

      <CloudMlWalletCard
        wallet={status.wallet}
        onRefresh={ready ? () => void refreshWallet() : undefined}
        busy={busy !== null}
      />
    </div>

    {#if destination}
      <article class="card models fl-continuous-corners" aria-labelledby="cloud-ml-models-heading">
        <h3 id="cloud-ml-models-heading">{$t('admin.frameleaf_cloud_ml_models_title')}</h3>
        <p>{$t('admin.frameleaf_cloud_ml_models_description')}</p>
        {#if !catalog}
          <p class="muted">{$t('admin.frameleaf_cloud_ml_models_unavailable')}</p>
        {:else if routedWorkloads.length === 0}
          <p class="muted">{$t('admin.frameleaf_cloud_ml_models_none_routed')}</p>
        {:else}
          {#each routedWorkloads as workload (workload)}
            <CloudMlModelPicker
              {workload}
              destinationId={destination.id}
              models={catalog.models}
              route={routes.find((route) => route.workload === workload)}
              disabled={busy !== null}
              onChanged={() => void load()}
            />
          {/each}
        {/if}
      </article>

      {#if status.consent}
        <CloudMlConsentDialog
          bind:open={consentOpen}
          destinationId={destination.id}
          consent={status.consent}
          onRecorded={() => {
            notice = $t('admin.frameleaf_cloud_ml_consent_recorded');
            void load();
          }}
        />
      {/if}
    {/if}

    <details class="history">
      <summary>
        <Icon icon={mdiHistory} size="16" aria-hidden={true} />
        {$t('admin.frameleaf_cloud_ml_history_title')} <span>{history.length}</span>
      </summary>
      {#if destination}
        <div class="buttons">
          <Button onclick={() => void settle()} disabled={!ready || busy !== null}>
            {$t('admin.frameleaf_cloud_ml_settle')}
          </Button>
        </div>
      {/if}
      {#if history.length === 0}
        <p>{$t('admin.frameleaf_cloud_ml_history_empty')}</p>
      {:else}
        <ol>
          {#each history as entry, index (`${entry.kind}-${entry.at}-${index}`)}
            <li>
              <div>
                {#if entry.kind === 'consent'}
                  <strong
                    >{$t('admin.frameleaf_cloud_ml_history_consent', { values: { version: entry.version } })}</strong
                  >
                  <span>
                    {[
                      entry.features.identityNames && $t('admin.frameleaf_cloud_ml_consent_feature_names'),
                      entry.features.medicalSignals && $t('admin.frameleaf_cloud_ml_consent_feature_medical'),
                      entry.features.ocrAddon && $t('admin.frameleaf_cloud_ml_consent_feature_ocr'),
                    ]
                      .filter(Boolean)
                      .join(', ') || $t('admin.frameleaf_cloud_ml_history_no_features')}
                  </span>
                {:else if entry.kind === 'revoked'}
                  <strong
                    >{$t('admin.frameleaf_cloud_ml_history_revoked', { values: { version: entry.version } })}</strong
                  >
                {:else}
                  <strong>
                    {$t('admin.frameleaf_cloud_ml_history_settlement', {
                      values: {
                        workload: $t(mlWorkloadLabelKey(entry.workload)),
                        cost: formatUsd(entry.costUsd, $locale),
                      },
                    })}
                  </strong>
                  <span>
                    {entry.succeeded
                      ? $t('admin.frameleaf_cloud_ml_history_settlement_succeeded')
                      : $t('admin.frameleaf_cloud_ml_history_settlement_failed')}
                  </span>
                {/if}
              </div>
              <time datetime={entry.at}>{formatDateTime(entry.at, $locale)}</time>
            </li>
          {/each}
        </ol>
      {/if}
    </details>
  {/if}
</section>

<style>
  .cloud-ml {
    display: flex;
    flex-direction: column;
    gap: 14px;
    min-width: 0;
  }
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
  }
  .head h2 {
    font-size: var(--fl-font-size);
    margin: 0 0 0.25rem;
  }
  .head p,
  .card p,
  .muted {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .head-actions,
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: 7px;
    align-items: center;
  }
  .buttons {
    margin-top: 14px;
  }
  .link-button {
    font-size: var(--fl-font-small);
    color: var(--fl-accent);
  }
  /* jobs-manager.css:770-794 `.jm-provider-state`. */
  .state {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 15px 17px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .state > div {
    flex: 1;
    min-width: 0;
  }
  .state strong,
  .state > div > span {
    display: block;
  }
  .state > div > span,
  .state-badge {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    margin-top: 2px;
  }
  .state-icon {
    display: inline-flex;
    color: var(--fl-muted);
  }
  /* jobs-manager.css:441-468 `.jm-message`. */
  .message {
    display: flex;
    gap: 8px;
    align-items: center;
    padding: 11px 13px;
    margin: 0;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font-size: var(--fl-font-small);
    background: var(--fl-panel);
    color: var(--fl-muted);
  }
  .message.error,
  .error {
    color: var(--fl-danger);
  }
  .warning {
    margin: 12px 0 0;
    color: var(--fl-warning);
    font-size: var(--fl-font-small);
  }
  .settings {
    display: grid;
    gap: 4px;
  }
  .policy {
    margin: 4px 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  /* jobs-manager.css:795-818 `.jm-provider-grid`. */
  .grid {
    display: grid;
    grid-template-columns: 1.1fr 1fr;
    gap: 18px;
  }
  @media (width < 1100px) {
    .grid {
      grid-template-columns: 1fr;
    }
  }
  .card {
    padding: 18px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    min-width: 0;
  }
  .card h3 {
    font-size: var(--fl-font-size);
    margin: 0 0 16px;
  }
  fieldset {
    margin: 12px 0 0;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 0.625rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
    font-size: var(--fl-font-small);
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .field {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-top: 12px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .field input {
    width: 100%;
    padding: 0.4375rem 0.625rem;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-muted);
    border-radius: var(--fl-radius-control);
  }
  /* jobs-manager.css:855-872 `.jm-capabilities`. */
  .facts {
    margin: 0;
    font-size: var(--fl-font-small);
  }
  .facts > div {
    display: grid;
    grid-template-columns: 1fr 1.25fr;
    gap: 14px;
    padding: 10px 0;
    border-bottom: 1px solid var(--fl-border);
  }
  .facts dt {
    color: var(--fl-muted);
  }
  .facts dd {
    margin: 0;
    text-align: right;
    overflow-wrap: anywhere;
  }
  .models p {
    margin-bottom: 8px;
  }
  /* jobs-manager.css:469-518 `.jm-history`. */
  .history {
    border-top: 1px solid var(--fl-border);
    padding-top: 15px;
  }
  .history summary {
    cursor: pointer;
    display: flex;
    align-items: center;
    gap: 8px;
    font-weight: 550;
  }
  .history summary > span {
    font-size: var(--fl-font-micro);
    background: var(--fl-panel);
    padding: 1px 5px;
    border-radius: 3px;
  }
  .history > p {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .history ol {
    padding: 0;
    list-style: none;
  }
  .history li {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 15px;
    padding: 10px 0;
    border-bottom: 1px solid var(--fl-border);
  }
  .history li strong {
    display: block;
    font-size: var(--fl-font-small);
    font-weight: 500;
  }
  .history li span,
  .history time {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
  }
  .history time {
    white-space: nowrap;
  }
  @supports (corner-shape: squircle) {
    .state,
    .card {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
</style>
