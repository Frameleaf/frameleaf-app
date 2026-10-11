<script lang="ts">
  /** A link inside a sentence or under a row. */
  import type { Snippet } from 'svelte';

  let { href, external = false, children }: { href: string; external?: boolean; children: Snippet } = $props();
</script>

<a class="kit-link" {href} target={external ? '_blank' : undefined} rel={external ? 'noreferrer' : undefined}
  >{@render children()}</a
>

<style>
  .kit-link {
    color: var(--fl-accent);
    font-weight: 600;
    text-decoration: none;
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
