<script lang="ts">
  /**
   * The model sliders a feature page shows: it reads what they need once (the Cloud status, its catalogue
   * and choices, the Hardware & GPU check and what connected computers report) and draws one set of
   * sliders per kind of work.
   *
   * Blue stops are offered whatever Where work runs says, because that is only a preference. Frameleaf
   * Cloud's list can't be read without a linked server, so then the page says so in one line rather than
   * hide the section. Whatever sets Frameleaf Cloud up is the page's: `onNeedsCloud`.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import WorkloadModelPickers from '$lib/components/frameleaf/cloud/WorkloadModelPickers.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import { cloudConsentNeeded, type RoutedWorkload } from '$lib/frameleaf/cloud-ml';
  import { choicesByGroup, loadCloudModelData, type CloudModelData } from '$lib/frameleaf/cloud-models';
  import { getCloudManager } from '$lib/managers/get-cloud-manager.svelte';
  import {
    CloudMlConnection,
    getCloudMlStatus,
    getHardwareCheck,
    getMlDestinationRestorationModels,
    listMlDestinations,
    MlDestinationKind,
    MlWorkload,
    type CloudMlStatusResponseDto,
    type HardwareCheckResponseDto,
    type MlRestorationModelsResponseDto,
  } from '@frameleaf/sdk';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    rows: { row: RoutedWorkload; legend?: string }[];
    /** A person picked a blue model, or asked to, and Frameleaf Cloud isn't set up: open whatever does. */
    onNeedsCloud?: () => void;
  };

  let { rows, onNeedsCloud }: Props = $props();

  const HOME_WORK = new Set<MlWorkload>([
    MlWorkload.RestorationFaithful,
    MlWorkload.RestorationCreative,
    MlWorkload.Interpolation,
  ]);

  let status = $state<CloudMlStatusResponseDto | null>(null);
  let models = $state<CloudModelData>({ catalog: null, catalogFailed: false, choices: {} });
  let hardware = $state<HardwareCheckResponseDto | null>(null);
  let homeReports = $state<MlRestorationModelsResponseDto[]>([]);
  let loaded = $state(false);
  let notice = $state('');

  const read = async <T,>(answer: () => Promise<T>): Promise<T | null> => {
    try {
      return await answer();
    } catch {
      return null;
    }
  };

  /** What the computers that may do this work report, without an asset. One that doesn't answer adds nothing. */
  const readHomeReports = async () => {
    const places = (await read(listMlDestinations)) ?? [];
    const computers = places.filter(
      (place) =>
        place.kind !== MlDestinationKind.FrameleafCloud &&
        place.enabled &&
        place.workloads.some((workload) => HOME_WORK.has(workload)),
    );
    const reports = await Promise.all(
      computers.map((computer) => read(() => getMlDestinationRestorationModels({ id: computer.id }))),
    );
    return reports.filter((report) => report !== null);
  };

  const load = async () => {
    const readsHome = rows.some(({ row }) => row === 'restoration' || row === 'interpolation');
    const [nextStatus, nextHardware, nextReports] = await Promise.all([
      read(getCloudMlStatus),
      read(getHardwareCheck),
      readsHome ? readHomeReports() : [],
    ]);
    status = nextStatus;
    hardware = nextHardware;
    homeReports = nextReports;
    models = await loadCloudModelData(nextStatus);
    loaded = true;
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

  const linked = $derived(
    !!status &&
      status.connection !== CloudMlConnection.NotLinked &&
      status.connection !== CloudMlConnection.NotConfigured,
  );
  const cloudSetUp = $derived(
    status?.connection === CloudMlConnection.Ready && status.enabled && !cloudConsentNeeded(status),
  );
</script>

<Said message={notice} onDismiss={() => (notice = '')} />
{#each rows as { row, legend } (row)}
  <WorkloadModelPickers
    {row}
    route="both"
    {legend}
    {hardware}
    catalog={models.catalog}
    catalogFailed={false}
    choices={models.choices}
    {homeReports}
    cloudPlaceholder={loaded && !!status && !linked}
    {cloudSetUp}
    {onNeedsCloud}
    onSaved={(choices, message) => {
      models = { ...models, choices: choicesByGroup(choices) };
      notice = message;
    }}
  />
{/each}
{#if loaded && !linked}
  <p class="cloud-line" role="status">
    {status ? $t('frameleaf_model_cloud_needs_link') : $t('admin.frameleaf_cloud_model_catalog_error')}
    {#if status && onNeedsCloud}
      <Button onclick={onNeedsCloud}>{$t('frameleaf_model_cloud_set_up')}</Button>
    {/if}
  </p>
{:else if models.catalogFailed}
  <p class="cloud-line" role="status">{$t('admin.frameleaf_cloud_model_catalog_error')}</p>
{/if}

<style>
  .cloud-line {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3);
    margin: var(--fl-space-3) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
