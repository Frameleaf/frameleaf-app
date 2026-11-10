<script lang="ts">
  /**
   * Server & updates › Advanced › Server logs (FL-893, after the approved prototype
   * `settings-v2/server/operator.jsx` Logs, FL-798). Reads the server's own recent logs (FL-870):
   * a page of the newest lines, then the live tail added at the bottom. Search and the source go to
   * the server; "Show" keeps a level and anything more serious, here, because the API filters one
   * exact level. A line opens its details (request, job, photo). Lines are drawn in a window, so ten
   * thousand of them scroll like ten.
   *
   * When the live tail drops (the server restarted, or the network went away), the viewer says so,
   * reads the lines written meanwhile and follows again. Away from home the server asks for a recent
   * Frameleaf sign-in first; the page says why and offers to sign in again.
   */
  import { page } from '$app/state';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import Advanced from '$lib/components/frameleaf/settings/kit/Advanced.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Pill from '$lib/components/frameleaf/settings/kit/Pill.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Select from '$lib/components/frameleaf/settings/kit/Select.svelte';
  import TextLink from '$lib/components/frameleaf/settings/kit/TextLink.svelte';
  import {
    DOWNLOAD_SPANS,
    LOG_SHOW,
    LOG_SOURCES,
    MAX_LINES,
    downloadName,
    levelWord,
    mergeLines,
    retryDelay,
    shows,
    sourceWord,
    streamPath,
    type LogShow,
    type ServerLogLine,
  } from '$lib/frameleaf/server-logs';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { copyToClipboard, downloadUrl } from '$lib/utils';
  import { getAssetInfo, getBaseUrl, isHttpError, listServerLogs, type Worker } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCloudAlertOutline,
    mdiContentCopy,
    mdiDownloadOutline,
    mdiLockOutline,
    mdiMagnify,
    mdiPause,
    mdiPlay,
    mdiRefresh,
    mdiShieldCheckOutline,
    mdiTextSearch,
  } from '@mdi/js';
  import { DateTime } from 'luxon';
  import { onDestroy, tick } from 'svelte';
  import { t } from 'svelte-i18n';

  /** Lines a page asks for. */
  const PAGE = 200;
  /** For a strict "Show" choice, read older pages until this many lines show, at most `FILL_PAGES` pages. */
  const FILL = 50;
  const FILL_PAGES = 5;
  /** A line's height before it has been measured, and the extra drawn above and below the window. */
  const ESTIMATE = 48;
  const OVERSCAN = 600;
  /** How close to the bottom still counts as "at the bottom" for following new lines. */
  const BOTTOM = 32;

  // ------------------------------------------------------------------ filters

  /** A link can open the viewer already searching, e.g. for a photo's id (Library care › Couldn't process). */
  const initial = page.url.searchParams.get('q')?.trim().slice(0, 100) ?? '';
  let typed = $state(initial);
  let q = $state(initial);
  let worker = $state<Worker | ''>('');
  let show = $state<LogShow>('normal');

  let typing: ReturnType<typeof setTimeout> | undefined;
  const search = (value: string) => {
    typed = value;
    clearTimeout(typing);
    typing = setTimeout(() => (q = value.trim().slice(0, 100)), 350);
  };

  const filtering = $derived(!!worker || show !== 'normal' || !!q);
  const clear = () => {
    clearTimeout(typing);
    typed = '';
    q = '';
    worker = '';
    show = 'normal';
  };

  // ------------------------------------------------------------------ lines

  let lines = $state.raw<ServerLogLine[]>([]);
  let waiting = $state.raw<ServerLogLine[]>([]);
  let cursor = $state<string | null>(null);
  let status = $state<'loading' | 'ready' | 'error' | 'away'>('loading');
  let live = $state<'connecting' | 'live' | 'reconnecting' | 'reconnected'>('connecting');
  let paused = $state(false);
  let olderBusy = $state(false);

  const shown = $derived(lines.filter((line) => shows(line, show)));
  const waitingCount = $derived(waiting.filter((line) => shows(line, show)).length);

  /** Each load, filter change or teardown starts a new generation; answers for an older one are dropped. */
  let generation = 0;
  let source: EventSource | undefined;
  let retry: ReturnType<typeof setTimeout> | undefined;
  let attempt = 0;

  const away = (error: unknown) => isHttpError(error) && error.status === 403;

  const stop = () => {
    source?.close();
    source = undefined;
    clearTimeout(retry);
  };

  const receive = (incoming: ServerLogLine[]) => {
    if (paused) {
      waiting = mergeLines(waiting, incoming);
      return;
    }
    const follow = atBottom;
    lines = mergeLines(lines, incoming);
    if (follow) {
      void toBottom();
    }
  };

  const connect = (gen: number) => {
    const stream = new EventSource(getBaseUrl() + streamPath({ worker: worker || undefined, q: q || undefined }), {
      withCredentials: true,
    });
    source = stream;
    stream.addEventListener('open', () => {
      if (gen !== generation) {
        return;
      }
      live = live === 'reconnecting' ? 'reconnected' : 'live';
      attempt = 0;
    });
    stream.addEventListener('message', (event: MessageEvent<string>) => {
      if (gen !== generation) {
        return;
      }
      try {
        receive([JSON.parse(event.data) as ServerLogLine]);
      } catch {
        // A line the viewer can't read is skipped; the download still has it.
      }
    });
    stream.addEventListener('error', () => {
      if (gen !== generation) {
        return;
      }
      // The browser would retry on its own, but lines written while away would be missed: read them first.
      stream.close();
      live = 'reconnecting';
      retry = setTimeout(() => void reconnect(gen), retryDelay(attempt++));
    });
  };

  const reconnect = async (gen: number) => {
    try {
      const since = (paused ? (waiting.at(-1) ?? lines.at(-1)) : lines.at(-1))?.at;
      const missed = await listServerLogs({ worker: worker || undefined, q: q || undefined, since, limit: PAGE });
      if (gen !== generation) {
        return;
      }
      receive(missed.entries);
    } catch (error) {
      if (gen !== generation) {
        return;
      }
      if (away(error)) {
        stop();
        status = 'away';
        return;
      }
      retry = setTimeout(() => void reconnect(gen), retryDelay(attempt++));
      return;
    }
    connect(gen);
  };

  const fetchOlder = async (gen: number) => {
    const older = await listServerLogs({
      worker: worker || undefined,
      q: q || undefined,
      before: cursor ?? undefined,
      limit: PAGE,
    });
    if (gen !== generation) {
      return false;
    }
    lines = mergeLines(older.entries, lines, Math.max(MAX_LINES, lines.length + older.entries.length));
    cursor = older.nextCursor;
    return true;
  };

  const load = async () => {
    const gen = ++generation;
    stop();
    status = 'loading';
    live = 'connecting';
    lines = [];
    waiting = [];
    cursor = null;
    attempt = 0;
    try {
      const first = await listServerLogs({ worker: worker || undefined, q: q || undefined, limit: PAGE });
      if (gen !== generation) {
        return;
      }
      lines = mergeLines([], first.entries);
      cursor = first.nextCursor;
      for (let pages = 1; cursor && pages < FILL_PAGES && shown.length < FILL; pages++) {
        if (!(await fetchOlder(gen))) {
          return;
        }
      }
      status = 'ready';
      atBottom = true;
      void toBottom();
      connect(gen);
    } catch (error) {
      if (gen === generation) {
        status = away(error) ? 'away' : 'error';
      }
    }
  };

  // Source and search go to the server: a change reads the logs again. "Show" is applied here.
  $effect(() => {
    void [worker, q];
    void load();
  });

  onDestroy(() => {
    generation++;
    clearTimeout(typing);
    stop();
  });

  const older = async () => {
    olderBusy = true;
    const before = total;
    try {
      if (await fetchOlder(generation)) {
        await tick();
        if (viewport) {
          viewport.scrollTop += total - before;
        }
      }
    } catch (error) {
      status = away(error) ? 'away' : 'error';
    } finally {
      olderBusy = false;
    }
  };

  const pause = () => {
    paused = true;
  };
  const resume = () => {
    paused = false;
    lines = mergeLines(lines, waiting);
    waiting = [];
    atBottom = true;
    void toBottom();
  };

  // ------------------------------------------------------------------ the window

  let viewport = $state<HTMLDivElement>();
  let viewportHeight = $state(0);
  let scrollTop = $state(0);
  let atBottom = true;
  /** Measured heights by line id; `measured` changes when one does, so the offsets are worked out again. */
  const heights = new Map<string, number>();
  let measured = $state(0);

  const offsets = $derived.by(() => {
    void measured;
    const tops = new Float64Array(shown.length + 1);
    for (let index = 0; index < shown.length; index++) {
      tops[index + 1] = tops[index] + (heights.get(shown[index].id) ?? ESTIMATE);
    }
    return tops;
  });
  const total = $derived(offsets[shown.length] ?? 0);

  /** The first line whose bottom is below `y`. */
  const lineAt = (y: number) => {
    let low = 0;
    let high = shown.length;
    while (low < high) {
      const middle = (low + high) >> 1;
      if (offsets[middle + 1] <= y) {
        low = middle + 1;
      } else {
        high = middle;
      }
    }
    return low;
  };
  const drawn = $derived.by(() => {
    const start = lineAt(Math.max(0, scrollTop - OVERSCAN));
    const end = Math.min(shown.length, lineAt(scrollTop + (viewportHeight || 800) + OVERSCAN) + 1);
    return shown.slice(start, end).map((line, index) => ({ line, top: offsets[start + index] }));
  });

  const onScroll = () => {
    if (!viewport) {
      return;
    }
    scrollTop = viewport.scrollTop;
    atBottom = viewport.scrollHeight - viewport.scrollTop - viewport.clientHeight <= BOTTOM;
  };

  const toBottom = async () => {
    await tick();
    if (viewport) {
      viewport.scrollTop = viewport.scrollHeight;
      scrollTop = viewport.scrollTop;
    }
  };

  const measure = (node: HTMLElement, id: string) => {
    let current = id;
    const note = () => {
      const height = node.offsetHeight;
      if (height > 0 && heights.get(current) !== height) {
        heights.set(current, height);
        measured++;
      }
    };
    const observer = new ResizeObserver(note);
    observer.observe(node);
    note();
    return {
      update(next: string) {
        current = next;
        note();
      },
      destroy: () => observer.disconnect(),
    };
  };

  // ------------------------------------------------------------------ words

  const time = (at: string) => {
    const when = DateTime.fromISO(at).setLocale($locale ?? 'en');
    return when.hasSame(DateTime.now(), 'day')
      ? when.toLocaleString(DateTime.TIME_WITH_SECONDS)
      : when.toLocaleString({ month: 'short', day: 'numeric', hour: 'numeric', minute: '2-digit', second: '2-digit' });
  };

  // ------------------------------------------------------------------ a line's details

  let opened = $state<ServerLogLine>();
  let detailsOpen = $state(false);
  let assetVisible = $state(false);

  const open = async (line: ServerLogLine) => {
    opened = line;
    assetVisible = false;
    detailsOpen = true;
    if (line.assetId) {
      try {
        await getAssetInfo({ id: line.assetId });
        assetVisible = opened?.id === line.id;
      } catch {
        // Gone, or not this account's to see: the id is still shown, without a link.
      }
    }
  };

  const details = $derived(
    opened
      ? [
          {
            label: $t('frameleaf_logs_field_when'),
            value: DateTime.fromISO(opened.at)
              .setLocale($locale ?? 'en')
              .toLocaleString(DateTime.DATETIME_MED_WITH_SECONDS),
          },
          { label: $t('frameleaf_logs_field_level'), value: $t(levelWord(opened.level).word), detail: opened.level },
          { label: $t('frameleaf_logs_field_from'), value: $t(sourceWord(opened.worker)), detail: opened.context },
          ...(opened.requestId
            ? [{ label: $t('frameleaf_logs_field_request'), value: opened.requestId, detail: opened.route }]
            : []),
          ...(opened.jobName || opened.jobId
            ? [
                {
                  label: $t('frameleaf_logs_field_job'),
                  value: opened.jobName ?? opened.jobId ?? '',
                  detail: opened.jobName ? opened.jobId : undefined,
                },
              ]
            : []),
          ...(opened.assetId ? [{ label: $t('frameleaf_logs_field_photo'), value: opened.assetId }] : []),
        ]
      : [],
  );

  // ------------------------------------------------------------------ download

  let downloadOpen = $state(false);
  let span = $state(24);
  const download = () => {
    downloadUrl(`${getBaseUrl()}/admin/logs/download?hours=${span}`, downloadName(span));
    downloadOpen = false;
  };

  const signInAgain = () => authManager.logout({ continue: page.url.pathname + page.url.search });
</script>

<KitPage>
  {#if status === 'error'}
    <Hero
      tone="warn"
      icon={mdiCloudAlertOutline}
      title={$t('frameleaf_logs_error_title')}
      body={$t('frameleaf_logs_error_body')}
      label={$t('frameleaf_logs_label')}
    >
      {#snippet actions()}
        <Button variant="primary" onclick={() => void load()}>
          <Icon icon={mdiRefresh} size="18" aria-hidden />
          {$t('frameleaf_logs_try_again')}
        </Button>
      {/snippet}
    </Hero>
  {:else if status === 'away'}
    <Hero
      tone="warn"
      icon={mdiLockOutline}
      title={$t('frameleaf_logs_away_title')}
      body={$t('frameleaf_logs_away_body')}
      label={$t('frameleaf_logs_label')}
    >
      {#snippet actions()}
        <Button variant="primary" onclick={() => void signInAgain()}>{$t('frameleaf_logs_sign_in_again')}</Button>
      {/snippet}
    </Hero>
  {:else}
    <p class="promise">
      <Icon icon={mdiShieldCheckOutline} size="18" aria-hidden />
      {$t('frameleaf_logs_promise')}
    </p>

    <section class="logs" aria-label={$t('frameleaf_logs_label')}>
      <div class="toolbar">
        <label class="search">
          <Icon icon={mdiMagnify} size="20" aria-hidden />
          <input
            type="search"
            aria-label={$t('frameleaf_logs_search')}
            placeholder={$t('frameleaf_logs_search')}
            value={typed}
            oninput={(event) => search(event.currentTarget.value)}
          />
        </label>
        <div class="choice">
          <span aria-hidden="true">{$t('frameleaf_logs_from')}</span>
          <Select
            label={$t('frameleaf_logs_from')}
            value={worker}
            options={[
              { value: '', label: $t('frameleaf_logs_every_part') },
              ...LOG_SOURCES.map(([value, word]) => ({ value, label: $t(word) })),
            ]}
            onChange={(value) => (worker = value as Worker | '')}
          />
        </div>
        <div class="choice">
          <span aria-hidden="true">{$t('frameleaf_logs_show')}</span>
          <Select
            label={$t('frameleaf_logs_show')}
            value={show}
            options={LOG_SHOW.map(([value, word]) => ({ value, label: $t(word) }))}
            onChange={(value) => (show = value as LogShow)}
          />
        </div>
        <div class="actions">
          <Button onclick={paused ? resume : pause}>
            <Icon icon={paused ? mdiPlay : mdiPause} size="18" aria-hidden />
            {paused ? $t('frameleaf_logs_resume') : $t('frameleaf_logs_pause')}
          </Button>
          <Button onclick={() => (downloadOpen = true)}>
            <Icon icon={mdiDownloadOutline} size="18" aria-hidden />
            {$t('frameleaf_logs_download')}
          </Button>
        </div>
      </div>

      <div class="status" role="status">
        {#if status === 'loading'}
          <span>{$t('frameleaf_logs_loading')}</span>
        {:else if paused}
          <Pill tone="warn">{$t('frameleaf_logs_paused')}</Pill>
          <span>
            {$t('frameleaf_logs_waiting', { values: { count: waitingCount } })}
            {#if waitingCount > 0}
              <TextLink onclick={resume}>{$t('frameleaf_logs_show_them')}</TextLink>
            {/if}
          </span>
        {:else if live === 'reconnecting'}
          <Pill tone="warn">{$t('frameleaf_logs_reconnecting')}</Pill>
          <span>{$t('frameleaf_logs_reconnecting_body')}</span>
        {:else if live === 'connecting'}
          <Pill tone="off">{$t('frameleaf_logs_connecting')}</Pill>
          <span>{$t('frameleaf_logs_connecting_body')}</span>
        {:else}
          <Pill tone="good">{$t('frameleaf_logs_live')}</Pill>
          <span>
            {live === 'reconnected' ? $t('frameleaf_logs_reconnected_body') : $t('frameleaf_logs_live_body')}
          </span>
        {/if}
        {#if filtering && status === 'ready'}
          <span class="count">
            {$t('frameleaf_logs_showing', { values: { shown: shown.length, total: lines.length } })}
            <TextLink onclick={clear}>{$t('frameleaf_logs_clear')}</TextLink>
          </span>
        {/if}
      </div>

      {#if status === 'ready' && shown.length === 0}
        <div class="empty">
          <Icon icon={mdiTextSearch} size="28" aria-hidden />
          <strong>
            {q ? $t('frameleaf_logs_empty_search', { values: { q } }) : $t('frameleaf_logs_empty')}
          </strong>
          <p>{$t('frameleaf_logs_empty_body')}</p>
          <div class="empty-actions">
            {#if cursor}
              <Button disabled={olderBusy} onclick={() => void older()}>{$t('frameleaf_logs_older')}</Button>
            {/if}
            {#if filtering}
              <Button onclick={clear}>{$t('frameleaf_logs_clear')}</Button>
            {/if}
          </div>
        </div>
      {:else if status === 'ready'}
        <div class="frame">
          {#if cursor}
            <div class="older">
              <Button variant="quiet" disabled={olderBusy} onclick={() => void older()}>
                {$t('frameleaf_logs_older')}
              </Button>
            </div>
          {/if}
          <div class="viewport" bind:this={viewport} bind:clientHeight={viewportHeight} onscroll={onScroll}>
            <ol class="lines" aria-label={$t('frameleaf_logs_lines')} style:height="{total}px">
              {#each drawn as { line, top } (line.id)}
                {@const level = levelWord(line.level)}
                <li class="is-{level.tone}" style:transform="translateY({top}px)" use:measure={line.id}>
                  <button type="button" onclick={() => void open(line)}>
                    <time datetime={line.at}>{time(line.at)}</time>
                    <Pill tone={level.tone}>{$t(level.word)}</Pill>
                    <span class="where">{$t(sourceWord(line.worker))} · {line.context}</span>
                    <span class="message">{line.message}</span>
                  </button>
                </li>
              {/each}
            </ol>
          </div>
        </div>
      {/if}
    </section>
  {/if}

  <Section title={$t('frameleaf_logs_reading')}>
    <Facts
      columns={4}
      rows={LOG_SOURCES.map(([id, word]) => ({ label: $t(word), value: $t(`${word}_body` as typeof word) }))}
    />
    <Advanced>
      <p class="hint">{$t('frameleaf_logs_advanced')}</p>
    </Advanced>
  </Section>
</KitPage>

<Dialog bind:open={detailsOpen} title={$t('frameleaf_logs_line_title')} closeLabel={$t('close')} size="medium">
  {#if opened}
    <div class="details">
      <p class="full-message">{opened.message}</p>
      <Facts columns={2} rows={details} />
      {#if opened.assetId && assetVisible}
        <TextLink href={Route.viewAsset({ id: opened.assetId })}>{$t('frameleaf_logs_open_photo')}</TextLink>
      {/if}
    </div>
  {/if}
  {#snippet actions()}
    <Button onclick={() => opened && void copyToClipboard(JSON.stringify(opened, null, 2))}>
      <Icon icon={mdiContentCopy} size="18" aria-hidden />
      {$t('frameleaf_logs_copy_line')}
    </Button>
    <Button variant="primary" onclick={() => (detailsOpen = false)}>{$t('close')}</Button>
  {/snippet}
</Dialog>

<Dialog bind:open={downloadOpen} title={$t('frameleaf_logs_download_title')} closeLabel={$t('close')}>
  <div class="details">
    <SegmentedControl
      label={$t('frameleaf_logs_download_span')}
      options={DOWNLOAD_SPANS.map(([hours, word]) => ({ value: String(hours), label: $t(word) }))}
      value={String(span)}
      onChange={(value) => (span = Number(value))}
    />
    <p>{$t('frameleaf_logs_download_body')}</p>
  </div>
  {#snippet actions()}
    <Button onclick={() => (downloadOpen = false)}>{$t('cancel')}</Button>
    <Button variant="primary" onclick={download}>
      <Icon icon={mdiDownloadOutline} size="18" aria-hidden />
      {$t('frameleaf_logs_download_start')}
    </Button>
  {/snippet}
</Dialog>

<style>
  .promise {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-3);
    margin: 0;
    padding: 14px 18px;
    color: var(--fl-muted);
    line-height: 1.5;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .promise :global(svg) {
    flex: none;
    margin-top: 2px;
    color: var(--fl-accent);
  }
  /* A card like the kit's sections (prototype `bk2-section ops-logs`). */
  .logs {
    display: grid;
    gap: var(--fl-space-4);
    min-width: 0;
    padding: var(--fl-space-6);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-3);
  }
  .search {
    display: flex;
    flex: 1 1 240px;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: var(--fl-control-height);
    padding: 0 var(--fl-space-3);
    color: var(--fl-muted);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .search:focus-within {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  .search input {
    flex: 1;
    min-width: 0;
    padding: 0;
    color: var(--fl-text);
    font: inherit;
    background: transparent;
    border: 0;
    outline: none;
  }
  .choice {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .actions {
    display: flex;
    gap: var(--fl-space-2);
    margin-left: auto;
  }
  .status {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2) var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .count {
    margin-left: auto;
  }
  .frame {
    overflow: hidden;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .older {
    display: flex;
    justify-content: center;
    padding: var(--fl-space-2);
    border-bottom: 1px solid var(--fl-border);
  }
  .viewport {
    max-height: min(70vh, 720px);
    min-height: 240px;
    overflow-y: auto;
    overscroll-behavior: contain;
  }
  .lines {
    position: relative;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .lines li {
    position: absolute;
    top: 0;
    left: 0;
    right: 0;
    border-bottom: 1px solid var(--fl-border);
  }
  .lines li.is-bad {
    background: color-mix(in srgb, var(--fl-danger) 12%, transparent);
  }
  .lines li.is-warn {
    background: color-mix(in srgb, var(--fl-warning) 12%, transparent);
  }
  .lines button {
    display: grid;
    grid-template-columns: 88px 104px minmax(0, 220px) minmax(0, 1fr);
    align-items: baseline;
    gap: var(--fl-space-1) var(--fl-space-4);
    width: 100%;
    padding: var(--fl-space-3) var(--fl-space-4);
    color: var(--fl-text);
    font: inherit;
    text-align: left;
    background: transparent;
    border: 0;
    cursor: pointer;
  }
  .lines button:hover {
    background: color-mix(in srgb, var(--fl-text) 5%, transparent);
  }
  .lines button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: -2px;
  }
  time {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
  }
  .where {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
  /* A very long line wraps inside its own column, breaking long file names anywhere. */
  .message,
  .full-message {
    line-height: 1.5;
    overflow-wrap: anywhere;
  }
  .empty {
    display: grid;
    justify-items: center;
    gap: var(--fl-space-2);
    padding: 40px var(--fl-space-6);
    color: var(--fl-muted);
    text-align: center;
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .empty strong {
    color: var(--fl-text);
  }
  .empty p {
    margin: 0 0 var(--fl-space-2);
  }
  .empty-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: center;
    gap: var(--fl-space-2);
  }
  .details {
    display: grid;
    gap: var(--fl-space-4);
  }
  .details p {
    margin: 0;
    line-height: 1.55;
  }
  .hint {
    margin: 0;
    color: var(--fl-muted);
    line-height: 1.55;
  }
  @container kit (max-width: 720px) {
    .actions,
    .count {
      margin-left: 0;
    }
    .logs {
      padding: var(--fl-space-4);
    }
    .choice {
      flex: 1 1 140px;
    }
    .choice :global(.kit-select) {
      flex: 1;
      min-width: 0;
    }
    .lines button {
      grid-template-columns: auto minmax(0, 1fr);
      gap: 6px var(--fl-space-3);
      padding: var(--fl-space-3);
    }
    .where,
    .message {
      grid-column: 1 / -1;
    }
  }
</style>
