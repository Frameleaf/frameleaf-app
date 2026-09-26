<script lang="ts">
  /**
   * Compute & jobs → Where each job runs (FL-159, handoff §3.2; prototype WorkloadRouting.jsx): for
   * every kind of work that uses the ML service, this server, Frameleaf Cloud or both. "Both" means
   * each job lets the person pick, preselecting "When a job can run in both places, start with"; a
   * job never moves to the cloud on its own. Search, faces and text recognition stay on this server,
   * and Studio exports render at home. The cloud options stay disabled until this server is linked
   * and cloud processing is on.
   *
   * Where work runs is a setting (`frameleafCloud.cloudMl.routing`, `startWith`) saved with the settings
   * bar like every other setting. Each kind of work allowed on Frameleaf Cloud has the Frameleaf Cloud
   * model picker (FL-186): the models come from the cloud's catalogue and a choice is saved on the
   * workload's route at once, since that route is what admission reads.
   */
  import './frameleaf-cloud.css';
  import CloudRouteModels from '$lib/components/frameleaf/cloud/CloudRouteModels.svelte';
  import {
    isRoutedWorkload,
    localCapability,
    localGbNeeded,
    mlWorkloads,
    routeSummary,
    routingModes,
    workerFromHardware,
    workloadNameKey,
    workloadRoute,
    workloadUseKey,
    workloadWhyKey,
  } from '$lib/frameleaf/cloud-ml';
  import { loadCloudModelData, type CloudModelData } from '$lib/frameleaf/cloud-models';
  import type { RouteMode } from '$lib/frameleaf/gpu-model-catalog';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import {
    CloudMlConnection,
    CloudRouteMode,
    getCloudMlStatus,
    getHardwareCheck,
    type CloudMlStatusResponseDto,
    type HardwareCheckResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAlertOutline, mdiCheckCircleOutline, mdiExpansionCard, mdiSourceBranch } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    /** The Cloud processing page shows the models in its own Models card. */
    showModels?: boolean;
  };

  let { showModels = true }: Props = $props();

  let status = $state<CloudMlStatusResponseDto | null>(null);
  let hardware = $state<HardwareCheckResponseDto | null>(null);
  let models = $state<CloudModelData>({ catalog: null, catalogFailed: false, routes: [] });
  let notice = $state('');

  onMount(() => {
    void getCloudMlStatus()
      .then((next) => (status = next))
      .catch(() => (status = null))
      .then(async () => {
        if (showModels) {
          models = await loadCloudModelData(status);
        }
      });
    void getHardwareCheck()
      .then((next) => (hardware = next))
      .catch(() => (hardware = null));
  });

  const settingsDraft = getSystemConfigDraft();
  const cloudMl = $derived(settingsDraft?.draft.frameleafCloud?.cloudMl);
  const disabled = $derived(featureFlagsManager.value.configFile);

  const linked = $derived(
    !!status &&
      status.connection !== CloudMlConnection.NotLinked &&
      status.connection !== CloudMlConnection.NotConfigured,
  );
  const cloudOn = $derived(linked && !!cloudMl?.enabled);
  const worker = $derived(workerFromHardware(hardware));

  const setRoute = (id: string, mode: RouteMode) => {
    if (cloudMl && isRoutedWorkload(id)) {
      cloudMl.routing[id] = mode as CloudRouteMode;
    }
  };
</script>

<section class="fc-card fc-routing fl-continuous-corners" aria-labelledby="fc-routing-title">
  <div class="fc-card-title">
    <span class="fc-card-icon"><Icon icon={mdiSourceBranch} size="20" aria-hidden={true} /></span>
    <div>
      <h2 id="fc-routing-title">{$t('admin.frameleaf_routing_title')}</h2>
      <p>{$t('admin.frameleaf_routing_description')}</p>
    </div>
  </div>
  <p class="fc-note">
    <Icon icon={mdiExpansionCard} size="16" aria-hidden={true} />
    {worker.gpu
      ? $t('admin.frameleaf_routing_hardware_gpu', { values: { gpu: worker.gpu.name, memory: worker.gpu.vramGb } })
      : $t('admin.frameleaf_routing_hardware_processor')}
    ·
    <a class="fc-link" href={Route.hardware()}>{$t('admin.frameleaf_routing_hardware_link')}</a>
  </p>
  {#if !cloudOn}
    <p class="fc-muted">
      {linked ? $t('admin.frameleaf_routing_turn_on_first') : $t('admin.frameleaf_routing_link_first')}
      <a class="fc-link" href={Route.cloudMl()}>{$t('admin.frameleaf_routing_open_cloud')}</a>
    </p>
  {/if}
  {#if cloudMl}
    <label class="fc-stack fc-start-with">
      {$t('admin.frameleaf_routing_start_with')}
      <select bind:value={cloudMl.startWith} {disabled}>
        <option value="local">{$t('admin.frameleaf_routing_start_with_local')}</option>
        <option value="cloud">{$t('admin.frameleaf_routing_start_with_cloud')}</option>
      </select>
      <small>{$t('admin.frameleaf_routing_start_with_help')}</small>
    </label>
  {/if}
  {#if notice}
    <p class="fc-muted" role="status">{notice}</p>
  {/if}
  <ul class="fc-routing-list">
    {#each mlWorkloads as row (row.id)}
      {@const route = workloadRoute(cloudMl?.routing, row.id)}
      {@const local = localCapability(row.id, worker)}
      {@const summary = row.cloud ? routeSummary(route, local) : null}
      <li>
        <div class="fc-routing-name">
          <strong>{$t(workloadNameKey(row.id))}</strong>
          <span class="fc-muted">{$t(workloadUseKey(row.id))}</span>
          <span class="fc-routing-local" class:is-ok={local.ok} class:is-short={!local.ok}>
            <Icon icon={local.ok ? mdiCheckCircleOutline : mdiAlertOutline} size="14" aria-hidden={true} />
            {local.ok
              ? $t('admin.frameleaf_routing_runs_here')
              : $t('admin.frameleaf_routing_needs_locally', { values: { gb: localGbNeeded(row.id) } })}
          </span>
        </div>
        <div
          class="fc-segmented"
          role="radiogroup"
          aria-label={$t('admin.frameleaf_routing_where_label', { values: { name: $t(workloadNameKey(row.id)) } })}
        >
          {#each routingModes as mode (mode.id)}
            {@const off = disabled || (mode.id !== 'local' && (!row.cloud || !cloudOn))}
            <button
              type="button"
              role="radio"
              aria-checked={route === mode.id}
              class:is-on={route === mode.id}
              disabled={off}
              title={!row.cloud && mode.id !== 'local' ? $t(workloadWhyKey(row.id)) : undefined}
              onclick={() => setRoute(row.id, mode.id)}
            >
              {$t(mode.labelKey)}
            </button>
          {/each}
        </div>
        <p class="fc-routing-summary" class:is-warning={summary?.tone === 'warning'}>
          {#if summary}
            {summary.local
              ? `${$t(local.key, { values: local.values })} ${$t(summary.key)}`
              : $t(summary.key, { values: summary.values })}
          {:else}
            {$t(workloadWhyKey(row.id))}
          {/if}
        </p>
        {#if showModels && cloudOn && isRoutedWorkload(row.id) && route !== 'local'}
          <div class="fc-routing-models">
            <CloudRouteModels
              row={row.id}
              catalog={models.catalog}
              catalogFailed={models.catalogFailed}
              routes={models.routes}
              cloudDestinationId={status?.destination?.id ?? null}
              onSaved={(routes, message) => {
                models = { ...models, routes };
                notice = message;
              }}
            />
          </div>
        {/if}
      </li>
    {/each}
  </ul>
</section>
