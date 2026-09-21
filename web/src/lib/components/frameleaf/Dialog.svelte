<script lang="ts">
  import type { Snippet } from 'svelte';
  let {
    title,
    closeLabel,
    returnFocus,
    open = $bindable(false),
    children,
  }: {
    title: string;
    closeLabel: string;
    returnFocus?: HTMLElement;
    open?: boolean;
    children: Snippet;
  } = $props();
  let dialog: HTMLDialogElement;
  const titleId = $props.id();
  $effect(() => {
    if (!open || dialog.open) {
      return;
    }

    const previous = returnFocus ?? document.activeElement;
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
    border-radius: var(--fl-panel-radius);
    max-width: min(40rem, calc(100vw - 2rem));
    max-height: calc(100dvh - 2rem);
    padding: 1rem;
  }
  dialog::backdrop {
    background: rgb(0 0 0 / 65%);
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
    border-radius: var(--fl-radius);
    min-width: 44px;
  }
</style>
