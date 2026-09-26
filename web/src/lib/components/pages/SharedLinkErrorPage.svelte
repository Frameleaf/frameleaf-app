<script lang="ts">
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import PublicShellFrame from '$lib/components/frameleaf/PublicShellFrame.svelte';
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiClockOutline, mdiLinkOff } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  // FL-56: both the key and slug shared-link routes render this when the link cannot be opened (the
  // `getMySharedLink`/`getAssetInfoFromParam` failure in `$lib/utils/shared-links.ts` throws and
  // SvelteKit lands here). Own layout, no LibraryRail/TopBar/account menu; the prototype
  // (`PublicViewer.jsx`) draws these states inside the public frame.
  //
  // SvelteKit reports every failed load as 500; the API's own status and reason are on the error
  // (hooks.client.ts). A link that only ran out of time says so (`reason: 'expired'`); any other
  // 4xx is "not available", never the raw API message; a server or network failure is not the
  // link's fault, so it offers a retry.
  const error = $derived(page.error as { code?: string | number; reason?: string } | null);
  const code = $derived(Number(error?.code ?? page.status));

  type State = { icon: string; title: Translations; body: Translations; retry?: boolean };
  const state: State = $derived.by(() => {
    if (!code || code >= 500) {
      return {
        icon: mdiAlertCircleOutline,
        title: 'frameleaf_error_server_title',
        body: 'frameleaf_error_server_body',
        retry: true,
      };
    }
    if (error?.reason === 'expired') {
      return { icon: mdiClockOutline, title: 'frameleaf_public_expired_title', body: 'frameleaf_public_expired_body' };
    }
    return { icon: mdiLinkOff, title: 'frameleaf_public_unavailable_title', body: 'frameleaf_public_unavailable_body' };
  });
</script>

<svelte:head>
  <title>{$t(state.title)}</title>
</svelte:head>

<PublicShellFrame hero>
  <div class="pv-state" role="status">
    <Icon icon={state.icon} size="40" aria-hidden={true} />
    <h1>{$t(state.title)}</h1>
    <p>{$t(state.body)}</p>
    {#if state.retry}
      <Button variant="primary" onclick={() => location.reload()}>{$t('frameleaf_public_try_again')}</Button>
    {:else}
      <Button onclick={() => location.assign('/')}>{$t('frameleaf_public_go_home')}</Button>
    {/if}
  </div>
</PublicShellFrame>

<style>
  /* The template's `.pv-state` (sharing.css). */
  .pv-state {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 8px;
    width: 100%;
    max-width: 380px;
    margin: 0 auto;
    padding: 36px 28px;
    text-align: center;
    color: var(--fl-muted);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .pv-state > :global(svg) {
    margin-bottom: 8px;
    color: var(--fl-muted);
  }
  .pv-state h1 {
    margin: 0;
    color: var(--fl-text);
    font-size: 19px;
    font-weight: 600;
    letter-spacing: -0.02em;
  }
  .pv-state p {
    margin: 0 0 12px;
    font-size: 13px;
    line-height: 1.55;
  }
</style>
