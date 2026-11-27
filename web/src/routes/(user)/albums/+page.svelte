<script lang="ts">
  import { scrollMemory } from '$lib/actions/scroll-memory';
  import AlbumDirectory, { albumDirectoryHeadingId } from '$lib/components/frameleaf/AlbumDirectory.svelte';
  import FolderAlbumsNotice from '$lib/components/frameleaf/FolderAlbumsNotice.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import SkipLink from '$lib/elements/SkipLink.svelte';
  import { refreshAlbumTrees } from '$lib/frameleaf/album-tree-cache';
  import { Route } from '$lib/route';
  import { Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // The Albums page (FL-52): collections as shelves, albums on their own, then
  // shared spaces, from GET /albums/tree. Mutations go through the album service
  // and re-run this route's loader.
  const refresh = () => refreshAlbumTrees();
</script>

<UserPageLayout use={[[scrollMemory, { routeStartsWith: Route.albums() }]]}>
  {#snippet railExtra()}
    <SkipLink target={`#${albumDirectoryHeadingId}`} text={$t('skip_to_albums')} breakpoint="md" />
  {/snippet}

  <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
    <!-- The page surface reaches the foot of the window however few albums there are. -->
    <div class="fl-page-fill">
      <!-- FL-1837: a one-time offer of one album for each event folder; kept outside AlbumDirectory on purpose -->
      <FolderAlbumsNotice onChanged={refresh} />
      <AlbumDirectory tree={data.tree} spaceInvitations={data.spaceInvitations} onRefresh={refresh} />
    </div>
  </Theme>
</UserPageLayout>

<style>
  /*
   * Everything below the top bar, less the layout's 8px gutter above and below, so the Frameleaf
   * surface never stops short of the window with the page background showing under it.
   */
  .fl-page-fill {
    min-height: calc(100dvh - var(--fl-topbar-height) - 1rem);
  }
  @media (max-width: 767px) {
    .fl-page-fill {
      min-height: calc(100dvh - var(--fl-topbar-height-phone) - 0.5rem - max(0.5rem, var(--fl-tabbar-space, 0px)));
    }
  }
</style>
