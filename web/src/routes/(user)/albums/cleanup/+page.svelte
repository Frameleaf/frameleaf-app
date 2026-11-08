<script lang="ts">
  import AlbumCleanupReview from '$lib/components/frameleaf/album-cleanup/AlbumCleanupReview.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import UserSidebar from '$lib/components/shared-components/side-bar/UserSidebar.svelte';
  import { Theme as AppTheme, themeManager } from '@frameleaf/ui';
</script>

<UserPageLayout>
  {#snippet sidebar()}
    <UserSidebar />
  {/snippet}

  <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
    <AlbumCleanupReview />
  </Theme>
</UserPageLayout>
