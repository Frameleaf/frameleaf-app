<script lang="ts">
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import '$lib/frameleaf/tokens.css';
  import type { PersonResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
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
    exclude = false,
    title,
    person,
    children,
  }: {
    label?: string;
    removeLabel: string;
    onRemove: () => void;
    exclude?: boolean;
    title?: string;
    person?: PersonResponseDto;
    /** Replaces `label`, for a value that is still loading. */
    children?: Snippet;
  } = $props();
</script>

<span class="search-chip fl-continuous-corners" class:exclude {title}>
  {#if person}
    <PersonAvatar {person} size={18} />
  {/if}
  {#if children}{@render children()}{:else}{label}{/if}
  <button type="button" aria-label={removeLabel} onclick={onRemove}>
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
    border-radius: 8px;
    background: color-mix(in srgb, var(--fl-accent) 22%, transparent);
    color: var(--fl-text);
    font-size: 13px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  @supports (corner-shape: squircle) {
    .search-chip {
      border-radius: 14px;
    }
  }
  .exclude {
    background: color-mix(in srgb, #ff453a 22%, transparent);
    text-decoration: line-through;
    text-decoration-color: #ff453a99;
  }
  button {
    display: inline-grid;
    flex-shrink: 0;
    place-items: center;
    min-width: 20px;
    min-height: 20px;
    padding: 2px;
    border: 0;
    border-radius: 4px;
    background: transparent;
    color: inherit;
    cursor: pointer;
  }
  button:hover {
    background: color-mix(in srgb, var(--fl-text) 10%, transparent);
  }
</style>
