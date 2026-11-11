<script lang="ts">
  /**
   * Moments inside videos for a search (FL-59, `REC-101`; FL-1393, UI review 11-10 B4).
   *
   * A strip above the search results with one tile per video that holds a matching moment: how
   * many moments match, the time of the first, and when and where the video was taken. Choosing a
   * tile opens the video at that first moment instead of at its start. Moment search answers with
   * single frames, found by meaning against the frame index or by the words of a caption or typed
   * transcript; they are grouped here (`momentsByVideo`), so four frames of one scene are one tile,
   * not four. Nothing is shown when no video matches.
   */
  import { formatLuxon } from '$lib/frameleaf/date-format';
  import { formatMomentTime } from '$lib/frameleaf/enrichment';
  import { momentsByVideo } from '$lib/frameleaf/search-results';
  import { momentImageUrl } from '$lib/frameleaf/video-moment-image';
  import { videoSeek } from '$lib/frameleaf/video-seek.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { parseUtcDate } from '$lib/utils/date-time';
  import { navigate } from '$lib/utils/navigation';
  import {
    getAssetInfo,
    searchVideoMoments,
    type AssetResponseDto,
    type VideoMomentSearchHitDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiPlay } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    query: string;
    /** The results already on the page: a video among them needs no lookup for its date and place. */
    assets?: AssetResponseDto[];
    /** FL-1457 (N2): how many videos the strip shows, so a page with no photo results can point at them. */
    found?: number;
  };

  let { query, assets = [], found = $bindable(0) }: Props = $props();

  let hits = $state<VideoMomentSearchHitDto[]>([]);
  let requested = '';

  const search = async (text: string) => {
    try {
      // The server's own default: enough frames that a video's count is not cut short by its neighbours.
      const response = await searchVideoMoments({ videoMomentSearchDto: { query: text, limit: 24 } });
      if (requested === text) {
        hits = response.hits;
      }
    } catch {
      // Moments are an addition to the results, never a reason for the search to fail.
      if (requested === text) {
        hits = [];
      }
    }
  };

  $effect(() => {
    const text = query.trim();
    requested = text;
    if (!text) {
      hits = [];
      return;
    }
    void search(text);
  });

  const videos = $derived(momentsByVideo(hits));
  $effect(() => {
    found = videos.length;
  });

  /** Videos that are not among the results on the page, looked up once for their date and place. */
  let lookedUp = $state<Record<string, AssetResponseDto>>({});
  const asked = new Set<string>();
  const lookUp = async (id: string) => {
    try {
      lookedUp[id] = await getAssetInfo({ id });
    } catch {
      // The tile still opens the video; it only goes without its date and place.
    }
  };
  const onPage = $derived(new Map(assets.map((asset) => [asset.id, asset])));
  $effect(() => {
    for (const { assetId } of videos) {
      if (!onPage.has(assetId) && !asked.has(assetId)) {
        asked.add(assetId);
        void lookUp(assetId);
      }
    }
  });

  /** "Jul 4 · Banff": the day (with its year when that is not this year) and the place. */
  const whereOf = (assetId: string) => {
    const asset = onPage.get(assetId) ?? lookedUp[assetId];
    if (!asset) {
      return '';
    }
    const taken = parseUtcDate(asset.localDateTime);
    const day = taken.isValid
      ? formatLuxon(
          taken,
          { month: 'short', day: 'numeric', ...(taken.year !== DateTime.now().year && { year: 'numeric' }) },
          $locale,
        )
      : '';
    return [day, asset.exifInfo?.city].filter(Boolean).join(' · ');
  };

  const open = async (assetId: string, firstMs: number) => {
    videoSeek.request(assetId, firstMs);
    await navigate({ targetRoute: 'current', assetId });
  };
</script>

{#if videos.length > 0}
  <section class="moments" aria-label={$t('frameleaf_moments_search_title')} data-testid="search-moments">
    <h2 class="heading">
      {$t('frameleaf_moments_search_title')}
      <small>{$t('frameleaf_moments_videos', { values: { count: videos.length } })}</small>
    </h2>
    <ul>
      {#each videos as video (video.assetId)}
        {@const where = whereOf(video.assetId)}
        {@const time = formatMomentTime(video.firstMs)}
        <li>
          <button
            type="button"
            onclick={() => void open(video.assetId, video.firstMs)}
            aria-label={$t('frameleaf_moments_video_label', {
              values: { count: video.count, place: where ? 'yes' : 'no', where, time },
            })}
          >
            <span class="thumb">
              <img src={momentImageUrl(video.first)} alt="" loading="lazy" />
              <span class="time"><Icon icon={mdiPlay} size="12" aria-hidden />{time}</span>
            </span>
            <span class="text">
              <strong>{$t('frameleaf_moments_video_count', { values: { count: video.count } })}</strong>
              {#if where}<span>{where}</span>{/if}
            </span>
          </button>
        </li>
      {/each}
    </ul>
  </section>
{/if}

<style>
  /* Prototype `review-1110.css` `.search-moments` and `.search-section`. */
  .moments {
    margin: 0;
  }
  .heading {
    display: flex;
    align-items: baseline;
    gap: var(--fl-space-2);
    margin: 0;
    padding: var(--fl-space-5) 0 var(--fl-space-1);
    color: var(--fl-text);
    font-size: 17px;
    font-weight: 600;
  }
  .heading small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 400;
  }
  ul {
    display: flex;
    gap: var(--fl-space-3);
    margin: 0;
    padding: var(--fl-space-2) 0 var(--fl-space-3);
    overflow-x: auto;
    list-style: none;
  }
  li {
    flex: 0 0 176px;
    min-width: 0;
  }
  button {
    display: grid;
    gap: var(--fl-space-2);
    width: 100%;
    padding: 0;
    border: 0;
    background: none;
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
  }
  .thumb {
    position: relative;
    display: block;
    aspect-ratio: 16 / 10;
    overflow: hidden;
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
  }
  img {
    display: block;
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .time {
    position: absolute;
    inset-inline-start: var(--fl-space-2);
    bottom: var(--fl-space-2);
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-1);
    padding: 2px 6px;
    border-radius: var(--fl-radius-xs);
    background: rgb(0 0 0 / 62%);
    color: #fff;
    font-size: var(--fl-font-micro);
    font-variant-numeric: tabular-nums;
  }
  .text {
    display: grid;
    gap: 2px;
    padding-inline: 2px;
    color: var(--fl-text);
    font-size: var(--fl-font-small);
  }
  .text strong {
    font-weight: 600;
  }
  .text span {
    overflow: hidden;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  button:focus-visible {
    outline: none;
  }
  button:focus-visible .thumb {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
