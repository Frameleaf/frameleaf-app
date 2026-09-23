<script lang="ts">
  import { page } from '$app/state';
  import Brand from '$lib/components/frameleaf/Brand.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import '$lib/frameleaf/tokens.css';
  import { Theme as AppTheme, themeManager } from '@immich/ui';
  import { t } from 'svelte-i18n';

  // FL-56: both the key and slug shared-link routes render this on an invalid, expired or
  // revoked link (the `getMySharedLink`/`getAssetInfoFromParam` failure in
  // `$lib/utils/shared-links.ts` throws and SvelteKit lands here). Own layout, no
  // LibraryRail/TopBar/account menu.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
</script>

<svelte:head>
  <title>{$t('frameleaf_public_unavailable_title')}</title>
</svelte:head>

<main class="frameleaf pv-error-shell" data-theme={appTheme}>
  <a class="pv-brand" href="/" data-sveltekit-preload-data="hover">
    <Brand />
  </a>
  <div class="pv-error-card" role="status">
    <h1>{$t('frameleaf_public_unavailable_title')}</h1>
    <p>{page.error?.message || $t('frameleaf_public_unavailable_body')}</p>
    <Button variant="primary" onclick={() => (location.href = '/')}>
      {$t('frameleaf_public_go_home')}
    </Button>
  </div>
</main>

<style>
  .pv-error-shell {
    display: flex;
    flex-direction: column;
    align-items: center;
    justify-content: center;
    gap: 2rem;
    min-height: 100dvh;
    padding: 1.5rem;
    color: var(--fl-text);
    background: var(--fl-canvas);
  }
  .pv-brand {
    display: inline-flex;
  }
  .pv-error-card {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 0.75rem;
    width: min(24rem, 100%);
    padding: 1.5rem;
    text-align: center;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-1);
  }
  .pv-error-card h1 {
    font-size: 1.25rem;
  }
  .pv-error-card p {
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
</style>
