<script lang="ts">
  /**
   * One row of an ItemList: an icon tile, a name, a status, a measure and one action, always in
   * those columns so a list of different things still lines up. `off` greys the tile for something
   * that is not in use; `quiet` does the same for a row that is only for reference. `media` takes
   * the tile's place when the row is a person or a picture.
   */
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import { Icon } from '@frameleaf/ui';
  import type { Snippet } from 'svelte';

  let {
    icon,
    media,
    quiet = false,
    off = false,
    name,
    detail,
    tone = 'off',
    status,
    note,
    measure,
    action,
  }: {
    icon?: string;
    media?: Snippet;
    quiet?: boolean;
    off?: boolean;
    name: string;
    detail?: string;
    tone?: KitTone;
    status?: string;
    note?: string;
    measure?: Snippet;
    action?: Snippet;
  } = $props();
</script>

<li class="kit-item" class:is-off={off}>
  {#if media}
    <span class="media">{@render media()}</span>
  {:else}
    <span class="tile" class:is-quiet={quiet || off} aria-hidden="true">
      {#if icon}<Icon {icon} size="22" />{/if}
    </span>
  {/if}
  <div class="name">
    <strong>{name}</strong>
    {#if detail}<span>{detail}</span>{/if}
  </div>
  <div class="status">
    {#if status}<Pill {tone}>{status}</Pill>{/if}
    {#if note}<small>{note}</small>{/if}
  </div>
  <div class="measure">{@render measure?.()}</div>
  <div class="action">{@render action?.()}</div>
</li>

<style>
  .kit-item {
    display: grid;
    grid-template-columns: 44px minmax(0, 1.2fr) minmax(0, 1fr) minmax(0, 1fr) minmax(104px, auto);
    align-items: center;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4) 0;
    border-top: 1px solid var(--fl-border);
  }
  .tile {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 13%, transparent);
    border-radius: var(--fl-radius-card);
  }
  .media {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
  }
  .tile.is-quiet {
    color: var(--fl-muted);
    background: var(--fl-raised);
  }
  .name {
    min-width: 0;
  }
  strong {
    display: block;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .name span {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
  .status {
    min-width: 0;
  }
  small {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
  .measure {
    min-width: 0;
  }
  .action {
    display: flex;
    justify-content: flex-end;
  }
  @container kit (max-width: 860px) {
    .kit-item {
      grid-template-columns: 44px minmax(0, 1fr) auto;
      row-gap: var(--fl-space-3);
    }
    .status,
    .measure {
      grid-column: 2 / -1;
    }
    .measure:empty {
      display: none;
    }
    .action {
      grid-row: 1;
      grid-column: 3;
    }
  }
</style>
