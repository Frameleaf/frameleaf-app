<script lang="ts">
  /**
   * A PIN-protected destination before it is unlocked (LIB-P2): Locked and suppressed content open
   * inside the app, with the rail and top bar in place, as the template's Locked collection does
   * (`App.jsx` `collection === "Locked" && !unlocked` → `.locked-library-empty`). The page's large
   * title and its one Timeline tab head it, the card says what is kept here, and its button asks for
   * the PIN in the same dialog the top bar's Locked control uses (`LockedUnlockDialog`). An account
   * without a PIN is offered PIN settings there.
   */
  import { invalidateAll } from '$app/navigation';
  import EmptyState from '$lib/components/frameleaf/EmptyState.svelte';
  import LibraryLayoutSwitch from '$lib/components/frameleaf/LibraryLayoutSwitch.svelte';
  import LockedUnlockDialog from '$lib/components/frameleaf/LockedUnlockDialog.svelte';
  import { markLocksRevealed } from '$lib/components/timeline/lock-reveal';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import { requestSessionLock } from '$lib/frameleaf/session-lock';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handlePromiseError } from '$lib/utils';
  import { Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { mdiLockOpenVariantOutline, mdiShieldLockOutline } from '@mdi/js';

  type Props = {
    /** The destination's name, drawn as the page's large title. */
    title: string;
    heading: string;
    message: string;
    actionLabel: string;
    icon?: string;
  };

  let { title, heading, message, actionLabel, icon = mdiShieldLockOutline }: Props = $props();

  let unlocking = $state(false);
  // As LibraryView's root: the page area has no themed ancestor to inherit a theme from.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');

  /**
   * The server elevated the session. As the top bar's own unlock does (TopBar `onUnlocked`), the rest
   * of the app is told, what the PIN reveals sharpens into view, and the pages load again, this one
   * with its photos in place of the card. A lock asked for meanwhile wins.
   */
  const onUnlocked = async () => {
    if (sessionAccess.lockPending) {
      await requestSessionLock();
      return;
    }
    markLocksRevealed();
    eventManager.emit('SessionAccessChanged', { isElevated: true });
    await invalidateAll();
    markLocksRevealed();
  };
</script>

<div class="frameleaf fl-locked-gate" data-theme={appTheme} data-testid="library-locked-gate">
  <!-- LibraryView's header: the large title with the Timeline tab beside it, then a hairline. -->
  <header class="fl-locked-gate-header">
    <h1>{title}</h1>
    <LibraryLayoutSwitch session={librarySession} layouts={['timeline']} />
  </header>
  <div class="fl-locked-gate-card fl-reveal">
    <EmptyState
      {icon}
      title={heading}
      {message}
      action={{ label: actionLabel, icon: mdiLockOpenVariantOutline, onClick: () => (unlocking = true) }}
    />
  </div>
</div>

<LockedUnlockDialog bind:open={unlocking} onUnlocked={() => handlePromiseError(onUnlocked())} />

<style>
  /* The page gutter, as LibraryView keeps it on a page of its own: 24px, and 16px on phones. */
  .fl-locked-gate {
    --fl-gate-gutter: var(--fl-space-4);
    display: flex;
    flex-direction: column;
    min-height: 100%;
    /* Level with LibraryView's header, which gives back the page area's 8px top inset. */
    margin-top: -0.5rem;
    padding-inline: var(--fl-gate-gutter);
  }
  .fl-locked-gate-header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--fl-space-3);
    min-height: 77px;
    /* The hairline runs across the page (template `.collection-header` border). */
    margin-inline: calc(-1 * var(--fl-gate-gutter) - 0.5rem);
    padding: 0 calc(var(--fl-gate-gutter) + 0.5rem) var(--fl-space-3);
    border-bottom: 1px solid var(--fl-border);
  }
  .fl-locked-gate-header h1 {
    margin: 0;
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.02em;
  }
  .fl-locked-gate-header > :global(.fl-layouts) {
    margin-block: var(--fl-space-2) 0;
    margin-inline-start: auto;
  }
  /* Template `.locked-library-empty`: 96px under the header (50px on phones). */
  .fl-locked-gate-card {
    padding-top: 96px;
  }
  @media (max-width: 767px) {
    .fl-locked-gate {
      --fl-gate-gutter: var(--fl-space-2);
    }
    .fl-locked-gate-card {
      padding-top: 50px;
    }
  }
</style>
