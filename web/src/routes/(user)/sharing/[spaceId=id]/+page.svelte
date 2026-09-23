<script lang="ts">
  import { invalidate } from '$app/navigation';
  import SharedSpaceDetail from '$lib/components/frameleaf/SharedSpaceDetail.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import UserSidebar from '$lib/components/shared-components/side-bar/UserSidebar.svelte';
  import { Theme as AppTheme, themeManager } from '@immich/ui';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // Membership changes re-run this route's loader, the pattern the shared
  // spaces workspace and the Albums page both use.
  const refresh = () => invalidate('space:data');
</script>

<UserPageLayout>
  {#snippet sidebar()}
    <UserSidebar />
  {/snippet}

  <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
    <SharedSpaceDetail space={data.space} members={data.members} albums={data.albums} onRefresh={refresh} />
  </Theme>
</UserPageLayout>
