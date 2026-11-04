<script lang="ts">
  /**
   * Command center → Library analytics (FL-79), ported from the design template's
   * `SettingsAnalytics.jsx` and the Sept 24 dashboard (`AnalyticsDashboard.jsx`,
   * `library-insights.mjs`). The template drew a fictional journal; this page reads `GET /analytics`
   * for the chosen scope and date range and shows only what the server measured: the hero, growth,
   * then the dashboard panels (`LibraryInsights`), arrivals, processing, metadata, views and albums.
   *
   * What differs from the template, on purpose:
   * - No "Sample data" badge: the notice says when the library was read and whether growth history
   *   is current, out of date (stale) or not collected yet (unknown).
   * - The storage donut splits the whole volume only from what the server measured, and only in
   *   the administrator's whole-server report (`host.breakdown`: originals, previews and
   *   thumbnails, encoded video, the database, and other files as the rest of the space used). For
   *   an account or library it shows the volume as used and free; nothing is estimated from the
   *   selection. Every donut segment is a share of the capacity, like its centre figure.
   * - Processing is recorded for the whole server; for an account or library it is left out, not
   *   drawn as zero. Its cost is an estimate from configured rates, never a bill, and absent when no
   *   rate is configured. There are no GPU or invoice charts.
   * - Charts, their tables and the CSV come from the same rows (`analyticsTables`).
   * - Every dashboard breakdown adds up to the report's items less the items this session keeps
   *   hidden (Locked people and tags, sensitive content); a quiet note says how many when any are.
   * - People and places are only for the owner reading their own library; otherwise the panel says
   *   so instead of showing other accounts' names.
   */
  import { goto } from '$app/navigation';
  import { page } from '$app/state';
  import AnalyticsChart from '$lib/components/frameleaf/analytics/AnalyticsChart.svelte';
  import AnalyticsDataTable from '$lib/components/frameleaf/analytics/AnalyticsDataTable.svelte';
  import LibraryHero from '$lib/components/frameleaf/analytics/LibraryHero.svelte';
  import LibraryInsights from '$lib/components/frameleaf/analytics/LibraryInsights.svelte';
  import SettingsOverline from '$lib/components/frameleaf/settings/SettingsOverline.svelte';
  import {
    analyticsCsv,
    analyticsFormats,
    analyticsTables,
    breakdownTotal,
    csvFileName,
    historyNotice,
    inventoryRows,
    oneFullStop,
    type AnalyticsTable,
    type GrowthMetric,
    type Translate,
  } from '$lib/frameleaf/analytics';
  import { commandCenterUrl, type SettingsAreaId } from '$lib/frameleaf/settings-areas';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { downloadBlob } from '$lib/utils';
  import { motionScrollBehavior } from '$lib/frameleaf/motion';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AnalyticsMetadataField,
    AnalyticsRange,
    AnalyticsView,
    AnalyticsScopeKind,
    createJob,
    ManualJobName,
    type AnalyticsReportResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiChevronRight, mdiDownload } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  // The account or library is chosen once, in the command center's "Viewing" picker above this
  // page; a second scope select here wrote the same address (design review finding 65).
  type Props = { report: AnalyticsReportResponseDto };
  let { report }: Props = $props();

  const range = $derived(report.range);
  const scope = $derived(report.scope);
  let metric = $state<GrowthMetric>('items');
  let loading = $state(false);
  let exportStatus = $state('');

  const tr: Translate = (key, values) => $t(key as Translations, { values });
  const tables = $derived(analyticsTables(report, metric, tr));
  const table = (id: string) => tables.find((item) => item.id === id) as AnalyticsTable;

  const f = $derived(analyticsFormats($locale, tr));
  const number = (value: number) => new Intl.NumberFormat($locale, { maximumFractionDigits: 2 }).format(value);
  const day = (value: string) =>
    new Intl.DateTimeFormat($locale, { month: 'short', day: 'numeric', year: 'numeric', timeZone: 'UTC' }).format(
      new Date(`${value.slice(0, 10)}T00:00:00Z`),
    );
  const dateTime = (value: string) =>
    new Intl.DateTimeFormat($locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  const bucketLabel = (key: string) =>
    new Intl.DateTimeFormat(
      $locale,
      key.length === 7
        ? { month: 'short', year: '2-digit', timeZone: 'UTC' }
        : { month: 'short', day: 'numeric', timeZone: 'UTC' },
    ).format(new Date(`${key.length === 7 ? `${key}-01` : key}T00:00:00Z`));

  const selectedLabel = $derived(
    report.scopeKind === AnalyticsScopeKind.Host ? $t('frameleaf_analytics_scope_all') : report.scopeLabel,
  );
  const span = $derived(`${day(report.from)} – ${day(report.through)}`);
  const labels = $derived(report.series.map((row) => bucketLabel(row.key)));
  const notice = $derived(historyNotice(report));
  const added = $derived(report.series.reduce((sum, row) => sum + row.photos + row.videos, 0));
  // A line needs two nightly readings; with one, say so instead of drawing a lone dot among gaps.
  const growthReadings = $derived(table('growth').rows.filter((row) => row[1] !== null));
  // People and places come only with the owner's own scope, which the hero calls "Your library".
  const heroKicker = $derived(
    report.insights?.peopleAndPlaces ? $t('frameleaf_analytics_your_library') : selectedLabel,
  );
  const settingsArea = (area: SettingsAreaId) => commandCenterUrl(area);

  /**
   * The lower cards answer their own question (approved design, 2026-11-04): the old title is the kicker
   * and the title says what the numbers say, as the panels above do.
   */
  const period = $derived(report.range === AnalyticsRange.Year ? 'month' : 'week');
  const perPeriod = (total: number) => (report.series.length > 0 ? Math.round(total / report.series.length) : 0);
  const arrivalsPerPeriod = $derived(
    perPeriod(table('arrivals').rows.reduce((sum, row) => sum + (row[1] as number) + (row[2] as number), 0)),
  );
  const knownPercent = (field: AnalyticsMetadataField) => {
    const row = report.metadata.find((entry) => entry.field === field);
    return row?.total ? Math.round((row.present / row.total) * 100) : 0;
  };
  const timelineCount = $derived(report.views.find((row) => row.view === AnalyticsView.Timeline)?.total ?? 0);

  /**
   * Sticky section links for a long page; the one in view is marked (approved design, 2026-11-04). A
   * section that is not on the page (people and places come with your own library only) is left out.
   */
  const JUMPS: [string[], Translations][] = [
    [['an-overview'], 'frameleaf_analytics_jump_overview'],
    [['an-growth'], 'frameleaf_analytics_jump_growth'],
    [['an-years'], 'frameleaf_analytics_jump_habits'],
    [['an-storage'], 'frameleaf_analytics_jump_storage'],
    [['an-gear'], 'frameleaf_analytics_jump_gear'],
    [['an-people', 'an-places', 'an-people-places'], 'frameleaf_analytics_jump_people'],
    [['an-coverage'], 'frameleaf_analytics_jump_coverage'],
    [['an-records'], 'frameleaf_analytics_jump_records'],
    [['an-activity'], 'frameleaf_analytics_jump_activity'],
    [['an-albums'], 'frameleaf_analytics_jump_albums'],
    [['an-technical'], 'frameleaf_analytics_jump_technical'],
  ];
  let jumpBar = $state<HTMLElement>();
  let jumps = $state<{ id: string; label: Translations }[]>([]);
  let currentJump = $state('an-overview');
  const section = (id: string) => document.querySelector<HTMLElement>(`#${CSS.escape(id)}`);
  const updateJumps = () => {
    jumps = JUMPS.flatMap(([ids, label]) => {
      const id = ids.find((candidate) => section(candidate));
      return id ? [{ id, label }] : [];
    });
    // The section in view is the last one whose top has passed just below the bar.
    const line = (jumpBar?.getBoundingClientRect().bottom ?? 0) + 48;
    let here = jumps[0]?.id ?? 'an-overview';
    for (const { id } of jumps) {
      if ((section(id)?.getBoundingClientRect().top ?? Infinity) <= line) {
        here = id;
      }
    }
    currentJump = here;
  };
  $effect(() => {
    void report;
    let frame = requestAnimationFrame(updateJumps);
    const onScroll = () => {
      cancelAnimationFrame(frame);
      frame = requestAnimationFrame(updateJumps);
    };
    // The page scrolls inside the settings area, so listen for any scroll.
    document.addEventListener('scroll', onScroll, { capture: true, passive: true });
    return () => {
      cancelAnimationFrame(frame);
      document.removeEventListener('scroll', onScroll, { capture: true });
    };
  });
  // Keep the current link in view inside the bar only: scrollIntoView would also move the page.
  $effect(() => {
    const link = jumpBar?.querySelector<HTMLElement>(`[href="#${CSS.escape(currentJump)}"]`);
    if (
      jumpBar &&
      link &&
      (link.offsetLeft < jumpBar.scrollLeft ||
        link.offsetLeft + link.offsetWidth > jumpBar.scrollLeft + jumpBar.clientWidth)
    ) {
      jumpBar.scrollTo({ left: link.offsetLeft - 12 });
    }
  });
  const jumpTo = (event: MouseEvent, id: string) => {
    event.preventDefault();
    section(id)?.scrollIntoView({ behavior: motionScrollBehavior(), block: 'start' });
    currentJump = id;
  };

  // FL-363: "Count now" on the "No history yet" banner starts tonight's count straight away.
  let counting = $state(false);
  let counted = $state('');
  const countNow = async () => {
    counting = true;
    try {
      await createJob({ jobCreateDto: { name: ManualJobName.AnalyticsCollect } });
      counted = $t('frameleaf_analytics_counting');
    } catch {
      counted = $t('frameleaf_analytics_count_failed');
    } finally {
      counting = false;
    }
  };

  /** The route's load reads the report for the new address; this page never fetches on its own. */
  const load = async (next: { range?: AnalyticsRange }) => {
    loading = true;
    exportStatus = '';
    try {
      const url = new URL(page.url.href);
      url.searchParams.set('scope', scope);
      url.searchParams.set('range', next.range ?? range);
      await goto(`${url.pathname}${url.search}`, { replace: true, reset: false });
    } catch (error) {
      handleError(error, $t('frameleaf_analytics_load_failed'));
    } finally {
      loading = false;
    }
  };

  const exportCsv = () => {
    try {
      downloadBlob(
        new Blob([analyticsCsv(report, metric, tr)], { type: 'text/csv;charset=utf-8' }),
        csvFileName(report, metric),
      );
      exportStatus = $t('frameleaf_analytics_export_started');
    } catch {
      exportStatus = $t('frameleaf_analytics_export_failed');
    }
  };
</script>

{#snippet cardHeading(title: string, caption: string, action?: { href: string; label: string }, kicker?: string)}
  <header class="card-heading">
    <div>
      {#if kicker}<p class="kicker">{kicker}</p>{/if}
      <h2>{title}</h2>
      {#if caption}<p>{caption}</p>{/if}
    </div>
    {#if action}
      <a class="text-button" href={action.href}>{action.label}<Icon icon={mdiChevronRight} size="14" /></a>
    {/if}
  </header>
{/snippet}

<div class="analytics" aria-busy={loading}>
  <header class="page-heading">
    <div>
      <SettingsOverline>{$t('frameleaf_analytics_eyebrow')}</SettingsOverline>
      <h1>{$t('frameleaf_analytics_heading')}</h1>
      <p>{$t('frameleaf_analytics_subheading')}</p>
    </div>
    <button type="button" class="export" onclick={exportCsv}>
      {$t('frameleaf_analytics_export_csv')}<Icon icon={mdiDownload} size="16" />
    </button>
  </header>

  <div class="notice" data-state={notice ?? 'current'}>
    <span class="badge">
      {#if notice === 'unknown'}
        {$t('frameleaf_analytics_state_unknown')}
      {:else if notice === 'stale'}
        {$t('frameleaf_analytics_state_stale')}
      {:else}
        {$t('frameleaf_analytics_state_live')}
      {/if}
    </span>
    <p>
      {oneFullStop($t('frameleaf_analytics_as_of', { values: { date: dateTime(report.generatedAt) } }))}
      {#if notice === 'unknown'}
        {$t('frameleaf_analytics_history_unknown')}
        <!-- FL-363: the count that starts the charts, here instead of under another name in Jobs. -->
        <button type="button" class="text-button count-now" disabled={counting} onclick={countNow}
          >{$t('frameleaf_analytics_count_now')}</button
        >
        {#if counted}<span role="status">{counted}</span>{/if}
      {:else if notice === 'stale' && report.history.lastObservedAt}
        {$t('frameleaf_analytics_history_stale', { values: { date: dateTime(report.history.lastObservedAt) } })}
      {:else if notice === 'gaps'}
        {$t('frameleaf_analytics_history_gaps')}
      {/if}
    </p>
  </div>

  <div class="controls">
    <label>
      {$t('frameleaf_analytics_date_range')}
      <select
        value={range}
        disabled={loading}
        onchange={(event) => load({ range: event.currentTarget.value as AnalyticsRange })}
      >
        <option value={AnalyticsRange.$90Days}>{$t('frameleaf_analytics_range_90days')}</option>
        <option value={AnalyticsRange.Year}>{$t('frameleaf_analytics_range_year')}</option>
      </select>
    </label>
    <label>
      {$t('frameleaf_analytics_growth_metric')}
      <select bind:value={metric} onchange={() => (exportStatus = '')}>
        <option value="items">{$t('frameleaf_analytics_metric_items')}</option>
        <option value="storage">{$t('frameleaf_analytics_metric_storage')}</option>
      </select>
    </label>
    <p>
      {$t('frameleaf_analytics_history_span', { values: { span } })}<br />
      {$t('frameleaf_analytics_inventory_latest')}
    </p>
  </div>
  <p class="export-status" role="status">{exportStatus}</p>

  <nav class="jump" aria-label={$t('frameleaf_analytics_jump_label')} bind:this={jumpBar}>
    {#each jumps as jump (jump.id)}
      <a
        href="#{jump.id}"
        aria-current={currentJump === jump.id ? 'true' : undefined}
        onclick={(event) => jumpTo(event, jump.id)}>{$t(jump.label)}</a
      >
    {/each}
  </nav>

  <div id="an-overview"><LibraryHero {report} kicker={heroKicker} /></div>

  <div class="card growth-card fl-continuous-corners" id="an-growth">
    <figure class="growth">
      <figcaption>
        <div>
          <span>{$t('frameleaf_analytics_growth')}</span>
          <strong>
            {metric === 'storage'
              ? f.size(report.summary.physicalBytes)
              : $t('frameleaf_analytics_items_count', { values: { count: number(report.summary.items) } })}
          </strong>
        </div>
        <small>{selectedLabel} · {span}</small>
      </figcaption>
      {#if notice === 'unknown'}
        <p class="empty" role="status">{$t('frameleaf_analytics_growth_unknown')}</p>
      {:else if growthReadings.length < 2}
        <p class="empty" role="status">{$t('frameleaf_analytics_growth_one_reading')}</p>
      {:else}
        <AnalyticsChart
          kind="line"
          title={$t(
            metric === 'storage'
              ? 'frameleaf_analytics_growth_storage_title'
              : 'frameleaf_analytics_growth_items_title',
          )}
          {labels}
          unit={metric === 'storage' ? 'GB' : $t('frameleaf_analytics_unit_items')}
          height={260}
          datasets={metric === 'storage'
            ? [
                {
                  label: $t('frameleaf_analytics_physical_originals'),
                  values: table('growth').rows.map((row) => row[1] as number | null),
                  fill: true,
                },
                {
                  label: $t('frameleaf_analytics_logical_originals'),
                  values: table('growth').rows.map((row) => row[2] as number | null),
                  tone: 'secondary',
                  dashed: true,
                },
              ]
            : [
                {
                  label: $t('frameleaf_analytics_library'),
                  values: table('growth').rows.map((row) => row[1] as number | null),
                  fill: true,
                },
              ]}
        />
      {/if}
      <p class="note">
        {metric === 'storage'
          ? $t('frameleaf_analytics_growth_storage_note')
          : $t('frameleaf_analytics_growth_items_note', { values: { count: number(added) } })}
      </p>
      <AnalyticsDataTable table={table('growth')} />
    </figure>
  </div>

  <!-- FL-363: backup status lives in Backup; this page no longer keeps a third copy of it. -->
  <p class="backup-note">
    {$t('frameleaf_analytics_backup_elsewhere')}
    <a class="text-button" href={settingsArea('backups')}
      >{$t('frameleaf_analytics_open_backup')}<Icon icon={mdiChevronRight} size="14" /></a
    >
  </p>

  {#if report.insights}
    {#if report.insights.hiddenItems > 0}
      <!-- The breakdowns leave out what this session keeps hidden; say so, quietly. -->
      <p class="hidden-note" role="note">
        {$t('frameleaf_analytics_hidden_note', {
          values: {
            count: report.insights.hiddenItems,
            value: number(report.insights.hiddenItems),
            total: number(breakdownTotal(report)),
          },
        })}
      </p>
    {/if}
    <LibraryInsights {report} insights={report.insights} {tables} />
  {/if}

  <div class="grid">
    <section class="card fl-continuous-corners" id="an-activity">
      {@render cardHeading(
        arrivalsPerPeriod
          ? $t('frameleaf_analytics_arrivals_answer', { values: { count: number(arrivalsPerPeriod), period } })
          : $t('frameleaf_analytics_arrivals_none'),
        $t('frameleaf_analytics_arrivals_caption'),
        undefined,
        $t('frameleaf_analytics_arrivals'),
      )}
      <AnalyticsChart
        title={$t('frameleaf_analytics_arrivals_title')}
        {labels}
        stacked
        unit={$t('frameleaf_analytics_unit_items')}
        datasets={[
          { label: $t('photos'), values: table('arrivals').rows.map((row) => row[1] as number) },
          { label: $t('videos'), values: table('arrivals').rows.map((row) => row[2] as number), tone: 'secondary' },
        ]}
      />
      <AnalyticsDataTable table={table('arrivals')} />
    </section>

    <section class="card fl-continuous-corners">
      {#if report.processing.available}
        {@render cardHeading(
          report.processing.attempts
            ? $t('frameleaf_analytics_processing_answer', {
                values: { count: number(perPeriod(report.processing.attempts)), period },
              })
            : $t('frameleaf_analytics_processing_none'),
          $t('frameleaf_analytics_processing_caption', {
            values: {
              attempts: number(report.processing.attempts),
              percent: number(
                report.processing.attempts
                  ? Math.round((report.processing.completed / report.processing.attempts) * 10_000) / 100
                  : 0,
              ),
              failed: number(report.processing.failed),
            },
          }),
          { href: Route.queues(), label: $t('frameleaf_analytics_processing_link') },
          $t('frameleaf_analytics_processing'),
        )}
        <AnalyticsChart
          title={$t('frameleaf_analytics_processing_title')}
          {labels}
          stacked
          unit={$t('frameleaf_analytics_unit_attempts')}
          datasets={[
            {
              label: $t('frameleaf_analytics_completed'),
              values: table('processing').rows.map((row) => row[1] as number),
            },
            {
              label: $t('frameleaf_analytics_failed'),
              values: table('processing').rows.map((row) => row[2] as number),
              tone: 'failure',
            },
          ]}
        />
        <p class="note">{$t('frameleaf_analytics_processing_note')}</p>
        <AnalyticsDataTable table={table('processing')} />
      {:else}
        {@render cardHeading($t('frameleaf_analytics_processing'), '', {
          href: Route.queues(),
          label: $t('frameleaf_analytics_processing_link'),
        })}
        <p class="empty" role="status">{$t('frameleaf_analytics_processing_unavailable')}</p>
      {/if}
    </section>

    <section class="card wide fl-continuous-corners">
      {@render cardHeading(
        $t('frameleaf_analytics_metadata_answer', {
          values: {
            dates: knownPercent(AnalyticsMetadataField.CaptureDate),
            places: knownPercent(AnalyticsMetadataField.Location),
          },
        }),
        $t('frameleaf_analytics_metadata_caption'),
        { href: settingsArea('intelligence'), label: $t('frameleaf_analytics_intelligence') },
        $t('frameleaf_analytics_metadata'),
      )}
      <AnalyticsChart
        title={$t('frameleaf_analytics_metadata_title')}
        horizontal
        stacked
        height={220}
        unit={$t('frameleaf_analytics_unit_items')}
        labels={table('metadata').rows.map((row) => row[0] as string)}
        datasets={[
          { label: $t('frameleaf_analytics_present'), values: table('metadata').rows.map((row) => row[1] as number) },
          {
            label: $t('frameleaf_analytics_missing'),
            values: table('metadata').rows.map((row) => row[2] as number),
            tone: 'missing',
          },
        ]}
      />
      <AnalyticsDataTable table={table('metadata')} />
    </section>
  </div>

  <div class="card fl-continuous-corners">
    <section class="library-views" id="an-albums">
      {@render cardHeading(
        $t('frameleaf_analytics_views_answer', {
          values: { count: number(timelineCount), view: $t('frameleaf_analytics_view_timeline') },
        }),
        $t('frameleaf_analytics_views_caption'),
        undefined,
        $t('frameleaf_analytics_views'),
      )}
      <AnalyticsDataTable table={table('views')} />
      <dl class="stat-strip">
        {#each report.views as row (row.view)}
          <div>
            <dt>{$t(`frameleaf_analytics_view_${row.view}` as Translations)}</dt>
            <dd>{number(row.total)}</dd>
            <dd class="note">
              {row.overlaps
                ? $t('frameleaf_analytics_also_counted')
                : $t('frameleaf_analytics_photos_videos', {
                    values: { photos: row.photos, videos: row.videos },
                  })}
            </dd>
          </div>
        {/each}
      </dl>
    </section>

    <section class="album-views">
      {@render cardHeading($t('frameleaf_analytics_albums'), $t('frameleaf_analytics_albums_caption'))}
      <dl class="stat-strip three">
        <div>
          <dt>{$t('frameleaf_analytics_owned')}</dt>
          <dd>{number(report.albums.owned)}</dd>
          <dd class="note">
            {$t('frameleaf_analytics_albums_private', { values: { count: number(report.albums.notShared) } })}
          </dd>
        </div>
        <div>
          <dt>{$t('frameleaf_analytics_shared')}</dt>
          <dd>{number(report.albums.shared)}</dd>
          <dd class="note">
            {$t('frameleaf_analytics_albums_also_owned', {
              values: { count: number(report.albums.ownedShared) },
            })}
          </dd>
        </div>
        <div>
          <dt>{$t('frameleaf_analytics_albums_distinct')}</dt>
          <dd>{number(report.albums.total)}</dd>
          <dd class="note">{$t('frameleaf_analytics_albums_once')}</dd>
        </div>
      </dl>
      {#if report.albums.unlisted > 0}
        <p class="note">
          {$t('frameleaf_analytics_albums_unlisted', { values: { count: number(report.albums.unlisted) } })}
        </p>
      {/if}
      <AnalyticsDataTable table={table('albums')} />
    </section>
  </div>

  <!-- FL-363: "Technical details", closed until asked for; exact bytes stay in the export. -->
  <details class="card technical fl-continuous-corners" id="an-technical">
    <summary>
      <span>{$t('frameleaf_analytics_under_the_hood')}</span>
      <small>{$t('frameleaf_analytics_under_the_hood_caption')}</small>
    </summary>
    <!-- svelte-ignore a11y_no_noninteractive_tabindex -->
    <div class="scroll" tabindex="0" role="region" aria-label={$t('frameleaf_analytics_under_the_hood')}>
      <table class="geek">
        <caption>{selectedLabel} · {day(report.through)}</caption>
        <thead>
          <tr>
            <th scope="col">{$t('frameleaf_analytics_col_metric')}</th>
            <th scope="col">{$t('frameleaf_analytics_col_value')}</th>
            <th scope="col">{$t('frameleaf_analytics_col_definition')}</th>
          </tr>
        </thead>
        <tbody>
          {#each inventoryRows(report) as row (row.id)}
            <tr>
              <th scope="row">{$t(`frameleaf_analytics_inventory_${row.id}` as Translations)}</th>
              <td>
                {row.unit === 'bytes' ? f.size(row.value) : number(row.value)}
              </td>
              <td>{$t(`frameleaf_analytics_definition_${row.id}` as Translations)}</td>
            </tr>
          {/each}
          {#if report.processing.available}
            <tr>
              <th scope="row">{$t('frameleaf_analytics_estimate')}</th>
              <td>
                {report.processing.estimatedCostUsd === null
                  ? $t('frameleaf_analytics_estimate_none')
                  : new Intl.NumberFormat($locale, {
                      style: 'currency',
                      currency: 'USD',
                      maximumFractionDigits: 4,
                    }).format(report.processing.estimatedCostUsd)}
              </td>
              <td>
                {$t('frameleaf_analytics_estimate_definition', {
                  values: {
                    costed: number(report.processing.costedAttempts),
                    uncosted: number(report.processing.uncostedAttempts),
                  },
                })}
              </td>
            </tr>
          {/if}
        </tbody>
      </table>
    </div>
    <a class="text-button" href={settingsArea('care')}
      >{$t('frameleaf_analytics_library_care')}<Icon icon={mdiChevronRight} size="14" /></a
    >
  </details>

  <footer class="footnote">
    <strong>{$t('frameleaf_analytics_about')}</strong>
    <p>{$t('frameleaf_analytics_about_text', { values: { date: day(report.through) } })}</p>
  </footer>
</div>

<style>
  .analytics {
    /* Chart series from the foundation tokens (analytics-dashboard.css:1-12). */
    --an-1: var(--fl-accent);
    --an-2: var(--fl-teal);
    --an-3: var(--fl-blue);
    --an-4: color-mix(in srgb, var(--fl-muted) 78%, var(--fl-panel));
    --an-5: var(--fl-warning);
    --an-6: color-mix(in srgb, var(--fl-muted) 45%, var(--fl-panel));
    /*
     * FL-139: the text drawn on each series, chosen per theme for WCAG AA (4.5:1 at 11px). The
     * prototype draws #0b1210 on every series; that keeps where it passes and turns white where the
     * series is dark (the sixth here, most of them in the light theme).
     */
    --an-1-ink: #0b1210;
    --an-2-ink: #0b1210;
    --an-3-ink: #0b1210;
    --an-4-ink: #0b1210;
    --an-5-ink: #0b1210;
    --an-6-ink: #ffffff;
    --an-free: color-mix(in srgb, var(--fl-text) 10%, transparent);
    --an-cell: color-mix(in srgb, var(--fl-text) 7%, transparent);
    container-type: inline-size;
    width: 100%;
    max-width: 1440px;
    min-width: 0;
    margin: 0 auto;
    /* Hosted only in the settings pane, which already insets it (command-center.css `.cc-main > .settings-analytics`). */
    padding: 0;
    color: var(--fl-text);
    background: var(--fl-canvas);
    font-size: 13px;
    line-height: 1.5;
  }
  :global(.frameleaf[data-theme='light']) .analytics {
    --an-1-ink: #ffffff;
    --an-2-ink: #ffffff;
    --an-3-ink: #ffffff;
    --an-5-ink: #ffffff;
    --an-6-ink: #0b1210;
  }

  .analytics[aria-busy='true'] {
    opacity: 0.7;
  }
  .page-heading,
  .card-heading {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 20px;
  }
  .page-heading {
    margin-bottom: 22px;
  }
  .page-heading h1 {
    margin: 0;
    font-size: 28px;
    font-weight: 550;
    letter-spacing: -0.9px;
  }
  .page-heading p,
  .card-heading p {
    margin: 6px 0 0;
    color: var(--fl-muted);
  }
  .export {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 16px;
    padding: 9px 13px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    color: var(--fl-text);
    font-size: 12px;
  }
  .export:hover {
    background: var(--fl-raised);
  }
  .notice {
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 14px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .notice p {
    margin: 0;
    color: var(--fl-muted);
    font-size: 11px;
  }
  .notice[data-state='stale'],
  .notice[data-state='unknown'] {
    border-color: var(--fl-warning);
  }
  .badge {
    flex-shrink: 0;
    padding: 3px var(--fl-space-2);
    border: 1px solid var(--fl-border);
    border-radius: 3px;
    font-size: 9px;
    font-weight: 650;
    letter-spacing: 0.1em;
    text-transform: uppercase;
  }
  .controls {
    display: flex;
    flex-wrap: wrap;
    align-items: end;
    gap: 14px;
    margin-top: 24px;
  }
  .controls label {
    display: flex;
    flex-direction: column;
    gap: 6px;
    color: var(--fl-muted);
    font-size: 11px;
  }
  select {
    min-width: 150px;
    padding: 8px 32px 8px 10px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    color: var(--fl-text);
    font: inherit;
    font-size: 12px;
  }
  .controls p {
    margin: 0 0 3px auto;
    color: var(--fl-muted);
    font-size: 10px;
    text-align: end;
  }
  .export-status {
    min-height: 18px;
    margin: 6px 0 0;
    color: var(--fl-muted);
    font-size: 11px;
  }
  .stat-strip {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 16px;
    margin: 0 0 24px;
    padding: 22px 0 25px;
    border-bottom: 1px solid var(--fl-border);
  }
  .stat-strip.three {
    grid-template-columns: repeat(3, minmax(0, 1fr));
  }
  .stat-strip > div {
    min-width: 0;
    padding-inline-end: 12px;
  }
  .stat-strip > div + div {
    padding-inline-start: 20px;
    border-inline-start: 1px solid var(--fl-border);
  }
  .stat-strip dt {
    color: var(--fl-muted);
    font-size: 11px;
  }
  .stat-strip dd:not(.note) {
    margin: 7px 0;
    font-size: clamp(21px, 2.1vw, 30px);
    font-variant-numeric: var(--fl-numeric);
    font-weight: 550;
    letter-spacing: -0.7px;
  }
  /* the note under a figure is part of its description (a <dd>, as a <dl> only holds dt and dd) */
  .stat-strip dd.note {
    display: block;
    margin: 0;
    color: var(--fl-muted);
    font-size: 10px;
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
    margin-bottom: 18px;
  }
  .card {
    min-width: 0;
    margin-bottom: 18px;
    padding: 22px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  @supports (corner-shape: squircle) {
    .card {
      border-radius: calc(var(--fl-radius-card) * 1.8);
    }
  }
  .hidden-note {
    margin: 0 0 12px;
    color: var(--fl-muted);
    font-size: 11.5px;
  }
  .grid > .card {
    margin-bottom: 0;
  }
  .wide {
    grid-column: 1 / -1;
  }
  .card-heading {
    margin-bottom: 12px;
  }
  /* Sticky section links (approved design, 2026-11-04). */
  .jump {
    position: sticky;
    top: -1px;
    z-index: 3;
    display: flex;
    gap: 4px;
    margin: 0 0 18px;
    padding: 6px;
    overflow-x: auto;
    scrollbar-width: none;
    border: 1px solid var(--fl-material-edge);
    border-radius: var(--fl-radius-pill);
    background: var(--fl-material);
    backdrop-filter: var(--fl-material-blur);
    box-shadow: var(--fl-shadow-1);
  }
  .jump:empty {
    display: none;
  }
  .jump::-webkit-scrollbar {
    display: none;
  }
  .jump a {
    flex: none;
    padding: 6px 12px;
    border-radius: var(--fl-radius-pill);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 500;
    text-decoration: none;
    white-space: nowrap;
    transition:
      background var(--fl-motion-fast) var(--fl-ease),
      color var(--fl-motion-fast) var(--fl-ease);
  }
  .jump a:hover {
    color: var(--fl-text);
    background: var(--fl-raised);
  }
  .jump a[aria-current='true'] {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
  }
  .analytics :global([id^='an-']) {
    scroll-margin-top: 72px;
  }
  .card-heading h2 {
    font-size: 14px;
    font-weight: 550;
    letter-spacing: -0.15px;
  }
  /* A kicker over an answer, as the panels above (AnalyticsPanel `.an-kicker`). */
  .card-heading .kicker {
    margin: 0 0 6px;
    color: var(--fl-accent);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .card-heading:has(.kicker) h2 {
    font-size: 19px;
    font-weight: 650;
    letter-spacing: -0.02em;
    text-wrap: balance;
  }
  .card-heading p {
    max-width: 620px;
    font-size: 11px;
    line-height: 1.6;
  }
  .text-button {
    display: inline-flex;
    flex-shrink: 0;
    align-items: center;
    gap: 4px;
    padding: 2px 0;
    color: var(--fl-muted);
    font-size: 10px;
    white-space: nowrap;
  }
  .text-button:hover {
    color: var(--fl-text);
    text-decoration: underline;
    text-underline-offset: 3px;
  }
  .growth {
    min-width: 0;
    margin: 0;
  }
  .growth figcaption {
    display: flex;
    justify-content: space-between;
    align-items: flex-start;
    gap: 16px;
    margin-bottom: 12px;
  }
  .growth figcaption > div {
    display: flex;
    align-items: baseline;
    gap: 18px;
  }
  .growth figcaption span {
    font-size: 14px;
    font-weight: 550;
  }
  .growth figcaption strong {
    color: var(--fl-muted);
    font-size: 12px;
    font-variant-numeric: var(--fl-numeric);
    font-weight: 450;
  }
  .growth figcaption small {
    color: var(--fl-muted);
    font-size: 10px;
    text-align: end;
  }
  .note {
    margin: 8px 0 12px;
    color: var(--fl-muted);
    font-size: 10px;
    line-height: 1.6;
  }
  .empty {
    display: grid;
    place-content: center;
    min-height: 120px;
    margin: 0;
    padding: 16px;
    color: var(--fl-muted);
    text-align: center;
  }
  .scroll {
    max-width: 100%;
    overflow: auto;
    scrollbar-width: thin;
  }
  table {
    width: 100%;
    border-collapse: collapse;
    font-size: 11px;
    font-variant-numeric: var(--fl-numeric);
  }
  caption {
    padding: 10px 0;
    color: var(--fl-muted);
    font-size: 10px;
    text-align: start;
  }
  th,
  td {
    padding: 9px 10px;
    border-bottom: 1px solid var(--fl-border);
    text-align: end;
    white-space: nowrap;
  }
  th {
    color: var(--fl-muted);
    font-weight: 450;
  }
  th:first-child {
    padding-inline-start: 0;
    text-align: start;
  }
  .geek td:last-child {
    min-width: 180px;
    padding-inline-start: 24px;
    color: var(--fl-muted);
    text-align: start;
    white-space: normal;
  }
  .library-views .stat-strip,
  .album-views .stat-strip {
    margin-bottom: 0;
  }
  .library-views,
  .album-views {
    margin-bottom: 18px;
  }
  .footnote {
    padding: 10px 0 0;
    color: var(--fl-muted);
    font-size: 10px;
  }
  .footnote strong {
    color: var(--fl-text);
    font-weight: 500;
  }
  .footnote p {
    max-width: 1100px;
    margin: 6px 0 0;
    line-height: 1.7;
  }
  :is(button, select, a, [tabindex]):focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
  @container (max-width: 850px) {
    .controls p {
      width: 100%;
      margin-inline-start: 0;
      text-align: start;
    }
    .stat-strip {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      row-gap: 22px;
    }
    .stat-strip > div:nth-child(3) {
      padding-inline-start: 0;
      border-inline-start: 0;
    }
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .growth figcaption {
      flex-direction: column;
      gap: 6px;
    }
    .growth figcaption small {
      text-align: start;
    }
  }
  @container (max-width: 480px) {
    .page-heading {
      flex-direction: column;
      gap: 12px;
    }
    .controls label {
      flex: 1;
      min-width: 135px;
    }
    select {
      width: 100%;
      min-width: 0;
    }
    .stat-strip dd:not(.note) {
      font-size: 21px;
      overflow-wrap: anywhere;
    }
    .card {
      padding: 15px 12px;
    }
    .card-heading {
      flex-wrap: wrap;
      gap: 8px;
    }
  }
  .count-now {
    margin-inline-start: var(--fl-space-2);
  }
  .backup-note {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .technical > summary {
    display: grid;
    gap: var(--fl-space-1);
    cursor: pointer;
    list-style-position: inside;
  }
  .technical > summary span {
    font-weight: 600;
  }
  .technical > summary small {
    color: var(--fl-muted);
  }
  .technical[open] > summary {
    margin-bottom: var(--fl-space-4);
  }
  .technical > .text-button {
    margin-top: var(--fl-space-4);
  }
</style>
