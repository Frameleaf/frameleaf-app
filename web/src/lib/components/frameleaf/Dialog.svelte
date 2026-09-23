<script lang="ts">
  import '$lib/frameleaf/tokens.css';
  import { Theme as AppTheme, themeManager } from '@immich/ui';
  import type { Snippet } from 'svelte';
  let {
    title,
    closeLabel,
    open = $bindable(false),
    onRequestClose,
    wide = false,
    children,
  }: {
    title: string;
    closeLabel: string;
    open?: boolean;
    /** Lets a caller guard X and Escape before the dialog closes. */
    onRequestClose?: () => void;
    /** A workflow with side-by-side evidence (FL-59), like the design's wide dialogs. */
    wide?: boolean;
    children: Snippet;
  } = $props();
  let dialog: HTMLDialogElement;
  const titleId = $props.id();

  // Every caller renders this dialog through `showModal()`, which the browser promotes to
  // the top layer. CSS custom properties still inherit through the ordinary DOM ancestry
  // there, but a caller mounted outside the Frameleaf shell (a public link, a route that
  // has not been ported) has no `.frameleaf[data-theme]` ancestor to inherit from, so the
  // token scope is applied here directly rather than assumed from the caller's tree.
  const appTheme = $derived(themeManager.value === AppTheme.Dark ? 'dark' : 'light');
  const requestClose = () => (onRequestClose ? onRequestClose() : (open = false));

  $effect(() => {
    if (!open || dialog.open) {
      return;
    }

    const previous = document.activeElement;
    dialog.showModal();
    return () => {
      dialog.close();
      if (previous instanceof HTMLElement && previous.isConnected) {
        previous.focus();
      }
    };
  });
</script>

<dialog
  bind:this={dialog}
  class="frameleaf"
  class:wide
  data-theme={appTheme}
  aria-labelledby={titleId}
  oncancel={(event) => {
    event.preventDefault();
    requestClose();
  }}
  onclose={() => (open = false)}
>
  <header>
    <h2 id={titleId}>{title}</h2>
    <button type="button" aria-label={closeLabel} onclick={requestClose}>×</button>
  </header>
  {@render children()}
</dialog>

<style>
  dialog {
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    /* The revision sets dialogs at 14px, above the 10px card and 6px control radii. */
    border-radius: var(--fl-radius-dialog);
    box-shadow: var(--fl-shadow-2);
    max-width: min(40rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    padding: 1.375rem;
    /* Clamped by the prefers-reduced-motion rule in tokens.css. */
    animation: fl-dialog-in var(--fl-motion) var(--fl-ease);
  }
  @keyframes fl-dialog-in {
    from {
      opacity: 0;
      transform: scale(0.98) translateY(0.375rem);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  dialog.wide {
    width: min(56rem, calc(100vw - 2rem));
    max-width: min(56rem, calc(100vw - 2rem));
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 60%);
  }
  header {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 1rem;
  }
  h2 {
    font-size: 1.125rem;
  }
  button {
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    min-width: 44px;
  }
</style>
