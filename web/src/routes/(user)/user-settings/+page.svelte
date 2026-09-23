<script lang="ts">
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
  <Container size="medium" center>
    <Theme theme={appTheme}>
      <UserSettingsList keys={data.keys} sessions={data.sessions} />
    </Theme>
  </Container>
</UserPageLayout>
