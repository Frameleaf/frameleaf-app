<script lang="ts">
  import { goto } from '$app/navigation';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import OnEvents from '$lib/components/OnEvents.svelte';
  import ButtonContextMenu from '$lib/components/shared-components/context-menu/ButtonContextMenu.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import ChangeDate from '$lib/components/timeline/actions/ChangeDateAction.svelte';
  import ChangeLocation from '$lib/components/timeline/actions/ChangeLocationAction.svelte';
  import DeleteAssets from '$lib/components/timeline/actions/DeleteAssetsAction.svelte';
  import DownloadAction from '$lib/components/timeline/actions/DownloadAction.svelte';
  import MarkNsfwAction from '$lib/components/timeline/actions/MarkNsfwAction.svelte';
  import SelectAllAssets from '$lib/components/timeline/actions/SelectAllAction.svelte';
  import SetVisibilityAction from '$lib/components/timeline/actions/SetVisibilityAction.svelte';
  import AssetSelectControlBar from '$lib/components/timeline/AssetSelectControlBar.svelte';
  import Timeline from '$lib/components/timeline/Timeline.svelte';
  import { AssetAction } from '$lib/constants';
  import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { getUserActions } from '$lib/services/user.service';
  import { AssetVisibility } from '@immich/sdk';
  import { mdiDotsVertical } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  const options = $derived(data.legacy ? { visibility: AssetVisibility.Locked } : { sensitiveOnly: true });

  const handleEscape = () => {
    if (!assetMultiSelectManager.selectionActive) {
      return;
    }

    assetMultiSelectManager.clear();
    return;
  };

  const handleMoveOffLockedFolder = (assetIds: string[]) => {
    assetMultiSelectManager.clear();
    timelineManager.removeAssets(assetIds);
  };

  const { LockSession } = $derived(getUserActions($t));

  const onSessionLocked = async () => {
    await goto(Route.photos());
  };
</script>

<OnEvents {onSessionLocked} />

<UserPageLayout
  title={data.meta.title}
  actions={[LockSession]}
  hideNavbar={assetMultiSelectManager.selectionActive}
  scrollbar={false}
>
  {#snippet buttons()}
    <nav aria-label={$t('locked_folder')} class="flex gap-4 text-sm">
      <a
        href={Route.locked()}
        onclick={() => assetMultiSelectManager.clear()}
        aria-current={data.legacy ? undefined : 'page'}>{$t('sensitive_media')}</a
      >
      <a
        href={`${Route.locked()}?view=legacy`}
        onclick={() => assetMultiSelectManager.clear()}
        aria-current={data.legacy ? 'page' : undefined}>{$t('previously_moved_to_locked')}</a
      >
    </nav>
  {/snippet}
  {#key data.legacy}
    <Timeline
      enableRouting={true}
      bind:timelineManager
      {options}
      assetInteraction={assetMultiSelectManager}
      onEscape={handleEscape}
      removeAction={data.legacy ? AssetAction.SET_VISIBILITY_TIMELINE : undefined}
    >
      {#snippet empty()}
        <EmptyPlaceholder
          text={$t(data.legacy ? 'no_locked_photos_message' : 'sensitive_timeline_message')}
          title={$t('nothing_here_yet')}
          class="mx-auto mt-10"
        />
      {/snippet}
    </Timeline>
  {/key}
</UserPageLayout>

<!-- Multi-selection mode app bar -->
{#if assetMultiSelectManager.selectionActive}
  <AssetSelectControlBar>
    <SelectAllAssets withText {timelineManager} assetInteraction={assetMultiSelectManager} />
    {#if data.legacy}
      <SetVisibilityAction unlock onVisibilitySet={handleMoveOffLockedFolder} />
    {:else}
      <MarkNsfwAction markSafe />
    {/if}
    <ButtonContextMenu icon={mdiDotsVertical} title={$t('menu')}>
      <DownloadAction menuItem />
      <ChangeDate menuItem />
      <ChangeLocation menuItem />
      <DeleteAssets menuItem force={data.legacy} onAssetDelete={(assetIds) => timelineManager.removeAssets(assetIds)} />
    </ButtonContextMenu>
  </AssetSelectControlBar>
{/if}
