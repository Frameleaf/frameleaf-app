<script lang="ts">
  import PlacesPanel from '$lib/components/frameleaf/PlacesPanel.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { invalidateAll } from '$app/navigation';
  import type { PageData } from './$types';

  /** Places (FL-51): the prototype's `Places.jsx` over the real places data (`PlacesPanel`). */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const counts = $derived(new Map(data.counts.map(({ city, count }) => [city, count])));
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  let retrying = $state(false);
  const onRetry = async () => {
    retrying = true;
    try {
      await invalidateAll();
    } finally {
      retrying = false;
    }
  };
</script>

<UserPageLayout>
  <Theme theme={appTheme}>
    <PlacesPanel places={data.items} {counts} unplaced={data.unplaced} failed={data.failed} {onRetry} {retrying} />
  </Theme>
</UserPageLayout>
