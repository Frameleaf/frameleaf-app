<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import '$lib/frameleaf/tokens.css';
  import { Theme, themeManager } from '@immich/ui';
  import { onMount, type Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let { active, children }: { active: boolean; children: Snippet } = $props();
  let shieldDialog = $state<HTMLDialogElement>();
  const locking = $derived(sessionAccess.lockStatus === 'locking');

  // FL-83: leaving an unlocked tab hides only this tab's content (the prototype's "Content hides
  // when you leave this tab"). It never locks the server session, which other tabs share, and never
  // touches uploads or downloads; the explicit Lock and the server's idle timeout end the session.
  onMount(() => {
    const onVisibilityChange = () => {
      sessionAccess.concealed = document.hidden && sessionAccess.isElevated;
    };
    document.addEventListener('visibilitychange', onVisibilityChange);
    return () => {
      document.removeEventListener('visibilitychange', onVisibilityChange);
      sessionAccess.concealed = false;
    };
  });
  $effect(() => {
    // an unlock that completes while hidden is concealed too; a lock always reveals the locked view
    sessionAccess.concealed = sessionAccess.isElevated && document.hidden;
  });
  $effect(() => {
    document.documentElement.classList.toggle('session-concealed', sessionAccess.concealed);
    return () => document.documentElement.classList.remove('session-concealed');
  });

  $effect(() => {
    if (!shieldDialog) {
      return;
    }
    if (active && !shieldDialog.open) {
      shieldDialog.showModal();
    } else if (!active && shieldDialog.open) {
      shieldDialog.close();
    }
  });
</script>

<div class="session-lock-content" class:session-lock-content-hidden={active} inert={active} aria-hidden={active}>
  {@render children()}
</div>

<dialog
  bind:this={shieldDialog}
  class="frameleaf session-lock-shield"
  data-theme={themeManager.value === Theme.Dark ? 'dark' : 'light'}
  aria-labelledby="session-lock-title"
  oncancel={(event) => event.preventDefault()}
>
  {#if active}
    <p id="session-lock-title">{$t('frameleaf_locked_hidden')}</p>
    {#if locking}
      <p class="session-lock-status" role="status">{$t('frameleaf_session_lock_locking')}</p>
    {:else if sessionAccess.lockStatus === 'failed'}
      <p class="session-lock-status" role="alert">{$t('frameleaf_session_lock_failed')}</p>
    {/if}
    <Button
      variant="primary"
      disabled={!sessionAccess.retryLock || locking}
      onclick={() => void sessionAccess.retryLock?.()}
    >
      {$t('retry')}
    </Button>
  {/if}
</dialog>

<style>
  .session-lock-content-hidden {
    display: none;
  }
  /* A hidden unlocked tab: nothing of it (portals and top-layer dialogs included) is painted. */
  :global(html.session-concealed body) {
    visibility: hidden !important;
  }
  .session-lock-status {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.875rem;
  }
  /* Portals are attached directly to body, and native dialogs enter the browser top layer. */
  :global(body:has(.session-lock-shield[open]) > :not(:has(.session-lock-shield))),
  :global(body:has(.session-lock-shield[open]) dialog[open]:not(.session-lock-shield)),
  :global(body:has(.session-lock-shield[open]) [popover]:popover-open) {
    visibility: hidden !important;
  }
  .session-lock-shield {
    position: fixed;
    inset: 0;
    width: 100vw;
    height: 100dvh;
    max-width: none;
    max-height: none;
    margin: 0;
    padding: 0;
    border: 0;
    /* @immich/ui sets body pointer-events:none while a body-mounted modal is open. */
    pointer-events: auto;
    place-content: center;
    justify-items: center;
    gap: 1rem;
    background: var(--fl-canvas);
    color: var(--fl-text);
  }
  .session-lock-shield[open] {
    display: grid;
  }
  .session-lock-shield::backdrop {
    background: var(--fl-canvas);
  }
</style>
