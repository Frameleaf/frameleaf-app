<script lang="ts">
  /**
   * Command center → Library analytics (FL-79). The page title is carried by the admin layout's
   * breadcrumb; everything else lives in LibraryAnalytics.
   */
  import LibraryAnalytics from '$lib/components/frameleaf/analytics/LibraryAnalytics.svelte';
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
  <Container size="full" center class="my-4">
    <Theme theme={appTheme}>
      <LibraryAnalytics scopes={data.scopes} report={data.report} />
    </Theme>
  </Container>
</AdminPageLayout>
