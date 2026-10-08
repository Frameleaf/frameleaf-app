<script lang="ts">
  import SearchChip from './SearchChip.svelte';
  import type { PersonResponseDto } from '@frameleaf/sdk';
  /**
   * An active-filter chip (prototype `App.jsx` `.active-filter-bar .chip`). The label opens the
   * filter panel at the chip's own section when `onOpen` is given; the × removes the condition.
   * It is the same chip as the search palette and the search results page (SearchChip).
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

<SearchChip {label} {removeLabel} {onRemove} {onOpen} {icon} {person} {onUnavailable} />
