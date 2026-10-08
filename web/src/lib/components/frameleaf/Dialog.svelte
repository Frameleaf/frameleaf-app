<script lang="ts">
  import '$lib/frameleaf/tokens.css';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import { leave } from '$lib/frameleaf/motion';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { Icon, Theme as AppTheme, themeManager } from '@frameleaf/ui';
  import { mdiClose } from '@mdi/js';
  import { onDestroy, untrack, type Snippet } from 'svelte';
  /**
   * The Frameleaf modal: prototype `Dialog` (template/src/Controls.jsx) and its `.dialog`
   * styles, with the September 24 sheet chrome (apple-style.css:106-135, 211-217, 303-321):
   * continuous sheet corners, a spring entry, and a dimmed, blurred backdrop. A title bar with
   * an icon close button, the body, and an optional `actions` footer that stays pinned while a
   * long body scrolls.
   *
   * It opens and closes on the Sheet motion pattern (BRAND.md). Setting `open` to false plays the
   * exit and then closes the native dialog and returns focus; `onClosed` fires at that point. A
   * caller that unmounts the dialog in response to closing (a `modalManager.show` wrapper) should
   * do so from `onClosed`, not as soon as `open` turns false, or the exit is cut short.
   */
  let {
    title,
    closeLabel,
    returnFocus,
    open = $bindable(false),
    onRequestClose,
    onkeydown,
    wide = false,
    compactControls = false,
    onClosed,
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
    /** Lets a modal keep its keys from underlying viewer shortcuts. */
    onkeydown?: (event: KeyboardEvent) => void;
    /** A workflow with side-by-side evidence (FL-59), like the design's wide dialogs. */
    wide?: boolean;
    /** Opt in to the prototype's compact desktop controls while retaining touch targets. */
    compactControls?: boolean;
    /** Runs once the exit has finished and the dialog is closed. Not called if the dialog is unmounted first. */
    onClosed?: () => void;
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

  // Not $state: bookkeeping for the exit, never rendered.
  let shown = false;
  let previous: Element | null = null;
  let cancelLeave: (() => void) | undefined;
  let finishLeave: (() => void) | undefined;
  let destroyed = false;

  /** Closes the native dialog and hands focus back to whatever opened it. */
  const closeNow = () => {
    if (dialog.open) {
      dialog.close();
    }
    // The exit holds its last frame until the dialog is closed; release it for the next open.
    cancelLeave?.();
    cancelLeave = finishLeave = undefined;
    if (previous instanceof HTMLElement && previous.isConnected) {
      previous.focus();
    }
  };

  // Runs only when `open` changes; unmounting is handled by onDestroy below.
  $effect(() => {
    if (open) {
      // Reopened while the exit was still playing: keep the dialog and drop the exit.
      cancelLeave?.();
      cancelLeave = finishLeave = undefined;
      if (!dialog.open) {
        previous = untrack(() => returnFocus) ?? document.activeElement;
        dialog.showModal();
        // As in the prototype, a caller marks the control that should take focus first.
        dialog.querySelector<HTMLElement>('[data-initial-focus]')?.focus();
      }
      shown = true;
      return;
    }
    if (!shown) {
      return;
    }
    shown = false;
    const exit = { finished: false };
    const finish = () => {
      exit.finished = true;
      closeNow();
      // A dialog torn down by its owner has nobody left to tell.
      if (!destroyed) {
        onClosed?.();
      }
    };
    finishLeave = finish;
    // Sheet exit, then close. Where nothing can animate, `finish` runs at once, as before.
    const cancel = leave(dialog, 'sheet', finish, { backdrop: true });
    if (!exit.finished) {
      cancelLeave = cancel;
    }
  });

  // Unmounted while open or mid-exit: close and return focus now, there is nothing left to animate.
  onDestroy(() => {
    destroyed = true;
    if (finishLeave) {
      finishLeave();
    } else if (shown) {
      closeNow();
    }
  });
</script>

<dialog
  bind:this={dialog}
  class="frameleaf dialog fl-continuous-corners"
  class:wide
  class:compact-controls={compactControls}
  class:with-actions={!!actions}
  data-theme={appTheme}
  aria-labelledby={titleId}
  {onkeydown}
  oncancel={(event) => {
    event.preventDefault();
    requestClose();
  }}
  onclose={() => (open = false)}
>
  <header class="dialog-title">
    <h2 id={titleId}>{title}</h2>
    <IconButton label={closeLabel} onclick={requestClose}><Icon icon={mdiClose} size={ICON_SIZE.lg} /></IconButton>
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
   * template/src/styles.css `.dialog` with the apple-style.css sheet: the radius, elevation,
   * scrim and motion all come from the token scale. The entrance is the Sheet pattern (base.css
   * keyframes `fl-fade-in` and `fl-sheet-in`); the exit is played from script (motion.ts `leave`)
   * so it can finish before the native dialog closes. Under Reduce Motion the media query below
   * turns the rise into a crossfade. A dialog mounted inside another `.frameleaf` scope is also
   * matched by the tokens.css clamp (`.frameleaf *`, !important), so that rule is !important too
   * and wins on specificity, keeping the crossfade rather than an instant change.
   */
  .dialog {
    color: var(--fl-text);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-sheet);
    padding: 22px;
    margin: auto;
    width: 100%;
    max-width: min(510px, calc(100vw - 32px));
    max-height: calc(100dvh - 44px);
    overflow: auto;
    box-shadow: var(--fl-shadow-4);
    animation:
      fl-fade-in var(--fl-duration-fade) var(--fl-ease) both,
      fl-sheet-in var(--fl-duration-sheet) var(--fl-spring) both;
  }
  .dialog.wide {
    max-width: min(1120px, calc(100vw - 32px));
  }
  .dialog.compact-controls {
    /* The upstream app root's 0.1px tracking changes the prototype's description wrapping. */
    letter-spacing: normal;
  }
  @media (min-width: 701px) and (pointer: fine) {
    .dialog.compact-controls :global(button.button) {
      min-height: 34px;
    }
    .dialog.compact-controls .dialog-title :global(button) {
      min-height: 34px;
      min-width: 40px;
    }
  }
  @media (pointer: coarse) {
    .dialog.compact-controls :global(button) {
      min-height: 48px;
      min-width: 48px;
    }
  }
  /*
   * The shared scrim. The fallbacks repeat the token values for engines where ::backdrop does
   * not inherit custom properties from its dialog.
   */
  .dialog::backdrop {
    background: var(--fl-scrim, rgb(0 0 0 / 40%));
    -webkit-backdrop-filter: var(--fl-scrim-blur, blur(12px));
    backdrop-filter: var(--fl-scrim-blur, blur(12px));
    animation: fl-fade-in var(--fl-duration-fade, 200ms) var(--fl-ease, ease) both;
  }
  @supports (corner-shape: squircle) {
    .dialog {
      border-radius: calc(var(--fl-radius-sheet) * 1.8);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .dialog {
      animation: fl-fade-in var(--fl-duration-reduced) var(--fl-ease) both !important;
    }
  }
  /* The solid fallback of the frosted materials: a darker scrim, nothing blurred behind it. */
  @media (prefers-contrast: more), (prefers-reduced-transparency: reduce) {
    .dialog::backdrop {
      background: var(--fl-scrim, rgb(0 0 0 / 67%));
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
    font-size: var(--fl-font-headline);
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
     * tokens.css draws it 2px wide at a 2px offset (4px out from the field), so 6px clears it.
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
