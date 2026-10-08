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
   * accent-tinted pill, struck through in red for an exclusion, with a squircle face photo for a
   * person. The palette's typed chips, the search results page's filter row (SD-12) and the
   * Library's active-filter bar (through FilterChip) share it.
   */
  let {
    label,
    removeLabel,
    onRemove,
    onOpen,
    exclude = false,
    title,
    icon,
    person,
    onUnavailable,
    children,
  }: {
    label?: string;
    removeLabel: string;
    onRemove: () => void;
    /** Makes the label a button that opens the filters at this chip's section, as the Library's chips do. */
    onOpen?: () => void;
    exclude?: boolean;
    title?: string;
    /** A leading icon, such as the magnifier on the search-text chip. */
    icon?: string;
    person?: PersonResponseDto;
    /** The person's face could not be shown (access narrowed); the caller drops the chip. */
    onUnavailable?: () => void;
    /** Replaces `label`, for a value that is still loading. */
    children?: Snippet;
  } = $props();
</script>

<!-- A chip settles in on the spring and leaves on a short fade; Reduce Motion makes both a crossfade. -->
<span
  class="search-chip"
  class:exclude
  {title}
  in:motionScale={{ start: 0.9, duration: DURATION.slow, easing: springEasing }}
  out:motionFade={{ duration: DURATION.fast }}
>
  {#if icon}
    <span class="chip-icon" aria-hidden="true"><Icon {icon} size="15" /></span>
  {:else if person}
    <PersonAvatar {person} size={18} {onUnavailable} />
  {/if}
  {#if onOpen}
    <button type="button" class="open" onclick={onOpen}>{label}</button>
  {:else if children}{@render children()}{:else}{label}{/if}
  <button type="button" aria-label={removeLabel} onclick={onRemove}>
    <Icon icon={mdiClose} size="12" aria-hidden={true} />
  </button>
</span>

<style>
  /*
   * The one chip: the palette's accent-tinted pill at the general Chip primitive's height. On a
   * touch screen the chip and its controls grow to the control height so the × is easy to hit.
   */
  .search-chip {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 6px;
    min-height: 1.75rem;
    padding: 2px 4px 2px 8px;
    border-radius: var(--fl-radius-pill);
    background: color-mix(in srgb, var(--fl-accent) 22%, transparent);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .exclude {
    background: color-mix(in srgb, var(--fl-danger) 22%, transparent);
    text-decoration: line-through;
    text-decoration-color: color-mix(in srgb, var(--fl-danger) 60%, transparent);
  }
  .chip-icon {
    display: inline-grid;
    flex-shrink: 0;
    place-items: center;
    color: var(--fl-muted);
  }
  button {
    display: inline-grid;
    flex-shrink: 0;
    place-items: center;
    min-width: 24px;
    min-height: 24px;
    padding: 2px;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  button:hover {
    background: color-mix(in srgb, var(--fl-text) 10%, transparent);
  }
  .open {
    display: inline;
    min-width: 0;
    padding: 0 2px;
    font: inherit;
    text-align: start;
    overflow-wrap: anywhere;
  }
  .open:hover {
    background: transparent;
    text-decoration: underline;
  }
  @media (pointer: coarse) {
    .search-chip {
      min-height: var(--fl-control-height);
    }
    button {
      min-width: var(--fl-control-height);
      min-height: var(--fl-control-height);
    }
    .open {
      min-width: 0;
    }
  }
</style>
