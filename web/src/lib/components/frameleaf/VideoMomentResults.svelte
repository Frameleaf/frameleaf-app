<script lang="ts">
  /**
   * Moments inside videos for a search (FL-59, `REC-101`).
   *
   * A strip above the search results: each hit is a time inside one of the person's own videos,
   * found by meaning against the frame index or by the words of a caption or typed transcript.
   * Choosing one opens the video at that moment instead of at its start. Nothing is shown when
   * there are no hits, so a search without video moments looks exactly as it did.
   */
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { formatMomentTime, frameImagePath } from '$lib/frameleaf/enrichment';
  import { videoSeek } from '$lib/frameleaf/video-seek.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { navigate } from '$lib/utils/navigation';
  import {
    AssetMediaSize,
    getBaseUrl,
    searchVideoMoments,
    VideoMomentMatch,
    type VideoMomentSearchHitDto,
  } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  let { query }: { query: string } = $props();

  let hits = $state<VideoMomentSearchHitDto[]>([]);
  let requested = '';

  const frameUrl = (frameId: string) => {
    const search = new URLSearchParams();
    for (const [key, value] of Object.entries(authManager.params)) {
      if (value) {
        search.set(key, value);
      }
    }
    const text = search.toString();
    return `${getBaseUrl()}${frameImagePath(frameId)}${text ? `?${text}` : ''}`;
  };

  const imageFor = (hit: VideoMomentSearchHitDto) =>
    hit.frameId ? frameUrl(hit.frameId) : getAssetMediaUrl({ id: hit.assetId, size: AssetMediaSize.Thumbnail });

  const matchKey = (hit: VideoMomentSearchHitDto) =>
    hit.match === VideoMomentMatch.Visual
      ? 'frameleaf_moments_match_visual'
      : hit.match === VideoMomentMatch.Caption
        ? 'frameleaf_moments_match_caption'
        : 'frameleaf_moments_match_transcript';

  const open = async (hit: VideoMomentSearchHitDto) => {
    videoSeek.request(hit.assetId, hit.timestampMs);
    await navigate({ targetRoute: 'current', assetId: hit.assetId });
  };

  $effect(() => {
    const text = query.trim();
    requested = text;
    if (!text) {
      hits = [];
      return;
    }
    searchVideoMoments({ videoMomentSearchDto: { query: text, limit: 12 } })
      .then((response) => {
        if (requested === text) {
          hits = response.hits;
        }
      })
      .catch(() => {
        // Moments are an addition to the results, never a reason for the search to fail.
        if (requested === text) {
          hits = [];
        }
      });
  });
</script>

{#if hits.length > 0}
  <section class="moments" aria-label={$t('frameleaf_moments_search_title')}>
    <h2>{$t('frameleaf_moments_search_title')}</h2>
    <ul>
      {#each hits as hit (`${hit.assetId}:${hit.timestampMs}`)}
        <li>
          <button
            type="button"
            onclick={() => void open(hit)}
            aria-label={$t('frameleaf_moments_play_from', { values: { time: formatMomentTime(hit.timestampMs) } })}
          >
            <img src={imageFor(hit)} alt="" loading="lazy" />
            <span class="time">{formatMomentTime(hit.timestampMs)}</span>
          </button>
          <p class="caption">{hit.caption ?? $t(matchKey(hit))}</p>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  .moments {
    margin: 0 0 1rem;
  }
  h2 {
    margin: 0 0 0.5rem;
    font-size: 0.875rem;
    font-weight: 600;
  }
  ul {
    display: flex;
    gap: 0.75rem;
    margin: 0;
    padding: 0 0 0.25rem;
    overflow-x: auto;
    list-style: none;
  }
  li {
    flex: 0 0 10rem;
    min-width: 0;
  }
  button {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    overflow: hidden;
    border-radius: 8px;
    background: rgb(0 0 0 / 20%);
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent, #3fb68b);
    outline-offset: 2px;
  }
  img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .time {
    position: absolute;
    left: 0.375rem;
    bottom: 0.375rem;
    padding: 0 0.3rem;
    font-size: 11px;
    color: #fff;
    background: rgb(0 0 0 / 60%);
    border-radius: 4px;
  }
  .caption {
    margin: 0.25rem 0 0;
    font-size: 12px;
    line-height: 1.4;
    overflow: hidden;
    display: -webkit-box;
    -webkit-line-clamp: 2;
    line-clamp: 2;
    -webkit-box-orient: vertical;
  }
</style>
