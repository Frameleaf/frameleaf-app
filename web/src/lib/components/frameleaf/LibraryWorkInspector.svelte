<script lang="ts">
  import type { TimelineAsset } from '$lib/managers/timeline-manager/types';
  import { fromTimelinePlainDate, getDateLocaleString } from '$lib/utils/timeline-util';
  let { assets, count, onopen }: { assets: TimelineAsset[]; count: number; onopen: (asset: TimelineAsset) => void } =
    $props();
  const asset = $derived(assets.length === 1 ? assets[0] : undefined);
</script>

<aside id="library-work-inspector" aria-label="Selection inspector">
  <h2>Selection</h2>
  <p aria-live="polite">{assets.length} selected · {count} items</p>
  {#if asset}
    <dl>
      <dt>Media</dt>
      <dd>{asset.isVideo ? 'Video' : 'Photo'}</dd>
      <dt>Captured</dt>
      <dd>{getDateLocaleString(fromTimelinePlainDate(asset.fileCreatedAt))}</dd>
      {#if asset.city || asset.country}<dt>Location</dt>
        <dd>{[asset.city, asset.country].filter(Boolean).join(', ')}</dd>{/if}
      {#if asset.isFavorite}<dt>Favorite</dt>
        <dd>Yes</dd>{/if}
      {#if asset.isVideo && asset.duration !== null}<dt>Duration</dt>
        <dd>
          {Math.floor(asset.duration / 60_000)}:{String(Math.floor((asset.duration / 1000) % 60)).padStart(2, '0')}
        </dd>{/if}
    </dl>
    <button type="button" onclick={() => onopen(asset)}>Open media</button>
  {:else if assets.length > 1}
    <p>Use the selection toolbar to work with these items.</p>
  {:else}
    <p>Select an item to inspect it. Open media for full information and editing.</p>
  {/if}
</aside>

<style>
  aside {
    width: 240px;
    flex-shrink: 0;
    overflow: auto;
    padding: 1rem;
    border-inline-start: 1px solid var(--fl-border);
    background: var(--fl-panel);
    color: var(--fl-text);
    font-size: 0.8rem;
  }
  h2 {
    font-size: 0.9rem;
    font-weight: 600;
    margin-bottom: 0.75rem;
  }
  p,
  dt {
    color: var(--fl-muted);
  }
  p {
    margin-bottom: 1rem;
  }
  dl {
    display: grid;
    gap: 0.3rem;
    margin: 1rem 0;
  }
  dd {
    margin-bottom: 0.7rem;
    overflow-wrap: anywhere;
  }
  button {
    min-height: 44px;
    padding: 0.5rem 0.8rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-control-radius);
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  @media (max-width: 767px) {
    aside {
      width: 100%;
      max-height: 35%;
      border-inline-start: 0;
      border-top: 1px solid var(--fl-border);
    }
  }
</style>
