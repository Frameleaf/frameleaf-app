<script lang="ts">
  /**
   * The Timeline's curated Years and Months (FL-33, FL-50), ported from the September 24 template:
   * `TimelineLibrary.jsx` `TimelineCard` and `timeline-library.css` "Curated Years and Months".
   * One card per year or month with its key photo, count and top places; month cards add a strip of
   * highlights. Opening a card steps one level finer (`onOpen`), as in Photos.
   *
   * The cards come from `GET /timeline/highlights` with the time buckets' own query, so they cover
   * exactly what the grid would show, ranked on the server; the view's months are never walked here.
   */
  import {
    cardTarget,
    firstCardOfYear,
    MONTH_HIGHLIGHT_COUNT,
    placeSummary,
    timelineCards,
    type TimelineCard,
    type TimelineCardTarget,
  } from '$lib/frameleaf/timeline-cards';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import type { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { websocketEvents } from '$lib/stores/websocket';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, getTimelineHighlights, TimelineHighlightGrouping } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiImageOutline } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { debounce } from 'lodash-es';
  import { onDestroy, tick, untrack, type Snippet } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  type Props = {
    timelineManager: TimelineManager;
    grouping: 'years' | 'months';
    /** A card was opened: the grouping and period to show next. */
    onOpen: (target: TimelineCardTarget) => void;
    /** After a year opened Months, the year whose first month card is brought to the top. */
    focusYear?: number | null;
    /**
     * The period at the top of the cards as they scroll, for the scrubber's marker: a month card's
     * year and month, or a year card's year alone.
     */
    onCurrentPeriod?: (period: { year: number; month?: number } | undefined) => void;
    /** Rendered above the cards, inside the same scroll container. */
    header?: Snippet;
    empty?: Snippet;
  };

  let { timelineManager, grouping, onOpen, focusYear = null, onCurrentPeriod, header, empty }: Props = $props();

  /** Library changes that can move a key photo, a count or a place settle for this long before a refetch. */
  const REFRESH_DELAY_MS = 1500;

  const kind = $derived(grouping === 'years' ? 'year' : 'month');
  let cards = $state<TimelineCard[]>([]);
  let status = $state<'loading' | 'ready' | 'failed'>('loading');
  let scroller = $state<HTMLElement>();
  let request = 0;
  /** Bumped (debounced) by uploads, deletes, trash and restore, and edits such as a rating change. */
  let revision = $state(0);
  const refresh = debounce(() => revision++, REFRESH_DELAY_MS);
  const unsubscribers = [
    websocketEvents.on('on_upload_success', refresh),
    websocketEvents.on('on_asset_delete', refresh),
    websocketEvents.on('on_asset_trash', refresh),
    websocketEvents.on('on_asset_restore', refresh),
    websocketEvents.on('on_asset_update', refresh),
    eventManager.on({
      AssetUpdate: refresh,
      AssetsDelete: refresh,
      AssetsArchive: refresh,
      AssetsUnarchive: refresh,
      AssetsMarkNsfw: refresh,
    }),
  ];
  onDestroy(() => {
    refresh.cancel();
    for (const unsubscribe of unsubscribers) {
      unsubscribe();
    }
  });

  $effect(() => {
    // Refetch when the view's query is (re)initialised, the grouping changes or the library changed.
    if (!timelineManager.isInitialized) {
      return;
    }
    void revision;
    const query = timelineManager.bucketQuery;
    const wanted = kind;
    const current = ++request;
    // A refresh keeps the cards on screen until the new ones arrive; only a new view shows loading.
    if (untrack(() => cards.length === 0 || cards[0]?.kind !== wanted)) {
      status = 'loading';
    }
    const load = async () => {
      try {
        const highlights = await getTimelineHighlights({
          ...query,
          grouping: wanted === 'year' ? TimelineHighlightGrouping.Year : TimelineHighlightGrouping.Month,
          highlightCount: wanted === 'month' ? MONTH_HIGHLIGHT_COUNT : 0,
        });
        if (current !== request) {
          return;
        }
        cards = timelineCards(highlights, wanted);
        status = 'ready';
      } catch {
        if (current !== request) {
          return;
        }
        cards = [];
        status = 'failed';
      }
    };
    void load();
  });

  // Template `openCard`: a year opens Months scrolled to that year.
  $effect(() => {
    const year = focusYear;
    if (year === null || status !== 'ready' || kind !== 'month') {
      return;
    }
    const card = firstCardOfYear(cards, year);
    void tick().then(() => {
      const element = card && scroller?.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(card.id)}"]`);
      if (element && scroller) {
        scroller.scrollBy({ top: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top });
      }
    });
  });

  /** Template `jumpTo`: card views have no tiles, so a month goes to its month card, then its year's. */
  export const jumpTo = ({ year, month }: { year: number; month: number }) => {
    const monthId = `${year}-${String(month).padStart(2, '0')}`;
    const element =
      scroller?.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(monthId)}"]`) ??
      scroller?.querySelector<HTMLElement>(`[data-group-id="${CSS.escape(String(year))}"]`);
    if (!element || !scroller) {
      return false;
    }
    scroller.scrollBy({ top: element.getBoundingClientRect().top - scroller.getBoundingClientRect().top });
    return true;
  };

  /** Template "keep the scrubber marker in step": the first card still showing below the top edge. */
  const reportPeriod = () => {
    if (!scroller || !onCurrentPeriod) {
      return;
    }
    const top = scroller.getBoundingClientRect().top;
    for (const element of scroller.querySelectorAll<HTMLElement>('[data-group-id]')) {
      if (element.getBoundingClientRect().bottom > top) {
        const [year, month] = (element.dataset.groupId ?? '').split('-').map(Number);
        onCurrentPeriod(
          Number.isFinite(year) ? { year, month: Number.isFinite(month) ? month : undefined } : undefined,
        );
        return;
      }
    }
    onCurrentPeriod(undefined);
  };

  let frame = 0;
  const scheduleReport = () => {
    if (!frame) {
      frame = requestAnimationFrame(() => {
        frame = 0;
        reportPeriod();
      });
    }
  };
  onDestroy(() => cancelAnimationFrame(frame));

  $effect(() => {
    if (status !== 'ready') {
      return;
    }
    void cards;
    void tick().then(reportPeriod);
  });

  const titleOf = (card: TimelineCard) =>
    card.kind === 'year'
      ? String(card.year)
      : DateTime.fromObject({ year: card.year, month: card.month ?? 1 }).toLocaleString(
          { month: 'long', year: 'numeric' },
          { locale: $locale ?? undefined },
        );

  const metaOf = (card: TimelineCard) =>
    [$t('items_count', { values: { count: card.count } }), placeSummary(card.places, $locale ?? undefined)]
      .filter(Boolean)
      .join(' · ');

  const media = (id: string, size: AssetMediaSize) => getAssetMediaUrl({ id, size });
</script>

<section
  class="fl-tl-cards-scroll"
  bind:this={scroller}
  onscroll={scheduleReport}
  data-testid="frameleaf-timeline-cards"
  aria-busy={status === 'loading'}
>
  {@render header?.()}
  {#if status === 'failed'}
    <p class="fl-tl-cards-status" role="status">{$t('frameleaf_timeline_cards_failed')}</p>
  {:else if status === 'ready' && cards.length === 0}
    {@render empty?.()}
  {:else}
    <ul
      class="fl-tl-cards"
      class:is-months={kind === 'month'}
      aria-label={$t(grouping === 'years' ? 'frameleaf_library_grouping_years' : 'frameleaf_library_grouping_months')}
    >
      {#each cards as card (card.id)}
        {@const title = titleOf(card)}
        {@const meta = metaOf(card)}
        <li class="fl-tl-card" class:is-year={card.kind === 'year'} data-group-id={card.id}>
          <button
            type="button"
            class="fl-tl-card-open"
            aria-label={$t(
              card.kind === 'year' ? 'frameleaf_timeline_card_show_months' : 'frameleaf_timeline_card_show_days',
              {
                values: { title, meta },
              },
            )}
            onclick={() => onOpen(cardTarget(card))}
          >
            <span class="fl-tl-card-media">
              {#if card.keyAssetId}
                <img src={media(card.keyAssetId, AssetMediaSize.Preview)} alt="" loading="lazy" decoding="async" />
              {:else}
                <Icon icon={mdiImageOutline} size="32" aria-hidden />
              {/if}
              <span class="fl-tl-card-caption">
                <span class="fl-tl-card-title">{title}</span>
                <span class="fl-tl-card-meta">{meta}</span>
              </span>
            </span>
            {#if card.highlightAssetIds.length > 0}
              <span class="fl-tl-card-strip" aria-hidden="true">
                {#each card.highlightAssetIds as id (id)}
                  <img src={media(id, AssetMediaSize.Thumbnail)} alt="" loading="lazy" decoding="async" />
                {/each}
              </span>
            {/if}
          </button>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .fl-tl-cards-scroll {
    container: fl-tl-cards / inline-size;
    height: 100%;
    overflow-y: auto;
    outline: none;
    scrollbar-width: none;
  }
  /* Template timeline-library.css "Curated Years and Months". */
  .fl-tl-cards {
    display: grid;
    gap: 16px;
    margin: 0;
    padding: 0 0 16px;
    list-style: none;
  }
  .fl-tl-cards.is-months {
    grid-template-columns: repeat(auto-fill, minmax(min(100%, 340px), 1fr));
  }
  .fl-tl-card {
    min-width: 0;
    animation: fl-tl-card-in var(--fl-duration, 380ms) var(--fl-snappy, ease-out) both;
  }
  @keyframes fl-tl-card-in {
    from {
      opacity: 0;
      transform: translateY(8px) scale(0.985);
    }
  }
  .fl-tl-card-open {
    display: flex;
    flex-direction: column;
    gap: 2px;
    width: 100%;
    padding: 0;
    border: 0;
    border-radius: var(--fl-radius-card, 12px);
    overflow: hidden;
    background: var(--fl-panel);
    color: inherit;
    font: inherit;
    text-align: start;
    cursor: pointer;
    box-shadow: 0 0 0 1px var(--fl-material-edge, var(--fl-border));
    transition:
      transform var(--fl-duration, 380ms) var(--fl-spring, ease),
      box-shadow var(--fl-motion-fast, 120ms) ease;
  }
  .fl-tl-card-open:hover {
    box-shadow:
      0 0 0 1px var(--fl-material-edge, var(--fl-border)),
      var(--fl-shadow-1);
  }
  .fl-tl-card-open:active {
    transform: scale(0.985);
  }
  .fl-tl-card-open:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 3px;
  }
  .fl-tl-card-media {
    position: relative;
    display: grid;
    place-items: center;
    overflow: hidden;
    aspect-ratio: 16 / 10;
    background: var(--fl-raised);
    color: var(--fl-muted);
  }
  .is-year .fl-tl-card-media {
    aspect-ratio: 21 / 9;
    max-height: min(440px, 55vh);
    width: 100%;
  }
  .fl-tl-card-media img {
    position: absolute;
    inset: 0;
    width: 100%;
    height: 100%;
    object-fit: cover;
    transition: transform calc(var(--fl-duration, 380ms) * 2) var(--fl-spring, ease);
  }
  .fl-tl-card-open:hover .fl-tl-card-media img {
    transform: scale(1.03);
  }
  .fl-tl-card-caption {
    position: absolute;
    inset: auto 0 0;
    display: flex;
    flex-direction: column;
    gap: 2px;
    padding: 40px 18px 14px;
    color: #fff;
    background: linear-gradient(transparent, rgb(0 0 0 / 62%));
    text-shadow: 0 1px 2px rgb(0 0 0 / 35%);
  }
  /* Years put the title at the top, as in Photos, clear of the floating toolbar. */
  .is-year .fl-tl-card-caption {
    inset: 0 0 auto;
    padding: 18px 22px 56px;
    background: linear-gradient(rgb(0 0 0 / 55%), transparent);
  }
  .fl-tl-card-title {
    font-size: 22px;
    font-weight: 700;
    line-height: 1.15;
    letter-spacing: -0.01em;
    text-wrap: balance;
  }
  .is-year .fl-tl-card-title {
    font-size: clamp(34px, 6cqi, 56px);
    font-weight: 800;
    letter-spacing: -0.02em;
    font-variant-numeric: tabular-nums;
  }
  .fl-tl-card-meta {
    font-size: var(--fl-font-small, 12px);
    font-weight: 500;
    font-variant-numeric: tabular-nums;
    opacity: 0.9;
  }
  .fl-tl-card-strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 2px;
  }
  .fl-tl-card-strip img {
    display: block;
    width: 100%;
    aspect-ratio: 1;
    object-fit: cover;
  }
  .fl-tl-cards-status {
    padding: 45px 12px;
    color: var(--fl-muted);
    font-size: 13px;
    text-align: center;
  }
  @media (prefers-reduced-motion: reduce) {
    .fl-tl-card {
      animation-name: fl-tl-card-fade;
    }
    .fl-tl-card-open,
    .fl-tl-card-media img {
      transition: none;
    }
    .fl-tl-card-open:active,
    .fl-tl-card-open:hover .fl-tl-card-media img {
      transform: none;
    }
  }
  @keyframes fl-tl-card-fade {
    from {
      opacity: 0;
    }
  }
</style>
