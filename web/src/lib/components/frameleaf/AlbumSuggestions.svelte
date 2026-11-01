<script lang="ts">
  /**
   * FL-1092 / FL-1093 magic albums, built to the approved mock (prototype `MagicAlbum.jsx`, PR 21):
   * a notice on an album the viewer can add to when photos from their library look like they are from
   * its trip, and a review with two tabs. "From the trip" lists photos taken during it; "Need a date"
   * lists photos with no trustworthy date and offers one. Adding and changing a date are separate
   * choices, and nothing changes until the person presses the button.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    addAssetsToAlbum,
    dismissAlbumSuggestions,
    getAlbumSuggestions,
    setAlbumSuggestionAutoAdd,
    updateAsset,
    type AlbumDateSuggestionDto,
    type AlbumSuggestionReasonDto,
    type AlbumSuggestionsResponseDto,
    type AlbumTripSuggestionDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAutoFix,
    mdiCalendarCheckOutline,
    mdiCameraOutline,
    mdiClose,
    mdiContentCopy,
    mdiImageSearchOutline,
    mdiInformationOutline,
    mdiMapMarkerOutline,
  } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    albumId: string;
    albumName: string;
    /** Called after photos were added or dates changed, so the album reloads. */
    onChanged: () => void;
  }

  let { albumId, albumName, onChanged }: Props = $props();

  let suggestions = $state<AlbumSuggestionsResponseDto | null>(null);
  let hidden = $state(false);
  let open = $state(false);
  let tab = $state<'trip' | 'dates'>('trip');
  let dismissed = $state(new Set<string>());
  let picked = $state(new Set<string>());
  let fixDate = $state(new Set<string>());
  let autoAdd = $state(false);
  let saving = $state(false);

  const load = async (id: string) => {
    try {
      const result = await getAlbumSuggestions({ id });
      if (id !== albumId) {
        return;
      }
      suggestions = result;
      autoAdd = result.autoAdd;
      picked = new Set([...result.fromTrip, ...result.needDate].map(({ assetId }) => assetId));
      fixDate = new Set();
      dismissed = new Set();
    } catch {
      // Suggestions are optional: an album that can't be read for them simply shows none.
      suggestions = null;
    }
  };

  $effect(() => {
    hidden = false;
    suggestions = null;
    void load(albumId);
  });

  const fromTrip = $derived((suggestions?.fromTrip ?? []).filter(({ assetId }) => !dismissed.has(assetId)));
  const needDate = $derived((suggestions?.needDate ?? []).filter(({ assetId }) => !dismissed.has(assetId)));
  const count = $derived(fromTrip.length + needDate.length);
  const groups = $derived(
    [
      { likely: true, items: fromTrip.filter(({ likely }) => likely) },
      { likely: false, items: fromTrip.filter(({ likely }) => !likely) },
    ].filter(({ items }) => items.length > 0),
  );
  const adding = $derived([...fromTrip, ...needDate].filter(({ assetId }) => picked.has(assetId)));
  const fixing = $derived(needDate.filter(({ assetId }) => fixDate.has(assetId)));

  const toggle = (set: Set<string>, id: string) => {
    const next = new Set(set);
    if (next.has(id)) {
      next.delete(id);
    } else {
      next.add(id);
    }
    return next;
  };

  const formatDay = (day: string) =>
    new Date(`${day}T12:00:00Z`).toLocaleDateString($locale, {
      day: 'numeric',
      month: 'short',
      year: 'numeric',
      timeZone: 'UTC',
    });

  /** The suggested local date and time, read from its own wall time so the viewer's zone doesn't shift it. */
  const formatSuggested = ({ dateTimeOriginal, precision }: AlbumDateSuggestionDto) => {
    const wall = new Date(`${dateTimeOriginal.slice(0, 19)}Z`);
    const day = formatDay(dateTimeOriginal.slice(0, 10));
    if (precision !== 'moment') {
      return day;
    }
    const time = wall.toLocaleTimeString($locale, { hour: 'numeric', minute: '2-digit', timeZone: 'UTC' });
    return `${day}, ${time}`;
  };

  const tripSpan = $derived(
    suggestions?.tripStart && suggestions.tripEnd
      ? suggestions.tripStart === suggestions.tripEnd
        ? formatDay(suggestions.tripStart)
        : `${formatDay(suggestions.tripStart)} – ${formatDay(suggestions.tripEnd)}`
      : '',
  );
  const places = $derived(new Intl.ListFormat($locale, { type: 'conjunction' }).format(suggestions?.places ?? []));

  const reasonIcon: Record<string, string> = {
    'during-trip': mdiCalendarCheckOutline,
    place: mdiMapMarkerOutline,
    'same-camera': mdiCameraOutline,
    'looks-like': mdiImageSearchOutline,
    'same-scene': mdiImageSearchOutline,
    'near-identical': mdiContentCopy,
    people: mdiAccountMultipleOutline,
  };

  const reasonText = (reason: AlbumSuggestionReasonDto): string | undefined => {
    switch (reason.kind) {
      case 'during-trip': {
        return $t('frameleaf_album_suggestions_reason_during', { values: { date: formatDay(reason.date!) } });
      }
      case 'place': {
        return reason.place;
      }
      case 'same-camera': {
        return $t('frameleaf_album_suggestions_reason_camera');
      }
      case 'looks-like': {
        return $t('frameleaf_album_suggestions_reason_looks_like');
      }
      case 'same-scene': {
        return $t('frameleaf_album_suggestions_reason_same_scene', {
          values: { name: reason.fileName ?? '', date: formatDay(reason.date!) },
        });
      }
      case 'near-identical': {
        return $t('frameleaf_album_suggestions_reason_identical', {
          values: { name: reason.fileName ?? '', date: formatDay(reason.date!) },
        });
      }
      case 'people': {
        return $t('frameleaf_album_suggestions_reason_people', {
          values: { names: new Intl.ListFormat($locale, { type: 'conjunction' }).format(reason.names ?? []) },
        });
      }
      default: {
        // A kind added after this build is left out rather than shown wrongly.
        return undefined;
      }
    }
  };

  const sourceText = (source: string) =>
    ({
      facebook: $t('frameleaf_album_suggestions_source_facebook'),
      whatsapp: $t('frameleaf_album_suggestions_source_whatsapp'),
      messenger: $t('frameleaf_album_suggestions_source_messenger'),
    })[source] ?? $t('frameleaf_album_suggestions_source_none');

  const precisionText = (precision: string) =>
    ({
      moment: $t('frameleaf_album_suggestions_precision_moment'),
      day: $t('frameleaf_album_suggestions_precision_day'),
    })[precision] ?? $t('frameleaf_album_suggestions_precision_trip');

  const dismiss = async (id: string) => {
    dismissed = new Set([...dismissed, id]);
    try {
      await dismissAlbumSuggestions({ id: albumId, bulkIdsDto: { ids: [id] } });
    } catch (error) {
      dismissed = toggle(dismissed, id);
      handleError(error, $t('frameleaf_album_suggestions_dismiss_failed'));
    }
  };

  const apply = async () => {
    saving = true;
    let added = 0;
    let fixed = 0;
    try {
      if (autoAdd !== suggestions?.autoAdd) {
        await setAlbumSuggestionAutoAdd({ id: albumId, albumSuggestionAutoAddDto: { enabled: autoAdd } });
      }
      for (const item of fixing) {
        await updateAsset({ id: item.assetId, updateAssetDto: { dateTimeOriginal: item.dateTimeOriginal } });
        fixed++;
      }
      if (adding.length > 0) {
        const results = await addAssetsToAlbum({
          id: albumId,
          bulkIdsDto: { ids: adding.map(({ assetId }) => assetId) },
        });
        added = results.filter(({ success }) => success).length;
      }
      toastManager.primary(
        [
          added > 0 && $t('frameleaf_album_suggestions_added', { values: { count: added } }),
          fixed > 0 && $t('frameleaf_album_suggestions_dates_fixed', { values: { count: fixed } }),
          autoAdd && !suggestions?.autoAdd && $t('frameleaf_album_suggestions_auto_add_on'),
        ]
          .filter(Boolean)
          .join(' '),
      );
      open = false;
      hidden = true;
      onChanged();
      void load(albumId);
    } catch (error) {
      handleError(error, $t('frameleaf_album_suggestions_apply_failed'));
      if (added > 0 || fixed > 0) {
        onChanged();
      }
    } finally {
      saving = false;
    }
  };

  const openReview = () => {
    tab = fromTrip.length > 0 ? 'trip' : 'dates';
    open = true;
  };
</script>

{#snippet reasons(items: AlbumSuggestionReasonDto[])}
  <ul class="reasons">
    {#each items as reason, index (index)}
      {@const text = reasonText(reason)}
      {#if text}
        <li><Icon icon={reasonIcon[reason.kind]} size="14" aria-hidden />{text}</li>
      {/if}
    {/each}
  </ul>
{/snippet}

{#snippet notThisOne(id: string)}
  <button type="button" class="not" onclick={() => void dismiss(id)}>
    <Icon icon={mdiClose} size="14" aria-hidden />
    {$t('frameleaf_album_suggestions_not_from_trip')}
  </button>
{/snippet}

{#if !hidden && count > 0}
  <section class="pl-notice ma-notice" role="status" aria-label={$t('frameleaf_album_suggestions_label')}>
    <Icon icon={mdiAutoFix} size="18" aria-hidden />
    <p>
      <strong>{$t('frameleaf_album_suggestions_title', { values: { count } })}</strong>
      <span>{$t('frameleaf_album_suggestions_body')}</span>
    </p>
    <Button variant="primary" onclick={openReview}>{$t('frameleaf_album_suggestions_review')}</Button>
    <Button onclick={() => (hidden = true)}>{$t('frameleaf_album_suggestions_not_now')}</Button>
  </section>
{/if}

<Dialog title={$t('frameleaf_album_suggestions_dialog_title')} closeLabel={$t('close')} size="wide" bind:open>
  <p class="lead">
    {$t('frameleaf_album_suggestions_lead', { values: { album: albumName, span: tripSpan, places } })}
  </p>
  <div class="tabs" role="tablist" aria-label={$t('frameleaf_album_suggestions_show')}>
    <button type="button" role="tab" aria-selected={tab === 'trip'} onclick={() => (tab = 'trip')}>
      {$t('frameleaf_album_suggestions_tab_trip', { values: { count: fromTrip.length } })}
    </button>
    <button type="button" role="tab" aria-selected={tab === 'dates'} onclick={() => (tab = 'dates')}>
      {$t('frameleaf_album_suggestions_tab_dates', { values: { count: needDate.length } })}
    </button>
  </div>

  {#if tab === 'trip'}
    {#each groups as group (group.likely)}
      <section class="group">
        <h3>
          {group.likely ? $t('frameleaf_album_suggestions_likely') : $t('frameleaf_album_suggestions_possibly')}
          <small>
            {group.likely
              ? $t('frameleaf_album_suggestions_likely_hint')
              : $t('frameleaf_album_suggestions_possibly_hint')}
          </small>
        </h3>
        <ul class="grid">
          {#each group.items as item (item.assetId)}
            {@render tripTile(item)}
          {/each}
        </ul>
      </section>
    {:else}
      <p class="empty">{$t('frameleaf_album_suggestions_trip_empty')}</p>
    {/each}
  {:else if needDate.length > 0}
    <p class="note">
      <Icon icon={mdiInformationOutline} size="16" aria-hidden />
      {$t('frameleaf_album_suggestions_dates_note')}
    </p>
    <ul class="dates">
      {#each needDate as item (item.assetId)}
        <li>
          <img src={getAssetMediaUrl({ id: item.assetId, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
          <div class="date-body">
            <div class="date-head">
              <strong>{item.fileName}</strong>
              <span class="muted">{sourceText(item.source)}</span>
            </div>
            <dl>
              <div>
                <dt>{$t('frameleaf_album_suggestions_file_date')}</dt>
                <dd>
                  {formatDay(item.fileDate)}
                  <span class="muted">
                    {item.source === 'none'
                      ? $t('frameleaf_album_suggestions_file_date_none')
                      : $t('frameleaf_album_suggestions_file_date_saved')}
                  </span>
                </dd>
              </div>
              <div>
                <dt>{$t('frameleaf_album_suggestions_likely_taken')}</dt>
                <dd>
                  <strong>{formatSuggested(item)}</strong>
                  <span class="precision">{precisionText(item.precision)}</span>
                </dd>
              </div>
            </dl>
            {@render reasons(item.reasons)}
            <div class="choices">
              <label>
                <input
                  type="checkbox"
                  checked={picked.has(item.assetId)}
                  onchange={() => (picked = toggle(picked, item.assetId))}
                />
                {$t('frameleaf_album_suggestions_add_to', { values: { album: albumName } })}
              </label>
              <label>
                <input
                  type="checkbox"
                  checked={fixDate.has(item.assetId)}
                  onchange={() => (fixDate = toggle(fixDate, item.assetId))}
                />
                {item.precision === 'trip'
                  ? $t('frameleaf_album_suggestions_set_date_approximate', {
                      values: { date: formatSuggested(item) },
                    })
                  : $t('frameleaf_album_suggestions_set_date', { values: { date: formatSuggested(item) } })}
              </label>
            </div>
            {@render notThisOne(item.assetId)}
          </div>
        </li>
      {/each}
    </ul>
  {:else}
    <p class="empty">{$t('frameleaf_album_suggestions_dates_empty')}</p>
  {/if}

  {#snippet actions()}
    <label class="auto ma-auto">
      <input type="checkbox" bind:checked={autoAdd} />
      <span>
        {$t('frameleaf_album_suggestions_auto_add')}
        <small>{$t('frameleaf_album_suggestions_auto_add_hint')}</small>
      </span>
    </label>
    <Button
      variant="primary"
      disabled={saving || (adding.length === 0 && fixing.length === 0 && autoAdd === suggestions?.autoAdd)}
      onclick={() => void apply()}
    >
      {$t('frameleaf_album_suggestions_apply', { values: { add: adding.length, fix: fixing.length } })}
    </Button>
  {/snippet}
</Dialog>

{#snippet tripTile(item: AlbumTripSuggestionDto)}
  <li class="tile" class:checked={picked.has(item.assetId)}>
    <label>
      <input
        type="checkbox"
        checked={picked.has(item.assetId)}
        onchange={() => (picked = toggle(picked, item.assetId))}
      />
      <img src={getAssetMediaUrl({ id: item.assetId, size: AssetMediaSize.Thumbnail })} alt="" loading="lazy" />
      <span class="name">{item.fileName}</span>
    </label>
    {@render reasons(item.reasons)}
    {@render notThisOne(item.assetId)}
  </li>
{/snippet}

<style>
  /* PartnerLockedNotice's .pl-notice: the same place, spacing and phone layout. */
  .pl-notice {
    display: flex;
    align-items: center;
    gap: 12px;
    /* 12px from the header's buttons above it: stacked rows of controls (spacing review). */
    margin: 12px 0;
    padding: 12px 14px;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .pl-notice > :global(svg) {
    flex: 0 0 auto;
    color: var(--fl-accent);
  }
  .pl-notice p {
    flex: 1;
    display: grid;
    gap: 2px;
    margin: 0;
    font-size: 13px;
  }
  .pl-notice p span,
  .muted,
  .reasons,
  .group h3 small,
  .auto small,
  .empty,
  .date-body dt {
    color: var(--fl-muted);
  }
  .lead {
    margin: 0 0 16px;
    max-width: 72ch;
    color: var(--fl-muted);
  }
  .tabs {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 0 0 24px;
  }
  .tabs button {
    min-height: 32px;
    padding: 0 14px;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font: inherit;
    font-size: 13px;
    font-weight: 500;
    cursor: pointer;
  }
  .tabs button[aria-selected='true'] {
    background: var(--fl-text);
    color: var(--fl-canvas);
  }
  .group + .group {
    margin-top: 24px;
  }
  .group h3 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
    margin: 0 0 12px;
    font-size: 15px;
  }
  .group h3 small {
    font-size: 13px;
    font-weight: 400;
  }
  .grid,
  .dates,
  .reasons {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(200px, 1fr));
    gap: 16px;
  }
  .tile {
    display: grid;
    gap: 8px;
    align-content: start;
  }
  .tile label {
    position: relative;
    display: grid;
    gap: 8px;
    cursor: pointer;
  }
  .tile img,
  .dates img {
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .tile img {
    /* Inside the photo: the dialog body scrolls and would clip a ring drawn outside. */
    outline: 3px solid transparent;
    outline-offset: -3px;
    opacity: 0.55;
  }
  .tile.checked img {
    opacity: 1;
    outline-color: var(--fl-accent);
  }
  .tile input {
    position: absolute;
    top: 8px;
    left: 8px;
    width: 20px;
    height: 20px;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  .name {
    font-size: 13px;
    font-weight: 500;
    overflow-wrap: anywhere;
  }
  .reasons {
    display: grid;
    gap: 4px;
    font-size: 12px;
  }
  .reasons li {
    display: flex;
    align-items: flex-start;
    gap: 8px;
  }
  .reasons :global(svg) {
    flex: 0 0 auto;
    margin-top: 1px;
  }
  .not {
    justify-self: start;
    display: inline-flex;
    align-items: center;
    gap: 4px;
    min-height: 32px;
    margin-inline-start: -8px;
    padding: 0 8px;
    border: 0;
    border-radius: var(--fl-radius-control, 8px);
    background: none;
    color: var(--fl-muted);
    font: inherit;
    font-size: 12px;
    cursor: pointer;
  }
  .not:hover {
    background: var(--fl-raised);
    color: var(--fl-text);
  }
  .note {
    display: flex;
    align-items: flex-start;
    gap: 8px;
    margin: 0 0 16px;
    padding: 12px 16px;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    color: var(--fl-muted);
    font-size: 13px;
  }
  .note :global(svg) {
    flex: 0 0 auto;
    margin-top: 1px;
  }
  .dates {
    display: grid;
    gap: 16px;
  }
  .dates > li {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    gap: 16px;
    padding: 16px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .date-body {
    display: grid;
    gap: 12px;
    align-content: start;
    min-width: 0;
  }
  .date-head {
    display: grid;
    gap: 2px;
    font-size: 13px;
    overflow-wrap: anywhere;
  }
  .date-body dl {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
    margin: 0;
    font-size: 13px;
  }
  .date-body dt {
    margin-bottom: 2px;
    font-size: 12px;
  }
  .date-body dd {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 4px 8px;
    margin: 0;
  }
  .precision {
    padding: 2px 8px;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-raised);
    font-size: 12px;
  }
  /* Each checkbox sits in the 44px control box (tokens.css), so the rows need no gap of their own. */
  .choices {
    display: grid;
    font-size: 13px;
  }
  .choices label,
  .auto {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    margin: 0;
    cursor: pointer;
  }
  .choices input,
  .auto input {
    flex: 0 0 auto;
    width: 18px;
    height: 18px;
    margin: 0;
    accent-color: var(--fl-accent);
  }
  /* The footer stretches its items to the tallest; centre the buttons beside this two-line label. */
  :global(.dialog-actions:has(> .ma-auto)) {
    align-items: center;
  }
  .auto {
    margin-inline-end: auto;
    max-width: 44ch;
    font-size: 13px;
  }
  .auto span {
    display: grid;
    gap: 2px;
  }
  .auto small {
    font-size: 12px;
  }
  .empty {
    margin: 24px 0;
  }
  @media (max-width: 700px) {
    .pl-notice {
      flex-wrap: wrap;
      align-items: flex-start;
      row-gap: 12px;
      padding: 12px 16px;
    }
    .pl-notice p {
      flex: 1 1 calc(100% - 30px);
    }
    .pl-notice > :global(button:first-of-type) {
      margin-inline-start: auto;
    }
    .grid {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      gap: 12px;
    }
    .dates > li,
    .date-body dl {
      grid-template-columns: minmax(0, 1fr);
    }
    .dates img {
      aspect-ratio: 16 / 9;
    }
    .auto {
      flex: 1 1 100%;
      max-width: none;
    }
  }
</style>
