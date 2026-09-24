<script lang="ts">
  import type { Snippet } from 'svelte';
  let { label, children }: { label: string; children: Snippet } = $props();
</script>

<section class="fl-continuous-corners" aria-label={label}>{@render children()}</section>

<style>
  /* A grouped container in the Sept 24 language: card radius, continuous corners where supported. */
  section {
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    min-width: 0;
    padding: 18px;
  }
  @supports (corner-shape: squircle) {
    section {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
</style>
