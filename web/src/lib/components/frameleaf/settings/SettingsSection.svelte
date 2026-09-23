<script lang="ts">
  /**
   * One section card on a Frameleaf settings page (FL-71): headline, one line of help and the
   * section's own form. The template's `.cc-section`; every section is open, the rail and the
   * search decide which ones are on screen.
   */
  import { Icon } from '@immich/ui';
  import type { Snippet } from 'svelte';

  let {
    key,
    title,
    subtitle,
    icon,
    overline,
    children,
  }: {
    key: string;
    title: string;
    subtitle?: string;
    icon?: string;
    /** Area name shown above the title in search results. */
    overline?: string;
    children: Snippet;
  } = $props();

  const headingId = $props.id();
</script>

<section class="section" id="setting-{key}" aria-labelledby={headingId}>
  <header>
    {#if overline}
      <p class="overline">{overline}</p>
    {/if}
    <h3 id={headingId}>
      {#if icon}
        <Icon {icon} size="1.25rem" aria-hidden={true} class="accent" />
      {/if}
      {title}
    </h3>
    {#if subtitle}
      <p class="subtitle">{subtitle}</p>
    {/if}
  </header>
  <div class="body">
    {@render children()}
  </div>
</section>

<style>
  .section {
    padding: 1.125rem 1.25rem 1.25rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
    color: var(--fl-text);
  }
  header {
    margin-bottom: 0.75rem;
  }
  .overline {
    margin: 0 0 0.375rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  h3 {
    display: flex;
    align-items: center;
    gap: 0.5rem;
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
  }
  h3 :global(.accent) {
    color: var(--fl-accent);
  }
  .subtitle {
    margin: 0.375rem 0 0;
    max-width: 48rem;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.55;
  }
  .body {
    min-width: 0;
  }
  /* The ported forms still carry the legacy inset; keep them flush inside the card. */
  .body :global(.ms-4) {
    margin-inline-start: 0;
  }
  .body :global(hr) {
    border: 0;
    border-top: 1px solid var(--fl-border);
    margin: 0.75rem 0;
  }
</style>
