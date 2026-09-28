<script lang="ts">
  import '$lib/frameleaf/tokens.css';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { Icon, Theme as AppTheme, themeManager } from '@immich/ui';
  import { mdiClose } from '@mdi/js';
  import type { Snippet } from 'svelte';
  /**
   * The Frameleaf modal: prototype `Dialog` (template/src/Controls.jsx) and its `.dialog`
   * styles, with the September 24 sheet chrome (apple-style.css:106-135, 211-217, 303-321):
   * 22px continuous corners, a spring entry, and a dimmed, blurred backdrop. A title bar with
   * an icon close button, the body, and an optional `actions` footer that stays pinned while a
   * long body scrolls.
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
  class="frameleaf dialog fl-continuous-corners"
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
  /*
   * template/src/styles.css `.dialog` with the apple-style.css sheet: the radius and motion come
   * from the token scale. Under Reduce Motion the media query below turns the rise into a
   * crossfade. A dialog mounted inside another `.frameleaf` scope is also matched by the
   * tokens.css clamp (`.frameleaf *`, !important), so that rule is !important too and wins on
   * specificity, keeping the crossfade rather than an instant change.
   */
  .dialog {
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-sheet);
    padding: 22px;
    width: 100%;
    max-width: min(510px, calc(100vw - 32px));
    max-height: calc(100dvh - 44px);
    overflow: auto;
    box-shadow: 0 18px 80px rgb(0 0 0 / 47%);
    animation:
      fl-sheet-fade 220ms ease both,
      fl-sheet-rise 480ms var(--fl-spring) both;
  }
  .dialog.wide {
    max-width: min(1120px, calc(100vw - 32px));
  }
  .dialog::backdrop {
    background: rgb(0 0 0 / 40%);
    -webkit-backdrop-filter: blur(12px);
    backdrop-filter: blur(12px);
    animation: fl-sheet-fade 260ms ease both;
  }
  @keyframes fl-sheet-fade {
    from {
      opacity: 0;
    }
  }
  @keyframes fl-sheet-rise {
    from {
      translate: 0 40px;
      scale: 0.96;
    }
  }
  @supports (corner-shape: squircle) {
    .dialog {
      border-radius: calc(var(--fl-radius-sheet) * 1.8);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dialog {
      animation: fl-sheet-fade 200ms ease both !important;
    }
  }
  /* The solid fallback of the frosted materials: a darker scrim, nothing blurred behind it. */
  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .dialog::backdrop {
      background: rgb(0 0 0 / 67%);
      -webkit-backdrop-filter: none;
      backdrop-filter: none;
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
