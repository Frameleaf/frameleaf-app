<script lang="ts" module>
  export type Tile = { id: string; name: string; hint?: string };
</script>

<script lang="ts">
  /**
   * Tiles to pick one from, when each choice needs a line of explanation. Each tile is a button
   * that says whether it is the chosen one, so Tab reaches every choice.
   */
  let {
    label,
    value,
    options,
    disabled = false,
    onChange,
  }: {
    label: string;
    value: string | undefined;
    options: Tile[];
    disabled?: boolean;
    onChange: (id: string) => void;
  } = $props();
</script>

<div class="kit-tiles" role="group" aria-label={label}>
  {#each options as option (option.id)}
    <button type="button" aria-pressed={value === option.id} {disabled} onclick={() => onChange(option.id)}>
      <strong>{option.name}</strong>
      {#if option.hint}<span>{option.hint}</span>{/if}
    </button>
  {/each}
</div>

<style>
  .kit-tiles {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(150px, 1fr));
    gap: var(--fl-space-2);
    padding-bottom: var(--fl-space-5);
  }
  button {
    display: grid;
    align-content: start;
    gap: var(--fl-space-1);
    min-height: 72px;
    padding: var(--fl-space-3) var(--fl-space-4);
    color: var(--fl-text);
    font: inherit;
    text-align: start;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    cursor: pointer;
  }
  button:hover:not(:disabled) {
    border-color: var(--fl-accent);
  }
  button:disabled {
    opacity: 0.6;
    cursor: default;
  }
  button[aria-pressed='true'] {
    background: color-mix(in srgb, var(--fl-accent) 12%, var(--fl-panel));
    border-color: var(--fl-accent);
    box-shadow: inset 0 0 0 1px var(--fl-accent);
  }
  button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  strong {
    font-size: var(--fl-font-callout);
    font-weight: 600;
  }
  span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.4;
  }
  @container kit (max-width: 620px) {
    .kit-tiles {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
