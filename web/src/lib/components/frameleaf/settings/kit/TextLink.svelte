<script lang="ts">
  /**
   * A link inside a sentence or under a row. With `href` it goes somewhere; with `onclick` alone it
   * is a button that looks the same, for a choice that changes this page (FL-379).
   */
  import type { Snippet } from 'svelte';

  let {
    href,
    external = false,
    onclick,
    children,
  }: { href?: string; external?: boolean; onclick?: () => void; children: Snippet } = $props();
</script>

{#if href}
  <a class="kit-link" {href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}
    >{@render children()}</a
  >
{:else}
  <button type="button" class="kit-link" {onclick}>{@render children()}</button>
{/if}

<style>
  .kit-link {
    color: var(--fl-accent);
    font-weight: 600;
    text-decoration: none;
  }
  button.kit-link {
    padding: 0;
    font: inherit;
    font-weight: 600;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .kit-link:hover {
    text-decoration: underline;
  }
  .kit-link:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
    border-radius: var(--fl-radius-sm);
  }
</style>
