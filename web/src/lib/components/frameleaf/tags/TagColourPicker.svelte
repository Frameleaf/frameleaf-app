<script lang="ts">
  import TagDot from '$lib/components/frameleaf/tags/TagDot.svelte';
  import TagSwatches from '$lib/components/frameleaf/tags/TagSwatches.svelte';
  import { tagColorHex, tagColorId, tagDotColor, type TagColorId } from '$lib/frameleaf/tag-tree';
  import { Icon } from '@frameleaf/ui';
  import { mdiPencilOutline, mdiTagOutline } from '@mdi/js';
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';

  /**
   * A button that opens the eight tag colours; choosing one applies it straight away and closes the
   * popup. Drawn as the tag page's colour tile (`tile`) or as its "Colour" action (`button`).
   *
   * Escape and a press outside close it, and focus goes back to the button. Escape is kept from the
   * page underneath, so closing the popup never also clears a selection.
   */
  let {
    color,
    variant,
    onChange,
  }: {
    /** The tag's stored colour (hex), or null when it has none. */
    color: string | null;
    variant: 'tile' | 'button';
    onChange: (color: TagColorId, hex: string) => void;
  } = $props();

  let open = $state(false);
  let root = $state<HTMLDivElement>();
  let trigger = $state<HTMLButtonElement>();
  const popupId = $props.id();

  const close = (restoreFocus: boolean) => {
    open = false;
    if (restoreFocus) {
      trigger?.focus();
    }
  };

  const toggle = async () => {
    open = !open;
    if (open) {
      await tick();
      const swatches = root?.querySelectorAll<HTMLElement>('[role="radio"]') ?? [];
      ([...swatches].find((swatch) => swatch.tabIndex === 0) ?? swatches[0])?.focus();
    }
  };

  $effect(() => {
    if (!open) {
      return;
    }
    const onPointerDown = (event: PointerEvent) => {
      if (!root?.contains(event.target as Node)) {
        close(false);
      }
    };
    document.addEventListener('pointerdown', onPointerDown, { capture: true });
    return () => document.removeEventListener('pointerdown', onPointerDown, true);
  });

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key !== 'Escape' || !open) {
      return;
    }
    event.preventDefault();
    event.stopPropagation();
    close(true);
  };

  const onFocusOut = (event: FocusEvent) => {
    const next = event.relatedTarget as Node | null;
    if (open && next && !root?.contains(next)) {
      close(false);
    }
  };
</script>

<div class="picker" bind:this={root} onkeydown={onKeydown} onfocusout={onFocusOut} role="presentation">
  {#if variant === 'tile'}
    <button
      bind:this={trigger}
      type="button"
      class="tile"
      class:open
      style:--tag-color={tagDotColor(color)}
      aria-label={$t('frameleaf_tags_change_color')}
      title={$t('frameleaf_tags_change_color')}
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? popupId : undefined}
      onclick={() => void toggle()}
    >
      <Icon icon={mdiTagOutline} size="26" aria-hidden />
      <span class="badge" aria-hidden="true"><Icon icon={mdiPencilOutline} size="12" /></span>
    </button>
  {:else}
    <button
      bind:this={trigger}
      type="button"
      class="action"
      class:open
      aria-haspopup="dialog"
      aria-expanded={open}
      aria-controls={open ? popupId : undefined}
      onclick={() => void toggle()}
    >
      <TagDot {color} />
      <span>{$t('frameleaf_tags_color')}</span>
    </button>
  {/if}
  {#if open}
    <div id={popupId} class="popup fl-pop" role="dialog" aria-label={$t('frameleaf_tags_color_title')}>
      <TagSwatches
        value={tagColorId(color)}
        onChange={(next) => {
          close(true);
          onChange(next, tagColorHex(next));
        }}
      />
    </div>
  {/if}
</div>

<style>
  .picker {
    position: relative;
    display: inline-flex;
  }
  /* The album header's icon tile (AlbumHeader `.icon-button`), filled with the tag's colour. */
  .tile {
    position: relative;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 3rem;
    block-size: 3rem;
    padding: 0;
    color: #fff;
    background: var(--tag-color);
    border: 1px solid transparent;
    border-radius: var(--fl-radius-card);
    box-shadow: inset 0 0 0 0.5px #ffffff40;
  }
  .badge {
    position: absolute;
    inset-block-end: -0.25rem;
    inset-inline-end: -0.25rem;
    display: inline-flex;
    align-items: center;
    justify-content: center;
    inline-size: 1.25rem;
    block-size: 1.25rem;
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-radius: 50%;
    opacity: 0;
    transition: opacity var(--fl-motion-fast) var(--fl-ease);
  }
  .tile:hover .badge,
  .tile:focus-visible .badge,
  .tile.open .badge {
    opacity: 1;
  }
  /* The album header's action button (AlbumHeader `.action`). */
  .action {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    padding: 0 var(--fl-space-3);
    min-height: 44px;
    white-space: nowrap;
    font: inherit;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .action:hover {
    background: color-mix(in srgb, var(--fl-raised), var(--fl-text) 8%);
  }
  .action.open {
    background: color-mix(in srgb, var(--fl-text) 12%, var(--fl-raised));
    border-color: color-mix(in srgb, var(--fl-text) 28%, var(--fl-border));
  }
  .popup {
    position: absolute;
    inset-block-start: calc(100% + var(--fl-space-2));
    inset-inline-start: 0;
    z-index: var(--fl-z-popover);
    width: max-content;
    max-width: calc(100vw - 32px);
    padding: var(--fl-space-3) var(--fl-space-4);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
    transform-origin: top left;
  }
</style>
