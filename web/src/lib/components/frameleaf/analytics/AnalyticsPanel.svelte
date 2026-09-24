<script lang="ts">
  /**
   * One dashboard panel (FL-79), the template's `Panel` (AnalyticsDashboard.jsx:188-212): a kicker,
   * a sentence-style title, a caption and an optional link to the settings area that owns the data.
   */
  import { Icon } from '@immich/ui';
  import { mdiChevronRight } from '@mdi/js';
  import type { Snippet } from 'svelte';

  type Props = {
    kicker?: string;
    title: string;
    caption?: string;
    action?: { href: string; label: string };
    wide?: boolean;
    id?: string;
    children: Snippet;
  };
  let { kicker, title, caption, action, wide = false, id, children }: Props = $props();
  const headingId = $props.id();
</script>

<section class="an-panel fl-continuous-corners" class:an-wide={wide} aria-labelledby={headingId} data-panel={id}>
  <header class="an-panel-head">
    <div>
      {#if kicker}<p class="an-kicker">{kicker}</p>{/if}
      <h2 id={headingId}>{title}</h2>
      {#if caption}<p class="an-caption">{caption}</p>{/if}
    </div>
    {#if action}
      <a class="an-link" href={action.href}>{action.label}<Icon icon={mdiChevronRight} size="14" aria-hidden /></a>
    {/if}
  </header>
  {@render children()}
</section>

<style>
  .an-panel {
    min-width: 0;
    padding: 22px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  @supports (corner-shape: squircle) {
    .an-panel {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
  .an-wide {
    grid-column: 1 / -1;
  }
  .an-panel-head {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 18px;
  }
  .an-kicker {
    margin: 0 0 6px;
    color: var(--fl-accent);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  h2 {
    margin: 0;
    font-size: 19px;
    font-weight: 650;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }
  .an-caption {
    max-width: 62ch;
    margin: 6px 0 0;
    color: var(--fl-muted);
    font-size: 12.5px;
    line-height: 1.5;
  }
  .an-link {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
    color: var(--fl-muted);
    font-size: 11px;
    white-space: nowrap;
  }
  .an-link:hover {
    color: var(--fl-text);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .an-link:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 3px;
  }
  @container (max-width: 520px) {
    .an-panel {
      padding: 16px 14px;
    }
  }
</style>
