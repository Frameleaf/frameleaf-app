<script lang="ts">
  /**
   * Library care › Tidy up › Review suggestions (FL-1470, approved prototype `settings-v2/care/tidy-up.jsx`
   * `TidyReview`, FL-1468). Every suggestion goes to the Archive unless the person sets it to Keep; nothing moves
   * until they press Archive, and Undo puts what was archived back up for review. Keep is for good: the photo is
   * never suggested again by any kind. The large view shows one photo at a time with why it was found, Keep (K)
   * and Archive (A), and ← → to step.
   *
   * Tidied away lists what Tidy up archived, each with Put back.
   */
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Notice from '$lib/components/frameleaf/settings/kit/Notice.svelte';
  import { archiveCount, chunks, kindName, kindWhy, TIDY_KINDS, TIDY_DECIDE_LIMIT } from '$lib/frameleaf/tidy-up';
  import { locale } from '$lib/stores/preferences.store';
  import { getAssetMediaUrl } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetMediaSize,
    decideTidyUp,
    getAssetInfo,
    getTidiedAway,
    getTidyUp,
    getTidyUpSuggestions,
    TidyUpDecision,
    TidyUpKind,
    type AssetResponseDto,
    type TidyUpItemDto,
    type TidyUpStatusDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiArchiveArrowDownOutline,
    mdiCheckCircleOutline,
    mdiChevronLeft,
    mdiChevronRight,
    mdiClose,
    mdiImageOutline,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { tick } from 'svelte';
  import { t } from 'svelte-i18n';

  /** Tiles per kind when every kind is shown; "Show all" opens one kind with the rest. */
  const PER_KIND = 6;
  const PAGE = 100;

  type Group = { kind: string; items: TidyUpItemDto[]; total: number };

  let tab = $state<'waiting' | 'tidied'>(page.url.searchParams.get('tab') === 'tidied' ? 'tidied' : 'waiting');
  let filter = $state<string>('all');
  let status = $state<TidyUpStatusDto>();
  let groups = $state<Group[]>([]);
  let more = $state<number | null>(null);
  let tidied = $state<TidyUpItemDto[]>([]);
  let tidiedTotal = $state(0);
  let loading = $state(true);
  let failed = $state(false);
  let busy = $state(false);
  /** Set to Keep on this page. Everything else waiting goes to the Archive. */
  let kept = $state(new Set<string>());
  /** The last Archive pressed here, for Undo. */
  let archived = $state<{ ids: string[]; kept: number }>();

  const waitingKinds = $derived(
    TIDY_KINDS.map(({ id }) => status?.kinds.find((kind) => kind.kind === id)).filter(
      (kind) => !!kind && kind.enabled && kind.available && kind.waiting > 0,
    ),
  );
  const total = $derived(status?.waiting ?? 0);
  const toArchive = $derived(archiveCount(total, kept));

  const loadWaiting = async () => {
    if (filter === 'all') {
      const seen = new Set<string>();
      groups = (
        await Promise.all(
          waitingKinds.map(async (kind) => {
            const result = await getTidyUpSuggestions({ kind: kind!.kind as TidyUpKind, size: PER_KIND });
            return { kind: kind!.kind, total: kind!.waiting, items: result.items };
          }),
        )
      ).map((group) => {
        const items = group.items.filter(({ assetId }) => !seen.has(assetId));
        for (const { assetId } of items) {
          seen.add(assetId);
        }
        return { ...group, items };
      });
      more = null;
      return;
    }
    const result = await getTidyUpSuggestions({ kind: filter as TidyUpKind, size: PAGE });
    groups = [{ kind: filter, total: result.total, items: result.items }];
    more = result.nextPage;
  };

  const loadTidied = async (pageNumber = 1) => {
    const result = await getTidiedAway({ page: pageNumber, size: PAGE });
    tidied = pageNumber === 1 ? result.items : [...tidied, ...result.items];
    tidiedTotal = result.total;
    more = result.nextPage;
  };

  const load = async () => {
    loading = true;
    try {
      status = await getTidyUp();
      await (tab === 'waiting' ? loadWaiting() : loadTidied());
      failed = false;
    } catch {
      failed = true;
    } finally {
      loading = false;
    }
  };
  void load();

  const showMore = async () => {
    if (!more) {
      return;
    }
    try {
      if (tab === 'tidied') {
        await loadTidied(more);
        return;
      }
      const result = await getTidyUpSuggestions({ kind: filter as TidyUpKind, page: more, size: PAGE });
      groups = [{ ...groups[0], items: [...groups[0].items, ...result.items] }];
      more = result.nextPage;
    } catch (error) {
      handleError(error, $t('frameleaf_tidy_load_failed'));
    }
  };

  const choose = (next: string) => {
    filter = next;
    void load();
  };
  const switchTab = (next: string) => {
    tab = next === 'tidied' ? 'tidied' : 'waiting';
    filter = 'all';
    void load();
  };

  const toggle = (id: string, keep = !kept.has(id)) => {
    const next = new Set(kept);
    if (keep) {
      next.add(id);
    } else {
      next.delete(id);
    }
    kept = next;
  };

  const decide = async (ids: string[], decision: TidyUpDecision) => {
    for (const chunk of chunks(ids)) {
      await decideTidyUp({ tidyUpDecisionDto: { assetIds: chunk, decision } });
    }
  };

  /** Every photo waiting, not only the ones on screen: the footer's count is the whole list. */
  const allWaiting = async () => {
    const ids: string[] = [];
    for (let next: number | null = 1; next;) {
      const result = await getTidyUpSuggestions({ page: next, size: TIDY_DECIDE_LIMIT });
      ids.push(...result.items.map(({ assetId }) => assetId));
      next = result.nextPage;
    }
    return ids;
  };

  const archiveNow = async () => {
    busy = true;
    try {
      const ids = await allWaiting();
      const archive = ids.filter((id) => !kept.has(id));
      const keep = ids.filter((id) => kept.has(id));
      await decide(archive, TidyUpDecision.Archive);
      await decide(keep, TidyUpDecision.Keep);
      archived = { ids: archive, kept: keep.length };
      kept = new Set();
      await load();
    } catch (error) {
      handleError(error, $t('frameleaf_tidy_archive_failed'));
    } finally {
      busy = false;
    }
  };

  const undo = async () => {
    if (!archived) {
      return;
    }
    busy = true;
    try {
      await decide(archived.ids, TidyUpDecision.Undo);
      archived = undefined;
      await load();
    } catch (error) {
      handleError(error, $t('frameleaf_tidy_undo_failed'));
    } finally {
      busy = false;
    }
  };

  const putBack = async (id: string) => {
    try {
      await decide([id], TidyUpDecision.Keep);
      tidied = tidied.filter(({ assetId }) => assetId !== id);
      tidiedTotal = Math.max(0, tidiedTotal - 1);
    } catch (error) {
      handleError(error, $t('frameleaf_tidy_put_back_failed'));
    }
  };

  // The large view, over whatever list is on screen.
  const list = $derived(tab === 'tidied' ? tidied : groups.flatMap((group) => group.items));
  let open = $state(-1);
  let info = $state<AssetResponseDto>();
  let closeButton = $state<HTMLButtonElement>();
  const current = $derived(open >= 0 ? list[open] : undefined);

  $effect(() => {
    const id = current?.assetId;
    info = undefined;
    if (!id) {
      return;
    }
    let live = true;
    void (async () => {
      try {
        const asset = await getAssetInfo({ id });
        if (live) {
          info = asset;
        }
      } catch {
        // the photo still shows; only its name and date are missing
      }
    })();
    return () => {
      live = false;
    };
  });

  const show = async (index: number) => {
    open = index;
    await tick();
    closeButton?.focus();
  };
  const step = (by: number) => {
    const next = open + by;
    if (next >= 0 && next < list.length) {
      open = next;
    }
  };
  const decideOpen = async (keep: boolean) => {
    if (!current) {
      return;
    }
    if (tab === 'tidied') {
      const index = open;
      await putBack(current.assetId);
      open = index < list.length ? index : -1;
      return;
    }
    toggle(current.assetId, keep);
    open = open + 1 < list.length ? open + 1 : -1;
  };
  const onKey = (event: KeyboardEvent) => {
    if (open < 0 || event.metaKey || event.ctrlKey || event.altKey) {
      return;
    }
    const key = event.key.toLowerCase();
    if (event.key === 'Escape') {
      open = -1;
    } else if (event.key === 'ArrowRight') {
      step(1);
    } else if (event.key === 'ArrowLeft') {
      step(-1);
    } else if (tab === 'waiting' && key === 'k') {
      void decideOpen(true);
    } else if (tab === 'waiting' && key === 'a') {
      void decideOpen(false);
    } else {
      return;
    }
    event.preventDefault();
  };

  const day = (value?: string) =>
    value
      ? DateTime.fromISO(value)
          .setLocale($locale ?? 'en')
          .toLocaleString(DateTime.DATE_MED)
      : '';
  const thumb = (id: string) => getAssetMediaUrl({ id, size: AssetMediaSize.Thumbnail });
</script>

<svelte:window onkeydown={onKey} />

<KitPage>
  <div class="tabs">
    <SegmentedControl
      label={$t('frameleaf_tidy_show')}
      value={tab}
      options={[
        {
          value: 'waiting',
          label: total
            ? $t('frameleaf_tidy_tab_waiting_count', { values: { count: total } })
            : $t('frameleaf_tidy_tab_waiting'),
        },
        {
          value: 'tidied',
          label: $t('frameleaf_tidy_tab_tidied_count', { values: { count: status?.tidiedAway ?? 0 } }),
        },
      ]}
      onChange={switchTab}
    />
  </div>

  {#if archived && tab === 'waiting'}
    <Notice
      tone="info"
      icon={mdiArchiveArrowDownOutline}
      title={$t('frameleaf_tidy_archived', { values: { count: archived.ids.length } })}
    >
      {$t('frameleaf_tidy_archived_body')}
      {#if archived.kept > 0}
        {$t('frameleaf_tidy_archived_kept', { values: { count: archived.kept } })}
      {/if}
      {#snippet action()}
        <div class="notice-actions">
          <Button disabled={busy} onclick={() => void undo()}>{$t('frameleaf_tidy_undo')}</Button>
          <Button onclick={() => switchTab('tidied')}>{$t('frameleaf_tidy_see_tidied_away')}</Button>
        </div>
      {/snippet}
    </Notice>
  {/if}

  {#if failed}
    <Hero
      tone="warn"
      icon={mdiCheckCircleOutline}
      title={$t('frameleaf_tidy_load_failed')}
      label={$t('frameleaf_tidy_review_title')}
    >
      {#snippet actions()}
        <Button variant="primary" onclick={() => void load()}>{$t('frameleaf_tidy_try_again')}</Button>
      {/snippet}
    </Hero>
  {:else if tab === 'waiting' && !loading && total === 0}
    <Hero
      tone="good"
      icon={mdiCheckCircleOutline}
      title={$t('frameleaf_tidy_all_reviewed')}
      body={$t('frameleaf_tidy_all_reviewed_body')}
      label={$t('frameleaf_tidy_review_title')}
    />
  {:else if tab === 'waiting'}
    <div class="filters" role="group" aria-label={$t('frameleaf_tidy_kinds')}>
      {#each [{ kind: 'all', count: total }, ...waitingKinds.map( (kind) => ({ kind: kind!.kind, count: kind!.waiting }) )] as chip (chip.kind)}
        <button type="button" class="filter" aria-pressed={filter === chip.kind} onclick={() => choose(chip.kind)}>
          {chip.kind === 'all' ? $t('frameleaf_tidy_all') : $t(kindName(chip.kind))}
          <span>{chip.count}</span>
        </button>
      {/each}
    </div>

    {#each groups as group (group.kind)}
      {#if group.items.length > 0}
        <section class="group" aria-label={$t(kindName(group.kind))}>
          <h2>{$t(kindName(group.kind))} <span>{group.total}</span></h2>
          <ul class="grid">
            {#each group.items as item (item.assetId)}
              {@const isKept = kept.has(item.assetId)}
              <li class="tile" class:kept={isKept}>
                <button
                  type="button"
                  class="open"
                  aria-label={$t('frameleaf_tidy_open_large')}
                  onclick={() => void show(list.indexOf(item))}
                >
                  <img src={thumb(item.assetId)} alt="" loading="lazy" />
                </button>
                <button type="button" class="choice" aria-pressed={!isKept} onclick={() => toggle(item.assetId)}>
                  <Icon icon={isKept ? mdiImageOutline : mdiArchiveArrowDownOutline} size="16" aria-hidden />
                  {isKept ? $t('frameleaf_tidy_keep') : $t('frameleaf_tidy_archive')}
                </button>
              </li>
            {/each}
          </ul>
          {#if filter === 'all' && group.total > group.items.length}
            <p class="more">
              {$t('frameleaf_tidy_showing', { values: { shown: group.items.length, count: group.total } })}
              <button type="button" class="link" onclick={() => choose(group.kind)}>
                {$t('frameleaf_tidy_show_all', { values: { name: $t(kindName(group.kind)) } })}
              </button>
            </p>
          {/if}
        </section>
      {/if}
    {/each}

    {#if more}
      <Button onclick={() => void showMore()}>{$t('frameleaf_tidy_show_more')}</Button>
    {/if}

    <div class="bar" role="region" aria-label={$t('frameleaf_tidy_archive_region')}>
      <p>
        <strong>{$t('frameleaf_tidy_to_archive', { values: { count: toArchive } })}</strong>
        {#if kept.size > 0}
          <span> · {$t('frameleaf_tidy_kept_count', { values: { count: kept.size } })}</span>
        {/if}
      </p>
      <Button variant="primary" disabled={busy || toArchive === 0} onclick={() => void archiveNow()}>
        {$t('frameleaf_tidy_archive_count', { values: { count: toArchive } })}
      </Button>
    </div>
  {:else}
    <p class="lead">{$t('frameleaf_tidy_tidied_lead')}</p>
    <ul class="grid">
      {#each tidied as item (item.assetId)}
        <li class="tile">
          <button
            type="button"
            class="open"
            aria-label={$t('frameleaf_tidy_open_large')}
            onclick={() => void show(list.indexOf(item))}
          >
            <img src={thumb(item.assetId)} alt="" loading="lazy" />
          </button>
          <small
            >{item.automatic ? $t('frameleaf_tidy_archived_automatically') : $t('frameleaf_tidy_you_archived')}</small
          >
          <Button onclick={() => void putBack(item.assetId)}>{$t('frameleaf_tidy_put_back')}</Button>
        </li>
      {/each}
    </ul>
    {#if more}
      <Button onclick={() => void showMore()}>{$t('frameleaf_tidy_show_more')}</Button>
    {/if}
  {/if}
</KitPage>

{#if current}
  {@const why = current.kinds.map((kind) => $t(kindWhy(kind)))}
  <div class="viewer" role="dialog" aria-modal="true" aria-label={$t('frameleaf_tidy_large_view')}>
    <header>
      <div>
        <strong>{$t(kindName(current.kinds[0] ?? 'memes'))}</strong>
        <span>{$t('frameleaf_tidy_position', { values: { index: open + 1, count: list.length } })}</span>
      </div>
      <button
        bind:this={closeButton}
        type="button"
        class="round"
        aria-label={$t('frameleaf_tidy_close')}
        onclick={() => (open = -1)}
      >
        <Icon icon={mdiClose} size="22" aria-hidden />
      </button>
    </header>
    <div class="stage">
      <button
        type="button"
        class="round step"
        aria-label={$t('frameleaf_tidy_previous')}
        disabled={open === 0}
        onclick={() => step(-1)}
      >
        <Icon icon={mdiChevronLeft} size="28" aria-hidden />
      </button>
      <img
        src={getAssetMediaUrl({ id: current.assetId, size: AssetMediaSize.Preview })}
        alt={info?.originalFileName ?? ''}
      />
      <button
        type="button"
        class="round step"
        aria-label={$t('frameleaf_tidy_next')}
        disabled={open === list.length - 1}
        onclick={() => step(1)}
      >
        <Icon icon={mdiChevronRight} size="28" aria-hidden />
      </button>
    </div>
    <footer>
      <div class="why">
        <p>{[info?.originalFileName, day(info?.localDateTime)].filter(Boolean).join(' · ')}</p>
        <ul aria-label={$t('frameleaf_tidy_why')}>
          {#each why as reason (reason)}
            <li>{reason}</li>
          {/each}
        </ul>
      </div>
      <div class="actions">
        {#if tab === 'tidied'}
          <Button variant="primary" onclick={() => void decideOpen(true)}
            >{$t('frameleaf_tidy_put_back_timeline')}</Button
          >
        {:else}
          <Button onclick={() => void decideOpen(true)}>
            {kept.has(current.assetId) ? $t('frameleaf_tidy_kept_timeline') : $t('frameleaf_tidy_keep_timeline')}
            <kbd>K</kbd>
          </Button>
          <Button variant="primary" onclick={() => void decideOpen(false)}>
            {kept.has(current.assetId) ? $t('frameleaf_tidy_archive_instead') : $t('frameleaf_tidy_archive')}
            <kbd>A</kbd>
          </Button>
        {/if}
      </div>
    </footer>
  </div>
{/if}

<style>
  .filters {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .filter {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: 36px;
    padding: 0 14px;
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-small);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-pill);
    cursor: pointer;
  }
  .filter span {
    color: var(--fl-muted);
  }
  .filter[aria-pressed='true'] {
    background: var(--fl-accent-soft);
    border-color: var(--fl-accent);
  }
  .group h2 {
    display: flex;
    align-items: baseline;
    gap: var(--fl-space-2);
    margin: 0 0 var(--fl-space-3);
    font-size: var(--fl-font-lg);
  }
  .group h2 span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: var(--fl-weight-medium);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(150px, 1fr));
    gap: var(--fl-space-4);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .tile {
    display: grid;
    gap: var(--fl-space-2);
  }
  .tile small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .open {
    display: block;
    aspect-ratio: 1;
    padding: 0;
    overflow: hidden;
    background: var(--fl-raised);
    border: 0;
    border-radius: var(--fl-radius-lg);
    cursor: zoom-in;
  }
  .open img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .open:focus-visible {
    outline: 3px solid var(--fl-accent);
    outline-offset: 2px;
  }
  .kept .open {
    opacity: 0.45;
  }
  .choice {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    gap: 6px;
    min-height: 36px;
    color: var(--fl-text);
    font: inherit;
    font-size: var(--fl-font-small);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    cursor: pointer;
  }
  .choice[aria-pressed='true'] {
    background: var(--fl-accent-soft);
    border-color: var(--fl-accent);
  }
  .more,
  .lead {
    margin: var(--fl-space-3) 0 0;
    color: var(--fl-muted);
  }
  .link {
    padding: 0;
    color: var(--fl-accent);
    font: inherit;
    background: none;
    border: 0;
    cursor: pointer;
  }
  .bar {
    position: sticky;
    bottom: var(--fl-space-4);
    z-index: 2;
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-4) var(--fl-space-5);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    box-shadow: var(--fl-shadow-2);
  }
  .bar p {
    flex: 1 1 200px;
    margin: 0;
  }
  .bar span {
    color: var(--fl-muted);
  }
  .notice-actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
  }
  .viewer {
    position: fixed;
    inset: 0;
    z-index: 60;
    display: grid;
    grid-template-rows: auto 1fr auto;
    color: #fff;
    background: rgb(8 8 9 / 0.96);
  }
  .viewer header,
  .viewer footer {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-4);
    padding: var(--fl-space-4) var(--fl-space-6);
  }
  .viewer header div {
    display: flex;
    align-items: baseline;
    gap: var(--fl-space-3);
  }
  .viewer header span,
  .why p {
    color: rgb(255 255 255 / 0.72);
  }
  .stage {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: var(--fl-space-4);
    min-height: 0;
    padding: 0 var(--fl-space-6);
  }
  .stage img {
    justify-self: center;
    max-width: 100%;
    max-height: 72vh;
    object-fit: contain;
    border-radius: var(--fl-radius-lg);
  }
  .round {
    display: grid;
    place-items: center;
    width: 44px;
    height: 44px;
    color: #fff;
    background: rgb(255 255 255 / 0.12);
    border: 0;
    border-radius: 50%;
    cursor: pointer;
  }
  .round:disabled {
    cursor: default;
    opacity: 0.3;
  }
  .why p {
    margin: 0 0 var(--fl-space-2);
  }
  .why ul {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .why li {
    padding: 4px 12px;
    font-size: var(--fl-font-small);
    background: rgb(255 255 255 / 0.14);
    border-radius: var(--fl-radius-pill);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
  }
  kbd {
    margin-inline-start: 6px;
    padding: 0 6px;
    font: inherit;
    font-size: var(--fl-font-xs);
    border: 1px solid currentColor;
    border-radius: 4px;
    opacity: 0.7;
  }
  @container kit (max-width: 640px) {
    .filters {
      flex-wrap: nowrap;
      overflow-x: auto;
      scrollbar-width: none;
    }
    .filter {
      flex: none;
    }
    .grid {
      grid-template-columns: repeat(3, minmax(0, 1fr));
      gap: var(--fl-space-2);
    }
  }
  @media (max-width: 640px) {
    .viewer header,
    .viewer footer {
      padding: var(--fl-space-3) var(--fl-space-4);
    }
    .stage {
      grid-template-columns: 1fr;
      padding: 0 var(--fl-space-4);
    }
    .step,
    kbd {
      display: none;
    }
    .actions,
    .actions :global(button) {
      flex: 1 1 auto;
    }
  }
</style>
