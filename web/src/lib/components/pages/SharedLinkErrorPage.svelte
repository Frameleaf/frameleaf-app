<script lang="ts">
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PublicShellFrame from '$lib/components/frameleaf/PublicShellFrame.svelte';
  import { t } from 'svelte-i18n';

  // FL-56: both the key and slug shared-link routes render this on an invalid, expired or
  // revoked link (the `getMySharedLink`/`getAssetInfoFromParam` failure in
  // `$lib/utils/shared-links.ts` throws and SvelteKit lands here). Own layout, no
  // LibraryRail/TopBar/account menu; the prototype draws this state inside the public frame.
</script>

<svelte:head>
  <title>{$t('frameleaf_public_unavailable_title')}</title>
</svelte:head>

<PublicShellFrame hero>
  <div class="pv-error-card" role="status">
    <h1>{$t('frameleaf_public_unavailable_title')}</h1>
    <p>{page.error?.message || $t('frameleaf_public_unavailable_body')}</p>
    <Button variant="primary" onclick={() => location.assign('/')}>
      {$t('frameleaf_public_go_home')}
    </Button>
  </div>
</PublicShellFrame>

<style>
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
