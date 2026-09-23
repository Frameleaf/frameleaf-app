<script lang="ts">
  /** Utilities → Workflows (FL-82): the Frameleaf workflow list and designer, in `WorkflowsPanel`. */
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import WorkflowsPanel from '$lib/components/frameleaf/WorkflowsPanel.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Container, Theme as AppTheme, themeManager } from '@immich/ui';
  import type { PageData } from './$types';

  let { data }: { data: PageData } = $props();
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<UserPageLayout title={data.meta.title} scrollbar={true}>
  <Container size="large" center class="my-4">
    <Theme theme={appTheme}>
      <WorkflowsPanel initial={data.workflows} />
    </Theme>
  </Container>
</UserPageLayout>
