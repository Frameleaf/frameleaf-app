<script lang="ts">
  /**
   * The Library analytics hero (FL-79), the template's `LibraryHero` (AnalyticsDashboard.jsx:216-290):
   * the library total, its span in capture years, fact chips and four tiles (added this period,
   * volume used, deduplication savings, photos and videos). Every figure is the server's; a fact
   * the report does not carry for this scope (people and places outside the owner's own scope, HDR
   * before any video stream has been read) is left out rather than shown as zero.
   */
  import AnalyticsRing from '$lib/components/frameleaf/analytics/AnalyticsRing.svelte';
  import AnalyticsSparkline from '$lib/components/frameleaf/analytics/AnalyticsSparkline.svelte';
  import { analyticsFormats, captureSpan, type Translate } from '$lib/frameleaf/analytics';
  import { locale } from '$lib/stores/preferences.store';
  import { AnalyticsState, type AnalyticsReportResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAccountGroupOutline,
    mdiCameraIris,
    mdiEarth,
    mdiHdr,
    mdiMapMarkerMultipleOutline,
    mdiMovieOpenOutline,
  } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  type Props = { report: AnalyticsReportResponseDto; kicker: string };
  let { report, kicker }: Props = $props();

  const tr: Translate = (key, values) => $t(key as Translations, { values });
  const f = $derived(analyticsFormats($locale, tr));
  const insights = $derived(report.insights);
  const span = $derived(insights ? captureSpan(insights) : null);
  const added = $derived(report.series.reduce((sum, row) => sum + row.photos + row.videos, 0));
  const host = $derived(report.host);
  const used = $derived(
    host.volumeUsedBytes === null || !host.capacityBytes ? null : f.percent(host.volumeUsedBytes, host.capacityBytes),
  );

  const facts = $derived.by(() => {
    if (!insights) {
      return [];
    }
    const places = insights.peopleAndPlaces;
    const list = [
      { icon: mdiEarth, key: 'frameleaf_analytics_fact_countries', count: places?.countries ?? 0 },
      { icon: mdiMapMarkerMultipleOutline, key: 'frameleaf_analytics_fact_places', count: places?.cities ?? 0 },
      { icon: mdiAccountGroupOutline, key: 'frameleaf_analytics_fact_people', count: places?.namedPeople ?? 0 },
      { icon: mdiCameraIris, key: 'frameleaf_analytics_fact_raw', count: report.summary.raw },
      { icon: mdiHdr, key: 'frameleaf_analytics_fact_dolby_vision', count: insights.hdr?.dolbyVisionVideos ?? 0 },
      { icon: mdiMovieOpenOutline, key: 'frameleaf_analytics_fact_video_hours', count: insights.records.videoHours },
    ];
    return list
      .filter((fact) => fact.count > 0)
      .map((fact) => ({ icon: fact.icon, text: tr(fact.key, { count: fact.count }) }));
  });
</script>

<section class="an-hero fl-continuous-corners" aria-label={$t('frameleaf_analytics_hero_label')}>
  <div class="main">
    <p class="an-kicker">{kicker}</p>
    <p class="number">{f.number(report.summary.items)}</p>
    <p class="line">
      {#if span}
        {$t('frameleaf_analytics_hero_before')}
        <strong>{$t('frameleaf_analytics_hero_years', { values: { count: span.years } })}</strong>
        {$t('frameleaf_analytics_hero_after', { values: { from: span.from, through: span.through } })}
      {:else}
        {$t('frameleaf_analytics_hero_plain')}
      {/if}
    </p>
    {#if facts.length > 0}
      <ul class="an-facts">
        {#each facts as fact (fact.text)}
          <li><Icon icon={fact.icon} size="15" aria-hidden />{fact.text}</li>
        {/each}
      </ul>
    {/if}
  </div>
  <div class="kpis">
    <div class="kpi">
      <span>{$t('frameleaf_analytics_added_period')}</span>
      <strong>+{f.number(added)}</strong>
      <AnalyticsSparkline
        values={report.series.map((row) => row.photos + row.videos)}
        label={$t('frameleaf_analytics_sparkline_label', { values: { count: report.series.length } })}
      />
    </div>
    <div class="kpi kpi-ring">
      {#if used === null}
        <div>
          <span>{$t('frameleaf_analytics_kpi_volume_used')}</span>
          <strong class="unknown">{$t('frameleaf_analytics_unknown_value')}</strong>
          <small>{$t('frameleaf_analytics_volume_unreadable')}</small>
        </div>
      {:else}
        <AnalyticsRing
          value={used}
          label={$t('frameleaf_analytics_volume_ring', { values: { percent: Math.round(used) } })}
        >
          {Math.round(used)}%
        </AnalyticsRing>
        <div>
          <span>{$t('frameleaf_analytics_kpi_volume_used')}</span>
          <strong>{f.size(host.volumeUsedBytes!)}</strong>
          <small>
            {host.freeBytes === null
              ? $t('frameleaf_analytics_volume_of', { values: { capacity: f.size(host.capacityBytes!) } })
              : $t('frameleaf_analytics_volume_of_free', {
                  values: { capacity: f.size(host.capacityBytes!), free: f.size(host.freeBytes) },
                })}
            {#if host.state === AnalyticsState.Stale && host.observedAt}
              · {$t('frameleaf_analytics_read_on', { values: { date: f.longDate(host.observedAt) } })}
            {/if}
          </small>
        </div>
      {/if}
    </div>
    <div class="kpi">
      <span>{$t('frameleaf_analytics_saved_dedup')}</span>
      <strong>{f.size(report.summary.savedBytes)}</strong>
      <small>
        {$t('frameleaf_analytics_shared_originals', {
          values: { count: report.summary.duplicateReferences, value: f.number(report.summary.duplicateReferences) },
        })}
      </small>
    </div>
    <div class="kpi">
      <span>{$t('frameleaf_analytics_photos_dot_videos')}</span>
      <strong>{f.compact(report.summary.photos)} · {f.compact(report.summary.videos)}</strong>
      <span class="split" aria-hidden="true">
        <span style:width="{f.percent(report.summary.photos, report.summary.items)}%"></span>
      </span>
    </div>
  </div>
</section>

<style>
  .an-hero {
    display: grid;
    grid-template-columns: minmax(0, 1.1fr) minmax(0, 1fr);
    gap: 28px;
    margin: 18px 0;
    padding: 28px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-sheet);
  }
  @supports (corner-shape: squircle) {
    .an-hero {
      border-radius: calc(var(--fl-radius-sheet) * 1.8);
    }
  }
  .an-kicker {
    margin: 0 0 6px;
    color: var(--fl-accent);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .number {
    margin: 0;
    font-size: clamp(48px, 7cqi, 88px);
    font-weight: 700;
    font-variant-numeric: tabular-nums;
    letter-spacing: -0.045em;
    line-height: 0.95;
  }
  .line {
    margin: 12px 0 0;
    color: var(--fl-muted);
    font-size: 15px;
  }
  .line strong {
    color: var(--fl-text);
  }
  .an-facts {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 22px 0 0;
    padding: 0;
    list-style: none;
  }
  .an-facts li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-pill);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .an-facts li :global(svg) {
    color: var(--fl-accent);
  }
  .kpis {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 12px;
  }
  .kpi {
    display: flex;
    flex-direction: column;
    gap: 4px;
    min-width: 0;
    padding: 16px;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .kpi > span:first-child,
  .kpi-ring span {
    color: var(--fl-muted);
    font-size: 12px;
  }
  .kpi strong {
    font-size: 24px;
    font-variant-numeric: tabular-nums;
    font-weight: 650;
    letter-spacing: -0.02em;
  }
  .kpi strong.unknown {
    color: var(--fl-muted);
  }
  .kpi small {
    color: var(--fl-muted);
    font-size: 11.5px;
  }
  .kpi-ring {
    flex-direction: row;
    align-items: center;
    gap: 14px;
  }
  .kpi-ring > div {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
  }
  .split {
    display: block;
    height: 8px;
    margin-top: auto;
    overflow: hidden;
    background: var(--an-2);
    border-radius: 999px;
  }
  .split span {
    display: block;
    height: 100%;
    background: var(--an-1);
  }
  @container (max-width: 900px) {
    .an-hero {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @container (max-width: 520px) {
    .an-hero {
      padding: 20px;
    }
    .kpis {
      grid-template-columns: minmax(0, 1fr);
    }
  }
</style>
