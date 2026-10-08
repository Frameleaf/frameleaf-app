<script lang="ts">
  /**
   * The one sticky bar that holds unsaved settings: the server settings draft (`SettingsSaveBar`)
   * and the account's own preference forms (`OwnPreferencesForm`) both draw through it, so there is
   * one place to look for unsaved state (design review finding 70). The caller supplies the words
   * and the buttons.
   *
   * It docks in from below and leaves the same way; a crossfade under Reduce Motion (finding 72).
   */
  import { dock } from '$lib/frameleaf/motion';
  import type { Snippet } from 'svelte';

  type Props = {
    /** The region's accessible name. */
    label: string;
    title: string;
    subtitle?: string;
    /** The bar is asking a question that holds a navigation: it is announced at once. */
    alert?: boolean;
    /** When this value changes the title ticks once, so the bar is seen to have counted the change. */
    tick?: unknown;
    children: Snippet;
  };

  let { label, title, subtitle = '', alert = false, tick, children }: Props = $props();
</script>

<div class="savebar" role="region" aria-label={label} in:dock out:dock>
  <span class="summary" role={alert ? 'alert' : undefined}>
    {#key tick}
      <strong class:tick={!alert}>{title}</strong>
    {/key}
    {#if subtitle}
      <small>{subtitle}</small>
    {/if}
  </span>
  {@render children()}
</div>

<style>
  .savebar {
    position: sticky;
    bottom: 0;
    z-index: 5;
    margin-top: var(--fl-space-4);
    display: flex;
    align-items: center;
    gap: 0.75rem;
    padding: 0.875rem 1.25rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
  }
  .summary {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin-inline-end: auto;
    min-width: 0;
  }
  .summary strong {
    font-weight: 500;
    font-size: var(--fl-font-small);
  }
  /* One small tick when the number of unsaved changes moves, so the bar is seen to have counted it. */
  .summary .tick {
    transform-origin: left center;
    animation: savebar-tick var(--fl-motion) var(--fl-snappy);
  }
  :global([dir='rtl']) .summary .tick {
    transform-origin: right center;
  }
  @keyframes savebar-tick {
    from {
      transform: scale(1.04);
    }
  }
  .summary small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  @media (max-width: 40rem) {
    .savebar {
      flex-wrap: wrap;
      padding: 0.75rem 0.875rem;
      gap: 0.625rem;
    }
    .summary {
      width: 100%;
    }
  }
</style>
