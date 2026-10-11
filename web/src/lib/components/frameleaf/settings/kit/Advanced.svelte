<script lang="ts">
  /**
   * Expert and operator fields: kept, and closed until asked for. Most people never open it, so
   * nothing a household needs belongs inside.
   */
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let { summary, open = false, children }: { summary?: string; open?: boolean; children: Snippet } = $props();
</script>

<details class="kit-advanced" {open}>
  <summary>{summary ?? $t('frameleaf_kit_advanced')}</summary>
  <div class="body">{@render children()}</div>
</details>

<style>
  .kit-advanced {
    padding: var(--fl-space-1) 0;
    border-top: 1px solid var(--fl-border);
  }
  summary {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: var(--fl-control-height);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    font-weight: 600;
    cursor: pointer;
    list-style: none;
  }
  summary::-webkit-details-marker {
    display: none;
  }
  /* The disclosure mark, drawn so it is the same in every browser and turns when open. */
  summary::before {
    content: '';
    width: 0;
    height: 0;
    border-block: 4px solid transparent;
    border-inline-start: 6px solid currentcolor;
    transition: transform var(--fl-motion-fast) var(--fl-ease);
  }
  .kit-advanced[open] > summary::before {
    transform: rotate(90deg);
  }
  summary:hover {
    color: var(--fl-text);
  }
  summary:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
    border-radius: var(--fl-radius-sm);
  }
  .body {
    padding-bottom: var(--fl-space-4);
  }
  /* Rows inside start under the summary, which already draws the rule above the group. */
  .body > :global(.kit-row:first-child) {
    border-top: 0;
    padding-top: var(--fl-space-2);
  }
</style>
