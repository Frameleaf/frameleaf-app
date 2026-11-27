<script lang="ts">
  /**
   * FL-999: Fix locations › Use your location history, as the approved mock
   * (`settings-v2/library/location-history.jsx`). A person adds files from an app that records where
   * they have been; Frameleaf offers a place for photos that have none, and nothing is filled before
   * they have seen it. Reading and filling run on the server, so this page asks how they are doing.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import LocationHistoryDay from '$lib/components/frameleaf/LocationHistoryDay.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import BackLink from '$lib/components/frameleaf/settings/kit/BackLink.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import Item from '$lib/components/frameleaf/settings/kit/Item.svelte';
  import ItemList from '$lib/components/frameleaf/settings/kit/ItemList.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import Row from '$lib/components/frameleaf/settings/kit/Row.svelte';
  import Said from '$lib/components/frameleaf/settings/kit/Said.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import {
    chunkIds,
    everySelected,
    FILL_GAPS,
    groupByDay,
    historySpan,
    HISTORY_ACCEPT,
    isHistoryFileName,
    isLostUpload,
    isSelected,
    isWorkingRun,
    kindName,
    mergeDays,
    noneSelected,
    placeKey,
    placeName,
    selectedCount,
    setSelected,
    sourceState,
    uploadHistoryFile,
    type FillGap,
    type FillSelection,
  } from '$lib/frameleaf/location-history';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { sleep } from '$lib/utils';
  import {
    applyLocationFill,
    createLocationFill,
    deleteLocationHistorySource,
    getLocationFill,
    getLocationFillProposals,
    getLocationFills,
    getLocationHistorySources,
    getUtilitiesSummary,
    reverseGeocode,
    undoLocationFill,
    type LocationFillDayDto,
    type LocationFillProposalDto,
    type LocationFillRunResponseDto,
    type LocationHistorySourceResponseDto,
  } from '@frameleaf/sdk';
  import { handleError } from '$lib/utils/handle-error';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCellphone,
    mdiCheckCircleOutline,
    mdiFileAlertOutline,
    mdiFileDocumentOutline,
    mdiLockOutline,
    mdiMapMarkerOffOutline,
    mdiMapMarkerPath,
    mdiTrayArrowUp,
    mdiUndo,
    mdiWatch,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy, onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  const POLL_MS = 2000;
  const PAGE_SIZE = 100;
  const ALL_PAGE_SIZE = 500;

  type Upload = {
    key: number;
    file: File;
    sent: number;
    status: 'waiting' | 'sending' | 'failed' | 'not-history';
    controller: AbortController;
  };

  let loaded = $state(false);
  let loadFailed = $state(false);
  let said = $state('');
  let sources = $state<LocationHistorySourceResponseDto[]>([]);
  let uploads = $state<Upload[]>([]);
  let continued = $state(false);
  let withoutPlace = $state<number>();
  let run = $state<LocationFillRunResponseDto>();
  let gap = $state<FillGap>(15);
  let days = $state.raw<LocationFillDayDto[]>([]);
  let hasNextPage = $state(false);
  let nextPage = 1;
  let loadingMore = $state(false);
  let selection = $state.raw<FillSelection>(everySelected());
  let requested = $state<number>();
  let submitting = $state(false);
  let missed = $state.raw<LocationFillDayDto[] | null>(null);
  let names = $state<Record<string, string>>({});
  let removing = $state<LocationHistorySourceResponseDto | null>(null);
  let removeOpen = $state(false);
  let dragging = $state(false);
  let input = $state<HTMLInputElement>();
  let uploadKey = 0;
  let pumping = false;
  let destroyed = false;

  const added = $derived(sources.filter((source) => sourceState(source) === 'added'));
  const reading = $derived(sources.filter((source) => sourceState(source) === 'reading'));
  const failed = $derived(sources.filter((source) => sourceState(source) === 'failed'));
  const sending = $derived(uploads.filter((upload) => upload.status === 'waiting' || upload.status === 'sending'));
  const refused = $derived(uploads.filter((upload) => upload.status === 'failed' || upload.status === 'not-history'));
  const adding = $derived(sending.length + reading.length > 0);
  const leftOut = $derived(failed.length + refused.length);
  const showImport = $derived(adding || (leftOut > 0 && (!continued || added.length === 0)));
  const span = $derived(historySpan(added));
  const status = $derived(run?.status);
  const working = $derived(isWorkingRun(status));
  const total = $derived(run?.proposalCount ?? 0);
  const picked = $derived(selectedCount(selection, total));
  const loadedCount = $derived(days.reduce((sum, day) => sum + day.proposals.length, 0));
  const finished = $derived(status === 'applied' || (status === 'ready' && requested !== undefined));
  const reviewing = $derived(status === 'ready' && requested === undefined);
  const showProposals = $derived(reviewing && total > 0);
  const noMatches = $derived(reviewing && total === 0 && (run?.candidateCount ?? 0) > 0);
  const nothingToFill = $derived(
    (reviewing && run?.candidateCount === 0) || ((!run || status === 'undone' || finished) && withoutPlace === 0),
  );
  const appliedCount = $derived(run?.appliedCount ?? 0);
  const asked = $derived(requested ?? (run?.error ? total : appliedCount));
  const partial = $derived(finished && appliedCount < asked);
  const notChanged = $derived(Math.max(asked - appliedCount, 0));
  const widerGaps = $derived(FILL_GAPS.filter((value) => value > gap));
  const announcement = $derived(
    showImport && adding
      ? $t('frameleaf_location_history_adding_title', { values: { count: sending.length + reading.length } })
      : status === 'proposing'
        ? $t('frameleaf_location_history_looking_title')
        : status === 'applying'
          ? $t('frameleaf_location_history_applying_title')
          : status === 'undoing'
            ? $t('frameleaf_location_history_undoing_title')
            : finished && !partial
              ? $t('frameleaf_location_history_applied_title', { values: { count: appliedCount } })
              : '',
  );

  const date = (iso: string) => DateTime.fromISO(iso, { locale: $locale }).toLocaleString(DateTime.DATE_FULL);
  const range = (from: string, to: string) =>
    $t('frameleaf_location_history_range', { values: { from: date(from), to: date(to) } });
  const selectedFn = (id: string) => isSelected(selection, id);
  const detailOf = (source: LocationHistorySourceResponseDto) => kindName(source.kind);

  const loadNames = async (proposals: LocationFillProposalDto[]) => {
    const wanted = new Map(proposals.map((proposal) => [placeKey(proposal), proposal]));
    for (const [key, proposal] of wanted) {
      if (destroyed || names[key] !== undefined) {
        continue;
      }
      try {
        const [found] = await reverseGeocode({ lat: proposal.latitude, lon: proposal.longitude });
        const name = placeName(found);
        if (name) {
          names[key] = name;
        }
      } catch {
        // The photo still shows its time and the map; the name is a help, not a need.
      }
    }
  };

  // FL-1810: an action that failed says so in a toast; only a failed read is shown in place.
  const actionError = (error: unknown) => handleError(error, $t('frameleaf_location_history_action_error'));

  const loadPage = async (id: string, reset = false) => {
    loadingMore = true;
    try {
      const page = reset ? 1 : nextPage;
      const result = await getLocationFillProposals({ id, page, size: PAGE_SIZE });
      if (run?.id !== id) {
        return;
      }
      days = mergeDays(reset ? [] : days, result.days);
      hasNextPage = result.hasNextPage;
      nextPage = page + 1;
      void loadNames(result.days.flatMap((day) => day.proposals));
    } catch (error) {
      actionError(error);
    } finally {
      loadingMore = false;
    }
  };

  const allProposals = async (id: string) => {
    const proposals: LocationFillProposalDto[] = [];
    for (let page = 1; ; page++) {
      const result = await getLocationFillProposals({ id, page, size: ALL_PAGE_SIZE });
      proposals.push(...result.days.flatMap((day) => day.proposals));
      if (!result.hasNextPage) {
        return proposals;
      }
    }
  };

  const refreshSummary = async () => {
    try {
      withoutPlace = (await getUtilitiesSummary()).withoutPlace;
    } catch {
      withoutPlace = undefined;
    }
  };

  /** Take a run's new state, and do what its change of state asks for. */
  const takeRun = (next: LocationFillRunResponseDto) => {
    const before = run?.id === next.id ? run.status : undefined;
    run = next;
    if (before === next.status) {
      return;
    }
    if (next.status === 'ready' && next.proposalCount > 0 && before !== 'applying') {
      void loadPage(next.id, true);
    }
    if (before === 'applying' || before === 'undoing') {
      void refreshSummary();
    }
    if (before === 'undoing' && next.status === 'undone') {
      requested = undefined;
      said = $t('frameleaf_location_history_undone');
    }
  };

  const load = async () => {
    loadFailed = false;
    try {
      const [history, runs] = await Promise.all([getLocationHistorySources(), getLocationFills()]);
      sources = history;
      await refreshSummary();
      const latest = runs[0];
      if (latest) {
        gap = (FILL_GAPS as readonly number[]).includes(latest.maxGapMinutes) ? (latest.maxGapMinutes as FillGap) : 15;
        takeRun(latest);
      }
    } catch {
      loadFailed = true;
    } finally {
      loaded = true;
    }
  };
  onMount(() => {
    void load();
  });
  onDestroy(() => {
    destroyed = true;
    for (const upload of uploads) {
      upload.controller.abort();
    }
  });

  const poll = async () => {
    try {
      if (reading.length > 0) {
        sources = await getLocationHistorySources();
      }
      if (run && isWorkingRun(run.status)) {
        const id = run.id;
        const next = await getLocationFill({ id });
        if (run?.id === id) {
          takeRun(next);
        }
      }
    } catch {
      // The next look tries again.
    }
  };
  $effect(() => {
    if (!adding && !working) {
      return;
    }
    const timer = setInterval(() => void poll(), POLL_MS);
    return () => clearInterval(timer);
  });

  /* Adding files ------------------------------------------------------- */

  const dropUpload = (key: number) => {
    uploads = uploads.filter((upload) => upload.key !== key);
  };

  const sendOne = async (upload: Upload) => {
    upload.status = 'sending';
    try {
      const source = await uploadHistoryFile(upload.file, upload.controller.signal, (sent) => (upload.sent = sent));
      sources = [source, ...sources];
      dropUpload(upload.key);
    } catch {
      if (upload.controller.signal.aborted) {
        dropUpload(upload.key);
      } else {
        upload.status = 'failed';
      }
    }
  };

  const pump = async () => {
    if (pumping) {
      return;
    }
    pumping = true;
    try {
      for (let next = uploads.find((upload) => upload.status === 'waiting'); next && !destroyed;) {
        await sendOne(next);
        next = uploads.find((upload) => upload.status === 'waiting');
      }
    } finally {
      pumping = false;
    }
  };

  const addFiles = (files: FileList | File[] | null | undefined) => {
    const chosen = [...(files ?? [])];
    if (chosen.length === 0) {
      return;
    }
    continued = false;
    uploads = [
      ...uploads,
      ...chosen.map((file): Upload => ({
        key: ++uploadKey,
        file,
        sent: 0,
        status: isHistoryFileName(file.name) && file.size > 0 ? 'waiting' : 'not-history',
        controller: new AbortController(),
      })),
    ];
    void pump();
  };

  const onChosen = () => {
    addFiles(input?.files);
    if (input) {
      input.value = '';
    }
  };
  const onDrop = (event: DragEvent) => {
    event.preventDefault();
    dragging = false;
    addFiles(event.dataTransfer?.files);
  };
  const onDragOver = (event: DragEvent) => {
    event.preventDefault();
    dragging = true;
  };

  const cancelUpload = (upload: Upload) => {
    if (upload.status === 'sending') {
      upload.controller.abort();
    } else {
      dropUpload(upload.key);
    }
  };

  /** Stop reading a file, or take a file that was left out off the list. */
  const discard = async (source: LocationHistorySourceResponseDto) => {
    try {
      await deleteLocationHistorySource({ id: source.id });
      sources = sources.filter((item) => item.id !== source.id);
    } catch (error) {
      actionError(error);
    }
  };

  const askRemove = (source: LocationHistorySourceResponseDto) => {
    removing = source;
    removeOpen = true;
  };
  const confirmRemove = async () => {
    if (!removing) {
      return;
    }
    const source = removing;
    try {
      await deleteLocationHistorySource({ id: source.id });
      sources = sources.filter((item) => item.id !== source.id);
      said = $t('frameleaf_location_history_removed', { values: { name: source.fileName } });
    } catch (error) {
      actionError(error);
    } finally {
      removeOpen = false;
    }
  };

  /* Filling ------------------------------------------------------------ */

  const start = async (minutes: FillGap) => {
    gap = minutes;
    said = '';
    submitting = true;
    try {
      const next = await createLocationFill({ locationFillCreateDto: { maxGapMinutes: minutes } });
      days = [];
      hasNextPage = false;
      nextPage = 1;
      selection = everySelected();
      requested = undefined;
      missed = null;
      takeRun(next);
    } catch (error) {
      actionError(error);
    } finally {
      submitting = false;
    }
  };

  const toggle = (ids: string[], on: boolean) => {
    selection = setSelected(selection, ids, on);
  };

  const waitWhileApplying = async (id: string) => {
    for (;;) {
      const current = await getLocationFill({ id });
      if (current.status !== 'applying' || destroyed) {
        takeRun(current);
        return;
      }
      await sleep(POLL_MS);
    }
  };

  const apply = async () => {
    if (!run || picked === 0) {
      return;
    }
    const id = run.id;
    const count = picked;
    submitting = true;
    try {
      let batches: (string[] | undefined)[] = [undefined];
      if (!selection.all) {
        batches = chunkIds([...selection.flipped]);
      } else if (selection.flipped.size > 0) {
        const every = await allProposals(id);
        batches = chunkIds(every.map(({ assetId }) => assetId).filter((assetId) => isSelected(selection, assetId)));
      }
      requested = count;
      for (const [index, assetIds] of batches.entries()) {
        takeRun(await applyLocationFill({ id, locationFillApplyDto: { assetIds } }));
        if (index < batches.length - 1) {
          await waitWhileApplying(id);
        }
      }
    } catch (error) {
      actionError(error);
      if (run?.status === 'ready') {
        requested = undefined;
      }
    } finally {
      submitting = false;
    }
  };

  const undo = async () => {
    if (!run) {
      return;
    }
    missed = null;
    try {
      takeRun(await undoLocationFill({ id: run.id }));
    } catch (error) {
      actionError(error);
    }
  };

  const showMissed = async () => {
    if (!run) {
      return;
    }
    try {
      const left = (await allProposals(run.id)).filter(
        (proposal) => !proposal.applied && isSelected(selection, proposal.assetId),
      );
      missed = groupByDay(left);
      void loadNames(left);
    } catch (error) {
      actionError(error);
    }
  };
</script>

{#snippet addButton()}
  <Button onclick={() => input?.click()}
    ><Icon icon={mdiTrayArrowUp} size="1.125rem" aria-hidden />{$t('frameleaf_location_history_add_files')}</Button
  >
{/snippet}

{#snippet gapSection()}
  <Section title={$t('frameleaf_location_history_gap_title')}>
    <Row label={$t('frameleaf_location_history_gap_row')} help={$t('frameleaf_location_history_gap_help')}>
      <SegmentedControl
        label={$t('frameleaf_location_history_gap_label')}
        value={String(gap)}
        disabled={working || submitting}
        options={FILL_GAPS.map((value) => ({
          value: String(value),
          label: $t('frameleaf_location_history_gap_option', { values: { count: value } }),
        }))}
        onChange={(value) => {
          if (Number(value) !== gap) {
            void start(Number(value) as FillGap);
          }
        }}
      />
    </Row>
  </Section>
{/snippet}

{#snippet leftOutRows()}
  {#each refused as upload (upload.key)}
    <Item
      icon={mdiFileAlertOutline}
      quiet
      name={upload.file.name}
      detail={`${formatBytes(upload.file.size, $locale)} · ${$t('frameleaf_location_history_status_not_added')}`}
      tone="bad"
      status={upload.status === 'not-history'
        ? $t('frameleaf_location_history_not_history')
        : $t('frameleaf_location_history_status_not_added')}
      note={upload.status === 'not-history'
        ? $t('frameleaf_location_history_not_history_note')
        : $t('frameleaf_location_history_failed_note')}
    >
      {#snippet action()}
        <Button
          label={$t('frameleaf_location_history_dismiss_file', { values: { name: upload.file.name } })}
          onclick={() => dropUpload(upload.key)}>{$t('dismiss')}</Button
        >
      {/snippet}
    </Item>
  {/each}
  {#each failed as source (source.id)}
    <Item
      icon={mdiFileAlertOutline}
      quiet
      name={source.fileName}
      detail={$t('frameleaf_location_history_status_not_added')}
      tone="bad"
      status={isLostUpload(source)
        ? $t('frameleaf_location_history_status_not_added')
        : $t('frameleaf_location_history_not_history')}
      note={isLostUpload(source)
        ? $t('frameleaf_location_history_lost_note')
        : $t('frameleaf_location_history_not_history_note')}
    >
      {#snippet action()}
        <Button
          label={$t('frameleaf_location_history_dismiss_file', { values: { name: source.fileName } })}
          onclick={() => void discard(source)}>{$t('dismiss')}</Button
        >
      {/snippet}
    </Item>
  {/each}
{/snippet}

<KitPage>
  <BackLink href={Route.geolocationUtility()} label={$t('library_care_tool_geolocation')} />
  <div class="sr-only" role="status">{announcement}</div>
  <input
    bind:this={input}
    type="file"
    multiple
    hidden
    accept={HISTORY_ACCEPT}
    aria-label={$t('frameleaf_location_history_file_input')}
    onchange={onChosen}
  />
  <Said message={said} onDismiss={() => (said = '')} />

  {#if !loaded}
    <div role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="block" height="10rem" />
    </div>
  {:else if loadFailed}
    <InlineError message={$t('frameleaf_location_history_load_error')} onRetry={() => void load()} />
  {:else if sources.length === 0 && uploads.length === 0}
    <Hero
      label={$t('frameleaf_location_history_region')}
      icon={mdiMapMarkerPath}
      title={$t('frameleaf_location_history_empty_title')}
      body={$t('frameleaf_location_history_empty_body')}
    />
    <Section
      title={$t('frameleaf_location_history_add_title')}
      description={$t('frameleaf_location_history_add_description')}
    >
      <!-- svelte-ignore a11y_no_static_element_interactions -->
      <div
        class="drop"
        class:is-over={dragging}
        ondrop={onDrop}
        ondragover={onDragOver}
        ondragleave={() => (dragging = false)}
      >
        <Icon icon={mdiTrayArrowUp} size="28" aria-hidden />
        <div>
          <strong>{$t('frameleaf_location_history_drop_title')}</strong>
          <p>{$t('frameleaf_location_history_drop_body')}</p>
        </div>
        <Button variant="primary" onclick={() => input?.click()}>{$t('frameleaf_location_history_choose')}</Button>
      </div>
      <ul class="kinds">
        {#each [{ icon: mdiMapMarkerPath, name: 'Google Timeline', how: $t('frameleaf_location_history_source_google') }, { icon: mdiWatch, name: 'GPX', how: $t('frameleaf_location_history_source_gpx') }, { icon: mdiCellphone, name: 'OwnTracks', how: $t('frameleaf_location_history_source_owntracks') }, { icon: mdiFileDocumentOutline, name: 'Dawarich', how: $t('frameleaf_location_history_source_dawarich') }] as kind (kind.name)}
          <li>
            <span class="kind-icon"><Icon icon={kind.icon} size="22" aria-hidden /></span>
            <span><strong>{kind.name}</strong><small>{kind.how}</small></span>
          </li>
        {/each}
      </ul>
    </Section>
  {:else if showImport}
    <Hero
      label={$t('frameleaf_location_history_region')}
      icon={mdiTrayArrowUp}
      tone={adding ? 'good' : 'warn'}
      title={adding
        ? $t('frameleaf_location_history_adding_title', { values: { count: sending.length + reading.length } })
        : $t('frameleaf_location_history_left_title', { values: { added: added.length, left: leftOut } })}
      body={adding
        ? sending.length > 0
          ? $t('frameleaf_location_history_adding_sending')
          : $t('frameleaf_location_history_adding_reading')
        : $t('frameleaf_location_history_left_body', { values: { left: leftOut } })}
    >
      {#snippet actions()}
        {#if !adding && added.length > 0}
          <Button variant="primary" onclick={() => (continued = true)}>{$t('continue')}</Button>
        {:else if !adding}
          {@render addButton()}
        {/if}
      {/snippet}
    </Hero>
    <Section title={adding ? $t('frameleaf_location_history_files_adding') : $t('frameleaf_location_history_files')}>
      <ItemList>
        {#each added as source (source.id)}
          <Item
            icon={mdiMapMarkerPath}
            quiet
            name={source.fileName}
            detail={detailOf(source)}
            tone="good"
            status={$t('frameleaf_location_history_status_added')}
            note={source.firstAt && source.lastAt ? range(source.firstAt, source.lastAt) : undefined}
          />
        {/each}
        {#each reading as source (source.id)}
          <Item
            icon={mdiMapMarkerPath}
            quiet
            name={source.fileName}
            detail={detailOf(source)}
            status={$t('frameleaf_location_history_status_reading')}
            note={$t('frameleaf_location_history_note_reading')}
          >
            {#snippet measure()}
              <progress
                aria-label={$t('frameleaf_location_history_progress_file', { values: { name: source.fileName } })}
              ></progress>
            {/snippet}
            {#snippet action()}
              <Button
                label={$t('frameleaf_location_history_cancel_file', { values: { name: source.fileName } })}
                onclick={() => void discard(source)}>{$t('cancel')}</Button
              >
            {/snippet}
          </Item>
        {/each}
        {#each sending as upload (upload.key)}
          {@const percent = Math.round((upload.sent / upload.file.size) * 100)}
          <Item
            icon={mdiMapMarkerPath}
            quiet
            name={upload.file.name}
            detail={formatBytes(upload.file.size, $locale)}
            status={upload.status === 'sending'
              ? $t('frameleaf_location_history_status_sending', { values: { percent } })
              : $t('frameleaf_location_history_status_waiting')}
            note={upload.status === 'waiting' ? $t('frameleaf_location_history_note_waiting') : undefined}
          >
            {#snippet measure()}
              <progress
                aria-label={$t('frameleaf_location_history_progress_file', { values: { name: upload.file.name } })}
                max={100}
                value={percent}
              ></progress>
            {/snippet}
            {#snippet action()}
              <Button
                label={$t('frameleaf_location_history_cancel_file', { values: { name: upload.file.name } })}
                onclick={() => cancelUpload(upload)}>{$t('cancel')}</Button
              >
            {/snippet}
          </Item>
        {/each}
        {@render leftOutRows()}
      </ItemList>
    </Section>
  {:else}
    {#if finished}
      <Notice
        tone={partial ? 'warn' : 'info'}
        icon={partial ? undefined : mdiCheckCircleOutline}
        title={partial
          ? $t('frameleaf_location_history_partial_title', { values: { count: appliedCount, total: asked } })
          : $t('frameleaf_location_history_applied_title', { values: { count: appliedCount } })}
      >
        {partial
          ? $t('frameleaf_location_history_partial_body', { values: { left: notChanged } })
          : $t('frameleaf_location_history_applied_body')}
        {#snippet action()}
          <span class="buttons">
            {#if partial}
              <Button onclick={() => void showMissed()}
                >{$t('frameleaf_location_history_see_missed', { values: { count: notChanged } })}</Button
              >
            {/if}
            {#if status === 'applied'}
              <Button onclick={() => void undo()}
                ><Icon icon={mdiUndo} size="1.125rem" aria-hidden />{$t('undo')}</Button
              >
            {/if}
          </span>
        {/snippet}
      </Notice>
      {#if missed}
        <Section title={$t('frameleaf_location_history_missed_title')}>
          <div class="days">
            {#each missed as day (day.day)}
              <LocationHistoryDay {day} {names} selected={selectedFn} readonly />
            {/each}
          </div>
        </Section>
      {/if}
    {/if}

    {#if status === 'failed'}
      <Notice tone="warn" title={$t('frameleaf_location_history_failed_title')}>
        {$t('frameleaf_location_history_failed_body')}
        {#snippet action()}
          <Button onclick={() => void start(gap)}>{$t('retry')}</Button>
        {/snippet}
      </Notice>
    {/if}

    {#if working}
      <Hero
        label={$t('frameleaf_location_history_region')}
        icon={mdiMapMarkerPath}
        title={status === 'proposing'
          ? $t('frameleaf_location_history_looking_title')
          : status === 'applying'
            ? $t('frameleaf_location_history_applying_title')
            : $t('frameleaf_location_history_undoing_title')}
        body={status === 'proposing'
          ? $t('frameleaf_location_history_looking_body')
          : status === 'applying'
            ? $t('frameleaf_location_history_applying_body')
            : $t('frameleaf_location_history_undoing_body')}
      >
        <div class="working">
          <progress aria-label={$t('frameleaf_location_history_region')}></progress>
          {#if status === 'proposing'}
            <small
              >{$t('frameleaf_location_history_looking_count', { values: { count: run?.candidateCount ?? 0 } })}</small
            >
          {/if}
        </div>
      </Hero>
    {:else if nothingToFill}
      <Hero
        label={$t('frameleaf_location_history_region')}
        icon={mdiCheckCircleOutline}
        title={$t('frameleaf_location_history_nothing_title')}
        body={span
          ? $t('frameleaf_location_history_nothing_body', { values: { from: date(span.first), to: date(span.last) } })
          : undefined}
      />
    {:else if showProposals || noMatches}
      {@render gapSection()}
      {#if noMatches}
        <Section title={$t('frameleaf_location_history_suggested')}>
          <Notice
            tone="warn"
            icon={mdiMapMarkerOffOutline}
            title={$t('frameleaf_location_history_no_match_title', { values: { minutes: gap } })}
          >
            {$t('frameleaf_location_history_no_match_body', {
              values: { count: run?.candidateCount ?? 0, minutes: gap },
            })}
            {#snippet action()}
              {#if widerGaps.length > 0}
                <span class="buttons">
                  {#each widerGaps as value (value)}
                    <Button disabled={submitting} onclick={() => void start(value)}
                      >{$t('frameleaf_location_history_try', { values: { minutes: value } })}</Button
                    >
                  {/each}
                </span>
              {/if}
            {/snippet}
          </Notice>
        </Section>
      {:else}
        <Section
          title={$t('frameleaf_location_history_proposals_title', {
            values: { count: total, total: run?.candidateCount ?? total },
          })}
          description={$t('frameleaf_location_history_proposals_body', {
            values: { left: Math.max((run?.candidateCount ?? total) - total, 0), minutes: gap },
          })}
        >
          <div class="apply">
            <strong>{$t('frameleaf_location_history_selected', { values: { count: picked } })}</strong>
            <span class="buttons">
              <Button disabled={picked === total} onclick={() => (selection = everySelected())}
                >{$t('select_all')}</Button
              >
              <Button disabled={picked === 0} onclick={() => (selection = noneSelected())}
                >{$t('frameleaf_location_history_deselect_all')}</Button
              >
              <Button variant="primary" disabled={picked === 0 || submitting} onclick={() => void apply()}
                >{$t('frameleaf_location_history_add_places', { values: { count: picked } })}</Button
              >
            </span>
          </div>
          <div class="days">
            {#each days as day (day.day)}
              <LocationHistoryDay {day} {names} selected={selectedFn} onToggle={toggle} />
            {/each}
          </div>
          {#if hasNextPage}
            <div class="rest">
              <p>{$t('frameleaf_location_history_more_photos', { values: { count: total - loadedCount } })}</p>
              <Button disabled={loadingMore} onclick={() => run && void loadPage(run.id)}
                >{$t('frameleaf_location_history_show_more')}</Button
              >
            </div>
          {/if}
        </Section>
      {/if}
    {:else}
      <Hero
        label={$t('frameleaf_location_history_region')}
        icon={mdiMapMarkerPath}
        title={finished
          ? $t('frameleaf_location_history_still_title', { values: { count: withoutPlace ?? 0 } })
          : $t('frameleaf_utilities_state_no_place', { values: { count: withoutPlace ?? 0 } })}
        body={finished ? $t('frameleaf_location_history_still_body') : $t('frameleaf_location_history_ready_body')}
      >
        {#snippet actions()}
          <Button variant="primary" disabled={submitting} onclick={() => void start(gap)}
            >{finished ? $t('frameleaf_location_history_look_again') : $t('frameleaf_location_history_see')}</Button
          >
        {/snippet}
        {#if span}
          <Facts
            columns={3}
            rows={[
              { label: $t('frameleaf_location_history_fact_covers'), value: range(span.first, span.last) },
              {
                label: $t('frameleaf_location_history_fact_no_place'),
                value: String(withoutPlace ?? '–'),
                detail: $t('frameleaf_location_history_fact_no_place_detail'),
              },
            ]}
          />
        {/if}
      </Hero>
    {/if}

    <Section
      title={$t('frameleaf_location_history_files_title')}
      description={span
        ? `${$t('frameleaf_location_history_files_summary', {
            values: { count: added.length, from: date(span.first), to: date(span.last) },
          })}.`
        : undefined}
      action={addButton}
    >
      <ItemList>
        {#each added as source (source.id)}
          <Item
            icon={mdiMapMarkerPath}
            quiet
            name={source.fileName}
            detail={detailOf(source)}
            tone="good"
            status={source.firstAt && source.lastAt ? range(source.firstAt, source.lastAt) : undefined}
          >
            {#snippet action()}
              <Button
                label={$t('frameleaf_location_history_remove_file', { values: { name: source.fileName } })}
                onclick={() => askRemove(source)}>{$t('remove')}</Button
              >
            {/snippet}
          </Item>
        {/each}
        {@render leftOutRows()}
      </ItemList>
    </Section>
  {/if}

  <Notice icon={mdiLockOutline} title={$t('frameleaf_location_history_private_title')}>
    {$t('frameleaf_location_history_private_body')}
  </Notice>
</KitPage>

{#if removing}
  {@const source = removing}
  <Dialog
    title={$t('frameleaf_location_history_remove_title', { values: { name: source.fileName } })}
    closeLabel={$t('cancel')}
    bind:open={removeOpen}
    onClosed={() => (removing = null)}
  >
    <p>
      {$t('frameleaf_location_history_remove_body', {
        values: {
          from: source.firstAt ? date(source.firstAt) : '–',
          to: source.lastAt ? date(source.lastAt) : '–',
        },
      })}
    </p>
    {#snippet actions()}
      <Button onclick={() => (removeOpen = false)}>{$t('cancel')}</Button>
      <Button variant="primary" onclick={() => void confirmRemove()}
        >{$t('frameleaf_location_history_remove_confirm')}</Button
      >
    {/snippet}
  </Dialog>
{/if}

<style>
  .drop {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-4);
    align-items: center;
    padding: var(--fl-space-6);
    border: 1px dashed var(--fl-border);
    border-radius: 0.75rem;
    color: var(--fl-accent);
  }
  .drop.is-over {
    border-color: var(--fl-accent);
  }
  .drop > div {
    flex: 1 1 16rem;
    color: var(--fl-text);
  }
  .drop p {
    margin: var(--fl-space-1) 0 0;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  .kinds {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(min(100%, 20rem), 1fr));
    gap: var(--fl-space-4) var(--fl-space-6);
    margin: var(--fl-space-6) 0 0;
    padding: 0;
    list-style: none;
  }
  .kinds li {
    display: flex;
    gap: var(--fl-space-3);
    align-items: center;
  }
  .kinds li > span:last-child {
    display: grid;
    gap: 0.125rem;
  }
  .kinds small,
  .working small {
    color: var(--fl-muted);
    font-size: 0.75rem;
  }
  .kind-icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 2.75rem;
    height: 2.75rem;
    border-radius: 0.625rem;
    background: var(--fl-canvas);
    color: var(--fl-muted);
  }
  progress {
    width: 100%;
    height: 0.25rem;
    accent-color: var(--fl-accent);
  }
  .working {
    display: grid;
    gap: var(--fl-space-2);
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .apply {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
    align-items: center;
    justify-content: space-between;
    margin-bottom: var(--fl-space-4);
  }
  .days {
    display: grid;
    gap: var(--fl-space-4);
  }
  .rest {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
    align-items: center;
    justify-content: space-between;
    margin-top: var(--fl-space-4);
  }
  .rest p {
    margin: 0;
    color: var(--fl-muted);
    font-size: 0.8125rem;
  }
  @media (max-width: 43.75rem) {
    .apply .buttons,
    .apply .buttons :global(button) {
      width: 100%;
    }
    .drop :global(button) {
      width: 100%;
    }
  }
</style>
