<script lang="ts">
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import { motionFade, motionScale, springEasing } from '$lib/frameleaf/motion';
  import { DURATION } from '$lib/frameleaf/tokens';
  import '$lib/frameleaf/tokens.css';
  import type { PersonResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose } from '@mdi/js';
  import type { Snippet } from 'svelte';

  /**
   * A removable search chip in the search palette's style (`search-palette.css` `.sp-token`): an
   * accent-tinted continuous-corner pill, struck through in red for an exclusion, with a squircle face
   * photo for a person. The palette's typed chips and the search results page's filter row (SD-12) share it.
   */
  let {
    label,
    removeLabel,
    onRemove,
    onOpen,
    exclude = false,
    title,
    person,
    children,
  }: {
    label?: string;
    removeLabel: string;
    onRemove: () => void;
    /** Makes the label a button that opens the filters at this chip's section, as the Library's chips do. */
    onOpen?: () => void;
    exclude?: boolean;
    title?: string;
    person?: PersonResponseDto;
    /** Replaces `label`, for a value that is still loading. */
    children?: Snippet;
  } = $props();
</script>

<!-- A chip settles in on the spring and leaves on a short fade; Reduce Motion makes both a crossfade. -->
<span
  class="search-chip fl-continuous-corners"
  class:exclude
  {title}
  in:motionScale={{ start: 0.9, duration: DURATION.slow, easing: springEasing }}
  out:motionFade={{ duration: DURATION.fast }}
>
  {#if person}
    <PersonAvatar {person} size={18} />
  {/if}
  {#if onOpen}
    <button type="button" class="open" onclick={onOpen}>{label}</button>
  {:else if children}{@render children()}{:else}{label}{/if}
  <button type="button" class="remove" aria-label={removeLabel} onclick={onRemove}>
    <Icon icon={mdiClose} size="12" aria-hidden={true} />
  </button>
</span>

<style>
  .search-chip {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 6px;
    padding: 3px 4px 3px 8px;
    border-radius: var(--fl-radius-control-compact);
    background: color-mix(in srgb, var(--fl-accent) 22%, transparent);
    color: var(--fl-text);
    font-size: 13px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  @supports (corner-shape: squircle) {
    .search-chip {
      border-radius: calc(var(--fl-radius-control-compact) * 1.8);
    }
  }
  .exclude {
    background: color-mix(in srgb, var(--fl-danger) 22%, transparent);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--fl-danger) 60%, transparent);
  }
  button {
    display: inline-grid;
    flex-shrink: 0;
    place-items: center;
    min-width: 20px;
    min-height: 20px;
    padding: 2px;
    border: 0;
    border-radius: var(--fl-radius-xs);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  button:hover {
    background: color-mix(in srgb, var(--fl-text) 10%, transparent);
  }
  /*
   * The remove mark stays 20px so the chip keeps its height; the pseudo-element gives it the full
   * control-height target. A label that opens the filters sits above that target, so reaching for
   * the mark never takes a press meant for a label.
   */
  .remove {
    position: relative;
    width: 20px;
    height: 20px;
  }
  .remove::after {
    position: absolute;
    inset: calc((20px - var(--fl-control-height)) / 2);
    content: '';
  }
  .open {
    position: relative;
    z-index: 1;
    display: inline;
    min-width: 0;
    padding: 0 2px;
    font: inherit;
    text-align: start;
    overflow-wrap: anywhere;
  }
</style>
