<script lang="ts">
  import AlbumCleanupReview from '$lib/components/frameleaf/album-cleanup/AlbumCleanupReview.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Theme as AppTheme, themeManager } from '@frameleaf/ui';
</script>

<UserPageLayout>
  <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
    <AlbumCleanupReview />
  </Theme>
</UserPageLayout>
