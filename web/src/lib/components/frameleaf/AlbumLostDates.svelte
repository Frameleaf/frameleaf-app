<script lang="ts">
  /**
   * FL-1299: the photos in an album that lost their date and what the album says instead, built to the mock's
   * Lost dates tab (prototype `AlbumCleanup.jsx`). Only shows the list: healing is the person's button.
   */
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type AlbumLostDatesResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowRight } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    lost: AlbumLostDatesResponseDto;
    formatDay: (day: string) => string;
  }

  /** Enough to see what would happen; the button still heals every one. */
  const SHOWN = 200;

  let { lost, formatDay }: Props = $props();

  const shown = $derived(lost.suggestions.slice(0, SHOWN));
  const more = $derived(lost.suggestions.length - shown.length);
  const span = $derived(
    lost.from && lost.to
      ? lost.from === lost.to
        ? formatDay(lost.from)
        : $t('frameleaf_album_lost_dates_span', { values: { from: formatDay(lost.from), to: formatDay(lost.to) } })
      : '',
  );
</script>

<p class="note">{$t('frameleaf_album_lost_dates_note')}</p>
<p class="summary">
  {$t('frameleaf_album_lost_dates_summary', { values: { count: lost.suggestions.length, span } })}
</p>
<ul class="heal">
  {#each shown as photo (photo.assetId)}
    <li>
      <img src={getAssetMediaUrl({ id: photo.assetId, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
      <span class="text">
        <strong>{photo.fileName}</strong>
        <small>
          {photo.between
            ? $t('frameleaf_album_lost_dates_between', {
                values: { before: photo.between.before, after: photo.between.after },
              })
            : $t('frameleaf_album_lost_dates_from_album')}
        </small>
      </span>
      <span class="dates">
        <s>{formatDay(photo.shownDay)}</s>
        <Icon icon={mdiArrowRight} size="14" aria-hidden />
        <b>
          {photo.precision === 'exact'
            ? formatDay(photo.day)
            : $t('frameleaf_album_lost_dates_around', { values: { date: formatDay(photo.day) } })}
        </b>
      </span>
    </li>
  {/each}
</ul>
{#if more > 0}
  <p class="more">{$t('frameleaf_album_lost_dates_more', { values: { count: more } })}</p>
{/if}

<style>
  .note,
  .summary,
  .more {
    margin: 0 0 12px;
    font-size: 13px;
  }
  .note,
  .more {
    max-width: 72ch;
    color: var(--fl-muted);
  }
  .summary {
    font-weight: 500;
  }
  .more {
    margin: 12px 0 0;
  }
  .heal {
    display: grid;
    gap: 8px;
    margin: 0;
    padding: 12px 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    list-style: none;
  }
  .heal li {
    display: flex;
    align-items: center;
    gap: 12px;
    min-width: 0;
  }
  .heal img {
    flex: 0 0 auto;
    width: 40px;
    height: 40px;
    object-fit: cover;
    border-radius: var(--fl-radius-xs, 4px);
    background: var(--fl-raised);
  }
  .text {
    display: grid;
    flex: 1;
    gap: 2px;
    min-width: 0;
  }
  .text strong,
  .text small {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .text strong {
    font-size: 13px;
    font-weight: 400;
  }
  .text small {
    color: var(--fl-muted);
    font-size: 12px;
  }
  .dates {
    display: inline-flex;
    flex: 0 0 auto;
    align-items: center;
    gap: 8px;
    font-size: 13px;
  }
  .dates s,
  .dates b {
    white-space: nowrap;
  }
  .dates s {
    color: var(--fl-muted);
  }
  .dates :global(svg) {
    color: var(--fl-muted);
  }
  .dates b {
    font-weight: 600;
  }
  @media (max-width: 700px) {
    .heal li {
      flex-wrap: wrap;
    }
    .text {
      flex: 1 1 calc(100% - 52px);
    }
    .dates {
      flex: 1 1 100%;
      padding-inline-start: 52px;
    }
  }
</style>
