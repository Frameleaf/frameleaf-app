<script lang="ts">
  /** One workflow (FL-82): the workflow list with that workflow open in the designer. */
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
      <WorkflowsPanel initial={data.workflows} openId={data.workflowId} />
    </Theme>
  </Container>
</UserPageLayout>
