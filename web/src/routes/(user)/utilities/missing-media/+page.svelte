<script lang="ts">
  /**
   * Library Care → Missing media (FL-69): the Frameleaf review in `LibraryCareHealth`, on the same
   * URL the utility has always had.
   */
  import LibraryCareHealth from '$lib/components/frameleaf/LibraryCareHealth.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Theme as AppTheme, themeManager } from '@immich/ui';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<UserPageLayout title={data.meta.title} scrollbar={true}>
  <div class="m-auto w-full max-w-6xl px-2 pb-16">
    <Theme theme={appTheme}>
      <LibraryCareHealth
        category={data.category}
        initial={data.mediaHealth}
        initialSummary={data.summary}
        initialStatus={data.status}
        roots={data.roots}
        users={data.users}
      />
    </Theme>
  </div>
</UserPageLayout>
