<script lang="ts">
  import { invalidate } from '$app/navigation';
  import SharedSpacesWorkspace from '$lib/components/frameleaf/SharedSpacesWorkspace.svelte';
  import SharedWithYouSection from '$lib/components/frameleaf/SharedWithYouSection.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import UserSidebar from '$lib/components/shared-components/side-bar/UserSidebar.svelte';
  import { Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  // The Shared spaces workspace (FL-55): every top-level shared space plus the
  // account's partners, then the items shared with you one by one (FL-83 AL-30b). Mutations go through the album service and re-run this
  // route's loader, the same pattern the Albums page (FL-52) uses.
  const refresh = () => invalidate('spaces:data');
</script>

<UserPageLayout>
  {#snippet sidebar()}
    <UserSidebar />
  {/snippet}

  <Theme theme={themeManager.value === AppTheme.Dark ? 'dark' : 'light'}>
    <SharedSpacesWorkspace
      spaces={data.spaces}
      partners={data.partners}
      invitations={data.invitations}
      onRefresh={refresh}
    />
    <!-- FL-83 (AL-30b): items people shared with you one by one; share notifications link here. -->
    <SharedWithYouSection />
  </Theme>
</UserPageLayout>
