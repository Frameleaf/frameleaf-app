<script lang="ts">
  import { invalidate } from '$app/navigation';
  import { scrollMemory } from '$lib/actions/scroll-memory';
  import AlbumDirectory, { albumDirectoryHeadingId } from '$lib/components/frameleaf/AlbumDirectory.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import UserSidebar from '$lib/components/shared-components/side-bar/UserSidebar.svelte';
  import SkipLink from '$lib/elements/SkipLink.svelte';
  import { Route } from '$lib/route';
  import { Theme as AppTheme, themeManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // The Albums page (FL-52): collections as shelves, albums on their own, then
  // shared spaces, from GET /albums/tree. Mutations go through the album service
  // and re-run this route's loader.
  const refresh = () => invalidate('album:data');
</script>

<UserPageLayout use={[[scrollMemory, { routeStartsWith: Route.albums() }]]}>
  {#snippet sidebar()}
    <UserSidebar>
      <SkipLink target={`#${albumDirectoryHeadingId}`} text={$t('skip_to_albums')} breakpoint="md" />
    </UserSidebar>
  {/snippet}

  <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
    <AlbumDirectory tree={data.tree} spaceInvitations={data.spaceInvitations} onRefresh={refresh} />
  </Theme>
</UserPageLayout>
