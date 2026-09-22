<script lang="ts">
  import type { Snippet } from 'svelte';
  let {
    title,
    closeLabel,
    open = $bindable(false),
    children,
  }: {
    title: string;
    closeLabel: string;
    open?: boolean;
    children: Snippet;
  } = $props();
  let dialog: HTMLDialogElement;
  const titleId = $props.id();
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

<dialog bind:this={dialog} aria-labelledby={titleId} onclose={() => (open = false)}>
  <header>
    <h2 id={titleId}>{title}</h2>
    <button type="button" aria-label={closeLabel} onclick={() => (open = false)}>×</button>
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
