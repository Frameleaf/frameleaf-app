<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import '$lib/frameleaf/tokens.css';
  import { Theme, themeManager } from '@immich/ui';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let { active, children }: { active: boolean; children: Snippet } = $props();
</script>

<div class="session-lock-content" class:session-lock-content-hidden={active} inert={active} aria-hidden={active}>
  {@render children()}
</div>

{#if active}
  <div
    class="frameleaf session-lock-shield"
    data-theme={themeManager.value === Theme.Dark ? 'dark' : 'light'}
    role="status"
    aria-live="polite"
  >
    <p>{$t('frameleaf_locked_hidden')}</p>
    <Button variant="primary" disabled={!sessionAccess.retryLock} onclick={() => void sessionAccess.retryLock?.()}>
      {$t('retry')}
    </Button>
  </div>
{/if}

<style>
  .session-lock-content-hidden {
    display: none;
  }
  /* Portals are attached directly to body, and native dialogs enter the browser top layer. */
  :global(body:has(.session-lock-shield) > :not(:has(.session-lock-shield))),
  :global(body:has(.session-lock-shield) dialog[open]),
  :global(body:has(.session-lock-shield) [popover]:popover-open) {
    visibility: hidden !important;
  }
  .session-lock-shield {
    position: fixed;
    inset: 0;
    z-index: 2147483647;
    display: grid;
    place-content: center;
    justify-items: center;
    gap: 1rem;
    background: var(--fl-canvas);
    color: var(--fl-text);
  }
</style>
