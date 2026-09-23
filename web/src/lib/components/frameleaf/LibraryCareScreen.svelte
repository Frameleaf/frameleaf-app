<script lang="ts">
  import { OpenQueryParam } from '$lib/constants';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight, mdiShieldCheckOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';
</script>

<main class="care-screen">
  <p class="eyebrow">{$t('frameleaf_settings_area_maintenance')}</p>
  <h1>{$t('frameleaf_library_care')}</h1>
  <p class="muted">{$t('library_care_description')}</p>
  {#if authManager.user.isAdmin}
    <a href={Route.missingMediaUtility()}
      ><Icon icon={mdiShieldCheckOutline} size="1.125rem" aria-hidden={true} />{$t('frameleaf_care_media_health')}<Icon
        icon={mdiChevronRight}
        size="1.125rem"
        aria-hidden={true}
      /></a
    >
  {/if}
  <a href={Route.livePhotosUtility()}
    ><Icon icon={mdiShieldCheckOutline} size="1.125rem" aria-hidden={true} />{$t('library_care_tool_live_photos')}<Icon
      icon={mdiChevronRight}
      size="1.125rem"
      aria-hidden={true}
    /></a
  >
  <a href={Route.duplicatesUtility()}
    ><Icon icon={mdiShieldCheckOutline} size="1.125rem" aria-hidden={true} />{$t('library_care_tool_duplicates')}<Icon
      icon={mdiChevronRight}
      size="1.125rem"
      aria-hidden={true}
    /></a
  >
  <a href={Route.icloudSyncUtility()}
    ><Icon icon={mdiShieldCheckOutline} size="1.125rem" aria-hidden={true} />{$t(
      'frameleaf_care_import_reconciliation',
    )}<Icon icon={mdiChevronRight} size="1.125rem" aria-hidden={true} /></a
  >
  <a href={Route.userSettings({ isOpen: OpenQueryParam.PRESERVATION })}
    ><Icon icon={mdiShieldCheckOutline} size="1.125rem" aria-hidden={true} />{$t(
      'frameleaf_preservation_care_link',
    )}<Icon icon={mdiChevronRight} size="1.125rem" aria-hidden={true} /></a
  >
</main>

<style>
  .care-screen {
    padding: 2rem;
    color: var(--fl-text);
  }
  .eyebrow {
    color: var(--fl-muted);
    font-size: 0.625rem;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  h1 {
    font-size: 1.75rem;
    font-weight: 550;
    margin: 0.5rem 0;
  }
  .muted {
    color: var(--fl-muted);
    font-size: 0.75rem;
    margin-bottom: 1.5rem;
  }
  a {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    width: 100%;
    padding: 1.375rem 0;
    margin: 0;
    text-align: left;
    background: transparent;
    border-bottom: 1px solid var(--fl-border);
    color: var(--fl-text);
    font-size: 0.8125rem;
    text-decoration: none;
  }
  a :global(svg:last-child) {
    margin-left: auto;
  }
  a:hover {
    background: var(--fl-raised);
  }
  a:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
</style>
