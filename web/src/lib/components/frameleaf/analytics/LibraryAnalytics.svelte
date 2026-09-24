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
    scopeLabel,
    type AnalyticsTable,
    type GrowthMetric,
    type Translate,
  } from '$lib/frameleaf/analytics';
  import { commandCenterUrl, type SettingsAreaId } from '$lib/frameleaf/settings-areas';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { downloadBlob } from '$lib/utils';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AnalyticsRange,
    AnalyticsScopeKind,
    type AnalyticsReportResponseDto,
    type AnalyticsScopeOptionDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiChevronRight, mdiDownload } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  type Props = { scopes: AnalyticsScopeOptionDto[]; report: AnalyticsReportResponseDto };
  let { scopes, report }: Props = $props();

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
  // People and places come only with the owner's own scope, which the hero calls "Your library".
  const heroKicker = $derived(
    report.insights?.peopleAndPlaces ? $t('frameleaf_analytics_your_library') : selectedLabel,
  );
  const settingsArea = (area: SettingsAreaId) => commandCenterUrl(area);

  /** The route's load reads the report for the new address; this page never fetches on its own. */
  const load = async (next: { scope?: string; range?: AnalyticsRange }) => {
    loading = true;
    exportStatus = '';
    try {
      const url = new URL(page.url);
      url.searchParams.set('scope', next.scope ?? scope);
      url.searchParams.set('range', next.range ?? range);
      await goto(`${url.pathname}${url.search}`, { replaceState: true, noScroll: true, keepFocus: true });
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

{#snippet cardHeading(title: string, caption: string, action?: { href: string; label: string })}
  <header class="card-heading">
    <div>
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
      {$t('frameleaf_analytics_as_of', { values: { date: dateTime(report.generatedAt) } })}
      {#if notice === 'unknown'}
        {$t('frameleaf_analytics_history_unknown')}
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
      {$t('frameleaf_analytics_library_scope')}
      <select value={scope} disabled={loading} onchange={(event) => load({ scope: event.currentTarget.value })}>
        {#each scopes as option (option.value)}
          <option value={option.value}>{scopeLabel(option, tr)}</option>
        {/each}
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

  <LibraryHero {report} kicker={heroKicker} />

  <div class="card growth-card fl-continuous-corners">
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
      {:else}
        <AnalyticsChart
          kind="line"
          title={$t(
            metric === 'storage'
              ? 'frameleaf_analytics_growth_storage_title'
              : 'frameleaf_analytics_growth_items_title',
          )}
          {labels}
          unit={metric === 'storage' ? 'GiB' : $t('frameleaf_analytics_unit_items')}
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
    <section class="card fl-continuous-corners">
      {@render cardHeading($t('frameleaf_analytics_arrivals'), $t('frameleaf_analytics_arrivals_caption'))}
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
          $t('frameleaf_analytics_processing'),
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
      {@render cardHeading($t('frameleaf_analytics_metadata'), $t('frameleaf_analytics_metadata_caption'), {
        href: settingsArea('intelligence'),
        label: $t('frameleaf_analytics_intelligence'),
      })}
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
    <section class="library-views">
      {@render cardHeading($t('frameleaf_analytics_views'), $t('frameleaf_analytics_views_caption'))}
      <AnalyticsDataTable table={table('views')} />
      <dl class="stat-strip">
        {#each report.views as row (row.view)}
          <div>
            <dt>{$t(`frameleaf_analytics_view_${row.view}` as Translations)}</dt>
            <dd>{number(row.total)}</dd>
            <span>
              {row.overlaps
                ? $t('frameleaf_analytics_also_counted')
                : $t('frameleaf_analytics_photos_videos', {
                    values: { photos: number(row.photos), videos: number(row.videos) },
                  })}
            </span>
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
          <span>{$t('frameleaf_analytics_albums_private', { values: { count: number(report.albums.notShared) } })}</span
          >
        </div>
        <div>
          <dt>{$t('frameleaf_analytics_shared')}</dt>
          <dd>{number(report.albums.shared)}</dd>
          <span
            >{$t('frameleaf_analytics_albums_also_owned', {
              values: { count: number(report.albums.ownedShared) },
            })}</span
          >
        </div>
        <div>
          <dt>{$t('frameleaf_analytics_albums_distinct')}</dt>
          <dd>{number(report.albums.total)}</dd>
          <span>{$t('frameleaf_analytics_albums_once')}</span>
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

  <section class="card fl-continuous-corners">
    {@render cardHeading($t('frameleaf_analytics_under_the_hood'), $t('frameleaf_analytics_under_the_hood_caption'), {
      href: settingsArea('care'),
      label: $t('frameleaf_analytics_library_care'),
    })}
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
                {row.unit === 'bytes'
                  ? $t('frameleaf_analytics_bytes', { values: { value: number(row.value) } })
                  : number(row.value)}
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
  </section>

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
    --an-free: color-mix(in srgb, var(--fl-text) 10%, transparent);
    --an-cell: color-mix(in srgb, var(--fl-text) 7%, transparent);
    container-type: inline-size;
    width: 100%;
    max-width: 1440px;
    min-width: 0;
    margin: 0 auto;
    padding: clamp(16px, 3vw, 36px);
    color: var(--fl-text);
    background: var(--fl-canvas);
    font-size: 13px;
    line-height: 1.5;
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
    padding: 3px 6px;
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
    text-align: right;
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
    padding-right: 12px;
  }
  .stat-strip > div + div {
    padding-left: 20px;
    border-left: 1px solid var(--fl-border);
  }
  .stat-strip dt {
    color: var(--fl-muted);
    font-size: 11px;
  }
  .stat-strip dd {
    margin: 7px 0;
    font-size: clamp(21px, 2.1vw, 30px);
    font-variant-numeric: tabular-nums;
    font-weight: 550;
    letter-spacing: -0.7px;
  }
  .stat-strip span {
    display: block;
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
  .card-heading h2 {
    font-size: 14px;
    font-weight: 550;
    letter-spacing: -0.15px;
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
    font-variant-numeric: tabular-nums;
    font-weight: 450;
  }
  .growth figcaption small {
    color: var(--fl-muted);
    font-size: 10px;
    text-align: right;
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
    font-variant-numeric: tabular-nums;
  }
  caption {
    padding: 10px 0;
    color: var(--fl-muted);
    font-size: 10px;
    text-align: left;
  }
  th,
  td {
    padding: 9px 10px;
    border-bottom: 1px solid var(--fl-border);
    text-align: right;
    white-space: nowrap;
  }
  th {
    color: var(--fl-muted);
    font-weight: 450;
  }
  th:first-child {
    padding-left: 0;
    text-align: left;
  }
  .geek td:last-child {
    min-width: 180px;
    padding-left: 24px;
    color: var(--fl-muted);
    text-align: left;
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
    outline: 2px solid var(--fl-accent);
    outline-offset: 3px;
  }
  @container (max-width: 850px) {
    .controls p {
      width: 100%;
      margin-left: 0;
      text-align: left;
    }
    .stat-strip {
      grid-template-columns: repeat(2, minmax(0, 1fr));
      row-gap: 22px;
    }
    .stat-strip > div:nth-child(3) {
      padding-left: 0;
      border-left: 0;
    }
    .grid {
      grid-template-columns: minmax(0, 1fr);
    }
    .growth figcaption {
      flex-direction: column;
      gap: 6px;
    }
    .growth figcaption small {
      text-align: left;
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
    .stat-strip dd {
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
</style>
