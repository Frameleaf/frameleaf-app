<script lang="ts">
  /**
   * FL-1092 / FL-1093 magic albums, built to the approved mock (prototype `MagicAlbum.jsx`, PR 21):
   * a notice on an album the viewer can add to when photos from their library look like they are from
   * its trip, and a review with two tabs. "From the trip" lists photos taken during it; "Need a date"
   * lists photos with no trustworthy date and offers one. Adding and changing a date are separate
   * choices, and nothing changes until the person presses the button. FL-1299 adds a third tab: photos
   * already in the album whose date was lost, healed from the album around them.
   */
  import AlbumLostDates from '$lib/components/frameleaf/AlbumLostDates.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { toastUndo } from '$lib/frameleaf/toast';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import {
    AssetMediaSize,
    BulkIdErrorReason,
    addAssetsToAlbum,
    dismissAlbumSuggestions,
    getAlbumLostDates,
    getAlbumSuggestions,
    healAlbumLostDates,
    isHttpError,
    setAlbumSuggestionAutoAdd,
    undoLatestAlbumChangeRun,
    updateAsset,
    type AlbumDateSuggestionDto,
    type AlbumLostDatesResponseDto,
    type AlbumSuggestionReasonDto,
    type AlbumSuggestionsResponseDto,
    type AlbumTripSuggestionDto,
  } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import {
    mdiAccountMultipleOutline,
    mdiAlertCircleOutline,
    mdiAutoFix,
    mdiCalendarCheckOutline,
    mdiCameraOutline,
    mdiClose,
    mdiContentCopy,
    mdiImageSearchOutline,
    mdiInformationOutline,
    mdiMapMarkerOutline,
    mdiTshirtCrewOutline,
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
  let lostDates = $state<AlbumLostDatesResponseDto | null>(null);
  let tab = $state<'trip' | 'dates' | 'lost'>('trip');
  let dismissed = $state(new Set<string>());
  let picked = $state(new Set<string>());
  let fixDate = $state(new Set<string>());
  let autoAdd = $state(false);
  let saving = $state(false);
  /** A failed add, apply or dismiss, said in the review itself (prototype `.ma-alert`). */
  let alert = $state<{ message: string; retry?: () => void } | null>(null);
  let turningOff = $state(false);
  let turnOffFailed = $state(false);
  const tabsId = $props.id();

  /** Said in the review while it is open; a toast once it has been closed, so it isn't lost. */
  const report = (message: string, retry?: () => void) => {
    if (open) {
      alert = { message, retry };
    } else {
      toastManager.danger(message);
    }
  };

  let loadRequested = 0;
  let loadApplied = 0;

  /**
   * `afterFailure`: a refresh after a failed save keeps the person's choices for what is still
   * suggested, and keeps what is shown if the refresh fails too, so Try again still has it.
   */
  const load = async (id: string, afterFailure = false) => {
    const request = ++loadRequested;
    try {
      const result = await getAlbumSuggestions({ id });
      // Requests can answer out of order: an older one never replaces what a newer one showed.
      if (id !== albumId || request < loadApplied) {
        return;
      }
      loadApplied = request;
      // A list that never loaded left nothing to choose from, so there are no choices to keep.
      const keepChoices = afterFailure && suggestions !== null;
      suggestions = result;
      // After a failed save the person's pending auto-add choice stays, so Try again still sends it.
      if (!keepChoices) {
        autoAdd = result.autoAdd;
      }
      const ids = [...result.fromTrip, ...result.needDate].map(({ assetId }) => assetId);
      picked = new Set(keepChoices ? ids.filter((assetId) => picked.has(assetId)) : ids);
      fixDate = new Set(keepChoices ? ids.filter((assetId) => fixDate.has(assetId)) : []);
      dismissed = keepChoices ? dismissed : new Set();
      turnOffFailed = false;
    } catch {
      // Suggestions are optional: an album that can't be read for them simply shows none.
      if (!afterFailure && request === loadRequested) {
        suggestions = null;
      }
    }
  };

  const loadLostDates = async (id: string, keepOnFailure = false) => {
    try {
      const result = await getAlbumLostDates({ id });
      if (id === albumId) {
        lostDates = result;
      }
    } catch {
      // Optional like the suggestions: the album still opens without them.
      if (id === albumId && !keepOnFailure) {
        lostDates = null;
      }
    }
  };

  $effect(() => {
    hidden = false;
    suggestions = null;
    lostDates = null;
    void load(albumId);
    void loadLostDates(albumId);
  });

  const fromTrip = $derived((suggestions?.fromTrip ?? []).filter(({ assetId }) => !dismissed.has(assetId)));
  const needDate = $derived((suggestions?.needDate ?? []).filter(({ assetId }) => !dismissed.has(assetId)));
  const count = $derived(fromTrip.length + needDate.length);
  const lostCount = $derived(lostDates?.suggestions.length ?? 0);
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
    'same-outfit': mdiTshirtCrewOutline,
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
      case 'same-outfit': {
        return $t('frameleaf_album_suggestions_reason_same_outfit', {
          values: { names: reason.names?.[0] ?? '', date: formatDay(reason.date!) },
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

  const dismiss = async (id: string, name: string) => {
    dismissed = new Set([...dismissed, id]);
    try {
      await dismissAlbumSuggestions({ id: albumId, bulkIdsDto: { ids: [id] } });
    } catch (error) {
      console.error(error);
      dismissed = toggle(dismissed, id);
      report($t('frameleaf_album_suggestions_dismiss_failed', { values: { name } }));
    }
  };

  const apply = async () => {
    if (saving) {
      return;
    }
    saving = true;
    alert = null;
    const autoAddChanged = autoAdd !== suggestions?.autoAdd;
    let added = 0;
    let fixed = 0;
    let failed = 0;
    /** Which request failed decides the message: adding the photos, or saving a date or the choice. */
    let addingStarted = false;
    /** Any write sent: its outcome is uncertain once a request fails, so the result is read again. */
    let wrote = false;
    try {
      if (autoAddChanged) {
        wrote = true;
        await setAlbumSuggestionAutoAdd({ id: albumId, albumSuggestionAutoAddDto: { enabled: autoAdd } });
      }
      for (const item of fixing) {
        wrote = true;
        await updateAsset({ id: item.assetId, updateAssetDto: { dateTimeOriginal: item.dateTimeOriginal } });
        fixed++;
      }
      if (adding.length > 0) {
        addingStarted = true;
        wrote = true;
        const results = await addAssetsToAlbum({
          id: albumId,
          bulkIdsDto: { ids: adding.map(({ assetId }) => assetId) },
        });
        added = results.filter(({ success }) => success).length;
        // Already in the album is fine; anything else stays suggested so it can be tried again.
        failed = results.filter(({ success, error }) => !success && error !== BulkIdErrorReason.Duplicate).length;
      }
      const message = [
        added > 0 && $t('frameleaf_album_suggestions_added', { values: { count: added } }),
        fixed > 0 && $t('frameleaf_album_suggestions_dates_fixed', { values: { count: fixed } }),
        autoAddChanged &&
          (autoAdd ? $t('frameleaf_album_suggestions_auto_add_on') : $t('frameleaf_album_suggestions_auto_add_off')),
      ]
        .filter(Boolean)
        .join(' ');
      if (message) {
        toastManager.primary(message);
      }
      if (failed > 0) {
        report($t('frameleaf_album_suggestions_add_failed', { values: { count: failed } }));
      } else {
        open = false;
        hidden = true;
      }
      onChanged();
      await load(albumId);
    } catch (error) {
      console.error(error);
      // Name the photos only when adding them failed; a date or the auto-add choice is a save.
      report(
        addingStarted ? $t('frameleaf_album_suggestions_apply_failed') : $t('frameleaf_album_suggestions_save_failed'),
        () => void apply(),
      );
      // Some of it may have been saved before the failure (an add can commit and still reject), so
      // the album and the suggestions are read again rather than trusted as they were.
      if (wrote) {
        onChanged();
        await load(albumId, true);
      }
    } finally {
      saving = false;
    }
  };

  const turnOffAutoAdd = async () => {
    if (turningOff) {
      return;
    }
    turningOff = true;
    turnOffFailed = false;
    try {
      await setAlbumSuggestionAutoAdd({ id: albumId, albumSuggestionAutoAddDto: { enabled: false } });
      autoAdd = false;
      if (suggestions) {
        suggestions = { ...suggestions, autoAdd: false };
      }
      toastManager.primary($t('frameleaf_album_suggestions_auto_add_off'));
    } catch (error) {
      console.error(error);
      turnOffFailed = true;
    } finally {
      turningOff = false;
    }
  };

  /** Puts healed dates back. Anything changed since stays as it is, and the message says what was kept. */
  const undoHeal = async (runId: string) => {
    try {
      const { skipped } = await undoLatestAlbumChangeRun({ albumChangeUndoDto: { runId } });
      toastManager.primary(
        skipped.length > 0
          ? $t('frameleaf_album_lost_dates_undone_kept', { values: { names: skipped.join(', ') } })
          : $t('frameleaf_album_lost_dates_undone'),
      );
      onChanged();
      await loadLostDates(albumId);
    } catch (error) {
      if (isHttpError(error) && error.status === 409) {
        toastManager.primary($t('frameleaf_albums_merge_undo_newer'));
        return;
      }
      console.error(error);
      toastManager.danger($t('frameleaf_album_lost_dates_undo_failed'));
    }
  };

  /** The person's approval, per album. The server decides each date again, so only the photos are sent. */
  const heal = async () => {
    if (saving || lostCount === 0) {
      return;
    }
    saving = true;
    alert = null;
    try {
      const { runId, healed } = await healAlbumLostDates({
        albumLostDatesHealDto: {
          albums: [{ albumId, assetIds: (lostDates?.suggestions ?? []).map(({ assetId }) => assetId) }],
        },
      });
      if (runId) {
        toastUndo($t('frameleaf_album_lost_dates_healed', { values: { count: healed } }), () => void undoHeal(runId));
      } else {
        toastManager.primary($t('frameleaf_album_lost_dates_none_healed'));
      }
      open = false;
      onChanged();
      await loadLostDates(albumId);
    } catch (error) {
      console.error(error);
      // The request can fail after the heal committed, so read again everything those dates feed.
      onChanged();
      await load(albumId, true);
      await loadLostDates(albumId, true);
      const message = $t('frameleaf_album_lost_dates_heal_failed');
      if (tabs.length === 0 && (!suggestions || autoAdd === suggestions.autoAdd)) {
        // Nothing is left to review or save, so the failure can't stay in the dialog.
        open = false;
        toastManager.primary(message);
      } else {
        report(message, lostCount > 0 ? () => void heal() : undefined);
      }
    } finally {
      saving = false;
    }
  };

  const openReview = () => {
    tab = firstTab;
    autoAdd = suggestions?.autoAdd ?? false;
    alert = null;
    open = true;
  };

  const tabs = $derived<('trip' | 'dates' | 'lost')[]>([
    ...(count > 0 ? (['trip', 'dates'] as const) : []),
    ...(lostCount > 0 ? (['lost'] as const) : []),
  ]);
  const firstTab = $derived(fromTrip.length > 0 ? 'trip' : needDate.length > 0 ? 'dates' : ('lost' as const));
  /** A refresh can take away the tab that was open; show the first one with something in it. */
  const activeTab = $derived(tabs.includes(tab) ? tab : firstTab);
  const tabButtons: Record<string, HTMLButtonElement | undefined> = {};

  /** Arrow keys, Home and End move between the tabs (prototype `SuggestionTabs`). */
  const onTabKey = (event: KeyboardEvent) => {
    const index = tabs.indexOf(activeTab);
    const next =
      event.key === 'ArrowRight'
        ? (index + 1) % tabs.length
        : event.key === 'ArrowLeft'
          ? (index - 1 + tabs.length) % tabs.length
          : event.key === 'Home'
            ? 0
            : event.key === 'End'
              ? tabs.length - 1
              : null;
    if (next === null) {
      return;
    }
    event.preventDefault();
    tab = tabs[next];
    tabButtons[tab]?.focus();
  };

  const applyLabel = $derived(
    saving
      ? adding.length > 0
        ? $t('frameleaf_album_suggestions_adding')
        : $t('frameleaf_album_suggestions_saving')
      : $t('frameleaf_album_suggestions_apply', { values: { add: adding.length, fix: fixing.length } }),
  );
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

{#snippet notThisOne(id: string, name: string)}
  <button
    type="button"
    class="not"
    aria-label={$t('frameleaf_album_suggestions_not_from_trip_named', { values: { name } })}
    onclick={() => void dismiss(id, name)}
  >
    <Icon icon={mdiClose} size="14" aria-hidden />
    {$t('frameleaf_album_suggestions_not_from_trip')}
  </button>
{/snippet}

{#if !hidden && count + lostCount > 0}
  <section class="pl-notice ma-notice" role="status" aria-label={$t('frameleaf_album_suggestions_label')}>
    <Icon icon={mdiAutoFix} size="18" aria-hidden />
    <p>
      {#if count > 0}
        <strong>{$t('frameleaf_album_suggestions_title', { values: { count } })}</strong>
        <span>
          {lostCount > 0
            ? $t('frameleaf_album_suggestions_body_with_lost', { values: { count: lostCount } })
            : $t('frameleaf_album_suggestions_body')}
        </span>
      {:else}
        <strong>{$t('frameleaf_album_lost_dates_title', { values: { count: lostCount } })}</strong>
        <span>{$t('frameleaf_album_lost_dates_body')}</span>
      {/if}
    </p>
    <Button variant="primary" onclick={openReview}>{$t('frameleaf_album_suggestions_review')}</Button>
    <Button onclick={() => (hidden = true)}>{$t('frameleaf_album_suggestions_not_now')}</Button>
  </section>
{:else if !hidden && suggestions?.autoAdd}
  <!-- Nothing waiting, but new photos are still being added: keep the way to stop that in reach. -->
  <section class="pl-notice ma-notice" role="status" aria-label={$t('frameleaf_album_suggestions_label')}>
    <Icon icon={mdiAutoFix} size="18" aria-hidden />
    <p>
      <span class="notice-text">{$t('frameleaf_album_suggestions_auto_add_active')}</span>
      {#if turnOffFailed}
        <span class="notice-error" role="alert">{$t('frameleaf_album_suggestions_auto_add_off_failed')}</span>
      {/if}
    </p>
    <Button onclick={() => void turnOffAutoAdd()} disabled={turningOff}>
      {turningOff
        ? $t('frameleaf_album_suggestions_turning_off')
        : turnOffFailed
          ? $t('frameleaf_error_retry')
          : $t('frameleaf_album_suggestions_auto_add_turn_off')}
    </Button>
  </section>
{/if}

<Dialog title={$t('frameleaf_album_suggestions_dialog_title')} closeLabel={$t('close')} size="wide" bind:open>
  {#if activeTab !== 'lost'}
    <p class="lead">
      {$t('frameleaf_album_suggestions_lead', { values: { album: albumName, span: tripSpan, places } })}
    </p>
  {/if}
  {#if alert}
    <div class="alert" role="alert">
      <Icon icon={mdiAlertCircleOutline} size="18" aria-hidden />
      <p>{alert.message}</p>
      {#if alert.retry}
        <Button disabled={saving} onclick={alert.retry}>{$t('frameleaf_error_retry')}</Button>
      {/if}
    </div>
  {/if}
  <div
    class="tabs"
    role="tablist"
    aria-label={$t('frameleaf_album_suggestions_show')}
    tabindex="-1"
    onkeydown={onTabKey}
  >
    {#each tabs as value (value)}
      <button
        bind:this={tabButtons[value]}
        id="{tabsId}-tab-{value}"
        type="button"
        role="tab"
        aria-selected={activeTab === value}
        aria-controls="{tabsId}-panel"
        tabindex={activeTab === value ? 0 : -1}
        onclick={() => (tab = value)}
      >
        {value === 'trip'
          ? $t('frameleaf_album_suggestions_tab_trip', { values: { count: fromTrip.length } })
          : value === 'dates'
            ? $t('frameleaf_album_suggestions_tab_dates', { values: { count: needDate.length } })
            : $t('frameleaf_album_lost_dates_tab', { values: { count: lostCount } })}
      </button>
    {/each}
  </div>

  <div id="{tabsId}-panel" role="tabpanel" aria-labelledby="{tabsId}-tab-{activeTab}">
    {#if activeTab === 'lost' && lostDates}
      <AlbumLostDates lost={lostDates} {formatDay} />
    {:else if activeTab === 'trip'}
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
              {@render notThisOne(item.assetId, item.fileName)}
            </div>
          </li>
        {/each}
      </ul>
    {:else}
      <p class="empty">{$t('frameleaf_album_suggestions_dates_empty')}</p>
    {/if}
  </div>

  {#snippet actions()}
    {#if activeTab === 'lost'}
      {#if suggestions && autoAdd !== suggestions.autoAdd}
        <!-- A changed auto-add choice can still be saved after its own tab has gone. -->
        <Button disabled={saving} onclick={() => void apply()}>{applyLabel}</Button>
      {/if}
      <Button variant="primary" disabled={saving || lostCount === 0} onclick={() => void heal()}>
        {saving
          ? $t('frameleaf_album_lost_dates_healing')
          : $t('frameleaf_album_lost_dates_heal_all', { values: { count: lostCount } })}
      </Button>
    {:else}
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
        {applyLabel}
      </Button>
    {/if}
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
    {@render notThisOne(item.assetId, item.fileName)}
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
  .pl-notice p .notice-text {
    color: var(--fl-text);
  }
  .notice-error {
    color: var(--fl-danger);
  }
  /* A failed add, apply or dismiss: said in place, with a way to try again. */
  .alert {
    display: flex;
    align-items: center;
    gap: 12px;
    margin: 0 0 16px;
    padding: 12px 16px;
    border-radius: var(--fl-radius-card);
    background: color-mix(in srgb, var(--fl-danger), transparent 88%);
    color: var(--fl-text);
    font-size: 13px;
  }
  .alert > :global(svg) {
    flex: 0 0 auto;
    color: var(--fl-danger);
  }
  .alert p {
    flex: 1;
    margin: 0;
  }
  /*
   * Desktop (magic-album.css @701px): the suggestion is one quiet line on the accent tint. The
   * explanation trails the headline and truncates; the full sentence is in the review. The buttons
   * keep the app's control height, so the line is padded 6px around them, not the prototype's 30px.
   */
  @media (min-width: 701px) {
    .ma-notice {
      gap: var(--fl-space-2);
      padding: 6px 6px 6px 14px;
      background: var(--fl-accent-soft);
    }
    .ma-notice > :global(svg) {
      margin-inline-end: 2px;
    }
    .ma-notice p {
      display: flex;
      align-items: baseline;
      gap: var(--fl-space-2);
      min-width: 0;
      white-space: nowrap;
    }
    .ma-notice p > span {
      min-width: 0;
      overflow: hidden;
      text-overflow: ellipsis;
    }
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
    .alert {
      flex-wrap: wrap;
      align-items: flex-start;
    }
    .alert p {
      flex: 1 1 calc(100% - 30px);
    }
    .alert > :global(button) {
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
