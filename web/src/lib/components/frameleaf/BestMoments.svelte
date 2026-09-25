<script lang="ts">
  /**
   * Best Photos' video moments (FL-50: "expose ranked video-frame cover/moment actions only where
   * supported").
   *
   * Scoring a video samples a few frames and keeps the best one's time (`bestFrameTimestampMs` on
   * each Best Photos result). This row lists the ranked videos that have one: playing starts the
   * video at that moment, and — only for a video whose frames have been cut, which is when the
   * moments index can take a cover — "Use as cover" makes that moment the video's cover
   * (`PUT /enrichment/videos/{id}/cover`, the same action as the viewer's Moments panel).
   *
   * The prototype draws no screen for this; it follows the nearest patterns: the Explore "Days to
   * revisit" snapping carousel (ExploreLibrary.jsx, apple-style.css "#5") for the row and the
   * Moments panel's frame card (time chip, "Play from", "Use as cover") for each item.
   *
   * Best Photos only ever returns the account's own, unlocked, unhidden items, so nothing here can
   * reveal a Locked or hidden video; the moments index is read per video with the same access check.
   */
  import { formatMomentTime } from '$lib/frameleaf/enrichment';
  import { bestMomentsOf, isEffectiveCover, type BestMoment } from '$lib/frameleaf/best-moments';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    getVideoMoments,
    setVideoMomentCover,
    type BestPhotoAssetResponseDto,
    type VideoMomentFrameDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiImageCheckOutline, mdiImageOutline, mdiPlay } from '@mdi/js';
  import { SvelteMap } from 'svelte/reactivity';
  import { t } from 'svelte-i18n';

  interface Props {
    assets: BestPhotoAssetResponseDto[];
    onPlay: (moment: BestMoment) => void;
  }

  let { assets, onPlay }: Props = $props();

  const moments = $derived(bestMomentsOf(assets));

  type CoverState = { frames: VideoMomentFrameDto[] };
  /** Per video: whether the moments index can take a cover yet, and the cover it has. */
  const covers = new SvelteMap<string, CoverState>();
  let busy = $state<string | null>(null);
  let status = $state('');

  $effect(() => {
    for (const moment of moments) {
      if (covers.has(moment.asset.id)) {
        continue;
      }
      covers.set(moment.asset.id, { frames: [] });
      void getVideoMoments({ id: moment.asset.id })
        .then((index) => covers.set(moment.asset.id, { frames: index.frames }))
        // No index (or enrichment is off): the video can be played from its moment, not covered.
        .catch(() => undefined);
    }
  });

  const useAsCover = async (moment: BestMoment) => {
    busy = moment.asset.id;
    try {
      const index = await setVideoMomentCover({
        id: moment.asset.id,
        videoMomentCoverDto: { timestampMs: moment.timestampMs },
      });
      covers.set(moment.asset.id, { frames: index.frames });
      status = $t('frameleaf_best_moments_cover_set', {
        values: { name: moment.asset.originalFileName, time: formatMomentTime(moment.timestampMs) },
      });
    } catch (error) {
      handleError(error, $t('frameleaf_moments_cover_error'));
    } finally {
      busy = null;
    }
  };
</script>

{#if moments.length > 0}
  <section class="best-moments" aria-labelledby="best-moments-heading">
    <div class="heading">
      <h2 id="best-moments-heading">{$t('frameleaf_best_moments_title')}</h2>
      <small>{$t('frameleaf_best_moments_intro')}</small>
    </div>
    <ul class="row">
      {#each moments as moment (moment.asset.id)}
        {@const time = formatMomentTime(moment.timestampMs)}
        {@const frames = covers.get(moment.asset.id)?.frames ?? []}
        {@const isCover = isEffectiveCover(frames, moment.timestampMs)}
        <li>
          <button
            type="button"
            class="play fl-continuous-corners"
            aria-label={$t('frameleaf_best_moments_play', { values: { name: moment.asset.originalFileName, time } })}
            onclick={() => onPlay(moment)}
          >
            <img
              src={getAssetMediaUrl({ id: moment.asset.id, size: AssetMediaSize.Thumbnail })}
              alt=""
              loading="lazy"
            />
            <span class="shade"></span>
            <span class="time"><Icon icon={mdiPlay} size="14" aria-hidden="true" />{time}</span>
          </button>
          <p class="name">{moment.asset.originalFileName}</p>
          <div class="actions">
            <button type="button" class="link" onclick={() => onPlay(moment)}>
              {$t('frameleaf_moments_play_from', { values: { time } })}
            </button>
            <!-- Only once frames are cut, and not for the moment that already is the cover. -->
            {#if isCover}
              <span class="is-cover">
                <Icon icon={mdiImageCheckOutline} size="14" aria-hidden="true" />
                {$t('frameleaf_moments_cover')}
              </span>
            {:else if frames.length > 0}
              <button type="button" class="link" disabled={busy !== null} onclick={() => void useAsCover(moment)}>
                <Icon icon={mdiImageOutline} size="14" aria-hidden="true" />
                {$t('frameleaf_moments_use_as_cover')}
              </button>
            {/if}
          </div>
        </li>
      {/each}
    </ul>
    <p class="sr-only" role="status" aria-live="polite">{status}</p>
  </section>
{/if}

<style>
  .best-moments {
    margin: 0 0 28px;
    color: var(--fl-text);
  }
  .heading {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 10px;
    margin-bottom: 14px;
  }
  h2 {
    margin: 0;
    font-size: 15px;
    font-weight: 580;
  }
  small {
    color: var(--fl-muted);
    font-size: 12px;
  }
  /* The Explore carousels' row, snapping (apple-style.css "#5 snapping carousels"). */
  .row {
    display: grid;
    grid-auto-columns: minmax(180px, 220px);
    grid-auto-flow: column;
    gap: 12px;
    margin: 0;
    padding: 0 0 6px;
    overflow-x: auto;
    list-style: none;
    scroll-snap-type: x mandatory;
    scroll-padding-inline: 4px;
    overscroll-behavior-inline: contain;
  }
  li {
    min-width: 0;
    scroll-snap-align: start;
  }
  .play {
    position: relative;
    display: block;
    width: 100%;
    aspect-ratio: 16 / 9;
    padding: 0;
    overflow: hidden;
    border: 0;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    cursor: pointer;
  }
  .play:focus-visible,
  .link:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .play img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .shade {
    position: absolute;
    inset: 0;
    background: linear-gradient(180deg, transparent 45%, rgb(0 0 0 / 60%));
    pointer-events: none;
  }
  .time {
    position: absolute;
    bottom: 8px;
    left: 8px;
    display: inline-flex;
    align-items: center;
    gap: 3px;
    padding: 2px 6px;
    border-radius: var(--fl-radius-pill);
    background: rgb(0 0 0 / 60%);
    color: #fff;
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }
  .name {
    margin: 7px 2px 0;
    overflow: hidden;
    font-size: 12px;
    font-weight: 560;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 2px 12px;
    margin: 2px 2px 0;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 28px;
    padding: 0;
    border: 0;
    background: none;
    color: var(--fl-accent);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .is-cover {
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 28px;
    color: var(--fl-muted);
    font-size: 12px;
  }
  .link:disabled {
    color: var(--fl-muted);
    cursor: default;
  }
  @supports (corner-shape: squircle) {
    .play {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
</style>
