<script lang="ts">
  import ICloudSyncPanel from '$lib/components/frameleaf/ICloudSyncPanel.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Container, Theme as AppTheme, themeManager } from '@immich/ui';
  import type { PageData } from './$types';

  /** Utilities → iCloud Photos (FL-68): the Frameleaf connection page from the design template. */
  let { data }: { data: PageData } = $props();

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<UserPageLayout title={data.meta.title} scrollbar={true}>
  <Container size="large" center class="my-4">
    <Theme theme={appTheme}>
      <ICloudSyncPanel initial={data.initial} />
    </Theme>
  </Container>
</UserPageLayout>
