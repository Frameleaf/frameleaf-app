<script lang="ts">
  /**
   * One titled group of a page. `action` is the one thing to do about the whole group, at the end of
   * its heading; a group that is only a heading and an action (a "Turn off…" card) has no children.
   */
  import type { Snippet } from 'svelte';

  let {
    title,
    description,
    id,
    action,
    children,
  }: {
    title: string;
    description?: string;
    /** For a link that opens the page at this group. */
    id?: string;
    action?: Snippet;
    children?: Snippet;
  } = $props();

  const headingId = $props.id();
</script>

<section class="kit-section fl-continuous-corners" {id} aria-labelledby="{headingId}-title">
  <div class="heading">
    <div>
      <h2 id="{headingId}-title">{title}</h2>
      {#if description}<p>{description}</p>{/if}
    </div>
    {#if action}<div class="action">{@render action()}</div>{/if}
  </div>
  {@render children?.()}
</section>

<style>
  .kit-section {
    min-width: 0;
    padding: 0 var(--fl-space-6);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    /* A link to the group lands with air above it, under the settings bar. */
    scroll-margin-top: var(--fl-space-6);
  }
  @supports (corner-shape: squircle) {
    .kit-section {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
  /* A notice between rows keeps air before the next rule (backup-v2.css `.bk2-section > .bk2-alert`). */
  .kit-section > :global(.kit-notice) {
    margin-bottom: var(--fl-space-4);
  }
  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-4);
    padding: var(--fl-space-5) 0;
  }
  .heading > div:first-child {
    min-width: 0;
  }
  h2 {
    margin: 0;
    font-size: 16px;
    font-weight: 600;
    letter-spacing: var(--fl-tracking-headline);
  }
  p {
    max-width: 640px;
    margin: var(--fl-space-2) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    line-height: 1.5;
  }
  .action {
    display: flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  @container kit (max-width: 620px) {
    .kit-section {
      padding: 0 var(--fl-space-4);
    }
    .heading {
      flex-wrap: wrap;
    }
  }
</style>
