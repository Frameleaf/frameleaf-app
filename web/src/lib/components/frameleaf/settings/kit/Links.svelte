<script lang="ts" module>
  export type LinkRow = {
    icon: string;
    title: string;
    body: string;
    href: string;
    /** Shown instead of a link when the row cannot be used; `body` then says why. */
    disabled?: boolean;
  };
</script>

<script lang="ts">
  /** Rows that open another page: for a landing page, or "what do you need?". */
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight } from '@mdi/js';

  let { rows }: { rows: LinkRow[] } = $props();
</script>

<ul class="kit-links">
  {#each rows as row (row.title)}
    <li>
      {#if row.disabled}
        <div class="link is-disabled">
          <span class="icon" aria-hidden="true"><Icon icon={row.icon} size="24" /></span>
          <strong>{row.title}</strong>
          <span class="body">{row.body}</span>
        </div>
      {:else}
        <a class="link" href={row.href}>
          <span class="icon" aria-hidden="true"><Icon icon={row.icon} size="24" /></span>
          <strong>{row.title}</strong>
          <span class="body">{row.body}</span>
          <span class="chevron" aria-hidden="true"><Icon icon={mdiChevronRight} size="20" /></span>
        </a>
      {/if}
    </li>
  {/each}
</ul>

<style>
  .kit-links {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: var(--fl-space-3);
    margin: 0;
    padding: 0 0 var(--fl-space-6);
    list-style: none;
  }
  li {
    display: grid;
    min-width: 0;
  }
  .link {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr) auto;
    grid-template-rows: auto auto;
    align-items: center;
    gap: var(--fl-space-1) var(--fl-space-4);
    padding: var(--fl-space-4);
    color: var(--fl-text);
    text-decoration: none;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    transition: border-color var(--fl-motion-fast) var(--fl-ease);
  }
  a.link:hover {
    border-color: var(--fl-accent);
  }
  a.link:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .is-disabled {
    opacity: 0.6;
  }
  .icon {
    display: inline-flex;
    grid-row: 1 / 3;
    color: var(--fl-accent);
  }
  .is-disabled .icon {
    color: var(--fl-muted);
  }
  .chevron {
    display: inline-flex;
    grid-row: 1 / 3;
    grid-column: 3;
    color: var(--fl-muted);
  }
  strong {
    align-self: end;
    font-size: var(--fl-font-size);
    font-weight: 600;
  }
  .body {
    grid-column: 2;
    align-self: start;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  @container kit (max-width: 620px) {
    .kit-links {
      grid-template-columns: 1fr;
    }
  }
</style>
