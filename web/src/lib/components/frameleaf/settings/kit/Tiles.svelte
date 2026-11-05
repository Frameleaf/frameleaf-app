<script lang="ts" module>
  export type Tile = { id: string; name: string; hint?: string };
</script>

<script lang="ts">
  /**
   * Tiles to pick one from, when each choice needs a line of explanation. Each tile is a button
   * that says whether it is the chosen one, so Tab reaches every choice. `list` draws them one under
   * another with a radio mark, as the prototype's `Choices` (settings-v2/library/parts.jsx).
   */
  let {
    label,
    value,
    options,
    disabled = false,
    list = false,
    onChange,
  }: {
    label: string;
    value: string | undefined;
    options: Tile[];
    disabled?: boolean;
    list?: boolean;
    onChange: (id: string) => void;
  } = $props();
</script>

<div class="kit-tiles" class:is-list={list} role="group" aria-label={label}>
  {#each options as option (option.id)}
    <button type="button" aria-pressed={value === option.id} {disabled} onclick={() => onChange(option.id)}>
      {#if list}<i class="mark" aria-hidden="true"></i>{/if}
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
  /* library.css `.lib-choices`: one choice per line, a radio mark before it. */
  .kit-tiles.is-list {
    grid-template-columns: minmax(0, 1fr);
    gap: var(--fl-space-3);
  }
  .is-list button {
    grid-template-columns: 20px minmax(0, 1fr);
    align-items: center;
    column-gap: var(--fl-space-3);
    min-height: 56px;
    padding: 10px var(--fl-space-4);
    border-radius: var(--fl-radius-control);
  }
  .is-list button[aria-pressed='true'] {
    background: color-mix(in srgb, var(--fl-accent) 8%, var(--fl-raised));
    box-shadow: none;
  }
  .is-list .mark {
    grid-row: 1 / span 2;
    width: 18px;
    height: 18px;
    border: 2px solid var(--fl-muted);
    border-radius: 50%;
  }
  .is-list button[aria-pressed='true'] .mark {
    border-color: var(--fl-accent);
    background: radial-gradient(circle, var(--fl-accent) 0 4px, transparent 4.5px);
  }
  .is-list strong,
  .is-list span {
    grid-column: 2;
  }
  @container kit (max-width: 620px) {
    .kit-tiles:not(.is-list) {
      grid-template-columns: 1fr 1fr;
    }
  }
</style>
