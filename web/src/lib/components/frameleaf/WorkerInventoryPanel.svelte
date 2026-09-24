<script lang="ts">
  /**
   * Workers & endpoints (FL-72), the prototype's "Workers & endpoints" section of Compute & jobs.
   *
   * Everything shown is the server's worker inventory: each endpoint's last check (never a
   * guess), what it may run, what it said it serves, where library work is routed, what
   * admission would answer and how busy it is. "Check capabilities" is a real probe of exactly
   * that endpoint. The machine-learning URL list is edited with the prototype's rules and saved
   * to the server configuration; a change made against a list someone else has since edited is
   * refused rather than applied to the wrong entry. The inventory refreshes while the page is
   * open and says so when it could not, instead of presenting an old snapshot as current.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Chip from '$lib/components/frameleaf/Chip.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import RestorationModelsDialog from '$lib/components/frameleaf/RestorationModelsDialog.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import { OpenQueryParam } from '$lib/constants';
  import { mlDestinationKindLabelKey, mlRefusalLabelKey, mlWorkloadLabelKey } from '$lib/frameleaf/ml-destinations';
  import {
    accelerationLabelKey,
    applyWorkerUrlChange,
    credentialLabelKey,
    formatGpuMemory,
    inventorySections,
    isStaleSnapshot,
    readinessLabelKey,
    readinessTone,
    roleLabelKey,
    routedEntry,
    WORKER_INVENTORY_REFRESH_MS,
    WorkerUrlChangeError,
    workerTypeLabelKey,
    workerUrlProblemKey,
    type WorkerUrlChange,
  } from '$lib/frameleaf/worker-inventory';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getConfig,
    getMlDestination,
    getWorkerInventory,
    MlDestinationKind,
    probeMlDestination,
    updateConfig,
    WorkerInventorySource,
    type MlDestinationResponseDto,
    type MlWorkload,
    type WorkerInventoryEntryDto,
    type WorkerInventoryResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCloudOutline, mdiDesktopTowerMonitor, mdiMemory, mdiServerOutline } from '@mdi/js';
  import { onMount, type Snippet } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  type Props = {
    inventory: WorkerInventoryResponseDto;
    /** The destinations list, for the restoration models dialog. */
    destinations: MlDestinationResponseDto[];
    /** Bumped by the page when a neighbouring panel changed something; reloads the inventory. */
    refreshKey?: number;
  };

  let { inventory: initialInventory, destinations, refreshKey = 0 }: Props = $props();

  let inventory = $state<WorkerInventoryResponseDto>(initialInventory);
  let refreshing = $state(false);
  let refreshFailed = $state(false);
  let busy = $state<string | null>(null);
  let notice = $state('');
  let now = $state(Date.now());

  const sections = $derived(inventorySections(inventory));
  const mlEnabled = $derived(inventory.machineLearningEnabled);
  const stale = $derived(refreshFailed || isStaleSnapshot(inventory.checkedAt, now));

  const formatTime = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat($locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(value),
        )
      : null;

  const reload = async () => {
    refreshing = true;
    try {
      inventory = await getWorkerInventory();
      refreshFailed = false;
    } catch {
      // Keep the last snapshot on screen and say it is old; never blank the page.
      refreshFailed = true;
    } finally {
      refreshing = false;
      now = Date.now();
    }
  };

  onMount(() => {
    const timer = setInterval(() => {
      now = Date.now();
      if (!document.hidden) {
        void reload();
      }
    }, WORKER_INVENTORY_REFRESH_MS);
    return () => clearInterval(timer);
  });

  let lastKey = refreshKey;
  $effect(() => {
    if (refreshKey === lastKey) {
      return;
    }

    lastKey = refreshKey;
    void reload();
  });

  /* ---------------- check capabilities ---------------- */

  const check = async (entry: WorkerInventoryEntryDto) => {
    busy = `check-${entry.id}`;
    try {
      await probeMlDestination({ id: entry.id });
      await reload();
    } catch (error) {
      handleError(error, $t('admin.frameleaf_ml_destinations_error_probe'));
    } finally {
      busy = null;
    }
  };

  /* ---------------- restoration models ---------------- */

  let modelsTarget = $state<MlDestinationResponseDto | null>(null);
  let modelsOpen = $state(false);
  const openModels = async (entry: WorkerInventoryEntryDto) => {
    try {
      // A worker added since the page loaded is read from the server rather than skipped.
      modelsTarget =
        destinations.find((destination) => destination.id === entry.id) ?? (await getMlDestination({ id: entry.id }));
      modelsOpen = true;
    } catch (error) {
      handleError(error, $t('admin.frameleaf_restoration_models_error'));
    }
  };

  /* ---------------- the machine-learning URL list ---------------- */

  type Form = { kind: 'add' | 'edit' | 'remove'; original: string | null; url: string };
  let form = $state<Form | null>(null);
  let formOpen = $state(false);
  let formError = $state('');
  let listError = $state('');

  const openForm = (next: Form) => {
    form = next;
    formError = '';
    formOpen = true;
  };

  /**
   * Apply one change to the list the server holds now (not the one on screen), then save it.
   * The prototype's rule refuses a change whose endpoint was edited elsewhere in the meantime.
   */
  const save = async (change: WorkerUrlChange): Promise<boolean> => {
    busy = 'urls';
    try {
      const config = await getConfig();
      const urls = applyWorkerUrlChange(config.machineLearning.urls, change);
      await updateConfig({ adminConfigDto: { ...config, machineLearning: { ...config.machineLearning, urls } } });
      notice = $t('admin.frameleaf_workers_saved');
      await reload();
      return true;
    } catch (error) {
      if (error instanceof WorkerUrlChangeError) {
        const message = $t(workerUrlProblemKey(error.problem));
        if (formOpen) {
          formError = message;
        } else {
          listError = message;
        }
      } else {
        handleError(error, $t('admin.frameleaf_workers_error_save'));
      }
      return false;
    } finally {
      busy = null;
    }
  };

  const submitForm = async () => {
    const current = form;
    if (!current) {
      return;
    }
    listError = '';
    const change: WorkerUrlChange =
      current.kind === 'add'
        ? { kind: 'add', url: current.url }
        : current.kind === 'edit'
          ? { kind: 'edit', original: current.original ?? '', url: current.url }
          : { kind: 'remove', original: current.original ?? '' };
    if (await save(change)) {
      formOpen = false;
    }
  };

  const move = (url: string, direction: -1 | 1) => {
    listError = '';
    void save({ kind: 'move', original: url, direction });
  };

  const dialogTitle = (current: Form | null) =>
    current?.kind === 'remove'
      ? $t('admin.frameleaf_workers_remove_title')
      : current?.kind === 'edit'
        ? $t('admin.frameleaf_workers_edit_title')
        : $t('admin.frameleaf_workers_add_title');

  const kindLabel = (entry: WorkerInventoryEntryDto) =>
    entry.source === WorkerInventorySource.MlDestination &&
    Object.values(MlDestinationKind).includes(entry.kind as MlDestinationKind)
      ? $t(mlDestinationKindLabelKey(entry.kind as MlDestinationKind))
      : entry.kind;

  const workloadList = (workloads: MlWorkload[] | null) =>
    workloads && workloads.length > 0
      ? workloads.map((workload) => $t(mlWorkloadLabelKey(workload))).join(', ')
      : $t('admin.frameleaf_workers_capabilities_none');
</script>

{#snippet facts(entry: WorkerInventoryEntryDto)}
  <dl>
    <div>
      <dt>{$t('admin.frameleaf_workers_type')}</dt>
      <dd>
        {$t(workerTypeLabelKey(entry))}
        {#if entry.role}
          · {$t(roleLabelKey(entry.role))}
        {/if}
      </dd>
    </div>
    <div>
      <dt>{$t('admin.frameleaf_workers_capabilities')}</dt>
      <dd>
        {#if entry.source === WorkerInventorySource.RenderWorker}
          {entry.renderKinds.length > 0
            ? entry.renderKinds.join(', ')
            : $t('admin.frameleaf_workers_capabilities_none')}
        {:else}
          {workloadList(entry.servedWorkloads)}
        {/if}
      </dd>
    </div>
    <div>
      <dt>{$t('admin.frameleaf_workers_gpu_memory')}</dt>
      <dd>
        {formatGpuMemory(entry.gpuMemoryBytes, $locale ?? undefined) ?? $t('admin.frameleaf_workers_gpu_unknown')}
        · {$t(accelerationLabelKey(entry.acceleration))}
      </dd>
    </div>
    <div>
      <dt>{$t('admin.frameleaf_workers_credentials')}</dt>
      <dd>{$t(credentialLabelKey(entry.credential))}</dd>
    </div>
    {#if entry.source === WorkerInventorySource.MlDestination}
      <div>
        <dt>{$t('admin.frameleaf_workers_routed')}</dt>
        <dd>
          {entry.routedWorkloads.length > 0
            ? workloadList(entry.routedWorkloads)
            : $t('admin.frameleaf_workers_routed_none')}
        </dd>
      </div>
      <div>
        <dt>{$t('admin.frameleaf_workers_admission')}</dt>
        <dd>
          {#if entry.admission.length === 0}
            {$t('admin.frameleaf_workers_capabilities_none')}
          {:else}
            <ul class="admission">
              {#each entry.admission as verdict (verdict.workload)}
                <li class:refused={!verdict.admitted}>
                  {verdict.admitted || !verdict.refusal
                    ? $t('admin.frameleaf_workers_admission_accepted', {
                        values: { workload: $t(mlWorkloadLabelKey(verdict.workload)) },
                      })
                    : $t('admin.frameleaf_workers_admission_refused', {
                        values: {
                          workload: $t(mlWorkloadLabelKey(verdict.workload)),
                          reason: $t(mlRefusalLabelKey(verdict.refusal)),
                        },
                      })}
                </li>
              {/each}
            </ul>
          {/if}
        </dd>
      </div>
    {/if}
    <div>
      <dt>{$t('admin.frameleaf_workers_load')}</dt>
      <dd>
        {#if entry.maxConcurrentOperations !== null}
          {$t('admin.frameleaf_workers_render_load', {
            values: { active: entry.activeOperations, max: entry.maxConcurrentOperations },
          })}
        {:else}
          {$t('admin.frameleaf_workers_load_value', {
            values: { active: entry.activeOperations, queued: entry.queuedOperations },
          })}
        {/if}
      </dd>
    </div>
    <div>
      <dt>{$t('admin.frameleaf_workers_last_check')}</dt>
      <dd>
        {formatTime(entry.checkedAt) ?? $t('admin.frameleaf_workers_never_checked')}
        {#if entry.latencyMs !== null}
          · {entry.latencyMs} ms
        {/if}
        {#if entry.summary}<span class="muted"> · {entry.summary}</span>{/if}
      </dd>
    </div>
  </dl>
{/snippet}

{#snippet card(entry: WorkerInventoryEntryDto | null, title: string, url: string | null, actions: Snippet)}
  <article aria-label={title}>
    <div class="endpoint">
      <span class="icon" aria-hidden="true">
        <Icon
          icon={entry?.source === WorkerInventorySource.RenderWorker
            ? mdiMemory
            : entry?.leavesNetwork
              ? mdiCloudOutline
              : entry?.kind === MlDestinationKind.Lan
                ? mdiDesktopTowerMonitor
                : mdiServerOutline}
          size="22"
        />
      </span>
      <div>
        <h4>{title}</h4>
        {#if url}
          <code>{url}</code>
        {/if}
        <div class="chips">
          {#if entry}
            <Chip label={kindLabel(entry)} />
            {#if entry.leavesNetwork}
              <Chip label={$t('admin.frameleaf_workers_leaves_network')} />
            {/if}
            {#if !entry.configured}
              <Chip label={$t('admin.frameleaf_workers_unlisted')} />
            {/if}
            {#if entry.sharesLibraryHardware}
              <Chip label={$t('admin.frameleaf_workers_shares_hardware')} />
            {/if}
          {/if}
        </div>
      </div>
      {#if entry}
        <Badge
          value={$t(readinessLabelKey(entry))}
          label={$t('admin.frameleaf_workers_state_label', {
            values: { name: title, state: $t(readinessLabelKey(entry)) },
          })}
          tone={readinessTone(entry.readiness)}
        />
      {:else}
        <Badge
          value={$t('admin.frameleaf_workers_state_unknown')}
          label={$t('admin.frameleaf_workers_state_label', {
            values: { name: title, state: $t('admin.frameleaf_workers_state_unknown') },
          })}
          tone="neutral"
        />
      {/if}
    </div>
    {#if entry}
      {#if entry.waitingForLibraryAnalysis}
        <p class="callout" role="note">
          {$t('admin.frameleaf_workers_waiting_library', { values: { count: inventory.libraryBacklog } })}
        </p>
      {/if}
      {@render facts(entry)}
    {:else}
      <p class="muted">{$t('admin.frameleaf_workers_not_created')}</p>
    {/if}
    <div class="actions">
      {@render actions()}
    </div>
  </article>
{/snippet}

{#snippet checkButton(entry: WorkerInventoryEntryDto)}
  <Button onclick={() => void check(entry)} disabled={busy !== null}>
    {busy === `check-${entry.id}` ? $t('admin.frameleaf_workers_checking') : $t('admin.frameleaf_workers_check')}
  </Button>
{/snippet}

<Pane label={$t('admin.frameleaf_workers_title')}>
  <div class="inventory">
    <div class="heading">
      <div>
        <!-- The page heading already names this section (a section named like its area does not repeat the name). -->
        <h2 class="sr-only">{$t('admin.frameleaf_workers_title')}</h2>
        <p class="sr-only">{$t('admin.frameleaf_workers_description')}</p>
      </div>
      <Button onclick={() => void reload()} disabled={refreshing}>
        {refreshing ? $t('admin.frameleaf_workers_refreshing') : $t('admin.frameleaf_workers_refresh')}
      </Button>
    </div>

    {#if stale}
      <p class="callout" role="alert">
        {$t('admin.frameleaf_workers_stale', { values: { time: formatTime(inventory.checkedAt) } })}
      </p>
    {:else}
      <p class="muted">
        {$t('admin.frameleaf_workers_updated', { values: { time: formatTime(inventory.checkedAt) } })}
      </p>
    {/if}
    {#if notice}
      <Status message={notice} />
    {/if}

    <!-- Machine-learning endpoints: the configured URL list, then other library workers. -->
    <section class="group" aria-labelledby="workers-ml-heading">
      <div class="heading">
        <div>
          <h3 id="workers-ml-heading">{$t('admin.frameleaf_workers_ml_heading')}</h3>
          <p>{$t('admin.frameleaf_workers_ml_description')}</p>
        </div>
        <Button
          disabled={!mlEnabled || busy !== null}
          onclick={() => openForm({ kind: 'add', original: null, url: '' })}
        >
          {$t('admin.frameleaf_workers_add_endpoint')}
        </Button>
      </div>
      {#if !mlEnabled}
        <p class="callout">{$t('admin.frameleaf_workers_ml_disabled')}</p>
      {/if}
      <p class="muted">{$t('admin.frameleaf_workers_ml_note')}</p>
      <p class="muted">{$t('admin.frameleaf_workers_order_note')}</p>
      {#if listError}
        <p class="error" role="alert">{listError}</p>
      {/if}

      <div class="list">
        {#each sections.endpoints as endpoint (endpoint.url)}
          {@const title = $t('admin.frameleaf_workers_endpoint_title', { values: { number: endpoint.index + 1 } })}
          {#snippet endpointActions()}
            <Button
              disabled={!mlEnabled || busy !== null}
              onclick={() => openForm({ kind: 'edit', original: endpoint.url, url: endpoint.url })}
            >
              {$t('admin.frameleaf_workers_edit_endpoint')}
            </Button>
            {#if endpoint.entry}
              {@render checkButton(endpoint.entry)}
            {/if}
            <Button
              disabled={!mlEnabled || busy !== null || endpoint.index === 0}
              label={$t('admin.frameleaf_workers_move_earlier_label', { values: { number: endpoint.index + 1 } })}
              onclick={() => move(endpoint.url, -1)}
            >
              {$t('admin.frameleaf_workers_move_earlier')}
            </Button>
            <Button
              disabled={!mlEnabled || busy !== null || endpoint.index === sections.endpoints.length - 1}
              label={$t('admin.frameleaf_workers_move_later_label', { values: { number: endpoint.index + 1 } })}
              onclick={() => move(endpoint.url, 1)}
            >
              {$t('admin.frameleaf_workers_move_later')}
            </Button>
            <Button
              disabled={!mlEnabled || busy !== null || sections.endpoints.length <= 1}
              onclick={() => openForm({ kind: 'remove', original: endpoint.url, url: endpoint.url })}
            >
              {$t('admin.frameleaf_workers_remove')}
            </Button>
          {/snippet}
          {@render card(endpoint.entry, title, endpoint.url, endpointActions)}
        {/each}

        {#each sections.libraryWorkers as entry (entry.id)}
          {#snippet libraryActions()}
            {@render checkButton(entry)}
            <Button onclick={() => document.querySelector('#ml-destinations')?.scrollIntoView()}>
              {$t('admin.frameleaf_workers_manage')}
            </Button>
          {/snippet}
          {@render card(entry, entry.name, entry.url, libraryActions)}
        {/each}
      </div>
      {#if sections.endpoints.length === 0}
        <p class="error" role="alert">{$t('admin.frameleaf_workers_no_endpoints')}</p>
      {/if}
    </section>

    <!-- Where library work runs: the truth about routing, cloud routes included. -->
    <section class="group" aria-labelledby="workers-routes-heading">
      <h3 id="workers-routes-heading">{$t('admin.frameleaf_workers_routes_heading')}</h3>
      <p class="muted">{$t('admin.frameleaf_workers_routes_description')}</p>
      <ul class="routes">
        {#each inventory.libraryRoutes as route (route.workload)}
          {@const target = routedEntry(inventory, route.destinationId)}
          {@const waiting = inventory.libraryQueues
            .filter((queue) => route.queues.includes(queue.queue))
            .reduce((total, queue) => total + queue.active + queue.waiting, 0)}
          <li>
            <span>{$t(mlWorkloadLabelKey(route.workload))}</span>
            <span class:refused={!target}>
              {#if target}
                {$t('admin.frameleaf_workers_route_value', { values: { name: target.name, kind: kindLabel(target) } })}
              {:else}
                {$t('admin.frameleaf_workers_route_none')}
              {/if}
            </span>
            <span class="muted">{$t('admin.frameleaf_workers_route_backlog', { values: { count: waiting } })}</span>
          </li>
        {/each}
      </ul>
      <p class="muted">
        {$t('admin.frameleaf_workers_backlog', { values: { count: inventory.libraryBacklog } })}
      </p>
    </section>

    <!-- Restoration and persistent video workers: never the library-analysis endpoints. -->
    <section class="group" aria-labelledby="workers-video-heading">
      <h3 id="workers-video-heading">
        {$t('admin.frameleaf_workers_restoration_heading', { values: { count: sections.restorationWorkers.length } })}
      </h3>
      <p class="muted">{$t('admin.frameleaf_workers_restoration_description')}</p>
      <div class="list">
        {#each sections.restorationWorkers as entry (entry.id)}
          {#snippet restorationActions()}
            {@render checkButton(entry)}
            <Button onclick={() => void openModels(entry)} disabled={busy !== null}>
              {$t('admin.frameleaf_restoration_models_action')}
            </Button>
          {/snippet}
          {@render card(entry, entry.name, entry.url, restorationActions)}
        {:else}
          <p class="muted">{$t('admin.frameleaf_workers_restoration_empty')}</p>
        {/each}
      </div>
      <div class="actions">
        <Button onclick={() => document.querySelector('#ml-destinations')?.scrollIntoView()}>
          {$t('admin.frameleaf_workers_open_video_profile')}
        </Button>
        <a class="link" href={Route.systemSettings({ isOpen: OpenQueryParam.IMAGE_DESCRIPTION })}>
          {$t('admin.frameleaf_workers_manage_library')}
        </a>
      </div>
    </section>

    {#if sections.mixedWorkers.length > 0}
      <section class="group" aria-labelledby="workers-mixed-heading">
        <h3 id="workers-mixed-heading">{$t('admin.frameleaf_workers_mixed_heading')}</h3>
        <p class="callout">{$t('admin.frameleaf_workers_mixed_description')}</p>
        <div class="list">
          {#each sections.mixedWorkers as entry (entry.id)}
            {#snippet mixedActions()}
              {@render checkButton(entry)}
              <Button onclick={() => document.querySelector('#ml-destinations')?.scrollIntoView()}>
                {$t('admin.frameleaf_workers_manage')}
              </Button>
            {/snippet}
            {@render card(entry, entry.name, entry.url, mixedActions)}
          {/each}
        </div>
      </section>
    {/if}

    <section class="group" aria-labelledby="workers-render-heading">
      <h3 id="workers-render-heading">{$t('admin.frameleaf_workers_render_heading')}</h3>
      <p class="muted">{$t('admin.frameleaf_workers_render_description')}</p>
      <div class="list">
        {#each sections.renderWorkers as entry (entry.id)}
          {#snippet renderActions()}
            <a class="link" href={Route.renderWorkers()}>{$t('admin.frameleaf_workers_render_manage')}</a>
          {/snippet}
          {@render card(entry, entry.name, null, renderActions)}
        {:else}
          <p class="muted">{$t('admin.frameleaf_workers_render_empty')}</p>
        {/each}
      </div>
    </section>

    <section class="group" aria-labelledby="workers-runners-heading">
      <h3 id="workers-runners-heading">{$t('admin.frameleaf_workers_runners_heading')}</h3>
      <p class="muted">{$t('admin.frameleaf_workers_runners_description')}</p>
      {#if inventory.runners.length === 0}
        <p class="muted">{$t('admin.frameleaf_workers_runners_empty')}</p>
      {:else}
        <ul class="routes">
          {#each inventory.runners as runner (runner.workerId)}
            <li>
              <code>{runner.workerId}</code>
              <span>
                {$t('admin.frameleaf_workers_runner_value', {
                  values: {
                    count: runner.activeOperations,
                    time: formatTime(runner.lastHeartbeatAt) ?? $t('admin.frameleaf_workers_never_checked'),
                  },
                })}
              </span>
            </li>
          {/each}
        </ul>
      {/if}
    </section>
  </div>
</Pane>

<RestorationModelsDialog destination={modelsTarget} bind:open={modelsOpen} />

<Dialog title={dialogTitle(form)} closeLabel={$t('close')} bind:open={formOpen}>
  {#if form}
    <form
      class="dialog-body"
      onsubmit={(event) => {
        event.preventDefault();
        void submitForm();
      }}
    >
      {#if form.kind === 'remove'}
        <p>{$t('admin.frameleaf_workers_remove_body')}</p>
        <code>{form.url}</code>
        <p class="muted">{$t('admin.frameleaf_workers_remove_note')}</p>
      {:else}
        <label>
          {$t('admin.frameleaf_workers_endpoint_url')}
          <input
            type="url"
            bind:value={form.url}
            maxlength="2048"
            placeholder="http://machine-learning:3003"
            required
          />
        </label>
        <p class="muted">{$t('admin.frameleaf_workers_endpoint_hint')}</p>
        {#if form.kind === 'edit'}
          <p class="muted">{$t('admin.frameleaf_workers_edit_note')}</p>
        {/if}
      {/if}
      {#if formError}
        <p class="error" role="alert">{formError}</p>
      {/if}
      <div class="dialog-actions">
        <Button onclick={() => (formOpen = false)} disabled={busy !== null}>{$t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy !== null}>
          {form.kind === 'remove' ? $t('admin.frameleaf_workers_remove_confirm') : $t('save')}
        </Button>
      </div>
    </form>
  {/if}
</Dialog>

<style>
  .inventory,
  .group,
  .list {
    display: grid;
    gap: 1rem;
  }
  .group {
    border-top: 1px solid var(--fl-border);
    padding-top: 1rem;
  }
  .heading {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 0.75rem;
  }
  h2,
  h3 {
    margin: 0 0 0.375rem;
    font-size: var(--fl-font-size);
  }
  h4 {
    margin: 0 0 0.3rem;
    font-size: var(--fl-font-small);
  }
  .heading p,
  .muted {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .callout {
    margin: 0;
    padding: 0.5rem 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    font-size: var(--fl-font-small);
  }
  .error {
    margin: 0;
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
  article {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 1rem;
    background: var(--fl-panel);
    display: grid;
    gap: 0.75rem;
  }
  .endpoint {
    display: flex;
    align-items: center;
    gap: 0.625rem;
  }
  .endpoint > div {
    flex: 1;
    min-width: 0;
  }
  .icon {
    display: inline-flex;
    color: var(--fl-muted);
  }
  .chips {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
    margin-top: 0.375rem;
  }
  code {
    overflow-wrap: anywhere;
    white-space: normal;
    font-size: var(--fl-font-small);
  }
  dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0;
    font-size: var(--fl-font-small);
  }
  dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    margin-bottom: 0.3rem;
  }
  dd {
    margin: 0;
    overflow-wrap: anywhere;
  }
  .admission {
    list-style: none;
    margin: 0;
    padding: 0;
  }
  .refused {
    color: var(--fl-warning);
  }
  .actions {
    display: flex;
    align-items: center;
    gap: 0.625rem;
    flex-wrap: wrap;
  }
  .link {
    color: var(--fl-accent);
    font-size: var(--fl-font-small);
    text-decoration: underline;
  }
  .routes {
    list-style: none;
    margin: 0;
    padding: 0;
    display: grid;
    gap: 0.5rem;
  }
  .routes li {
    display: grid;
    grid-template-columns: minmax(9rem, 1fr) minmax(10rem, 2fr) auto;
    gap: 0.75rem;
    align-items: center;
    font-size: var(--fl-font-small);
  }
  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    color: var(--fl-text);
  }
  .dialog-body label {
    display: grid;
    gap: 0.5rem;
    font-size: var(--fl-font-small);
  }
  .dialog-body input {
    width: 100%;
    padding: 0.5rem;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  @media (width < 40rem) {
    .heading {
      flex-direction: column;
    }
    dl {
      grid-template-columns: 1fr;
    }
    .endpoint {
      align-items: flex-start;
      flex-wrap: wrap;
    }
    .routes li {
      grid-template-columns: 1fr;
    }
  }
</style>
