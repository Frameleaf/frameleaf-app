<script lang="ts">
  import { goto, invalidate } from '$app/navigation';
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import LibraryEmptyState from '$lib/components/frameleaf/LibraryEmptyState.svelte';
  import LibraryLockedGate from '$lib/components/frameleaf/LibraryLockedGate.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import LockedReasonFilter from '$lib/components/frameleaf/LockedReasonFilter.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import { AssetAction } from '$lib/constants';
  import Portal from '$lib/elements/Portal.svelte';
  import { brandedArchiveName } from '$lib/frameleaf/archive-name';
  import { lockedTimelineOptions, parseLockedFilter, type LockedFilter } from '$lib/frameleaf/locked-view';
  import { requestSessionLock } from '$lib/frameleaf/session-lock';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { navigate } from '$lib/utils/navigation';
  import { Icon } from '@frameleaf/ui';
  import { mdiLockOutline, mdiShieldLockOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * Locked (FL-34): every item its owner locked, in one place, after the PIN.
   *
   * Locked is one lock per item, metadata that never relocates it: the item keeps its albums and
   * organisation and is hidden from every other view. Items that were in the old Locked folder when
   * the library was upgraded were moved into the lock, so they are here from the start; so are the
   * items locked by hand and the ones sensitive-content detection locked. All also lists what the
   * owner's Locked rules hide (people, pets and tags), as the prototype's `classifyLocked` does; those
   * carry no lock and leave when the rules change. The filter narrows by why an item is locked (All by
   * default), each tile says why, and Unlock returns an item exactly where it was.
   *
   * LIB-P2: the page opens inside the app. Until the session is unlocked it shows the template's
   * "Your Locked collection" card, and the PIN is asked in the Locked dialog over it. Unlocked, it has
   * one header as the template does: the large "Locked" title with its Timeline tab, and the reasons
   * and Lock in the results toolbar. Locking again from anywhere brings the card back.
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

  const setFilter = async (next: LockedFilter) => {
    pendingFilter = next;
    try {
      await goto(Route.locked(next === 'all' ? undefined : { reason: next }), {
        reset: false,
        replace: true,
      });
    } finally {
      pendingFilter = undefined;
    }
  };

  /** Locked in place: the page loads its access again and shows the card instead of the photos. */
  const reloadAccess = () => invalidate('locked:access');
</script>

<OnEvents onSessionLocked={reloadAccess} />

<UserPageLayout scrollbar={false}>
  {#if data.unlocked}
    <LibraryView
      bind:timelineManager
      {options}
      title={data.meta.title}
      destination={{ kind: 'library' }}
      bulkContext={{ locked: true }}
      downloadFileName={brandedArchiveName($t('frameleaf_archive_name_locked'))}
      enableRouting
      selectAll="loaded"
      onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
    >
      {#snippet toolbarStart()}
        <LockedReasonFilter value={filter} onChange={(next) => void setFilter(next)} />
      {/snippet}

      {#snippet toolbar()}
        <Button onclick={() => void requestSessionLock()}>
          <Icon icon={mdiLockOutline} size="16" aria-hidden />
          {$t('lock')}
        </Button>
      {/snippet}

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
  {:else}
    <LibraryLockedGate
      title={data.meta.title}
      heading={$t('frameleaf_locked_gate_title')}
      message={$t('frameleaf_locked_gate_body')}
      actionLabel={$t('frameleaf_locked_gate_unlock')}
    />
  {/if}
</UserPageLayout>
