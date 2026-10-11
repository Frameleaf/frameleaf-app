<script lang="ts" module>
  /** What a status means, said by its dot as well as its words. */
  export type KitTone = 'good' | 'warn' | 'bad' | 'off';
</script>

<script lang="ts">
  /**
   * A status in a few words with a coloured dot. The words carry the meaning; the dot only repeats
   * it, so `children` must say the state on its own.
   */
  import type { Snippet } from 'svelte';

  let { tone = 'off', children }: { tone?: KitTone; children: Snippet } = $props();
</script>

<span class="kit-pill" data-tone={tone}>
  <span class="dot" aria-hidden="true"></span>
  {@render children()}
</span>

<style>
  .kit-pill {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-text);
    font-size: var(--fl-font-small);
    font-weight: 600;
    line-height: 1.35;
  }
  .dot {
    flex-shrink: 0;
    width: 8px;
    height: 8px;
    border-radius: 50%;
    background: var(--fl-muted);
  }
  .kit-pill[data-tone='good'] .dot {
    background: var(--fl-accent);
  }
  .kit-pill[data-tone='warn'] .dot {
    background: var(--fl-warning);
  }
  .kit-pill[data-tone='bad'] .dot {
    background: var(--fl-danger);
  }
  .kit-pill[data-tone='off'] {
    color: var(--fl-muted);
    font-weight: 500;
  }
</style>
