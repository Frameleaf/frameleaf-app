<script lang="ts">
  /**
   * The Command Center (FL-71): the template's `screen === "admin"` in App.jsx, one full-screen
   * settings screen for every account under the top bar. An administrator also gets the server
   * settings (`SystemSettings.svelte`); `?screen=care` is the template's separate Library Care screen.
   */
  import LibraryCareScreen from '$lib/components/frameleaf/LibraryCareScreen.svelte';
  import SettingsHost from '$lib/components/frameleaf/settings/SettingsHost.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import NavigationBar from '$lib/components/shared-components/navigation-bar/NavigationBar.svelte';
  import type { SettingsHostSection } from '$lib/frameleaf/settings-areas';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Container, Theme as AppTheme, themeManager } from '@immich/ui';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';
  import { personalSections } from './personal-sections';
  import SystemSettings from './SystemSettings.svelte';
  import SectionBody from './sections/SectionBody.svelte';

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const personal = $derived(personalSections($t, { oauth: featureFlagsManager.value.oauth }));
</script>

{#snippet sectionBody(section: SettingsHostSection)}
  <SectionBody {section} />
{/snippet}

{#if data.screen === 'care'}
  <UserPageLayout title={data.meta.title}>
    <Container size="large" center>
      <Theme theme={appTheme}>
        <LibraryCareScreen />
      </Theme>
    </Container>
  </UserPageLayout>
{:else}
  <NavigationBar noBorder />
  <Theme theme={appTheme}>
    <div class="command-page">
      {#if data.system}
        <SystemSettings
          current={data.system.current}
          defaultConfig={data.system.defaultConfig}
          {personal}
          {sectionBody}
        />
      {:else}
        <SettingsHost sections={personal} {sectionBody} />
      {/if}
    </div>
  </Theme>
{/if}

<style>
  .command-page {
    height: calc(100dvh - var(--fl-topbar-height));
  }
  @media (max-width: 767px) {
    .command-page {
      height: calc(100dvh - var(--fl-topbar-height-phone));
    }
  }
</style>
