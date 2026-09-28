<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import Albums from '$lib/components/album-page/AlbumsList.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import LibraryEmptyState from '$lib/components/frameleaf/LibraryEmptyState.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { brandedArchiveName } from '$lib/frameleaf/archive-name';
  import type { BulkActionId } from '$lib/frameleaf/bulk-actions';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { albumViewSettings } from '$lib/stores/preferences.store';
  import { navigate } from '$lib/utils/navigation';
  import { AssetVisibility, getAuthStatus } from '@immich/sdk';
  import { mdiEyeOffOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * Suppressed content (FL-33 cleanup): the Frameleaf library over the suppressed items, with the
   * albums tab unchanged.
   *
   * Taking an item out of here and into an album still needs an elevated session, so that check
   * stays in front of the action rather than in front of a button: `beforeAction` gates
   * "add to album" exactly as the legacy select bar's own AddToAlbum override did.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  let pendingTab: 'timeline' | 'albums' | undefined = $state();
  let activeTab: 'timeline' | 'albums' = $derived(pendingTab ?? (data.tab === 'albums' ? 'albums' : 'timeline'));
  let searchQuery = $state('');
  let albumGroups: string[] = $state([]);

  const options = {
    visibility: AssetVisibility.Timeline,
    withStacked: true,
    withPartners: true,
    suppressedOnly: true,
  };

  const setTab = async (tab: 'timeline' | 'albums') => {
    pendingTab = tab;
    try {
      await goto(Route.suppressed({ tab }), { keepFocus: true, noScroll: true, replaceState: true });
    } finally {
      pendingTab = undefined;
    }
  };

  const ensureElevatedSession = async () => {
    const { isElevated, pinCode } = await getAuthStatus();
    if (isElevated && pinCode) {
      return true;
    }

    await goto(Route.pinPrompt({ continue: page.url.pathname + page.url.search }));
    return false;
  };

  const beforeAction = async (action: BulkActionId) =>
    action === 'add-to-album' ? await ensureElevatedSession() : true;
</script>

<UserPageLayout title={data.meta.title} scrollbar={false}>
  {#snippet buttons()}
    <div class="inline-flex rounded-full border border-gray-300 bg-gray-50 p-1 dark:border-gray-700 dark:bg-gray-900">
      <button
        type="button"
        class="rounded-full px-4 py-1.5 text-sm transition-colors"
        class:bg-primary={activeTab === 'timeline'}
        class:text-white={activeTab === 'timeline'}
        class:dark:text-immich-dark-gray={activeTab === 'timeline'}
        onclick={() => setTab('timeline')}
      >
        {$t('timeline')}
      </button>
      <button
        type="button"
        class="rounded-full px-4 py-1.5 text-sm transition-colors"
        class:bg-primary={activeTab === 'albums'}
        class:text-white={activeTab === 'albums'}
        class:dark:text-immich-dark-gray={activeTab === 'albums'}
        onclick={() => setTab('albums')}
      >
        {$t('albums')}
      </button>
    </div>
  {/snippet}

  {#if activeTab === 'timeline'}
    <LibraryView
      bind:timelineManager
      {options}
      destination={{ kind: 'library' }}
      {beforeAction}
      downloadFileName={brandedArchiveName($t('frameleaf_archive_name_suppressed'))}
      enableRouting
      selectAll="loaded"
      onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
    >
      {#snippet empty()}
        <LibraryEmptyState
          icon={mdiEyeOffOutline}
          title={$t('nothing_here_yet')}
          message={$t('no_suppressed_content_message')}
        />
      {/snippet}

      {#snippet viewer()}
        <Portal target="body">
          {#if assetViewerManager.isViewing}
            <TimelineAssetViewer bind:invisible={viewerInvisible} {timelineManager} withStacked />
          {/if}
        </Portal>
      {/snippet}
    </LibraryView>
  {:else}
    <div class="h-full overflow-y-auto p-4 md:px-6">
      <Albums
        ownedAlbums={data.ownedAlbums}
        sharedAlbums={data.sharedAlbums}
        userSettings={$albumViewSettings}
        showOwner
        {searchQuery}
        getAlbumHref={Route.suppressedAlbum}
        bind:albumGroupIds={albumGroups}
      >
        {#snippet empty()}
          <LibraryEmptyState
            icon={mdiEyeOffOutline}
            title={$t('nothing_here_yet')}
            message={$t('no_suppressed_albums_message')}
          />
        {/snippet}
      </Albums>
    </div>
  {/if}
</UserPageLayout>
