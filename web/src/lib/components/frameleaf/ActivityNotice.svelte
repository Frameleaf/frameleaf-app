<script lang="ts">
  /**
   * FL-1409 (prototype `Activity.jsx` `ScanInterrupted`, messy-1110.css `.act-interrupted`): something on Activity
   * that needs a look, in plain words: what happened, what it means, and the way forward beside it. Used for a scan
   * that stopped early and for finished work that left photos over.
   */
  import { Icon } from '@frameleaf/ui';
  import type { Snippet } from 'svelte';

  let {
    icon,
    title,
    children,
    actions,
    level = 'h3',
  }: {
    icon: string;
    title: string;
    /** h2 where the notice stands on its own under the page title (a stopped scan, FL-1457); h3 inside a section. */
    level?: 'h2' | 'h3';
    /** The sentence under the title, and anything quieter beneath it (Technical details). */
    children?: Snippet;
    actions?: Snippet;
  } = $props();

  const headingId = $props.id();
</script>

<article class="act-notice" aria-labelledby={headingId}>
  <span class="act-notice-icon" aria-hidden="true"><Icon {icon} size="22" /></span>
  <div class="act-notice-text">
    <svelte:element this={level} id={headingId} class="act-notice-title">{title}</svelte:element>
    {@render children?.()}
  </div>
  {#if actions}
    <div class="act-notice-actions">{@render actions()}</div>
  {/if}
</article>

<style>
  .act-notice {
    display: flex;
    align-items: center;
    gap: 16px;
    padding: 16px 20px;
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    box-shadow: inset 0 0 0 1px var(--fl-border);
  }
  .act-notice-icon {
    display: grid;
    flex: 0 0 40px;
    place-items: center;
    height: 40px;
    border-radius: var(--fl-radius-control);
    background: color-mix(in srgb, var(--fl-warning, #d9a441) 16%, transparent);
    color: var(--fl-warning, #d9a441);
  }
  .act-notice-text {
    flex: 1;
    min-width: 0;
  }
  .act-notice-title {
    margin: 0;
    font-size: inherit;
    font-weight: 600;
    line-height: 1.4;
  }
  .act-notice-text :global(p) {
    margin: 4px 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  .act-notice-text :global(details) {
    margin-top: 8px;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  /* A line of text, as in the rows below; its click area keeps the 44px floor around it. */
  .act-notice-text :global(summary) {
    position: relative;
    width: max-content;
    max-width: 100%;
    min-height: 0;
    cursor: pointer;
  }
  .act-notice-text :global(summary)::after {
    content: '';
    position: absolute;
    inset: -14px 0;
  }
  .act-notice-text :global(details p) {
    overflow-wrap: anywhere;
  }
  .act-notice-actions {
    display: flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
  }
  @media (max-width: 760px) {
    .act-notice {
      flex-wrap: wrap;
      padding: 16px;
    }
    .act-notice-text {
      flex: 1 1 calc(100% - 56px);
    }
    .act-notice-actions {
      flex-wrap: wrap;
      margin-inline-start: 56px;
    }
  }
</style>
