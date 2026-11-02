<script lang="ts">
  import { rovingFocus } from '$lib/frameleaf/roving-focus';
  /**
   * Compute & jobs → Where each job runs (FL-159, handoff §3.2; prototype WorkloadRouting.jsx): for
   * every kind of work that uses the ML service, this server, Frameleaf Cloud or both. "Both" means
   * each job lets the person pick, preselecting "When a job can run in both places, start with"; a
   * job never moves to the cloud on its own. Text recognition stays on this server and Studio exports
   * render at home; search and faces reach Frameleaf Cloud only through their destination route, while
   * it offers this server's own models and their consent is on (FL-455). The cloud options stay disabled until this server is linked
   * and cloud processing is on.
   *
   * Where work runs is a setting (`frameleafCloud.cloudMl.routing`, `startWith`) saved with the settings
   * bar like every other setting. Each kind of work allowed on Frameleaf Cloud has its model sliders
   * (FL-186, FL-189): this server's model where the work has a local model setting (white and green
   * stops, saved with the settings bar), and the Frameleaf Cloud model from the cloud's catalogue once
   * cloud processing is on (blue stops, saved per model group at once, apart from the workload's route,
   * which is what admission reads for every cloud job).
   *
   * FL-455: smart search and faces show their model slider too, for where each model would run: this
   * server's models in white and green, and a blue stop for this server's own model on Frameleaf Cloud
   * only while the cloud offers it (`cloudMatchedWorkloads`: the status's matched work, or the
   * catalogue). It shows the model in use; that model is chosen in Search & intelligence, so the
   * slider here cannot change it. Search text is always read on this server.
   *
   * Search and faces build one index for the library, so they run in one place and never offer "Both"
   * (results from two different models can't be mixed). Their row shows where the index is built now,
   * read from the same destination route Where work runs saves (`work-routes.ts`), and links there.
   */
  import './frameleaf-cloud.css';
  import ModelSlider from '$lib/components/frameleaf/cloud/ModelSlider.svelte';
  import WorkloadModelPickers from '$lib/components/frameleaf/cloud/WorkloadModelPickers.svelte';
  import {
    isIndexWork,
    isRoutedWorkload,
    localCapability,
    localGbNeeded,
    mlWorkloads,
    routeSummary,
    routingModes,
    workerFromHardware,
    workerGpu,
    workloadNameKey,
    workloadRoute,
    workloadUseKey,
    workloadWhyKey,
  } from '$lib/frameleaf/cloud-ml';
  import {
    choicesByGroup,
    cloudMatchedWorkloads,
    loadCloudModelData,
    type CloudModelData,
  } from '$lib/frameleaf/cloud-models';
  import { isMatchedWorkload, ladderFor, type MatchedWorkload, type RouteMode } from '$lib/frameleaf/gpu-model-catalog';
  import { localModelsFor } from '$lib/frameleaf/local-models';
  import { getSystemConfigDraft } from '$lib/frameleaf/system-config-draft.svelte';
  import { CLOUD, currentChoice, ROW_WORKLOAD } from '$lib/frameleaf/work-routes';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Route } from '$lib/route';
  import {
    CloudMlConnection,
    CloudRouteMode,
    getCloudMlStatus,
    getHardwareCheck,
    getMlWorkloadRoutes,
    listMlDestinations,
    type CloudMlStatusResponseDto,
    type HardwareCheckResponseDto,
    type MlDestinationResponseDto,
    type MlWorkloadRouteDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
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
  let models = $state<CloudModelData>({ catalog: null, catalogFailed: false, choices: {} });
  let notice = $state('');
  let destinations = $state<MlDestinationResponseDto[]>([]);
  let routes = $state<MlWorkloadRouteDto[]>([]);
  /** The catalogue was read for the current linked and turned-on state. */
  let modelsRequested = false;
  /** Only the latest read is shown, whatever order the answers arrive in. */
  let modelsLoad = 0;

  onMount(() => {
    void getCloudMlStatus()
      .then((next) => (status = next))
      .catch(() => (status = null));
    void getHardwareCheck()
      .then((next) => (hardware = next))
      .catch(() => (hardware = null));
    void Promise.all([listMlDestinations(), getMlWorkloadRoutes()])
      .then(([places, saved]) => {
        destinations = places ?? [];
        routes = saved?.routes ?? [];
      })
      .catch(() => {});
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
  /** FL-455: search and faces get their blue stop only while Frameleaf Cloud offers this server's models. */
  const cloudMatched = $derived(cloudOn ? cloudMatchedWorkloads(status, models.catalog) : []);
  const machineLearning = $derived(settingsDraft?.draft.machineLearning);
  /** The model search or faces uses, while it is one the slider shows. */
  const matchedModel = (id: MatchedWorkload) => {
    const value = id === 'search' ? machineLearning?.clip?.modelName : machineLearning?.facialRecognition?.modelName;
    return ladderFor(id).some((item) => item.id === value && !item.cloudMatch) ? value : null;
  };

  // FL-186: read the chosen models and the catalogue once cloud processing is linked and turned on,
  // including when it is turned on on this page, and again the next time after it was turned off.
  $effect(() => {
    if (!showModels || !cloudOn) {
      modelsRequested = false;
      modelsLoad += 1;
      return;
    }
    if (modelsRequested) {
      return;
    }
    modelsRequested = true;
    modelsLoad += 1;
    const load = modelsLoad;
    void loadCloudModelData(status).then((next) => {
      if (load === modelsLoad) {
        models = next;
      }
    });
  });

  /** Search or faces: built on Frameleaf Cloud when its destination route says so, else at home. */
  const indexRoute = (id: 'search' | 'faces'): RouteMode =>
    currentChoice(id, { destinations, routes, cloudRouting: cloudMl?.routing, cloudOn }) === CLOUD ? 'cloud' : 'local';
  /** The places a row can really use: search and faces never "Both", and Frameleaf Cloud only once it offers them. */
  const modesFor = (id: string, route: RouteMode) =>
    isIndexWork(id)
      ? routingModes.filter(
          (mode) =>
            mode.id === 'local' ||
            (mode.id === 'cloud' &&
              (route === 'cloud' || cloudMatched.includes(ROW_WORKLOAD[id as 'search' | 'faces']))),
        )
      : routingModes;

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
    {worker.gpu?.integrated
      ? $t('admin.frameleaf_routing_hardware_integrated', { values: { gpu: worker.gpu.name } })
      : worker.gpu
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
      {@const index = isIndexWork(row.id)}
      {@const route = index ? indexRoute(row.id as 'search' | 'faces') : workloadRoute(cloudMl?.routing, row.id)}
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
          use:rovingFocus
          aria-label={$t('admin.frameleaf_routing_where_label', { values: { name: $t(workloadNameKey(row.id)) } })}
        >
          {#each modesFor(row.id, route) as mode (mode.id)}
            <!-- Search and faces are chosen in Where work runs, where their one place is saved. -->
            {@const off = index || disabled || (mode.id !== 'local' && (!row.cloud || !cloudOn))}
            <button
              type="button"
              role="radio"
              aria-checked={route === mode.id}
              class:is-on={route === mode.id}
              disabled={off}
              title={!index && !row.cloud && mode.id !== 'local' ? $t(workloadWhyKey(row.id)) : undefined}
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
        {#if index}
          <p class="fc-routing-summary">
            {$t('frameleaf_index_one_place')}
            <a class="fc-link" href={Route.systemProcessingDestinations()}
              >{$t('admin.frameleaf_routing_change_index')}</a
            >
          </p>
        {/if}
        {#if showModels && isMatchedWorkload(row.id) && matchedModel(row.id)}
          {@const workload = row.id as MatchedWorkload}
          <div class="fc-routing-models">
            <ModelSlider
              {workload}
              value={matchedModel(workload)}
              gpu={workerGpu(worker, workload)}
              cpuProfile={worker.cpuProfile}
              route="both"
              {cloudMatched}
              label={$t('admin.frameleaf_model_for', {
                values: { name: $t(workloadNameKey(workload)).toLocaleLowerCase() },
              })}
              disabled
            />
            <p class="fc-routing-summary">{$t('admin.frameleaf_routing_same_model_note')}</p>
          </div>
        {/if}
        {#if showModels && isRoutedWorkload(row.id) && (cloudOn || localModelsFor(row.id).length > 0)}
          <div class="fc-routing-models">
            <WorkloadModelPickers
              row={row.id}
              {route}
              {hardware}
              catalog={cloudOn ? models.catalog : null}
              catalogFailed={cloudOn && models.catalogFailed}
              choices={models.choices}
              onSaved={(choices, message) => {
                models = { ...models, choices: choicesByGroup(choices) };
                notice = message;
              }}
            />
          </div>
        {/if}
      </li>
    {/each}
  </ul>
</section>
