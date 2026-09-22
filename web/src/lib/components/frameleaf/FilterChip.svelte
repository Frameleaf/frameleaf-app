<script lang="ts">
  import PersonAvatar from './PersonAvatar.svelte';
  import type { PersonResponseDto } from '@immich/sdk';
  let {
    label,
    removeLabel,
    onRemove,
    person,
    onUnavailable,
  }: {
    label: string;
    removeLabel: string;
    onRemove: () => void;
    person?: PersonResponseDto;
    onUnavailable?: () => void;
  } = $props();
</script>

<span class="chip">
  <PersonAvatar {person} {onUnavailable} />
  <span class="label">{label}</span>
  <button type="button" aria-label={removeLabel} onclick={onRemove}>×</button>
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
  .label {
    min-width: 0;
    overflow-wrap: anywhere;
  }
  button {
    flex-shrink: 0;
    background: transparent;
    color: inherit;
    border: 0;
    min-width: 44px;
    border-radius: var(--fl-radius-pill);
  }
</style>
