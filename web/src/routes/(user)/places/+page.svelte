<script lang="ts">
  import PlacesPanel from '$lib/components/frameleaf/PlacesPanel.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { Theme as AppTheme, themeManager } from '@immich/ui';
  import type { PageData } from './$types';

  /** Places (FL-51): the prototype's `Places.jsx` over the real places data (`PlacesPanel`). */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const counts = $derived(new Map(data.counts.map(({ city, count }) => [city, count])));
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<UserPageLayout>
  <Theme theme={appTheme}>
    <PlacesPanel places={data.items} {counts} unplaced={data.unplaced} />
  </Theme>
</UserPageLayout>
