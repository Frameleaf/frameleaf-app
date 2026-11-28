<script lang="ts">
  import { goto } from '$app/navigation';
  import { gotoWithFocusAndScroll } from '$lib/utils/navigation';
  import { page } from '$app/state';
  import MobileApps from '$lib/components/frameleaf/settings/utilities/MobileApps.svelte';
  import Phones from '$lib/components/frameleaf/settings/utilities/Phones.svelte';
  import WorkflowsPanel from '$lib/components/frameleaf/WorkflowsPanel.svelte';
  import DuplicateUtility from '$lib/components/frameleaf/DuplicateUtility.svelte';
  import LargeFilesUtility from '$lib/components/frameleaf/LargeFilesUtility.svelte';
  import LivePhotosUtility from '$lib/components/frameleaf/LivePhotosUtility.svelte';
  import GeolocationUtility from '$lib/components/frameleaf/GeolocationUtility.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import LocationHistoryUtility from '$lib/components/frameleaf/LocationHistoryUtility.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import ICloudReview from '$lib/components/frameleaf/ICloudReview.svelte';
  import ICloudSyncPanel from '$lib/components/frameleaf/ICloudSyncPanel.svelte';
  import LibraryCareHealth from '$lib/components/frameleaf/LibraryCareHealth.svelte';
  import SettingsOverline from '$lib/components/frameleaf/settings/SettingsOverline.svelte';
  import UtilityHistory from '$lib/components/frameleaf/UtilityHistory.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { isImportTool, utilityTool } from '$lib/frameleaf/utilities';
  import { loadUtility, type UtilityData } from '$lib/frameleaf/utilities-load';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight } from '@mdi/js';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  let { onNavigate }: { onNavigate?: () => void } = $props();
  const requestedStatus = $derived(page.url.searchParams.get('status'));
  const selected = $derived(utilityTool(page.url.searchParams.get('section')));
  // FL-416: File trash is Library care › Unused files now; an old address opens it there.
  $effect(() => {
    if (page.url.searchParams.get('section') === 'file-trash') {
      void goto(commandCenterUrl('care', 'unused-files'), { replaceState: true });
    }
  });
  const parentTool = $derived(selected?.parent ? utilityTool(selected.parent) : undefined);
  const denied = $derived(selected?.adminOnly && !authManager.user.isAdmin);
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
    if (!tool || (tool.adminOnly && !isAdmin)) {
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

  // The iCloud review is a page of the tool, so Back and a reload stay on it.
  const reviewConnection = $derived.by(() => {
    const id = page.url.searchParams.get('review');
    return data?.tool === 'icloud' && data.initial.connections.some((connection) => connection.id === id) ? id : null;
  });
  const closeICloudReview = async () => {
    const url = new URL(page.url.href);
    url.searchParams.delete('review');
    await goto(`${url.pathname}${url.search}`, { reset: false });
    retry++; // the counts changed
  };

  /**
   * FL-1807: the Tools directory is gone. Every tool has one home its heading leads back to: Import
   * for the ways photos come in (FL-1808), Library care for the rest.
   */
  const home = $derived(
    isImportTool(selected?.id)
      ? { title: $t('frameleaf_settings_area_backup'), href: commandCenterUrl('backup') }
      : {
          title: $t('frameleaf_library_care'),
          href: commandCenterUrl('care', undefined, { scope: page.url.searchParams.get('scope') ?? undefined }),
        },
  );
  // An old link to the directory, or to a tool that no longer exists, opens Library care.
  $effect(() => {
    if (!selected && page.url.searchParams.get('section') !== 'file-trash') {
      void goto(home.href, { replaceState: true });
    }
  });

  const back = () => {
    onNavigate?.();
    if (!parentTool) {
      return goto(home.href);
    }
    const url = new URL(page.url.href);
    for (const key of ['assetId', 'status', 'at', 'index', 'from', 'phone', 'review']) {
      url.searchParams.delete(key);
    }
    url.searchParams.set('section', parentTool.id);
    return goto(`${url.pathname}${url.search}`, { reset: false });
  };
</script>

{#if selected}
  <header class="heading">
    <SettingsOverline>
      <button type="button" onclick={back}>{parentTool ? $t(parentTool.titleKey) : home.title}</button>
      <Icon icon={mdiChevronRight} size="0.875rem" aria-hidden={true} />
      {$t(selected.titleKey)}
    </SettingsOverline>
    <h1>{$t(selected.titleKey)}</h1>
    <p>{$t(selected.descriptionKey)}</p>
  </header>
{/if}

{#if !selected}
  <div class="tool-loading" role="status" aria-busy="true"><span class="sr-only">{$t('loading')}</span></div>
{:else if denied}
  <InlineError compact message={$t('frameleaf_utilities_admin_required')} />
{:else if failed}
  <InlineError message={$t('frameleaf_utilities_load_error')} onRetry={() => retry++} />
{:else if data}
  {#key data}
    <div class="tool">
      {#if data.tool === 'duplicates'}<DuplicateUtility {data} />
      {:else if data.tool === 'large-files'}<LargeFilesUtility {data} />
      {:else if data.tool === 'live-photos'}<LivePhotosUtility {data} />
      {:else if data.tool === 'geolocation'}<GeolocationUtility />
      {:else if data.tool === 'location-history'}<LocationHistoryUtility />
      {:else if data.tool === 'workflows'}
        {#key page.url.searchParams.get('workflowId') ?? page.url.searchParams.get('workflowQuery') ?? page.url.searchParams.get('workflowAlbum')}
          <WorkflowsPanel
            workflowQuery={page.url.searchParams.get('workflowQuery') ?? undefined}
            workflowAlbum={page.url.searchParams.get('workflowAlbum') ?? undefined}
            workflowName={page.url.searchParams.get('workflowName') ?? undefined}
            openId={page.url.searchParams.get('workflowId') ?? undefined}
            onOpenClosed={() => {
              const url = new URL(page.url.href);
              url.searchParams.delete('workflowId');
              url.searchParams.delete('workflowQuery');
              url.searchParams.delete('workflowName');
              url.searchParams.delete('workflowAlbum');
              void gotoWithFocusAndScroll(`${url.pathname}${url.search}`, { replace: true, noScroll: true });
            }}
          />
        {/key}
      {:else if data.tool === 'downloads'}<MobileApps />
      {:else if data.tool === 'phones'}<Phones />
      {:else if data.tool === 'icloud' && reviewConnection}
        <ICloudReview connectionId={reviewConnection} onBack={closeICloudReview} />
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
      {#if !['duplicates', 'missing-media', 'corrupt-media', 'location-history'].includes(data.tool)}
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
    margin: 0 0 22px;
  }
  /* SettingsHost `.cc-page-heading`: the same title and description as every settings page. */
  .heading h1 {
    margin: 0;
    font-size: var(--fl-font-display);
    font-weight: 600;
    letter-spacing: -0.9px;
    line-height: 1.3;
  }
  .heading > p:last-child {
    max-width: 72ch;
    margin: 6px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  @media (max-width: 1000px) {
    .heading h1 {
      font-size: 24px;
    }
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
