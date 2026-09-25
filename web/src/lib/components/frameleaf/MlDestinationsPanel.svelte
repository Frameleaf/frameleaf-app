<script lang="ts">
  /**
   * Processing destinations (FL-110): where machine-learning work may run.
   *
   * Every fact shown here comes from the server's destination model: the destinations, their
   * last probe, their consent state and cost controls, and the route each workload uses. The
   * panel offers only choices the server would accept (a cloud destination without recorded
   * consent is shown as blocked and is absent from the route pickers) and never picks a
   * destination on the administrator's behalf: an unrouted workload is labelled as refused,
   * not quietly sent to whatever is available.
   *
   * FL-72: library analysis and restoration never share a worker on this network. The form closes
   * restoration once library work is ticked (and the reverse).
   *
   * FL-159: Frameleaf Cloud is the only cloud destination. Its row has no URL or token (requests
   * use short-lived tokens this server signs), keeps consent and the budget, and shows the AI Wallet
   * the last check read instead of an hourly rate. It is added, and its consent reviewed, from the
   * Frameleaf Cloud section, because consent there is versioned and per feature.
   */
  import Badge from '$lib/components/frameleaf/Badge.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Chip from '$lib/components/frameleaf/Chip.svelte';
  import CloudMlConsentDialog from '$lib/components/frameleaf/cloud/CloudMlConsentDialog.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import RestorationModelsDialog from '$lib/components/frameleaf/RestorationModelsDialog.svelte';
  import Status from '$lib/components/frameleaf/Status.svelte';
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  import {
    canRouteTo,
    isConsentBlocking,
    isConsentOutdated,
    isOverBudget,
    isRestorationWorkload,
    ML_WORKLOAD_ORDER,
    mlDestinationKindLabelKey,
    mlHealthLabelKey,
    mlHealthTone,
    mlRefusalLabelKey,
    mlWorkloadLabelKey,
    parseOptionalNumber,
    routableDestinations,
    workloadBlockedInDraft,
    workloadsForKind,
  } from '$lib/frameleaf/ml-destinations';
  import { formatUsd } from '$lib/frameleaf/cloud-ml';
  import { allowsRestoration } from '$lib/frameleaf/restoration-models';
  import { Route } from '$lib/route';
  import { roleLabelKey } from '$lib/frameleaf/worker-inventory';
  import { handleError } from '$lib/utils/handle-error';
  import {
    createMlDestination,
    deleteMlDestination,
    getCloudMlStatus,
    getMlWorkloadRoutes,
    listMlDestinations,
    MlDestinationKind,
    probeMlDestination,
    revokeMlDestinationConsent,
    setMlWorkloadRoute,
    updateMlDestination,
    type CloudMlConsentStateDto,
    type MlDestinationResponseDto,
    type MlWorkload,
    type MlWorkloadRouteDto,
  } from '@immich/sdk';
  import { locale, t } from 'svelte-i18n';

  type Props = {
    destinations: MlDestinationResponseDto[];
    routes: MlWorkloadRouteDto[];
    /** Called after any change is saved and the list reloaded, so a neighbouring view can refresh. */
    onChanged?: () => void;
  };

  let { destinations: initialDestinations, routes: initialRoutes, onChanged }: Props = $props();

  let destinations = $state<MlDestinationResponseDto[]>(initialDestinations);
  let routes = $state<MlWorkloadRouteDto[]>(initialRoutes);
  let busy = $state<string | null>(null);
  let statusMessage = $state('');

  const routeFor = (workload: MlWorkload) => routes.find((route) => route.workload === workload)?.destinationId ?? null;
  const routedName = (workload: MlWorkload) => {
    const id = routeFor(workload);
    return id ? (destinations.find((destination) => destination.id === id)?.name ?? null) : null;
  };

  const refresh = async () => {
    const [nextDestinations, nextRoutes] = await Promise.all([listMlDestinations(), getMlWorkloadRoutes()]);
    destinations = nextDestinations;
    routes = nextRoutes.routes;
    onChanged?.();
  };

  const run = async (key: string, action: () => Promise<unknown>, failure: string) => {
    busy = key;
    try {
      await action();
      await refresh();
    } catch (error) {
      handleError(error, failure);
    } finally {
      busy = null;
    }
  };

  /* ---------------- consent ---------------- */

  /**
   * Only Frameleaf Cloud needs consent, and its consent is versioned (FL-159): the sheet shows the
   * version and optional details the cloud requires now, read when it opens.
   */
  let consentTarget = $state<MlDestinationResponseDto | null>(null);
  let cloudConsent = $state<CloudMlConsentStateDto | null>(null);
  let cloudConsentOpen = $state(false);
  let cloudRegion = $state<string | null>(null);

  const openConsent = async (destination: MlDestinationResponseDto) => {
    busy = `consent-${destination.id}`;
    try {
      const status = await getCloudMlStatus();
      if (status.consent) {
        consentTarget = destination;
        cloudConsent = status.consent;
        cloudRegion = status.region;
        cloudConsentOpen = true;
      } else {
        statusMessage = $t('admin.frameleaf_cloud_ml_consent_needs_cloud');
      }
    } catch (error) {
      handleError(error, $t('admin.frameleaf_cloud_ml_error_load'));
    } finally {
      busy = null;
    }
  };

  const revokeConsent = async (destination: MlDestinationResponseDto) => {
    await run(
      `consent-${destination.id}`,
      () => revokeMlDestinationConsent({ id: destination.id }),
      $t('admin.frameleaf_ml_destinations_error_consent'),
    );
    statusMessage = $t('admin.frameleaf_ml_destinations_consent_revoked', { values: { name: destination.name } });
  };

  /* ---------------- restoration models (FL-114) ---------------- */

  let restorationTarget = $state<MlDestinationResponseDto | null>(null);
  let restorationOpen = $state(false);

  /* ---------------- probe, enable, delete ---------------- */

  const probe = (destination: MlDestinationResponseDto) =>
    run(
      `probe-${destination.id}`,
      () => probeMlDestination({ id: destination.id }),
      $t('admin.frameleaf_ml_destinations_error_probe'),
    );

  const setEnabled = (destination: MlDestinationResponseDto, enabled: boolean) =>
    run(
      `enable-${destination.id}`,
      () => updateMlDestination({ id: destination.id, mlDestinationUpdateDto: { enabled } }),
      $t('admin.frameleaf_ml_destinations_error_save'),
    );

  let deleteTarget = $state<MlDestinationResponseDto | null>(null);
  let deleteOpen = $state(false);

  const confirmDelete = async () => {
    const target = deleteTarget;
    if (!target) {
      return;
    }
    await run(
      `delete-${target.id}`,
      () => deleteMlDestination({ id: target.id }),
      $t('admin.frameleaf_ml_destinations_error_delete'),
    );
    deleteOpen = false;
  };

  /* ---------------- create and edit ---------------- */

  type Draft = {
    id: string | null;
    kind: MlDestinationKind;
    name: string;
    url: string;
    authToken: string;
    workloads: MlWorkload[];
    budgetLimitUsd: string;
    maxRuntimeMinutes: string;
    maxUploadMb: string;
    sharesLibraryHardware: boolean;
  };

  let draft = $state<Draft | null>(null);
  let draftOpen = $state(false);
  let draftError = $state<string | null>(null);

  const openCreate = (kind: MlDestinationKind) => {
    draft = {
      id: null,
      kind,
      name: '',
      url: '',
      authToken: '',
      workloads: [],
      budgetLimitUsd: '',
      maxRuntimeMinutes: '',
      maxUploadMb: '',
      sharesLibraryHardware: false,
    };
    draftError = null;
    draftOpen = true;
  };

  const openEdit = (destination: MlDestinationResponseDto) => {
    draft = {
      id: destination.id,
      kind: destination.kind,
      name: destination.name,
      url: destination.url ?? '',
      authToken: '',
      // A workload the kind can no longer run cannot be shown; leave it out so saving clears it.
      workloads: destination.workloads.filter((workload) => workloadsForKind(destination.kind).includes(workload)),
      budgetLimitUsd: destination.costControls.budgetLimitUsd?.toString() ?? '',
      maxRuntimeMinutes: destination.costControls.maxRuntimeMinutes?.toString() ?? '',
      maxUploadMb:
        destination.costControls.maxUploadBytes === null
          ? ''
          : Math.round(destination.costControls.maxUploadBytes / 1_000_000).toString(),
      sharesLibraryHardware: destination.sharesLibraryHardware,
    };
    draftError = null;
    draftOpen = true;
  };

  const toggleWorkload = (workload: MlWorkload, checked: boolean) => {
    if (!draft) {
      return;
    }
    draft.workloads = checked
      ? [...new Set([...draft.workloads, workload])]
      : draft.workloads.filter((entry) => entry !== workload);
    if (draft.workloads.every((entry) => !isRestorationWorkload(entry))) {
      draft.sharesLibraryHardware = false;
    }
  };

  /** Only a restoration worker on this network can share a GPU with library analysis. */
  const canShareHardware = (current: Draft) =>
    (current.kind === MlDestinationKind.Local || current.kind === MlDestinationKind.Lan) &&
    current.workloads.some((workload) => isRestorationWorkload(workload));

  const saveDraft = async () => {
    const current = draft;
    if (!current) {
      return;
    }
    const budgetLimitUsd = parseOptionalNumber(current.budgetLimitUsd);
    const maxRuntimeMinutes = parseOptionalNumber(current.maxRuntimeMinutes);
    const maxUploadMb = parseOptionalNumber(current.maxUploadMb);
    if (budgetLimitUsd === undefined || maxRuntimeMinutes === undefined || maxUploadMb === undefined) {
      draftError = $t('admin.frameleaf_ml_destinations_error_limits');
      return;
    }
    if (current.kind === MlDestinationKind.Lan && current.url.trim() === '') {
      draftError = $t('admin.frameleaf_ml_destinations_error_url');
      return;
    }
    const name = current.name.trim();
    if (!name) {
      draftError = $t('admin.frameleaf_ml_destinations_error_name');
      return;
    }
    const costControls = {
      budgetLimitUsd,
      maxRuntimeMinutes: maxRuntimeMinutes === null ? null : Math.round(maxRuntimeMinutes),
      maxUploadBytes: maxUploadMb === null ? null : Math.round(maxUploadMb * 1_000_000),
    };
    // Frameleaf Cloud has no URL or token to send (FL-159).
    const isCloud = current.kind === MlDestinationKind.FrameleafCloud;
    const sharesLibraryHardware = canShareHardware(current) && current.sharesLibraryHardware;

    await run(
      current.id ? `edit-${current.id}` : 'create',
      () =>
        current.id
          ? updateMlDestination({
              id: current.id,
              mlDestinationUpdateDto: {
                name,
                workloads: current.workloads,
                ...(!isCloud && { url: current.url.trim() || null }),
                ...(!isCloud && current.authToken && { authToken: current.authToken }),
                sharesLibraryHardware,
                ...costControls,
              },
            })
          : createMlDestination({
              mlDestinationCreateDto: {
                kind: current.kind,
                name,
                workloads: current.workloads,
                url: current.url.trim(),
                ...(current.authToken && { authToken: current.authToken }),
                sharesLibraryHardware,
                ...costControls,
              },
            }),
      $t('admin.frameleaf_ml_destinations_error_save'),
    );
    draftOpen = false;
  };

  /* ---------------- routes ---------------- */

  const setRoute = async (workload: MlWorkload, destinationId: string) => {
    await run(
      `route-${workload}`,
      () => setMlWorkloadRoute({ workload, mlWorkloadRouteUpdateDto: { destinationId: destinationId || null } }),
      $t('admin.frameleaf_ml_destinations_error_route'),
    );
  };

  const formatDate = (value: string | null) =>
    value
      ? new Intl.DateTimeFormat($locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' }).format(
          new Date(value),
        )
      : null;
</script>

<Pane label={$t('admin.frameleaf_ml_destinations_title')}>
  <div class="head">
    <div>
      <h2>{$t('admin.frameleaf_ml_destinations_title')}</h2>
      <p>{$t('admin.frameleaf_ml_destinations_description')}</p>
    </div>
    <div class="head-actions">
      <Button onclick={() => openCreate(MlDestinationKind.Lan)}>{$t('admin.frameleaf_ml_destinations_add_lan')}</Button>
      {#if destinations.every((destination) => destination.kind !== MlDestinationKind.FrameleafCloud)}
        <a class="link-button" href={Route.cloudMl()}>{$t('admin.frameleaf_ml_destinations_add_frameleaf_cloud')}</a>
      {/if}
    </div>
  </div>

  {#if statusMessage}
    <Status message={statusMessage} />
  {/if}

  {#if destinations.length === 0}
    <p class="empty">{$t('admin.frameleaf_ml_destinations_empty')}</p>
  {:else}
    <ul class="destinations">
      {#each destinations as destination (destination.id)}
        {@const blocked = isConsentBlocking(destination)}
        {@const overBudget = isOverBudget(destination)}
        <li class="destination" aria-label={destination.name}>
          <header>
            <div class="identity">
              <strong>{destination.name}</strong>
              <Chip label={$t(mlDestinationKindLabelKey(destination.kind))} />
              <Chip label={$t(roleLabelKey(destination.role))} />
              <Badge
                value={$t(mlHealthLabelKey(destination.health.status))}
                label={$t('admin.frameleaf_ml_destinations_health_label', {
                  values: { name: destination.name, status: $t(mlHealthLabelKey(destination.health.status)) },
                })}
                tone={mlHealthTone(destination.health.status)}
              />
              {#if blocked}
                <Badge
                  value={$t('admin.frameleaf_ml_destinations_consent_missing')}
                  label={$t('admin.frameleaf_ml_destinations_consent_missing_label', {
                    values: { name: destination.name },
                  })}
                  tone="warning"
                />
              {/if}
              {#if overBudget}
                <Badge
                  value={$t('admin.frameleaf_ml_destinations_over_budget')}
                  label={$t('admin.frameleaf_ml_destinations_over_budget_label', {
                    values: { name: destination.name },
                  })}
                  tone="danger"
                />
              {/if}
            </div>
            <Toggle
              label={$t('admin.frameleaf_ml_destinations_enabled_label', { values: { name: destination.name } })}
              checked={destination.enabled}
              onLabel={$t('admin.frameleaf_ml_destinations_enabled_on')}
              offLabel={$t('admin.frameleaf_ml_destinations_enabled_off')}
              disabled={busy !== null}
              onChange={(checked) => void setEnabled(destination, checked)}
            />
          </header>

          <p class="endpoint">
            {#if destination.kind === MlDestinationKind.FrameleafCloud}
              {destination.cloud?.region
                ? $t('admin.frameleaf_ml_destinations_cloud_endpoint_region', {
                    values: { region: destination.cloud.region },
                  })
                : $t('admin.frameleaf_ml_destinations_cloud_endpoint')}
            {:else if destination.url}
              <code>{destination.url}</code>
            {:else}
              {$t('admin.frameleaf_ml_destinations_no_url')}
            {/if}
          </p>

          <div class="workloads" aria-label={$t('admin.frameleaf_ml_destinations_allowed_workloads')}>
            {#if destination.workloads.length === 0}
              <span class="muted">{$t('admin.frameleaf_ml_destinations_no_workloads')}</span>
            {:else}
              {#each ML_WORKLOAD_ORDER.filter( (workload) => destination.workloads.includes(workload) ) as workload (workload)}
                {@const served = destination.health.servedWorkloads?.includes(workload) ?? false}
                <Chip
                  label={served
                    ? $t(mlWorkloadLabelKey(workload))
                    : $t('admin.frameleaf_ml_destinations_workload_not_served', {
                        values: { workload: $t(mlWorkloadLabelKey(workload)) },
                      })}
                  selected={served}
                />
              {/each}
            {/if}
          </div>

          <dl class="facts">
            <div>
              <dt>{$t('admin.frameleaf_ml_destinations_last_probe')}</dt>
              <dd>
                {#if destination.health.probedAt}
                  {formatDate(destination.health.probedAt)}
                  {#if destination.health.summary}<span class="muted"> · {destination.health.summary}</span>{/if}
                {:else}
                  {$t('admin.frameleaf_ml_destinations_never_probed')}
                {/if}
              </dd>
            </div>
            {#if destination.consent.required}
              <div>
                <dt>{$t('admin.frameleaf_ml_destinations_consent')}</dt>
                <dd>
                  {#if destination.consent.acknowledgedAt && isConsentOutdated(destination)}
                    {$t('admin.frameleaf_ml_destinations_consent_outdated', {
                      values: {
                        version: destination.consent.version ?? '',
                        required: destination.consent.requiredVersion ?? '',
                      },
                    })}
                  {:else if destination.consent.acknowledgedAt}
                    {destination.consent.version
                      ? $t('admin.frameleaf_ml_destinations_consent_version_recorded_at', {
                          values: {
                            version: destination.consent.version,
                            date: formatDate(destination.consent.acknowledgedAt),
                          },
                        })
                      : $t('admin.frameleaf_ml_destinations_consent_recorded_at', {
                          values: { date: formatDate(destination.consent.acknowledgedAt) },
                        })}
                  {:else}
                    {$t('admin.frameleaf_ml_destinations_consent_needed')}
                  {/if}
                </dd>
              </div>
            {/if}
            <div>
              <dt>{$t('admin.frameleaf_ml_destinations_budget')}</dt>
              <dd>
                {#if destination.costControls.budgetLimitUsd === null}
                  {$t('admin.frameleaf_ml_destinations_no_limit')}
                {:else}
                  {$t('admin.frameleaf_ml_destinations_budget_spent', {
                    values: {
                      spent: formatUsd(destination.costControls.spentUsd),
                      limit: formatUsd(destination.costControls.budgetLimitUsd),
                      days: destination.costControls.budgetWindowDays,
                    },
                  })}
                {/if}
              </dd>
            </div>
            <div>
              <dt>{$t('admin.frameleaf_ml_destinations_max_runtime')}</dt>
              <dd>
                {destination.costControls.maxRuntimeMinutes === null
                  ? $t('admin.frameleaf_ml_destinations_no_limit')
                  : $t('admin.frameleaf_ml_destinations_minutes', {
                      values: { count: destination.costControls.maxRuntimeMinutes },
                    })}
              </dd>
            </div>
            {#if destination.cloud}
              <div>
                <dt>{$t('admin.frameleaf_ml_destinations_cloud_wallet')}</dt>
                <dd>
                  {$t('admin.frameleaf_ml_destinations_cloud_wallet_value', {
                    values: {
                      available: formatUsd(destination.cloud.balanceUsd - destination.cloud.heldUsd),
                      held: formatUsd(destination.cloud.heldUsd),
                    },
                  })}
                </dd>
              </div>
              {#if destination.cloud.refusal}
                <div>
                  <dt>{$t('admin.frameleaf_cloud_ml_last_refusal')}</dt>
                  <dd>{$t(mlRefusalLabelKey(destination.cloud.refusal))}</dd>
                </div>
              {/if}
            {/if}
            {#if destination.sharesLibraryHardware}
              <div>
                <dt>{$t('admin.frameleaf_ml_destinations_shares_hardware')}</dt>
                <dd>{$t('admin.frameleaf_ml_destinations_shares_hardware_on')}</dd>
              </div>
            {/if}
            <div>
              <dt>{$t('admin.frameleaf_ml_destinations_max_upload')}</dt>
              <dd>
                {destination.costControls.maxUploadBytes === null
                  ? $t('admin.frameleaf_ml_destinations_no_limit')
                  : $t('admin.frameleaf_ml_destinations_megabytes', {
                      values: { count: Math.round(destination.costControls.maxUploadBytes / 1_000_000) },
                    })}
              </dd>
            </div>
          </dl>

          <div class="actions">
            <Button onclick={() => void probe(destination)} disabled={busy !== null}>
              {busy === `probe-${destination.id}`
                ? $t('admin.frameleaf_ml_destinations_probing')
                : $t('admin.frameleaf_ml_destinations_probe')}
            </Button>
            <Button onclick={() => openEdit(destination)} disabled={busy !== null}>{$t('edit')}</Button>
            {#if allowsRestoration(destination)}
              <Button
                onclick={() => {
                  restorationTarget = destination;
                  restorationOpen = true;
                }}
                disabled={busy !== null}
              >
                {$t('admin.frameleaf_restoration_models_action')}
              </Button>
            {/if}
            {#if destination.consent.required}
              {#if isConsentBlocking(destination)}
                <Button variant="primary" onclick={() => void openConsent(destination)} disabled={busy !== null}>
                  {$t('admin.frameleaf_cloud_ml_consent_review')}
                </Button>
              {/if}
              {#if destination.consent.acknowledgedAt}
                <Button onclick={() => void revokeConsent(destination)} disabled={busy !== null}>
                  {$t('admin.frameleaf_ml_destinations_revoke_consent')}
                </Button>
              {/if}
            {/if}
            {#if destination.kind !== MlDestinationKind.Local}
              <Button
                variant="quiet"
                onclick={() => {
                  deleteTarget = destination;
                  deleteOpen = true;
                }}
                disabled={busy !== null}
              >
                {$t('delete')}
              </Button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
  {/if}

  <section class="routes" aria-labelledby="ml-routes-heading">
    <h3 id="ml-routes-heading">{$t('admin.frameleaf_ml_destinations_routes_title')}</h3>
    <p>{$t('admin.frameleaf_ml_destinations_routes_description')}</p>
    <ul class="route-list">
      {#each ML_WORKLOAD_ORDER as workload (workload)}
        {@const options = routableDestinations(destinations, workload)}
        {@const current = routeFor(workload)}
        {@const currentStillValid = current !== null && options.some((option) => option.id === current)}
        <li class="route">
          <label for={`ml-route-${workload}`}>{$t(mlWorkloadLabelKey(workload))}</label>
          <select
            id={`ml-route-${workload}`}
            value={currentStillValid ? current : ''}
            disabled={busy !== null}
            onchange={(event) => void setRoute(workload, (event.currentTarget as HTMLSelectElement).value)}
          >
            <option value="">{$t('admin.frameleaf_ml_destinations_route_none')}</option>
            {#each options as option (option.id)}
              <option value={option.id}>{option.name} · {$t(mlDestinationKindLabelKey(option.kind))}</option>
            {/each}
          </select>
          <span class="route-state" class:refused={current === null || !currentStillValid}>
            {#if current === null}
              {$t('admin.frameleaf_ml_destinations_route_refused')}
            {:else if !currentStillValid}
              {$t('admin.frameleaf_ml_destinations_route_blocked', {
                values: { name: routedName(workload) ?? current },
              })}
            {:else}
              {$t('admin.frameleaf_ml_destinations_route_active', {
                values: { name: routedName(workload) ?? current },
              })}
            {/if}
          </span>
        </li>
      {/each}
    </ul>
    <p class="muted">
      {$t('admin.frameleaf_ml_destinations_routes_note', {
        values: {
          eligible: destinations.filter((destination) => canRouteTo(destination, ML_WORKLOAD_ORDER[0])).length,
        },
      })}
    </p>
  </section>
</Pane>

{#if cloudConsent && consentTarget}
  <CloudMlConsentDialog
    bind:open={cloudConsentOpen}
    destinationId={consentTarget.id}
    consent={cloudConsent}
    region={cloudRegion}
    onRecorded={() => {
      statusMessage = $t('admin.frameleaf_ml_destinations_consent_recorded', {
        values: { name: consentTarget?.name ?? '' },
      });
      void refresh();
    }}
  />
{/if}

<RestorationModelsDialog destination={restorationTarget} bind:open={restorationOpen} />

<Dialog
  title={$t('admin.frameleaf_ml_destinations_delete_dialog_title')}
  closeLabel={$t('close')}
  bind:open={deleteOpen}
>
  <div class="dialog-body">
    <p>{$t('admin.frameleaf_ml_destinations_delete_dialog_body', { values: { name: deleteTarget?.name ?? '' } })}</p>
    <div class="dialog-actions">
      <Button onclick={() => (deleteOpen = false)} disabled={busy !== null}>{$t('cancel')}</Button>
      <Button variant="primary" onclick={confirmDelete} disabled={busy !== null}>{$t('delete')}</Button>
    </div>
  </div>
</Dialog>

<Dialog
  title={draft?.id ? $t('admin.frameleaf_ml_destinations_edit_title') : $t('admin.frameleaf_ml_destinations_add_title')}
  closeLabel={$t('close')}
  bind:open={draftOpen}
>
  {#if draft}
    <form
      class="dialog-body"
      onsubmit={(event) => {
        event.preventDefault();
        void saveDraft();
      }}
    >
      <p class="muted">{$t(mlDestinationKindLabelKey(draft.kind))}</p>
      <label>
        {$t('name')}
        <input type="text" bind:value={draft.name} maxlength="80" required />
      </label>
      {#if draft.kind !== MlDestinationKind.FrameleafCloud}
        <label>
          {$t('url')}
          <input
            type="url"
            bind:value={draft.url}
            placeholder="http://machine-learning:3003"
            required={draft.kind === MlDestinationKind.Lan}
          />
        </label>
        <label>
          {$t('admin.frameleaf_ml_destinations_auth_token')}
          <input type="password" bind:value={draft.authToken} autocomplete="off" />
          <small class="muted">{$t('admin.frameleaf_ml_destinations_auth_token_hint')}</small>
        </label>
      {:else}
        <p class="muted">{$t('admin.frameleaf_ml_destinations_cloud_hint')}</p>
      {/if}
      <fieldset>
        <legend>{$t('admin.frameleaf_ml_destinations_allowed_workloads')}</legend>
        {#each workloadsForKind(draft.kind) as workload (workload)}
          <label class="check">
            <input
              type="checkbox"
              checked={draft.workloads.includes(workload)}
              disabled={workloadBlockedInDraft(draft.kind, draft.workloads, workload)}
              onchange={(event) => toggleWorkload(workload, (event.currentTarget as HTMLInputElement).checked)}
            />
            {$t(mlWorkloadLabelKey(workload))}
          </label>
        {/each}
        {#if draft.kind !== MlDestinationKind.FrameleafCloud}
          <small class="muted">{$t('admin.frameleaf_ml_destinations_roles_hint')}</small>
        {/if}
      </fieldset>
      {#if canShareHardware(draft)}
        <label class="check">
          <input type="checkbox" bind:checked={draft.sharesLibraryHardware} />
          {$t('admin.frameleaf_ml_destinations_shares_hardware_label')}
        </label>
        <small class="muted">{$t('admin.frameleaf_ml_destinations_shares_hardware_hint')}</small>
      {/if}
      <fieldset>
        <legend>{$t('admin.frameleaf_ml_destinations_cost_controls')}</legend>
        <label>
          {$t('admin.frameleaf_ml_destinations_budget_limit')}
          <input type="number" min="0" step="0.01" bind:value={draft.budgetLimitUsd} inputmode="decimal" />
        </label>
        <label>
          {$t('admin.frameleaf_ml_destinations_max_runtime')}
          <input type="number" min="1" step="1" bind:value={draft.maxRuntimeMinutes} inputmode="numeric" />
        </label>
        <label>
          {$t('admin.frameleaf_ml_destinations_max_upload_mb')}
          <input type="number" min="1" step="1" bind:value={draft.maxUploadMb} inputmode="numeric" />
        </label>
        <small class="muted">{$t('admin.frameleaf_ml_destinations_limits_hint')}</small>
      </fieldset>
      {#if draftError}
        <p class="error" role="alert">{draftError}</p>
      {/if}
      <div class="dialog-actions">
        <Button onclick={() => (draftOpen = false)} disabled={busy !== null}>{$t('cancel')}</Button>
        <Button type="submit" variant="primary" disabled={busy !== null}>{$t('save')}</Button>
      </div>
    </form>
  {/if}
</Dialog>

<style>
  .head {
    display: flex;
    align-items: flex-start;
    justify-content: space-between;
    gap: 1rem;
    flex-wrap: wrap;
    margin-bottom: 1rem;
  }
  .head h2 {
    font-size: var(--fl-font-size);
    margin: 0 0 0.25rem;
  }
  .head p,
  .empty,
  .muted,
  .routes p,
  .endpoint {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .link-button {
    font-size: var(--fl-font-small);
    color: var(--fl-accent);
    align-self: center;
  }
  .head-actions,
  .actions,
  .dialog-actions {
    display: flex;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .dialog-actions {
    justify-content: flex-end;
    margin-top: 0.5rem;
  }
  .destinations,
  .route-list {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
  }
  .destination {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 0.875rem;
    display: flex;
    flex-direction: column;
    gap: 0.625rem;
  }
  .destination header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .identity {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    flex-wrap: wrap;
  }
  .endpoint code {
    font-size: var(--fl-font-small);
    color: var(--fl-text);
  }
  .workloads {
    display: flex;
    gap: 0.375rem;
    flex-wrap: wrap;
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(14rem, 1fr));
    gap: 0.5rem 1rem;
    margin: 0;
  }
  .facts dt {
    font-size: var(--fl-font-micro);
    color: var(--fl-muted);
    text-transform: uppercase;
    letter-spacing: 0.02em;
  }
  .facts dd {
    margin: 0;
    font-size: var(--fl-font-small);
  }
  .routes {
    margin-top: 1.25rem;
    border-top: 1px solid var(--fl-border);
    padding-top: 1rem;
  }
  .routes h3 {
    font-size: var(--fl-font-size);
    margin: 0 0 0.25rem;
  }
  .route-list {
    margin-top: 0.75rem;
  }
  .route {
    display: grid;
    grid-template-columns: minmax(9rem, 1fr) minmax(12rem, 2fr) minmax(10rem, 2fr);
    gap: 0.75rem;
    align-items: center;
  }
  @media (width < 40rem) {
    .route {
      grid-template-columns: 1fr;
    }
  }
  .route select,
  .dialog-body input[type='text'],
  .dialog-body input[type='url'],
  .dialog-body input[type='password'],
  .dialog-body input[type='number'] {
    width: 100%;
    padding: 0.4375rem 0.625rem;
    font-size: var(--fl-font-small);
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-muted);
    border-radius: var(--fl-radius-control);
  }
  .route-state {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .route-state.refused {
    color: var(--fl-warning);
  }
  .dialog-body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    color: var(--fl-text);
  }
  .dialog-body label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: var(--fl-font-small);
  }
  .dialog-body fieldset {
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    padding: 0.625rem 0.75rem;
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .dialog-body legend {
    font-size: var(--fl-font-small);
    padding-inline: 0.25rem;
  }
  .check {
    flex-direction: row !important;
    align-items: center;
    gap: 0.5rem !important;
  }
  .error {
    margin: 0;
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
</style>
