<script lang="ts">
  /**
   * The model slider of Visual search and Faces & identity: this server's models for that work, banded by
   * the stored Hardware & GPU check, with a blue stop right after each one the live Frameleaf Cloud
   * catalogue says it runs. A saved model outside the list selects no stop and is said back in
   * `customNote`.
   *
   * Frameleaf Cloud runs only a model this server has set, so a blue stop sets the local model it runs
   * (`onChange` is never given an `@cloud` id) and routes the work to the Frameleaf Cloud destination; a
   * local stop while routed there moves it back. Which of the two a stop is depends on the route, so the
   * stop shown is the model and the route together, and the route is saved at once, like Where work runs.
   * A blue stop while Cloud isn't ready writes nothing until the set-up sheet finishes.
   */
  import ModelSlider from '$lib/components/frameleaf/cloud/ModelSlider.svelte';
  import { cloudConsentNeeded, workerFromHardware, workerGpu } from '$lib/frameleaf/cloud-ml';
  import { cloudTwinsOf, loadCloudModelData } from '$lib/frameleaf/cloud-models';
  import {
    CLOUD_MATCH,
    genericCloudStop,
    GENERIC_CLOUD_STOP,
    localTwinId,
    type MatchedWorkload,
    type PositionState,
  } from '$lib/frameleaf/gpu-model-catalog';
  import type { CloudConsentFeature } from '$lib/frameleaf/cloud-rules';
  import { canRouteTo } from '$lib/frameleaf/ml-destinations';
  import { homePlaces } from '$lib/frameleaf/work-routes';
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { toastManager } from '@frameleaf/ui';
  import {
    CloudMlConnection,
    getCloudMlStatus,
    getHardwareCheck,
    getMlWorkloadRoutes,
    listMlDestinations,
    MlDestinationKind,
    MlWorkload,
    setMlWorkloadProcessingOrder,
    setMlWorkloadRoute,
    type CloudMlModelDto,
    type CloudMlStatusResponseDto,
    type HardwareCheckResponseDto,
    type MlDestinationResponseDto,
    type MlWorkloadRouteDto,
  } from '@frameleaf/sdk';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    workload: MatchedWorkload;
    /** The model name in the settings draft. */
    value: string;
    /** The saved model name: when the model returns to it, unsaved, the route goes back too. */
    saved: string;
    label: string;
    disabled?: boolean;
    customNote?: string;
    onChange: (model: string) => void;
    /** A blue stop was picked and Frameleaf Cloud isn't ready to take this work yet; `onDone` means it is now. */
    onNeedsCloud?: (setup: { consentFeature: CloudConsentFeature; onDone?: () => void }) => void;
  };

  let { workload, value, saved, label, disabled = false, customNote, onChange, onNeedsCloud }: Props = $props();

  const mlWorkload = $derived(CLOUD_MATCH[workload] === 'clip' ? MlWorkload.Clip : MlWorkload.Face);
  /** FL-455: search and faces each need their own consent, or Frameleaf Cloud refuses every batch. */
  const consentFeature = $derived<CloudConsentFeature>(
    CLOUD_MATCH[workload] === 'clip' ? 'smartSearch' : 'faceRecognition',
  );

  let hardware = $state<HardwareCheckResponseDto | null>(null);
  let status = $state<CloudMlStatusResponseDto | null>(null);
  let catalog = $state<CloudMlModelDto[] | null>(null);
  let catalogFailed = $state(false);
  let destinations = $state<MlDestinationResponseDto[]>([]);
  let routes = $state<MlWorkloadRouteDto[]>([]);

  const read = async <T,>(answer: () => Promise<T>): Promise<T | null> => {
    try {
      return await answer();
    } catch {
      return null;
    }
  };

  const readRoutes = async () => (await read(getMlWorkloadRoutes))?.routes ?? routes;

  const load = async () => {
    [hardware, status, destinations, routes] = await Promise.all([
      read(getHardwareCheck),
      read(getCloudMlStatus),
      (async () => (await read(listMlDestinations)) ?? [])(),
      readRoutes(),
    ]);
    const models = await loadCloudModelData(status);
    catalog = models.catalog;
    catalogFailed = models.catalogFailed;
  };

  onMount(() => void load());

  // The set-up sheet finished: Frameleaf Cloud's list and state can be read now.
  let setupsSeen = getCloudManager.setups;
  $effect(() => {
    if (getCloudManager.setups !== setupsSeen) {
      setupsSeen = getCloudManager.setups;
      void load();
    }
  });

  const worker = $derived(workerFromHardware(hardware));
  const twins = $derived(cloudTwinsOf(catalog, mlWorkload));
  const cloudDestination = $derived(
    destinations.find(
      (destination) => destination.kind === MlDestinationKind.FrameleafCloud && canRouteTo(destination, mlWorkload),
    ),
  );
  const routedToCloud = $derived.by(() => {
    const id = routes.find((route) => route.workload === mlWorkload)?.destinationId;
    return destinations.find((destination) => destination.id === id)?.kind === MlDestinationKind.FrameleafCloud;
  });

  /** The stop shown: the model on Frameleaf Cloud when the work is routed there and the catalogue lists it. */
  const selected = $derived(
    routedToCloud && twins.some((twin) => twin.localModel === value) ? `${value}@cloud` : value,
  );

  const linked = $derived(
    !!status &&
      status.connection !== CloudMlConnection.NotLinked &&
      status.connection !== CloudMlConnection.NotConfigured,
  );

  const cloudReady = $derived(
    status?.connection === CloudMlConnection.Ready &&
      status.enabled &&
      !cloudConsentNeeded(status) &&
      status.consent?.features[consentFeature] === true,
  );
  /** Frameleaf Cloud's list can't be read yet, so one blue stop stands for it. */
  const placeholderStops = $derived(
    status && !linked ? [genericCloudStop(workload, $t('frameleaf_enhance_model_cloud'))] : undefined,
  );

  const pinRoute = async (destinationId: string | null) => {
    ({ routes } = await setMlWorkloadRoute({ workload: mlWorkload, mlWorkloadRouteUpdateDto: { destinationId } }));
  };

  const followOrder = async () => {
    await setMlWorkloadProcessingOrder({
      workload: mlWorkload,
      mlWorkloadProcessingOrderUpdateDto: { sources: null },
    });
    routes = await readRoutes();
  };

  /** Moves the route to Frameleaf Cloud (true) or back to the processing order (false). */
  const writeRoute = async (toCloud: boolean) => {
    if (toCloud) {
      if (cloudDestination) {
        await pinRoute(cloudDestination.id);
      }
      return;
    }
    await followOrder();
    // A local stop must not keep billing because the main order puts Frameleaf Cloud first.
    const home = routedToCloud ? homePlaces(mlWorkload, { destinations })[0] : undefined;
    if (home) {
      await pinRoute(home.id);
    }
  };

  type RouteState = { followsOrder: boolean; destinationId: string | null };

  const routeNow = (): RouteState => {
    const route = routes.find((item) => item.workload === mlWorkload);
    return { followsOrder: route?.followsOrder !== false, destinationId: route?.destinationId ?? null };
  };

  /** The route when the model left its saved value; it comes back when the model does, unsaved. */
  let routeWhenSaved: RouteState | null = null;

  /** A second pick during a move is ignored: the radios go back to what is really saved. */
  let moving = false;

  const applyStop = async (model: string, toCloud: boolean) => {
    if (moving) {
      return;
    }
    moving = true;
    try {
      if (value === saved && model !== value) {
        routeWhenSaved = routeNow();
      } else if (toCloud && model === saved) {
        // Back to the saved model, on Frameleaf Cloud on purpose: there is nothing to put back.
        routeWhenSaved = null;
      }
      if (toCloud !== routedToCloud) {
        await writeRoute(toCloud);
      }
      if (model !== value) {
        onChange(model);
      }
    } catch (error) {
      handleError(error, $t('frameleaf_model_route_failed'));
    } finally {
      moving = false;
    }
  };

  /** Set-up finished, so the stop that was waiting for it can take effect. */
  const applyAfterSetup = async (model: string) => {
    await load();
    if (cloudReady && (routedToCloud || cloudDestination)) {
      await applyStop(model, true);
    } else {
      toastManager.warning($t('frameleaf_model_route_failed'));
    }
  };

  const pick = async (id: string, stop: PositionState) => {
    if (moving) {
      return;
    }
    if (id === GENERIC_CLOUD_STOP) {
      onNeedsCloud?.({ consentFeature });
      return;
    }
    const model = localTwinId(id);
    const toCloud = stop.runsOn === 'cloud';
    if (toCloud && (!cloudReady || (!routedToCloud && !cloudDestination))) {
      onNeedsCloud?.({ consentFeature, onDone: () => void applyAfterSetup(model) });
      return;
    }
    await applyStop(model, toCloud);
  };

  const restoreRoute = async () => {
    const prior = routeWhenSaved;
    routeWhenSaved = null;
    const now = routeNow();
    if (
      !prior ||
      (prior.followsOrder === now.followsOrder && (prior.followsOrder || prior.destinationId === now.destinationId))
    ) {
      return;
    }
    moving = true;
    try {
      await (prior.followsOrder ? followOrder() : pinRoute(prior.destinationId));
    } catch (error) {
      handleError(error, $t('frameleaf_model_route_failed'));
    } finally {
      moving = false;
    }
  };

  // Undo or Discard put the model back, so the route goes back with it. A save moves `saved` to the model
  // instead, and then the route stays where the person put it.
  let savedSeen = untrack(() => saved);
  $effect(() => {
    const [model, baseline] = [value, saved];
    untrack(() => {
      if (baseline !== savedSeen) {
        savedSeen = baseline;
        routeWhenSaved = null;
      } else if (model === baseline && routeWhenSaved) {
        void restoreRoute();
      }
    });
  });
</script>

<div class="model-row">
  <ModelSlider
    {workload}
    value={selected}
    {label}
    {disabled}
    {customNote}
    {twins}
    cloudStops={placeholderStops}
    tiered
    gpu={workerGpu(worker, workload)}
    cpuProfile={worker.cpuProfile}
    route="both"
    onChange={(id, stop) => void pick(id, stop)}
  />
  {#if catalogFailed}
    <p class="ms-note" role="status">{$t('admin.frameleaf_cloud_model_catalog_error')}</p>
  {:else if status && !linked}
    <p class="ms-note" role="status">{$t('frameleaf_model_cloud_needs_link')}</p>
  {/if}
</div>

<style>
  /* Sits among the page's kit rows, so it takes their rule and padding. */
  .model-row {
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
</style>
