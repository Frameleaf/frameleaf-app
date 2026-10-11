<script lang="ts">
  /** The top of a place's own page: what it is, where it keeps its copy, how it is, and what to do. */
  import Pill, { type KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import { Icon } from '@frameleaf/ui';
  import type { Snippet } from 'svelte';

  let {
    icon,
    name,
    where,
    tone = 'off',
    status,
    children,
  }: { icon: string; name: string; where?: string; tone?: KitTone; status?: string; children?: Snippet } = $props();
</script>

<header class="place-header">
  <span class="tile" aria-hidden="true"><Icon {icon} size="28" /></span>
  <div class="copy">
    <h2>{name}</h2>
    {#if where}<p>{where}</p>{/if}
  </div>
  {#if status}<span class="status"><Pill {tone}>{status}</Pill></span>{/if}
  {#if children}<div class="actions">{@render children()}</div>{/if}
</header>

<style>
  .place-header {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3) var(--fl-space-4);
  }
  .tile {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 13%, transparent);
    border-radius: var(--fl-radius-capsule);
  }
  .copy {
    flex: 1;
    min-width: 160px;
  }
  h2 {
    margin: 0;
    font: var(--fl-type-title);
    letter-spacing: var(--fl-tracking-title);
  }
  p {
    margin: var(--fl-space-1) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
  }
  .status {
    display: inline-flex;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  @container kit (max-width: 620px) {
    .actions {
      flex-basis: 100%;
    }
    .actions > :global(*) {
      flex: 1;
    }
  }
</style>
