<script lang="ts">
  import AlbumNavigationTree from '$lib/components/shared-components/side-bar/AlbumNavigationTree.svelte';
  import RecentAlbums from '$lib/components/shared-components/side-bar/RecentAlbums.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { featureFlagsManager } from '$lib/managers/feature-flags-manager.svelte';
  import { albumTreeDropdown, recentAlbumsDropdown } from '$lib/stores/preferences.store';
  import { NavbarItem } from '@immich/ui';
  import {
    mdiAccountOutline,
    mdiAccountMultipleOutline,
    mdiArchiveArrowDownOutline,
    mdiCardsOutline,
    mdiClockPlusOutline,
    mdiCogOutline,
    mdiFolderOutline,
    mdiHeartOutline,
    mdiImageAlbum,
    mdiImageMultipleOutline,
    mdiLink,
    mdiLockOutline,
    mdiMagnify,
    mdiMapOutline,
    mdiShieldLockOutline,
    mdiStarOutline,
    mdiTagMultipleOutline,
    mdiToolboxOutline,
    mdiTrashCanOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';
  import Brand from './Brand.svelte';
  import { getNavigation, navigationSections } from './navigation-registry';

  let { iconOnly = false }: { iconOnly?: boolean } = $props();
  const entries = $derived(getNavigation(featureFlagsManager.value, authManager.preferences));
  const icons: Record<string, string> = {
    mdiAccountOutline,
    mdiAccountMultipleOutline,
    mdiArchiveArrowDownOutline,
    mdiCardsOutline,
    mdiClockPlusOutline,
    mdiCogOutline,
    mdiFolderOutline,
    mdiHeartOutline,
    mdiImageAlbum,
    mdiImageMultipleOutline,
    mdiLink,
    mdiLockOutline,
    mdiMagnify,
    mdiMapOutline,
    mdiShieldLockOutline,
    mdiStarOutline,
    mdiTagMultipleOutline,
    mdiToolboxOutline,
    mdiTrashCanOutline,
  };
</script>

{#if !iconOnly}
  <div class="brand"><Brand /></div>
{/if}

{#each navigationSections as section (section)}
  {#if !iconOnly}
    <h2>{section === 'collections' ? $t('albums') : $t(section)}</h2>
  {/if}
  {#each entries.filter((entry) => entry.section === section) as entry (entry.id)}
    {#if entry.id === 'albums'}
      <NavbarItem title={$t(entry.label)} href={entry.href} icon={icons[entry.icon]} bind:expanded={$albumTreeDropdown}>
        {#snippet items()}
          {#if !iconOnly}<AlbumNavigationTree />{/if}
        {/snippet}
      </NavbarItem>
    {:else if entry.id === 'recentlyAdded'}
      <NavbarItem
        title={$t(entry.label)}
        href={entry.href}
        icon={icons[entry.icon]}
        bind:expanded={$recentAlbumsDropdown}
      >
        {#snippet items()}
          {#if !iconOnly}<RecentAlbums />{/if}
        {/snippet}
      </NavbarItem>
    {:else}
      <NavbarItem title={$t(entry.label)} href={entry.href} icon={icons[entry.icon]} />
    {/if}
  {/each}
{/each}

<style>
  .brand {
    padding: 0.25rem 0.75rem;
  }
  h2 {
    border-top: 1px solid var(--fl-border);
    margin: 0.75rem 0.75rem 0;
    padding: 0.75rem 0.5rem 0.25rem;
    color: var(--fl-muted);
    font-size: 0.75rem;
    font-weight: 600;
  }
</style>
