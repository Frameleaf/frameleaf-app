<script lang="ts">
  import PersonAvatar from './PersonAvatar.svelte';
  import type { PersonResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose } from '@mdi/js';
  /**
   * An active-filter chip (prototype `App.jsx` `.active-filter-bar .chip`). The label opens the
   * filter panel at the chip's own section when `onOpen` is given; the × removes the condition.
   */
  let {
    label,
    removeLabel,
    onRemove,
    onOpen,
    icon,
    person,
    onUnavailable,
  }: {
    label: string;
    removeLabel: string;
    onRemove: () => void;
    /** Open the filter panel at this chip's section (prototype `.chip-label`). */
    onOpen?: () => void;
    /** A leading icon, such as the magnifier on the search-text chip. */
    icon?: string;
    person?: PersonResponseDto;
    onUnavailable?: () => void;
  } = $props();
</script>

<span class="chip fl-continuous-corners">
  {#if icon}
    <span class="chip-icon" aria-hidden="true"><Icon {icon} size="15" /></span>
  {:else}
    <PersonAvatar {person} {onUnavailable} />
  {/if}
  {#if onOpen}
    <button type="button" class="label chip-label" onclick={onOpen}>{label}</button>
  {:else}
    <span class="label">{label}</span>
  {/if}
  <button type="button" class="chip-remove" aria-label={removeLabel} onclick={onRemove}>
    <Icon icon={mdiClose} size="14" />
  </button>
</span>

<style>
  /* Shares the pill shape and secondary type size of the general Chip primitive. */
  .chip {
    display: inline-flex;
    max-width: 100%;
    align-items: center;
    gap: 0.375rem;
    padding: 3px 4px 3px 8px;
    font-size: var(--fl-font-small);
    /* The same accent-tinted chip as the search palette and the search results (SearchChip). */
    border: 0;
    border-radius: var(--fl-radius-control-compact);
    background: color-mix(in srgb, var(--fl-accent) 22%, transparent);
    color: var(--fl-text);
    font-weight: 500;
  }
  @supports (corner-shape: squircle) {
    .chip {
      border-radius: calc(var(--fl-radius-control-compact) * 1.8);
    }
  }
  .chip-icon {
    display: inline-grid;
    place-items: center;
    color: var(--fl-muted);
  }
  .label {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  button {
    flex-shrink: 0;
    min-width: 0;
    min-height: 0;
    background: transparent;
    color: inherit;
    border: 0;
    border-radius: var(--fl-radius-xs);
  }
  /* Above the remove target (below), so reaching for the mark never takes a press meant for a label. */
  .chip-label {
    position: relative;
    z-index: 1;
    flex-shrink: 1;
    padding: 0;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .chip-label:hover {
    text-decoration: underline;
  }
  /*
   * The remove mark is 20px so the chip keeps its height and width; the pseudo-element keeps the
   * pointer target at the full control height around it.
   */
  .chip-remove {
    position: relative;
    display: inline-grid;
    place-items: center;
    width: 20px;
    height: 20px;
    padding: 2px;
    cursor: pointer;
  }
  .chip-remove::after {
    position: absolute;
    inset: calc((20px - var(--fl-control-height)) / 2);
    content: '';
  }
  .chip-remove:hover {
    background: color-mix(in srgb, var(--fl-text) 10%, transparent);
  }
</style>
