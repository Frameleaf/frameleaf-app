<script lang="ts">
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import LockedReasonFilter from '$lib/components/frameleaf/LockedReasonFilter.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import LibraryEmptyState from '$lib/components/frameleaf/LibraryEmptyState.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import { AssetAction } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { brandedArchiveName } from '$lib/frameleaf/archive-name';
  import { lockedTimelineOptions, parseLockedFilter, type LockedFilter } from '$lib/frameleaf/locked-view';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { getUserActions } from '$lib/services/user.service';
  import { navigate } from '$lib/utils/navigation';
  import { mdiShieldLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * Locked (FL-34): every item its owner locked, in one place, after the PIN.
   *
   * Locked is one lock per item, metadata that never relocates it: the item keeps its albums and
   * organisation and is hidden from every other view. Items that were in the old Locked folder when
   * the library was upgraded were moved into the lock, so they are here from the start; so are the
   * items locked by hand and the ones sensitive-content detection locked. The filter narrows by why
   * an item is locked (All by default), each tile says why, and Unlock returns an item exactly where
   * it was.
   *
   * `locked` in the bulk context keeps this destination's own action set — Unlock, add to album,
   * download, change date and location, and the permanent delete. An unlocked person may put locked
   * items in an album (owner decision, September 22, 2026); they stay locked, and the album hides them
   * outside this session. Sharing and the refresh jobs are not offered on locked items.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  let pendingFilter: LockedFilter | undefined = $state();
  const filter = $derived(pendingFilter ?? parseLockedFilter(page.url.searchParams.get('reason')));
  const options = $derived(lockedTimelineOptions(filter));

  const { LockSession } = $derived(getUserActions($t));

  const setFilter = async (next: LockedFilter) => {
    pendingFilter = next;
    try {
      await goto(Route.locked(next === 'all' ? undefined : { reason: next }), {
        keepFocus: true,
        noScroll: true,
        replaceState: true,
      });
    } finally {
      pendingFilter = undefined;
    }
  };

  const onSessionLocked = async () => {
    await goto(Route.photos());
  };
</script>

<OnEvents {onSessionLocked} />

<UserPageLayout title={data.meta.title} actions={[LockSession]} scrollbar={false}>
  {#snippet buttons()}
    <LockedReasonFilter value={filter} onChange={(next) => void setFilter(next)} />
  {/snippet}

  <LibraryView
    bind:timelineManager
    {options}
    destination={{ kind: 'library' }}
    bulkContext={{ locked: true }}
    downloadFileName={brandedArchiveName($t('frameleaf_archive_name_locked'))}
    enableRouting
    selectAll="loaded"
    onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
  >
    {#snippet empty()}
      <LibraryEmptyState
        icon={mdiShieldLockOutline}
        title={$t('nothing_here_yet')}
        message={$t('frameleaf_locked_empty')}
      />
    {/snippet}

    {#snippet viewer()}
      <Portal target="body">
        {#if assetViewerManager.isViewing}
          <TimelineAssetViewer
            bind:invisible={viewerInvisible}
            {timelineManager}
            removeAction={AssetAction.SET_VISIBILITY_TIMELINE}
          />
        {/if}
      </Portal>
    {/snippet}
  </LibraryView>
</UserPageLayout>
