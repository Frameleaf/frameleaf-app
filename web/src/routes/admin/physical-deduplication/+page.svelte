<script lang="ts">
  /**
   * Storage → Physical deduplication (FL-71). One page title, carried by the admin layout's
   * breadcrumb; the toolbar, preview and apply flow live in PhysicalDedupManager.
   */
  import PhysicalDedupManager from '$lib/components/frameleaf/PhysicalDedupManager.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import AdminPageLayout from '$lib/components/layouts/AdminPageLayout.svelte';
  import { Container, Theme as AppTheme, themeManager } from '@immich/ui';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<AdminPageLayout breadcrumbs={[{ title: data.meta.title }]}>
  <Container size="large" center class="my-4">
    <Theme theme={appTheme}>
      <PhysicalDedupManager users={data.users} initial={data.preview} />
    </Theme>
  </Container>
</AdminPageLayout>
