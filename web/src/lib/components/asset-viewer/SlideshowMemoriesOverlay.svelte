<script lang="ts">
  /**
   * The Memories slideshow transition's copy (FL-36, FL-62): a title card once per run, then a
   * lower third with the place over the day for each item (MediaViewer.jsx:834-851, 1569-1580;
   * apple-style.css:422-470). The content comes from the shared Memories engine, so the viewer
   * reads like the Memories player. The blurred backdrop is PhotoViewer's slideshow backdrop.
   * It shows only while the slideshow plays (MediaViewer.jsx:836-839); pausing hides it and the
   * next run opens with the title card again. Under Reduce Motion the transition is a fade, and
   * none of this shows.
   */
  import { memoryLowerThird, memoryTitleCard } from '$lib/frameleaf/memory-engine';
  import { prefersReducedMotion } from '$lib/frameleaf/motion';
  import { effectiveTransition, SlideshowTransition } from '$lib/frameleaf/slideshow-transitions';
  import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
  import { locale } from '$lib/stores/preferences.store';
  import { fromISODateTime, fromISODateTimeUTC } from '$lib/utils/timeline-util';
  import type { AlbumResponseDto, AssetResponseDto, PersonResponseDto } from '@immich/sdk';
  import { DateTime } from 'luxon';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    /** The collection being played, when it is an album or a person. */
    album?: AlbumResponseDto;
    person?: PersonResponseDto;
  };

  const { asset, album, person }: Props = $props();

  /** How long the viewer's title card stays up (MediaViewer.jsx:849, fl-title-card 3.2s). */
  const TITLE_CARD_MS = 3200;

  const { slideshowState, slideshowTransition } = slideshowStore;

  const memoriesOn = $derived(
    $slideshowState === SlideshowState.PlaySlideshow &&
      effectiveTransition($slideshowTransition, prefersReducedMotion()) === SlideshowTransition.Memories,
  );
  const collectionTitle = $derived(album?.albumName || person?.name || $t('memories'));
  /** The collection's dates, as the prototype's title card shows them (MediaViewer.jsx:852-862). */
  const subtitle = $derived.by(() => {
    const format = (value: string | undefined) => {
      const date = value ? DateTime.fromISO(value, { zone: 'UTC' }) : undefined;
      return date?.isValid ? date.toLocaleString(DateTime.DATE_MED, { locale: $locale }) : '';
    };
    const start = format(album?.startDate);
    const end = format(album?.endDate);
    return start && end && start !== end ? `${start} – ${end}` : start || end;
  });
  const card = $derived(memoryTitleCard({ title: collectionTitle, subtitle, count: album?.assetCount ?? 0 }));

  let showTitleCard = $state(false);
  let titleShown = false;
  $effect(() => {
    if (!memoriesOn) {
      titleShown = false;
      showTitleCard = false;
      return;
    }
    if (titleShown) {
      return;
    }
    titleShown = true;
    showTitleCard = true;
    const timer = setTimeout(() => (showTitleCard = false), TITLE_CARD_MS);
    return () => clearTimeout(timer);
  });

  const day = $derived.by(() => {
    const date =
      asset.exifInfo?.timeZone && asset.exifInfo.dateTimeOriginal
        ? fromISODateTime(asset.exifInfo.dateTimeOriginal, asset.exifInfo.timeZone)
        : fromISODateTimeUTC(asset.localDateTime);
    return date.isValid ? date.toLocaleString(DateTime.DATE_FULL, { locale: $locale }) : '';
  });
  const lowerThird = $derived(
    memoryLowerThird({ city: asset.exifInfo?.city }, { fallbackTitle: collectionTitle, day, video: false }),
  );
</script>

{#if memoriesOn && showTitleCard}
  <div class="memories-title-card" aria-hidden="true">
    <h2>{card.title}</h2>
    {#if card.subtitle}
      <p>{card.subtitle}</p>
    {/if}
  </div>
{:else if memoriesOn && lowerThird}
  {#key asset.id}
    <div class="memories-lower-third" aria-hidden="true">
      <strong>{lowerThird.place}</strong>
      {#if lowerThird.day}
        <span>{lowerThird.day}</span>
      {/if}
    </div>
  {/key}
{/if}

<style>
  /* apple-style.css:422-454 */
  .memories-title-card {
    position: absolute;
    inset: 0;
    z-index: 3;
    display: grid;
    place-content: center;
    gap: 6px;
    text-align: center;
    color: #fff;
    background: #000a;
    pointer-events: none;
    animation: fl-memories-title-card 3.2s ease both;
  }
  .memories-title-card h2 {
    margin: 0;
    font-size: clamp(32px, 6vw, 64px);
    font-weight: 700;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }
  .memories-title-card p {
    margin: 0;
    font-size: 18px;
    opacity: 0.8;
  }
  @keyframes fl-memories-title-card {
    0%,
    70% {
      opacity: 1;
    }
    100% {
      opacity: 0;
    }
  }
  /* apple-style.css:456-470, 496-499 */
  .memories-lower-third {
    position: absolute;
    left: 32px;
    bottom: 88px;
    z-index: 3;
    display: flex;
    flex-direction: column;
    color: #fff;
    text-shadow: 0 1px 12px #000a;
    pointer-events: none;
    animation: fl-memories-lower-third 1.2s 600ms ease both;
  }
  .memories-lower-third strong {
    font-size: 24px;
    letter-spacing: -0.01em;
  }
  @keyframes fl-memories-lower-third {
    from {
      opacity: 0;
    }
    to {
      opacity: 1;
    }
  }
  @media (max-width: 760px) {
    .memories-lower-third {
      left: 18px;
      bottom: 78px;
    }
  }
</style>
