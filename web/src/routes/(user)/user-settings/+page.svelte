<script lang="ts">
  import { page } from '$app/state';
  import SettingsHost from '$lib/components/frameleaf/settings/SettingsHost.svelte';
  import LibraryCareScreen from '$lib/components/frameleaf/LibraryCareScreen.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserSettingsList from './UserSettingsList.svelte';
  import { getKeyboardActions } from '$lib/services/keyboard.service';
  import { Container, Theme as AppTheme, themeManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  const { KeyboardShortcuts } = $derived(getKeyboardActions($t));
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<UserPageLayout title={data.meta.title} actions={[KeyboardShortcuts]}>
  <Container size={data.commandCenter ? "large" : "medium"} center>
    <Theme theme={appTheme}>
      {#if page.url.searchParams.get('screen') === 'care'}
        <LibraryCareScreen />
      {:else if data.commandCenter}
        <SettingsHost sections={[]} utilityOnly />
      {:else}
        <UserSettingsList keys={data.keys} sessions={data.sessions} />
      {/if}
    </Theme>
  </Container>
</UserPageLayout>
