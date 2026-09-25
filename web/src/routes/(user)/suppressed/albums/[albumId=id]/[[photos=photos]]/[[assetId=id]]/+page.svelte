<script lang="ts">
  import { goto } from '$app/navigation';
  import AlbumSummary from '$lib/components/album-page/AlbumSummary.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import LibraryEmptyState from '$lib/components/frameleaf/LibraryEmptyState.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { navigate } from '$lib/utils/navigation';
  import { AlbumUserRole, type AlbumResponseDto } from '@immich/sdk';
  import { IconButton } from '@immich/ui';
  import { mdiArrowLeft, mdiEyeOffOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * A suppressed album's photos (FL-33 cleanup): the Frameleaf library scoped to the album, with
   * FL-32's selection bar in place of the legacy select bar.
   *
   * The album is the scope, so "remove from album" is offered to an editor or owner exactly as the
   * legacy menu offered it; a viewer gets the download and the metadata actions only, which is
   * what the ownership gates on that menu came to.
   */
  interface Props {
    data: PageData;
  }

  let { data = $bindable() }: Props = $props();
  let album: AlbumResponseDto = $derived(data.album);
  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);

  const options = $derived({
    albumId: album.id,
    order: album.order,
    suppressedOnly: true,
  });

  const isOwned = $derived(album.albumUsers[0].user.id === authManager.user.id);
  const isEditor = $derived(
    album.albumUsers.find(({ user: { id } }) => id === authManager.user.id)?.role === AlbumUserRole.Editor || isOwned,
  );

  // "Remove from album" is album-scoped, so it is offered only where the album id is in context.
  const bulkContext = $derived({ albumId: isEditor ? album.id : null });
</script>

<UserPageLayout title={data.meta.title} scrollbar={false}>
  {#snippet buttons()}
    <IconButton
      aria-label={$t('go_back')}
      color="secondary"
      shape="round"
      variant="ghost"
      icon={mdiArrowLeft}
      onclick={() => goto(Route.suppressed({ tab: 'albums' }))}
    />
  {/snippet}

  <LibraryView
    enableRouting
    selectAll="loaded"
    bind:timelineManager
    {options}
    destination={{ kind: 'album', id: album.id }}
    {bulkContext}
    downloadFileName={namedArchiveName(album.albumName, $t('frameleaf_archive_name_album'))}
    onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
  >
    <section class="pt-8 md:pt-24">
      <h1 class="line-clamp-2 max-w-5xl text-4xl font-semibold text-immich-fg dark:text-immich-dark-fg">
        {album.albumName}
      </h1>
      {#if album.assetCount > 0}
        <AlbumSummary {album} />
      {/if}
    </section>

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
          <TimelineAssetViewer bind:invisible={viewerInvisible} {timelineManager} {album} withStacked />
        {/if}
      </Portal>
    {/snippet}
  </LibraryView>
</UserPageLayout>
