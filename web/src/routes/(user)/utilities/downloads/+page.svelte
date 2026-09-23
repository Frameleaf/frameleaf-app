<script lang="ts">
  /** Utilities → Mobile applications (FL-82): the design's application setup, from this server's signed releases. */
  import ApplicationSetup from '$lib/components/frameleaf/ApplicationSetup.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Container, Theme as AppTheme, themeManager } from '@immich/ui';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<UserPageLayout title={data.meta.title} scrollbar={true}>
  <Container size="large" center class="my-4">
    <Theme theme={appTheme}>
      <ApplicationSetup tool="downloads" />
    </Theme>
  </Container>
</UserPageLayout>
