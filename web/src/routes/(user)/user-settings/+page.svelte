<script lang="ts">
  /**
   * The Command Center (FL-71): the template's `screen === "admin"` in App.jsx, one full-screen
   * settings screen for every account under the top bar. An administrator also gets the server
   * settings (`SystemSettings.svelte`). Library Care is the `care` area; `?screen=care` redirects there.
   */
  import { page } from '$app/state';
  import SettingsHost from '$lib/components/frameleaf/settings/SettingsHost.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import Theme from '$lib/components/frameleaf/Theme.svelte';
  import NavigationBar from '$lib/components/shared-components/navigation-bar/NavigationBar.svelte';
  import {
    isPlaceArea,
    presentedArea,
    resolveSettingsArea,
    type SettingsHostSection,
  } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';
  import { openFileUploadDialog } from '$lib/utils/file-uploader';
  import { personalSections } from './personal-sections';
  import SystemSettings from './SystemSettings.svelte';
  import SectionBody from './sections/SectionBody.svelte';

  type Props = {
    data: PageData;
  };

  let { data }: Props = $props();

  /**
   * FL-1806: Import, Library care and Trash are places, so they open beside the library rail inside
   * the app's shell; every other area is Settings, full width under its own top bar.
   */
  const place = $derived.by(() => {
    const section = page.url.searchParams.get('section');
    const area = resolveSettingsArea({
      area: page.url.searchParams.get('area'),
      section,
      isOpen: page.url.searchParams.get('isOpen'),
      isAdmin: authManager.user.isAdmin,
    });
    // A member never sees a backup section, so the host keeps such an address in its place too.
    return isPlaceArea(presentedArea(area, section)) || (!authManager.user.isAdmin && isPlaceArea(area));
  });

  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const personal = $derived(
    personalSections($t, { oauth: featureFlagsManager.value.oauth, isAdmin: authManager.user.isAdmin }),
  );
</script>

{#snippet sectionBody(section: SettingsHostSection)}
  <SectionBody {section} />
{/snippet}

{#snippet host()}
  <Theme theme={appTheme}>
    <div class="command-page" class:in-shell={place}>
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
{/snippet}

{#if place}
  <UserPageLayout fill>{@render host()}</UserPageLayout>
{:else}
  <!-- Upload stays in the top bar on settings pages too, as in the prototype's admin screen. -->
  <NavigationBar noBorder onUploadClick={() => void openFileUploadDialog()} />
  {@render host()}
{/if}

<style>
  .command-page {
    height: calc(100dvh - var(--fl-topbar-height));
  }
  .command-page.in-shell {
    flex: 1;
    height: auto;
    min-height: 0;
  }
  @media (max-width: 767px) {
    .command-page {
      height: calc(100dvh - var(--fl-topbar-height-phone));
    }
  }
</style>
