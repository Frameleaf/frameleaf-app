<script lang="ts">
  import PersonAvatar from './PersonAvatar.svelte';
  import type { PersonResponseDto } from '@immich/sdk';
  let {
    label,
    removeLabel,
    onRemove,
    person,
  }: {
    label: string;
    removeLabel: string;
    onRemove: () => void;
    person?: PersonResponseDto;
  } = $props();
</script>

<span class="chip">
  <PersonAvatar {person} />
  <span>{label}</span>
  <button type="button" aria-label={removeLabel} onclick={onRemove}>×</button>
</span>

<style>
  .chip {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    padding-inline-start: 0.5rem;
    border: 1px solid var(--fl-accent);
    border-radius: var(--fl-radius);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  button {
    background: transparent;
    color: inherit;
    border: 0;
    min-width: 44px;
    border-radius: var(--fl-radius);
  }
</style>
