<script lang="ts">
  import PersonAvatar from './PersonAvatar.svelte';
  import type { PersonResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
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

<span class="chip">
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
    padding-inline-start: 0.5rem;
    font-size: var(--fl-font-small);
    border: 1px solid var(--fl-accent);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-text);
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
    background: transparent;
    color: inherit;
    border: 0;
    border-radius: var(--fl-radius-pill);
  }
  .chip-label {
    flex-shrink: 1;
    padding: 0;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .chip-label:hover {
    text-decoration: underline;
  }
  .chip-remove {
    display: inline-grid;
    place-items: center;
    min-width: 44px;
  }
</style>
