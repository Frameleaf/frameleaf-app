<script lang="ts">
  import { goto } from '$app/navigation';
  import { gotoWithFocusAndScroll } from '$lib/utils/navigation';
  import { page } from '$app/state';
  import ApplicationSetup from '$lib/components/frameleaf/ApplicationSetup.svelte';
  import WorkflowsPanel from '$lib/components/frameleaf/WorkflowsPanel.svelte';
  import DuplicateUtility from '$lib/components/frameleaf/DuplicateUtility.svelte';
  import FileTrashUtility from '$lib/components/frameleaf/FileTrashUtility.svelte';
  import LargeFilesUtility from '$lib/components/frameleaf/LargeFilesUtility.svelte';
  import LivePhotosUtility from '$lib/components/frameleaf/LivePhotosUtility.svelte';
  import GeolocationUtility from '$lib/components/frameleaf/GeolocationUtility.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import ICloudSyncPanel from '$lib/components/frameleaf/ICloudSyncPanel.svelte';
  import LibraryCareHealth from '$lib/components/frameleaf/LibraryCareHealth.svelte';
  import SettingsDirectory, { type DirectoryRow } from '$lib/components/frameleaf/settings/SettingsDirectory.svelte';
  import SettingsOverline from '$lib/components/frameleaf/settings/SettingsOverline.svelte';
  import UtilityHistory from '$lib/components/frameleaf/UtilityHistory.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import {
    LIBRARY_CARE_TOOLS,
    RARELY_NEEDED_UTILITIES,
    UTILITY_GROUPS,
    utilityStates,
    utilityTool,
    utilityToolsFor,
    type UtilityId,
    type UtilityState,
  } from '$lib/frameleaf/utilities';
  import { loadUtility, type UtilityData } from '$lib/frameleaf/utilities-load';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { getUtilitiesSummary, type UtilitiesSummaryResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiClipboardAlertOutline, mdiClipboardCheckOutline } from '@mdi/js';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  let { query = '', onNavigate }: { query?: string; onNavigate?: () => void } = $props();
  const tools = $derived(utilityToolsFor(authManager.user.isAdmin));
  const requestedStatus = $derived(page.url.searchParams.get('status'));
  const selected = $derived(utilityTool(page.url.searchParams.get('section')));
  const denied = $derived(selected?.adminOnly && !authManager.user.isAdmin);
  // A repair tool opened from Library care says so and goes back there (design review finding 67).
  const fromCare = $derived(
    page.url.searchParams.get('from') === 'care' && !!selected && LIBRARY_CARE_TOOLS.includes(selected.id),
  );
  const matches = $derived(
    tools.filter((tool) =>
      `${$t(tool.titleKey)} ${$t(tool.descriptionKey)}`.toLowerCase().includes(query.trim().toLowerCase()),
    ),
  );
  let data = $state<UtilityData | null>(null);
  let failed = $state(false);
  let retry = $state(0);

  $effect(() => {
    const tool = selected;
    const isAdmin = authManager.user.isAdmin;
    const status = requestedStatus;
    void retry;
    data = null;
    failed = false;
    if (!tool || (tool.adminOnly && !isAdmin) || query.trim()) {
      return;
    }
    let active = true;
    const url = untrack(() => new URL(page.url.href));
    if (status) {
      url.searchParams.set('status', status);
    }
    void loadUtility(tool.id, url, isAdmin)
      .then((result) => {
        if (active) {
          data = result;
        }
      })
      .catch(() => {
        if (active) {
          failed = true;
        }
      });
    return () => {
      active = false;
    };
  });

  // FL-519: one cheap call says what each tool has waiting; the directory works without it.
  let summary = $state<UtilitiesSummaryResponseDto | null>(null);
  const loadSummary = async () => {
    try {
      summary = await getUtilitiesSummary();
    } catch {
      summary = null;
    }
  };
  $effect(() => {
    if (!selected) {
      void loadSummary();
    }
  });
  const states = $derived(summary ? utilityStates(summary) : {});
  const waiting = $derived(tools.filter((tool) => states[tool.id]?.waiting));
  const statusText = (id: UtilityId, state: UtilityState) => {
    switch (id) {
      case 'duplicates': {
        return $t('frameleaf_utilities_state_duplicates', { values: { count: state.count } });
      }
      case 'geolocation': {
        return $t('frameleaf_utilities_state_no_place', { values: { count: state.count } });
      }
      case 'missing-media': {
        return $t('frameleaf_utilities_state_missing', { values: { count: state.count } });
      }
      case 'corrupt-media': {
        return $t('frameleaf_utilities_state_damaged', { values: { count: state.count } });
      }
      default: {
        return $t('frameleaf_utilities_state_unused', {
          values: { count: state.count, size: formatBytes(state.bytes ?? 0) },
        });
      }
    }
  };
  const statusOf = (id: UtilityId) => {
    const state = states[id];
    return state && { text: statusText(id, state), tone: state.waiting ? ('warn' as const) : ('off' as const) };
  };

  // The template lists Utilities as an ordinary area directory: grouped rows, each with its tool's
  // icon (UT-12; CommandCenter.jsx:2739, utilities-data.mjs:15-87), no scope tag (every tool works
  // on the signed-in account's own library).
  // FL-519: tools with something waiting come first, under "Needs a look"; the rarely needed ones
  // sit under a closed Advanced at the end (a search shows every match in its usual group).
  const searching = $derived(query.trim() !== '');
  const rowOf = (tool: (typeof tools)[number], group: string): DirectoryRow => ({
    id: tool.id,
    title: $t(tool.titleKey),
    description: $t(tool.descriptionKey),
    group,
    icon: tool.icon,
    status: statusOf(tool.id),
    onSelect: () => void select(tool.id),
  });
  const rows = $derived([
    ...(searching ? [] : waiting.map((tool) => rowOf(tool, $t('frameleaf_utilities_needs_look')))),
    ...UTILITY_GROUPS.flatMap((group) =>
      matches
        .filter((tool) => tool.group === group)
        .filter((tool) => searching || (!waiting.includes(tool) && !RARELY_NEEDED_UTILITIES.includes(tool.id)))
        .map((tool) => rowOf(tool, $t(`library_care_group_${group}`))),
    ),
  ]);
  const rareRows = $derived(
    searching
      ? []
      : tools
          .filter((tool) => RARELY_NEEDED_UTILITIES.includes(tool.id) && !waiting.includes(tool))
          .map((tool) => rowOf(tool, '')),
  );

  const select = (section?: UtilityId) => {
    onNavigate?.();
    if (!section && fromCare) {
      return goto(commandCenterUrl('care', undefined, { scope: page.url.searchParams.get('scope') ?? undefined }));
    }
    const url = new URL(page.url.href);
    for (const key of ['section', 'assetId', 'status', 'at', 'index', 'workflowId', 'from']) {
      url.searchParams.delete(key);
    }
    if (section) {
      url.searchParams.set('section', section);
    }
    return goto(`${url.pathname}${url.search}`, { reset: false });
  };
</script>

<header class="heading">
  <SettingsOverline>
    {#if selected && !query.trim()}
      <button type="button" onclick={() => select()}
        >{fromCare ? $t('frameleaf_settings_area_care') : $t('utilities')}</button
      >
      <Icon icon={mdiChevronRight} size="0.875rem" aria-hidden={true} />
      {$t(selected.titleKey)}
    {:else}
      {$t('frameleaf_settings_group_library')}
    {/if}
  </SettingsOverline>
  <h1>{selected && !query.trim() ? $t(selected.titleKey) : $t('utilities')}</h1>
  <p>{selected && !query.trim() ? $t(selected.descriptionKey) : $t('frameleaf_utilities_description')}</p>
</header>

{#if denied}
  <InlineError compact message={$t('frameleaf_utilities_admin_required')} />
{:else if !selected || query.trim()}
  {#if summary && !query.trim()}
    {#if waiting.length > 0}
      <Hero
        tone="warn"
        icon={mdiClipboardAlertOutline}
        label={$t('utilities')}
        title={$t('frameleaf_utilities_waiting_title', { values: { count: waiting.length } })}
        body={$t('frameleaf_utilities_waiting_body')}
      />
    {:else}
      <Hero
        icon={mdiClipboardCheckOutline}
        label={$t('utilities')}
        title={$t('frameleaf_utilities_calm_title')}
        body={$t('frameleaf_utilities_calm_body')}
      />
    {/if}
  {/if}
  <SettingsDirectory {rows} areaTitle={$t('utilities')} />
  {#if rareRows.length > 0}
    <Advanced summary={$t('frameleaf_utilities_rarely_needed')}>
      <SettingsDirectory rows={rareRows} />
    </Advanced>
  {/if}
  {#if matches.length === 0}<p role="status">{$t('frameleaf_settings_search_empty', { values: { query } })}</p>{/if}
{:else if failed}
  <InlineError message={$t('frameleaf_utilities_load_error')} onRetry={() => retry++} />
{:else if data}
  {#key data}
    <div class="tool">
      {#if data.tool === 'duplicates'}<DuplicateUtility {data} />
      {:else if data.tool === 'large-files'}<LargeFilesUtility {data} />
      {:else if data.tool === 'live-photos'}<LivePhotosUtility {data} />
      {:else if data.tool === 'geolocation'}<GeolocationUtility />
      {:else if data.tool === 'workflows'}
        {#key page.url.searchParams.get('workflowId')}
          <WorkflowsPanel
            openId={page.url.searchParams.get('workflowId') ?? undefined}
            onOpenClosed={() => {
              const url = new URL(page.url.href);
              url.searchParams.delete('workflowId');
              void gotoWithFocusAndScroll(`${url.pathname}${url.search}`, { replace: true, noScroll: true });
            }}
          />
        {/key}
      {:else if data.tool === 'downloads' || data.tool === 'obtainium'}
        <ApplicationSetup tool={data.tool} />
      {:else if data.tool === 'icloud'}<ICloudSyncPanel initial={data.initial} />
      {:else if data.tool === 'file-trash'}<FileTrashUtility initial={data.initial} />
      {:else if data.tool === 'missing-media' || data.tool === 'corrupt-media'}
        <LibraryCareHealth
          category={data.category}
          initial={data.mediaHealth}
          initialSummary={data.summary}
          initialStatus={data.status}
          roots={data.roots}
          users={data.users}
          initialOwner={data.owner}
        />
      {/if}
      <!-- UT-11: every tool but Duplicate review shows the shared history (UtilitiesManager.jsx:946);
           Missing and Damaged media show Library Care's own, with its scans and searches. -->
      {#if !['duplicates', 'missing-media', 'corrupt-media', 'file-trash'].includes(data.tool)}
        <UtilityHistory />
      {/if}
    </div>
  {/key}
{:else}
  <div class="tool-loading" role="status" aria-busy="true">
    <span class="sr-only">{$t('loading')}</span>
    <Skeleton variant="block" height="3.5rem" />
    <Skeleton variant="block" height="14rem" />
    <Skeleton variant="text" lines={3} />
  </div>
{/if}

<style>
  .heading {
    margin: 0 0 1.25rem;
  }
  .heading h1 {
    margin: 0;
    font-size: 1.75rem;
    font-weight: 550;
    letter-spacing: -0.02em;
  }
  .heading > p:last-child {
    margin: 0.5rem 0 0;
    color: var(--fl-muted);
    font-size: 0.75rem;
    line-height: 1.6;
  }
  button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .tool {
    min-width: 0;
  }
  .tool-loading {
    display: grid;
    gap: var(--fl-space-4);
    max-width: 820px;
  }
</style>
