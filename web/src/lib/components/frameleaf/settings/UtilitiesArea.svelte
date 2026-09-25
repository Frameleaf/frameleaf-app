<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import ApplicationSetup from '$lib/components/frameleaf/ApplicationSetup.svelte';
  import WorkflowsPanel from '$lib/components/frameleaf/WorkflowsPanel.svelte';
  import DuplicateUtility from '$lib/components/frameleaf/DuplicateUtility.svelte';
  import LargeFilesUtility from '$lib/components/frameleaf/LargeFilesUtility.svelte';
  import LivePhotosUtility from '$lib/components/frameleaf/LivePhotosUtility.svelte';
  import GeolocationUtility from '$lib/components/frameleaf/GeolocationUtility.svelte';
  import ICloudSyncPanel from '$lib/components/frameleaf/ICloudSyncPanel.svelte';
  import LibraryCareHealth from '$lib/components/frameleaf/LibraryCareHealth.svelte';
  import SettingsDirectory, { type DirectoryRow } from '$lib/components/frameleaf/settings/SettingsDirectory.svelte';
  import SettingsOverline from '$lib/components/frameleaf/settings/SettingsOverline.svelte';
  import UtilityHistory from '$lib/components/frameleaf/UtilityHistory.svelte';
  import { UTILITY_GROUPS, utilityTool, utilityToolsFor, type UtilityId } from '$lib/frameleaf/utilities';
  import { loadUtility, type UtilityData } from '$lib/frameleaf/utilities-load';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  let { query = '', onNavigate }: { query?: string; onNavigate?: () => void } = $props();
  const tools = $derived(utilityToolsFor(authManager.user.isAdmin));
  const requestedStatus = $derived(page.url.searchParams.get('status'));
  const selected = $derived(utilityTool(page.url.searchParams.get('section')));
  const denied = $derived(selected?.adminOnly && !authManager.user.isAdmin);
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
    const url = untrack(() => new URL(page.url));
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

  // The template lists Utilities as an ordinary area directory: grouped rows, each with its tool's
  // icon (UT-12; CommandCenter.jsx:2739, utilities-data.mjs:15-87), no scope tag (every tool works
  // on the signed-in account's own library).
  const rows = $derived(
    UTILITY_GROUPS.flatMap((group) =>
      matches
        .filter((tool) => tool.group === group)
        .map((tool): DirectoryRow => ({
          id: tool.id,
          title: $t(tool.titleKey),
          description: $t(tool.descriptionKey),
          group: $t(`library_care_group_${group}`),
          icon: tool.icon,
          onSelect: () => void select(tool.id),
        })),
    ),
  );

  const select = (section?: UtilityId) => {
    onNavigate?.();
    const url = new URL(page.url);
    for (const key of ['section', 'assetId', 'status', 'at', 'index', 'workflowId']) {
      url.searchParams.delete(key);
    }
    if (section) {
      url.searchParams.set('section', section);
    }
    return goto(`${url.pathname}${url.search}`, { noScroll: true, keepFocus: true });
  };
</script>

<header class="heading">
  <SettingsOverline>
    {#if selected && !query.trim()}
      <button type="button" onclick={() => select()}>{$t('utilities')}</button>
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
  <p role="alert">{$t('frameleaf_utilities_admin_required')}</p>
{:else if !selected || query.trim()}
  <SettingsDirectory {rows} areaTitle={$t('utilities')} />
  {#if matches.length === 0}<p role="status">{$t('frameleaf_settings_search_empty', { values: { query } })}</p>{/if}
{:else if failed}
  <div role="alert">
    <p>{$t('frameleaf_utilities_load_error')}</p>
    <button type="button" onclick={() => retry++}>{$t('retry')}</button>
  </div>
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
              const url = new URL(page.url);
              url.searchParams.delete('workflowId');
              void goto(`${url.pathname}${url.search}`, { replaceState: true, noScroll: true });
            }}
          />
        {/key}
      {:else if data.tool === 'downloads' || data.tool === 'obtainium'}
        <ApplicationSetup tool={data.tool} />
      {:else if data.tool === 'icloud'}<ICloudSyncPanel initial={data.initial} />
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
      {#if !['duplicates', 'missing-media', 'corrupt-media'].includes(data.tool)}
        <UtilityHistory />
      {/if}
    </div>
  {/key}
{:else}<p role="status">{$t('loading')}</p>{/if}

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
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .tool {
    min-width: 0;
  }
</style>
