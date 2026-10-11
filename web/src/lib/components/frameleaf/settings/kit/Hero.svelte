<script lang="ts">
  /**
   * The answer a page opens on: is it working, and what needs doing. One per page. `actions` are the
   * few things to do about it; `children` sit under a rule (the coverage rows, or a run in progress).
   * `quiet` is neither good nor a problem: something optional that is not set up.
   */
  import type { KitTone } from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import { Icon } from '@frameleaf/ui';
  import type { Snippet } from 'svelte';

  let {
    tone = 'good',
    icon,
    title,
    body,
    label,
    actions,
    children,
  }: {
    tone?: Exclude<KitTone, 'off'> | 'quiet';
    icon: string;
    title: string;
    body?: string;
    /** The region's accessible name, for example "Backup status". */
    label: string;
    actions?: Snippet;
    children?: Snippet;
  } = $props();
</script>

<section class="kit-hero fl-continuous-corners" data-tone={tone} aria-label={label}>
  <div class="main">
    <span class="icon" aria-hidden="true"><Icon {icon} size="34" /></span>
    <div class="copy">
      <h2>{title}</h2>
      {#if body}<p>{body}</p>{/if}
    </div>
    {#if actions}<div class="actions">{@render actions()}</div>{/if}
  </div>
  {@render children?.()}
</section>

<style>
  .kit-hero {
    overflow: hidden;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  @supports (corner-shape: squircle) {
    .kit-hero {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
  .main {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-5);
    padding: var(--fl-space-6);
  }
  .icon {
    display: grid;
    place-items: center;
    width: 64px;
    height: 64px;
    color: var(--kit-tone);
    background: color-mix(in srgb, var(--kit-tone) 14%, transparent);
    border-radius: 18px;
  }
  .kit-hero[data-tone='good'] {
    --kit-tone: var(--fl-accent);
  }
  .kit-hero[data-tone='warn'] {
    --kit-tone: var(--fl-warning);
  }
  .kit-hero[data-tone='bad'] {
    --kit-tone: var(--fl-danger);
  }
  .kit-hero[data-tone='quiet'] .icon {
    color: var(--fl-muted);
    background: var(--fl-raised);
  }
  h2 {
    margin: 0;
    font: var(--fl-type-title);
    letter-spacing: var(--fl-tracking-title);
    text-wrap: balance;
  }
  p {
    max-width: 620px;
    margin: var(--fl-space-2) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: var(--fl-space-2);
  }
  @container kit (max-width: 620px) {
    .main {
      grid-template-columns: auto minmax(0, 1fr);
      gap: var(--fl-space-4);
      padding: var(--fl-space-4);
    }
    .icon {
      width: 48px;
      height: 48px;
      border-radius: 14px;
    }
    .actions {
      grid-column: 1 / -1;
      justify-content: stretch;
    }
    .actions > :global(*) {
      flex: 1;
    }
  }
</style>
