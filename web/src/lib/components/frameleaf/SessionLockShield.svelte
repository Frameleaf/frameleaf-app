<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import '$lib/frameleaf/tokens.css';
  import { Theme, themeManager } from '@frameleaf/ui';
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

  // When the shield lifts, the page fades back in (the Fade pattern) instead of snapping into view.
  let revealing = $state(false);
  let wasActive = false;
  $effect(() => {
    if (wasActive && !active) {
      revealing = true;
    }
    wasActive = active;
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

<!--
  Keep the portal barrier while locking, including newly created top-layer content. Installing
  its descendant selectors only while active avoids invalidating the whole body for every tile
  inserted into an unlocked library.
-->
<svelte:head>
  {#if active}
    <style data-session-lock-portals>
      body:has(.session-lock-shield[open]) > :not(:has(.session-lock-shield)),
      body:has(.session-lock-shield[open]) dialog[open]:not(.session-lock-shield),
      body:has(.session-lock-shield[open]) [popover]:popover-open {
        visibility: hidden !important;
      }
    </style>
  {/if}
</svelte:head>

<div
  class="session-lock-content"
  class:session-lock-content-hidden={active}
  class:session-lock-content-revealing={revealing && !active}
  inert={active}
  aria-hidden={active}
  onanimationend={(event) => {
    if (event.target === event.currentTarget) {
      revealing = false;
    }
  }}
>
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
  /* No fill after the end: a lasting opacity would keep the whole app in its own stacking context. */
  .session-lock-content-revealing {
    animation: fl-fade-in var(--fl-duration-fade) var(--fl-ease) backwards;
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
    /* @frameleaf/ui sets body pointer-events:none while a body-mounted modal is open. */
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
