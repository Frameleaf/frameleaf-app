<script lang="ts">
  /**
   * The one light viewer (FL-1814; the prototype's `LightViewer` in `ComponentsSheet.jsx`): for
   * looking closely at a photo inside a review, without leaving it for the full asset viewer.
   * Previous, next and close; focus stays inside it, the arrow keys move, Escape closes, and focus
   * goes back to whatever opened it.
   *
   * Mount it while a photo is open (`{#if open}<LightViewer …>`). What is being looked at is the
   * caller's: the stage (`children`), and optionally a line of actions under it (`footer`) and a
   * panel beside it (`aside`). Extra keys (K to keep, A to accept) stay with the caller.
   */
  import { focusTrap } from '$lib/actions/focus-trap';
  import { portal } from '$lib/elements/Portal.svelte';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronLeft, mdiChevronRight, mdiClose } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    label,
    heading,
    position,
    hasPrevious,
    hasNext,
    onPrevious,
    onNext,
    onClose,
    children,
    footer,
    aside,
  }: {
    /** The dialog's accessible name: what is being looked at. */
    label: string;
    /** Shown at the top left, before the position. */
    heading?: string;
    /** "3 of 12". */
    position?: string;
    hasPrevious: boolean;
    hasNext: boolean;
    onPrevious: () => void;
    onNext: () => void;
    onClose: () => void;
    children: Snippet;
    footer?: Snippet;
    aside?: Snippet;
  } = $props();

  const onkeydown = (event: KeyboardEvent) => {
    // A dialog opened from here (a confirmation) owns the keyboard until it closes.
    if (
      event.defaultPrevented ||
      event.metaKey ||
      event.ctrlKey ||
      event.altKey ||
      document.querySelector('dialog[open]')
    ) {
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      onClose();
    } else if (event.key === 'ArrowRight' && hasNext) {
      event.preventDefault();
      onNext();
    } else if (event.key === 'ArrowLeft' && hasPrevious) {
      event.preventDefault();
      onPrevious();
    }
  };
</script>

<svelte:window {onkeydown} />

<!-- focusTrap puts the focus on Close, keeps Tab inside, and hands focus back to the opener on close. -->
<!-- On the body (with the Frameleaf scope it leaves behind), so no page container can hold the fixed overlay inside itself. -->
<div class="frameleaf light-viewer" role="dialog" aria-modal="true" aria-label={label} use:portal use:focusTrap>
  <!-- The layout sits one level in: focusTrap adds its own sentinel elements to the element it is on. -->
  <div class="frame" class:with-aside={aside}>
    <div class="main">
      <header>
        <span class="what">
          {#if heading}<strong>{heading}</strong>{/if}
          {#if position}<small>{position}</small>{/if}
        </span>
        <button type="button" class="round" aria-label={$t('close')} onclick={onClose}>
          <Icon icon={mdiClose} size={ICON_SIZE.lg} aria-hidden />
        </button>
      </header>
      <div class="stage">
        <button
          type="button"
          class="round previous"
          aria-label={$t('frameleaf_tidy_previous')}
          disabled={!hasPrevious}
          onclick={onPrevious}
        >
          <Icon icon={mdiChevronLeft} size={ICON_SIZE.hero} aria-hidden />
        </button>
        <div class="content">{@render children()}</div>
        <button
          type="button"
          class="round next"
          aria-label={$t('frameleaf_tidy_next')}
          disabled={!hasNext}
          onclick={onNext}
        >
          <Icon icon={mdiChevronRight} size={ICON_SIZE.hero} aria-hidden />
        </button>
      </div>
      {#if footer}
        <footer>{@render footer()}</footer>
      {/if}
    </div>
    {#if aside}
      <aside>{@render aside()}</aside>
    {/if}
  </div>
</div>

<style>
  .light-viewer {
    position: fixed;
    inset: 0;
    z-index: var(--fl-z-modal);
    background: color-mix(in srgb, var(--fl-canvas) 92%, transparent);
    color: var(--fl-text);
  }
  .frame {
    display: grid;
    grid-template-columns: minmax(0, 1fr);
    height: 100%;
  }
  .frame.with-aside {
    grid-template-columns: minmax(0, 1fr) 360px;
  }
  .main {
    display: grid;
    grid-template-rows: auto minmax(0, 1fr) auto;
    min-width: 0;
    min-height: 0;
  }
  header,
  footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4) var(--fl-space-6);
    font-size: var(--fl-font-md);
  }
  .what {
    display: flex;
    align-items: baseline;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .what small {
    color: var(--fl-muted);
    font-size: inherit;
  }
  .stage {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-4);
    min-height: 0;
    padding: 0 var(--fl-space-6) var(--fl-space-6);
  }
  .content {
    display: grid;
    justify-items: center;
    min-width: 0;
    min-height: 0;
  }
  /* A bare photo on the stage; a caller with its own layout styles its own. */
  .content > :global(img) {
    max-width: 100%;
    max-height: calc(100vh - 200px);
    border-radius: var(--fl-radius-card);
    object-fit: contain;
  }
  .round {
    display: grid;
    place-items: center;
    flex: none;
    width: 44px;
    height: 44px;
    border: 1px solid var(--fl-border);
    border-radius: 50%;
    background: var(--fl-raised);
    color: var(--fl-text);
    cursor: pointer;
  }
  .round:disabled {
    cursor: default;
    opacity: 0.35;
  }
  aside {
    display: grid;
    grid-template-rows: minmax(0, 1fr) auto;
    min-height: 0;
    border-inline-start: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
  @media (max-width: 800px) {
    .frame.with-aside {
      grid-template-rows: minmax(0, 1fr) minmax(0, 46vh);
      grid-template-columns: minmax(0, 1fr);
    }
    aside {
      border-top: 1px solid var(--fl-border);
      border-inline-start: 0;
    }
    header,
    footer {
      padding: var(--fl-space-3) var(--fl-space-4);
    }
    /* The photo needs the full width, so previous and next sit beneath it. */
    .stage {
      grid-template-areas: 'content content' 'previous next';
      grid-template-rows: minmax(0, 1fr) auto;
      grid-template-columns: auto auto;
      gap: var(--fl-space-3) var(--fl-space-2);
      padding: 0 var(--fl-space-4) var(--fl-space-3);
    }
    .content {
      grid-area: content;
    }
    .previous {
      grid-area: previous;
      justify-self: start;
    }
    .next {
      grid-area: next;
      justify-self: end;
    }
  }
</style>
