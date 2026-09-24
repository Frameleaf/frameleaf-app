<script lang="ts">
  import '$lib/frameleaf/tokens.css';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiClose } from '@mdi/js';
  import type { Snippet } from 'svelte';
  /**
   * The Frameleaf modal: September 22 prototype `Dialog` (template/src/Controls.jsx) and its
   * `.dialog` styles. A title bar with an icon close button, the body, and an optional
   * `actions` footer that stays pinned while a long body scrolls.
   */
  let {
    title,
    closeLabel,
    returnFocus,
    open = $bindable(false),
    onRequestClose,
    wide = false,
    children,
    actions,
  }: {
    title: string;
    /** Accessible name of the icon close button. */
    closeLabel: string;
    returnFocus?: HTMLElement;
    open?: boolean;
    /** Lets a caller guard X and Escape before the dialog closes. */
    onRequestClose?: () => void;
    /** A workflow with side-by-side evidence (FL-59), like the design's wide dialogs. */
    wide?: boolean;
    children: Snippet;
    /**
     * The footer buttons. A form body associates its submit button through the `form`
     * attribute, because the footer sits outside the scrolling body.
     */
    actions?: Snippet;
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

    const previous = returnFocus ?? document.activeElement;
    dialog.showModal();
    // As in the prototype, a caller marks the control that should take focus first.
    dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
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
  class="frameleaf dialog"
  class:wide
  class:with-actions={!!actions}
  data-theme={appTheme}
  aria-labelledby={titleId}
  oncancel={(event) => {
    event.preventDefault();
    requestClose();
  }}
  onclose={() => (open = false)}
>
  <header class="dialog-title">
    <h2 id={titleId}>{title}</h2>
    <IconButton label={closeLabel} onclick={requestClose}><Icon icon={mdiClose} size="1.125rem" /></IconButton>
  </header>
  {#if actions}
    <div class="dialog-body">{@render children()}</div>
    <footer class="dialog-actions">{@render actions()}</footer>
  {:else}
    {@render children()}
  {/if}
</dialog>

<style>
  /* template/src/styles.css `.dialog`; the radius and motion come from the token scale. */
  .dialog {
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-dialog);
    padding: 22px;
    width: 100%;
    max-width: min(510px, calc(100vw - 32px));
    max-height: calc(100dvh - 44px);
    overflow: auto;
    box-shadow: 0 18px 80px rgb(0 0 0 / 47%);
    /* Clamped by the prefers-reduced-motion rule in tokens.css. */
    animation: fl-dialog-in var(--fl-motion) var(--fl-ease);
  }
  .dialog.wide {
    max-width: min(1120px, calc(100vw - 32px));
  }
  .dialog::backdrop {
    background: rgb(0 0 0 / 60%);
    backdrop-filter: blur(2px);
  }
  @keyframes fl-dialog-in {
    from {
      opacity: 0;
      transform: scale(0.98) translateY(6px);
    }
    to {
      opacity: 1;
      transform: none;
    }
  }
  .dialog-title {
    display: flex;
    justify-content: space-between;
    gap: 20px;
    align-items: center;
    margin-bottom: 20px;
  }
  h2 {
    margin: 0;
    font-size: 18px;
    font-weight: 600;
  }
  .dialog-actions {
    display: flex;
    justify-content: flex-end;
    gap: 10px;
    padding-top: 18px;
    border-top: 1px solid var(--fl-border);
    margin-top: 20px;
  }
  .dialog.with-actions[open] {
    display: flex;
    flex-direction: column;
    overflow: hidden;
  }
  .dialog.with-actions .dialog-title,
  .dialog.with-actions .dialog-actions {
    flex-shrink: 0;
  }
  .dialog-body {
    overflow: auto;
    min-height: 0;
    /*
     * Room for a full-width field's focus ring, which the scrolling body would otherwise clip:
     * tokens.css draws it 2px wide at a 3px offset (5px out from the field), so 6px clears it.
     * The negative margin keeps the prototype's edges.
     */
    padding: 6px;
    margin: -6px;
  }
  @media (max-width: 700px) {
    .dialog {
      padding: 17px;
      max-height: calc(100dvh - 24px);
    }
    .dialog.wide {
      max-width: calc(100vw - 16px);
    }
    h2 {
      font-size: 15px;
    }
    .dialog-actions {
      flex-wrap: wrap;
      justify-content: stretch;
    }
    /* The prototype shrinks footer text here; the 44px floor stays from tokens.css. */
    .dialog-actions > :global(*) {
      flex: 1;
    }
  }
</style>
