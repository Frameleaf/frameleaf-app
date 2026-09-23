<script lang="ts">
  /** Library Care → Utilities (FL-69): the queues and every utility, in `LibraryCareDirectory`. */
  import LibraryCareDirectory from '$lib/components/frameleaf/LibraryCareDirectory.svelte';
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

<UserPageLayout title={data.meta.title}>
  <div class="m-auto mt-5 w-full max-w-4xl px-2 pb-16">
    <Theme theme={appTheme}>
      <LibraryCareDirectory summary={data.summary} />
    </Theme>
  </div>
</UserPageLayout>
