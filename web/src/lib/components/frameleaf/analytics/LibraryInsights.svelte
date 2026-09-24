<script lang="ts">
  /**
   * The Library analytics dashboard panels (FL-79), ported from the template's
   * `AnalyticsDashboard.jsx` and `analytics-dashboard.css`: captures per year, the weekday-by-hour
   * punchcard, the storage donut, the daily heatmap, cameras, lenses and focal lengths, photo formats,
   * video resolution and orientation, people and places, coverage rings and library records.
   *
   * Everything comes from `GET /analytics` (`insights`, `summary`, `days`, `cameras`, `metadata`,
   * `host`); nothing is sampled or estimated. Each breakdown adds up to the report's items less the
   * items this session keeps hidden (`breakdownTotal`), and the page says so when any are hidden.
   * Catch-all rows ("Everywhere else", "Not recorded") come last and never set a bar's scale. People
   * and places are the owner's own: for any other scope the server leaves them out and the panel
   * explains why instead. Every chart keeps its exact values in a data table (and the CSV).
   */
  import AnalyticsDataTable from '$lib/components/frameleaf/analytics/AnalyticsDataTable.svelte';
  import AnalyticsDonut from '$lib/components/frameleaf/analytics/AnalyticsDonut.svelte';
  import AnalyticsLeaderboard from '$lib/components/frameleaf/analytics/AnalyticsLeaderboard.svelte';
  import AnalyticsPanel from '$lib/components/frameleaf/analytics/AnalyticsPanel.svelte';
  import AnalyticsRing from '$lib/components/frameleaf/analytics/AnalyticsRing.svelte';
  import AnalyticsStackBar from '$lib/components/frameleaf/analytics/AnalyticsStackBar.svelte';
  import {
    analyticsFormats,
    calendarWeeks,
    cameraRows,
    captureSpan,
    dayRecords,
    focalRows,
    lensRows,
    orientationRows,
    photoFormatRows,
    placeRows,
    punchcardPeak,
    videoResolutionRows,
    volumeSegments,
    WEEKDAYS,
    breakdownTotal,
    yearRows,
    type AnalyticsTable,
    type CalendarKind,
    type Translate,
  } from '$lib/frameleaf/analytics';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import { getPeopleThumbnailUrl } from '$lib/utils';
  import {
    AnalyticsMetadataField,
    type AnalyticsInsightsDto,
    type AnalyticsReportResponseDto,
    type PersonResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAccountGroupOutline,
    mdiCalendarCheckOutline,
    mdiChartLine,
    mdiClockTimeEightOutline,
    mdiFileVideoOutline,
    mdiFire,
    mdiHdr,
    mdiLayersTripleOutline,
    mdiMotionPlayOutline,
    mdiRuler,
    mdiTimerOutline,
    mdiCameraIris,
  } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    report: AnalyticsReportResponseDto;
    insights: AnalyticsInsightsDto;
    tables: AnalyticsTable[];
  };
  let { report, insights, tables }: Props = $props();

  const tr: Translate = (key, values) => $t(key as Translations, { values });
  // Recognition settings are the server's; an account without administration goes to its People.
  const isAdmin = $derived(authManager.user.isAdmin);
  const f = $derived(analyticsFormats($locale, tr));
  const table = (id: string) => tables.find((item) => item.id === id);

  // Chart colours: the accent, then the brand teal and blue, then warm and cool neutrals
  // (analytics-dashboard.css:1-12), all from the foundation tokens.
  const HOURS = Array.from({ length: 24 }, (_, hour) => hour);
  const SERIES = ['var(--an-1)', 'var(--an-2)', 'var(--an-3)', 'var(--an-5)', 'var(--an-4)', 'var(--an-6)'];

  // ── Through the years ──
  const years = $derived(yearRows(insights));
  const span = $derived(captureSpan(insights));
  const throughYear = $derived(Number(report.through.slice(0, 4)));
  const yearMax = $derived(Math.max(1, ...years.map((row) => row.count)));
  const bestYear = $derived.by(() => {
    let best: (typeof years)[number] | null = null;
    for (const row of years) {
      if (row.count > (best?.count ?? 0)) {
        best = row;
      }
    }
    return best;
  });

  // ── When you shoot ──
  const peak = $derived(punchcardPeak(insights));
  const punchMax = $derived(Math.max(1, ...insights.punchcard.map((cell) => cell.count)));
  const punchCount = (weekday: number, hour: number) =>
    insights.punchcard.find((cell) => cell.weekday === weekday && cell.hour === hour)?.count ?? 0;
  const weekdayShort = (weekday: number) => tr(`frameleaf_analytics_weekday_short_${weekday}`);

  // ── Every day ──
  let calendar = $state<CalendarKind>('captured');
  const weeks = $derived(calendarWeeks(report.days, calendar));
  const calendarTotal = $derived(report.days.reduce((sum, row) => sum + row[calendar], 0));

  // ── Gear, formats ──
  const cameras = $derived(cameraRows(report, tr));
  const lenses = $derived(lensRows(insights, tr));
  const focal = $derived(focalRows(insights, tr));
  const focalMax = $derived(Math.max(1, ...focal.filter((row) => !row.catchAll).map((row) => row.count)));
  const formats = $derived(photoFormatRows(insights, tr));
  const visiblePhotos = $derived(formats.reduce((sum, row) => sum + row.count, 0));
  const resolutions = $derived(videoResolutionRows(insights, tr));
  const orientation = $derived(orientationRows(insights, tr));

  // ── People and places (the owner's own scope only) ──
  const people = $derived(insights.peopleAndPlaces);
  const places = $derived(placeRows(insights, tr));
  const personRows = $derived(
    (people?.topPeople ?? []).map((person) => ({
      id: person.id,
      label: person.name,
      count: person.count,
      catchAll: false,
    })),
  );
  const personThumbnail = (id: string) => getPeopleThumbnailUrl({ id } as PersonResponseDto);

  // ── Coverage ──
  const visibleItems = $derived(breakdownTotal(report));
  const coverage = $derived(
    (
      [
        [AnalyticsMetadataField.CaptureDate, 'frameleaf_analytics_coverage_dated'],
        [AnalyticsMetadataField.Location, 'frameleaf_analytics_coverage_located'],
        [AnalyticsMetadataField.AiDescription, 'frameleaf_analytics_coverage_described'],
      ] as const
    )
      .flatMap(([field, key]) => {
        const row = report.metadata.find((item) => item.field === field);
        return row ? [{ field: field as string, label: tr(key), percent: f.percent(row.present, row.total) }] : [];
      })
      .concat(
        // Faces checked and search indexed are counted over the items this session may see
        // (the template's coverage rings, AnalyticsDashboard.jsx:538-560).
        [
          ['faces', 'frameleaf_analytics_coverage_faces', insights.coverage?.facesChecked],
          ['search', 'frameleaf_analytics_coverage_search', insights.coverage?.searchIndexed],
        ].flatMap(([field, key, count]) =>
          typeof count === 'number'
            ? [{ field: field as string, label: tr(key as string), percent: f.percent(count, visibleItems) }]
            : [],
        ),
        report.metadata
          .filter((row) => row.field === AnalyticsMetadataField.Checksum)
          .map((row) => ({
            field: row.field as string,
            label: tr('frameleaf_analytics_coverage_checksummed'),
            percent: f.percent(row.present, row.total),
          })),
      ),
  );

  // ── Records ──
  const days = $derived(dayRecords(report.days));
  const records = $derived(insights.records);
  const yearsAgo = (date: string) => Math.max(0, throughYear - Number(date.slice(0, 4)));
  // 0.3 mm per 6×4 print and 152.4 mm along its long edge (AnalyticsDashboard.jsx:565-566).
  const printStackMetres = $derived(Math.round(((report.summary.photos * 0.3) / 1000) * 10) / 10);
  const printLineKm = $derived(Math.round(((report.summary.photos * 152.4) / 1_000_000) * 10) / 10);

  // ── Storage ──
  const host = $derived(report.host);
  const volume = $derived(volumeSegments(report, tr));
  const PART_COLORS: Record<string, string> = {
    originals: 'var(--an-1)',
    used: 'var(--an-1)',
    previews: 'var(--an-2)',
    'encoded-video': 'var(--an-3)',
    database: 'var(--an-5)',
    other: 'var(--an-4)',
    free: 'var(--an-free)',
    'not-in-use': 'var(--an-free)',
    reserved: 'var(--an-6)',
  };
  const storageSegments = $derived(
    (volume?.segments ?? []).map((segment) => ({
      id: segment.id,
      label: segment.label,
      value: segment.bytes,
      color: PART_COLORS[segment.id],
    })),
  );
</script>

{#snippet dataTable(id: string, summary?: string)}
  {@const found = table(id)}
  {#if found}<AnalyticsDataTable table={found} {summary} />{/if}
{/snippet}

<div class="an-dashboard">
  <!-- Through the years (AnalyticsDashboard.jsx:292-318) -->
  <AnalyticsPanel
    id="years"
    wide
    kicker={$t('frameleaf_analytics_years_kicker')}
    title={span
      ? $t('frameleaf_analytics_years_title', { values: { count: span.years, from: span.from } })
      : $t('frameleaf_analytics_years_empty_title')}
    caption={bestYear
      ? $t('frameleaf_analytics_years_caption', {
          values: { year: bestYear.year, count: bestYear.count, value: f.number(bestYear.count) },
        }) +
        (span && span.through === throughYear
          ? ` ${$t('frameleaf_analytics_years_partial', { values: { year: throughYear } })}`
          : '')
      : ''}
  >
    {#if years.length === 0}
      <p class="empty">{$t('frameleaf_analytics_no_items')}</p>
    {:else}
      <div class="an-years" role="img" aria-label={$t('frameleaf_analytics_years_label')}>
        {#each years as row (row.year)}
          <div
            class="an-year"
            class:partial={row.year === throughYear}
            class:best={row === bestYear}
            title="{row.year}: {f.number(row.count)}"
          >
            <span class="value">{f.compact(row.count)}</span>
            <span class="bar" style:height="{(row.count / yearMax) * 100}%"></span>
            <span class="label">{String(row.year).slice(2)}</span>
          </div>
        {/each}
      </div>
    {/if}
    {@render dataTable('years')}
  </AnalyticsPanel>

  <!-- When you shoot (AnalyticsDashboard.jsx:320-350) -->
  <AnalyticsPanel
    id="punchcard"
    kicker={$t('frameleaf_analytics_habits_kicker')}
    title={peak
      ? $t('frameleaf_analytics_habits_title', {
          values: { day: tr(`frameleaf_analytics_weekday_plural_${peak.weekday}`), hour: f.hour(peak.hour) },
        })
      : $t('frameleaf_analytics_habits_empty_title')}
    caption={$t('frameleaf_analytics_habits_caption')}
  >
    <div class="an-punch" role="img" aria-label={$t('frameleaf_analytics_punchcard_label')}>
      <span></span>
      {#each HOURS as hour (hour)}
        <span class="hour">{hour % 6 === 0 ? f.hour(hour) : ''}</span>
      {/each}
      {#each WEEKDAYS as weekday (weekday)}
        <span class="day">{weekdayShort(weekday)}</span>
        {#each HOURS as hour (hour)}
          {@const count = punchCount(weekday, hour)}
          <span class="cell" title="{weekdayShort(weekday)} {f.hour(hour)}: {f.number(count)}">
            {#if count > 0}<i style:--s={Math.sqrt(count / punchMax)}></i>{/if}
          </span>
        {/each}
      {/each}
    </div>
    {@render dataTable('punchcard')}
  </AnalyticsPanel>

  <!-- Storage (AnalyticsDashboard.jsx:596-624): the whole volume, never split by subtraction -->
  <AnalyticsPanel
    id="storage"
    kicker={$t('frameleaf_analytics_storage_kicker')}
    title={host.volumeUsedBytes !== null && host.capacityBytes !== null
      ? $t('frameleaf_analytics_storage_title', {
          values: { used: f.size(host.volumeUsedBytes), capacity: f.size(host.capacityBytes) },
        })
      : $t('frameleaf_analytics_volume')}
    caption={$t('frameleaf_analytics_storage_caption')}
    action={{ href: commandCenterUrl('storage'), label: $t('frameleaf_analytics_storage_settings') }}
  >
    {#if !volume}
      <p class="empty" role="status">{$t('frameleaf_analytics_volume_unreadable')}</p>
    {:else}
      <!-- Every segment is a share of the capacity, like the centre figure. -->
      <AnalyticsDonut segments={storageSegments} label={$t('frameleaf_analytics_volume')} format={f.size}>
        {#snippet center()}
          <strong>{Math.round(volume.usedPercent)}%</strong>
          <small>{$t('frameleaf_analytics_used')}</small>
        {/snippet}
      </AnalyticsDonut>
    {/if}
    <p class="note">
      {#if host.breakdown?.exceedsUsed}
        {$t('frameleaf_analytics_parts_exceed')}
      {:else if host.breakdown}
        {$t('frameleaf_analytics_parts_note')}
        {#if host.breakdown.previewsBytes === null || host.breakdown.encodedVideoBytes === null}
          {$t('frameleaf_analytics_parts_not_measured')}
        {/if}
      {:else}
        {$t('frameleaf_analytics_disk_note', {
          values: { scope: report.scopeLabel || $t('frameleaf_analytics_scope_all') },
        })}
      {/if}
      {#if host.breakdown && host.breakdown.onOtherDisk.length > 0}
        {$t('frameleaf_analytics_parts_other_disk')}
      {/if}
      {#if host.freeBytes === null && volume}
        {$t('frameleaf_analytics_not_in_use_note')}
      {/if}
    </p>
    {@render dataTable('originals')}
    {@render dataTable('volume')}
    {@render dataTable('volume-parts')}
  </AnalyticsPanel>

  <!-- Every day (AnalyticsDashboard.jsx:352-420) -->
  <AnalyticsPanel
    id="days"
    wide
    kicker={$t('frameleaf_analytics_days_kicker')}
    title={$t(
      calendar === 'uploaded' ? 'frameleaf_analytics_days_title_uploads' : 'frameleaf_analytics_days_title_captures',
      {
        values: { count: calendarTotal, value: f.number(calendarTotal), days: report.days.length },
      },
    )}
    caption={$t('frameleaf_analytics_days_caption')}
  >
    <label class="an-inline-select">
      {$t('frameleaf_analytics_show')}
      <select bind:value={calendar}>
        <option value="captured">{$t('frameleaf_analytics_date_taken')}</option>
        <option value="uploaded">{$t('frameleaf_analytics_date_uploaded')}</option>
      </select>
    </label>
    <div class="an-heat-scroll">
      <div
        class="an-heat"
        style:--weeks={weeks.length}
        role="img"
        aria-label={$t(
          calendar === 'uploaded' ? 'frameleaf_analytics_upload_calendar' : 'frameleaf_analytics_capture_calendar',
        )}
      >
        {#each weeks as week (week[0].date)}
          {#each week as cell (cell.date)}
            <span
              class="cell"
              data-level={cell.value === null ? 'none' : cell.level}
              title={cell.value === null ? cell.date : `${f.longDate(cell.date)}: ${f.number(cell.value)}`}
            ></span>
          {/each}
        {/each}
      </div>
    </div>
    <div class="an-heat-legend" aria-hidden="true">
      {$t('frameleaf_analytics_less')}
      {#each [0, 1, 2, 3, 4] as level (level)}
        <span class="cell" data-level={level}></span>
      {/each}
      {$t('frameleaf_analytics_more')}
    </div>
    {@render dataTable(`calendar-${calendar}`, $t('frameleaf_analytics_view_daily_counts'))}
  </AnalyticsPanel>

  <!-- Your gear (AnalyticsDashboard.jsx:422-446) -->
  <AnalyticsPanel
    id="gear"
    kicker={$t('frameleaf_analytics_gear_kicker')}
    title={$t('frameleaf_analytics_gear_title')}
    caption={$t('frameleaf_analytics_gear_caption')}
  >
    {#if cameras.length === 0}
      <p class="empty">{$t('frameleaf_analytics_no_items')}</p>
    {:else}
      <AnalyticsLeaderboard rows={cameras} label={$t('frameleaf_analytics_cameras')} format={f.number} />
    {/if}
    <h3 class="an-subhead">{$t('frameleaf_analytics_lenses')}</h3>
    <AnalyticsLeaderboard rows={lenses} label={$t('frameleaf_analytics_lenses')} format={f.number} />
    <h3 class="an-subhead">{$t('frameleaf_analytics_focal_lengths')}</h3>
    <div class="an-focal" role="img" aria-label={$t('frameleaf_analytics_focal_label')}>
      {#each focal as row (row.id)}
        <div class:rest={row.catchAll} title="{row.label}: {f.number(row.count)}">
          <span style:height="{Math.min(100, (row.count / focalMax) * 100)}%"></span>
          <small>{row.label}</small>
        </div>
      {/each}
    </div>
    {@render dataTable('cameras')}
    {@render dataTable('lenses')}
    {@render dataTable('focal-lengths')}
  </AnalyticsPanel>

  <!-- Formats & quality (AnalyticsDashboard.jsx:448-492) -->
  <AnalyticsPanel
    id="formats"
    kicker={$t('frameleaf_analytics_formats_kicker')}
    title={$t('frameleaf_analytics_formats_title')}
    caption={$t('frameleaf_analytics_formats_caption')}
  >
    <AnalyticsDonut
      segments={formats.map((row, index) => ({
        id: row.id,
        label: row.label,
        value: row.count,
        color: row.catchAll ? 'var(--an-4)' : SERIES[index % SERIES.length],
      }))}
      label={$t('frameleaf_analytics_photo_formats')}
      format={f.number}
    >
      {#snippet center()}
        <strong>{f.compact(visiblePhotos)}</strong>
        <small>{$t('photos').toLowerCase()}</small>
      {/snippet}
    </AnalyticsDonut>
    <h3 class="an-subhead">{$t('frameleaf_analytics_video_resolution')}</h3>
    <AnalyticsStackBar
      rows={resolutions}
      label={$t('frameleaf_analytics_video_resolution')}
      format={f.number}
      colors={SERIES}
    />
    <h3 class="an-subhead">{$t('frameleaf_analytics_orientation')}</h3>
    <AnalyticsStackBar
      rows={orientation}
      label={$t('frameleaf_analytics_orientation')}
      format={f.number}
      colors={SERIES}
    />
    <ul class="an-chips">
      <li>
        <Icon icon={mdiMotionPlayOutline} size="15" aria-hidden />{$t('frameleaf_analytics_chip_live', {
          values: { count: insights.livePhotos },
        })}
      </li>
      {#if insights.hdr}
        <li>
          <Icon icon={mdiHdr} size="15" aria-hidden />{$t('frameleaf_analytics_chip_hdr', {
            values: { count: insights.hdr.hdrVideos },
          })}
        </li>
        <li>
          <Icon icon={mdiHdr} size="15" aria-hidden />{$t('frameleaf_analytics_chip_dolby', {
            values: { count: insights.hdr.dolbyVisionVideos },
          })}
        </li>
      {/if}
      <li>
        <Icon icon={mdiCameraIris} size="15" aria-hidden />{$t('frameleaf_analytics_chip_raw', {
          values: { count: report.summary.raw },
        })}
      </li>
    </ul>
    {#if insights.hdr && insights.hdr.probedVideos < report.summary.videos}
      <p class="note">
        {$t('frameleaf_analytics_hdr_probed', {
          values: { probed: f.number(insights.hdr.probedVideos), videos: f.number(report.summary.videos) },
        })}
      </p>
    {/if}
    {@render dataTable('photo-formats')}
    {@render dataTable('video-resolutions')}
    {@render dataTable('orientation')}
  </AnalyticsPanel>

  <!-- People and places (AnalyticsDashboard.jsx:494-536): only the owner reading their own scope -->
  {#if people}
    <AnalyticsPanel
      id="people"
      kicker={$t('frameleaf_analytics_people_kicker')}
      title={$t('frameleaf_analytics_people_title', { values: { count: people.faces } })}
      caption={$t('frameleaf_analytics_people_caption', { values: { count: people.namedPeople } })}
      action={isAdmin
        ? { href: commandCenterUrl('intelligence'), label: $t('frameleaf_analytics_recognition') }
        : { href: Route.people(), label: $t('people') }}
    >
      {#if personRows.length === 0}
        <p class="empty">{$t('frameleaf_analytics_people_none')}</p>
      {:else}
        <AnalyticsLeaderboard rows={personRows} label={$t('frameleaf_analytics_top_people')} format={f.number}>
          {#snippet lead(row)}
            <span class="avatar fl-squircle" aria-hidden="true">
              <img src={personThumbnail(row.id)} alt="" loading="lazy" />
            </span>
          {/snippet}
        </AnalyticsLeaderboard>
      {/if}
      <dl class="an-mini-stats">
        <div>
          <dt>{$t('frameleaf_analytics_items_with_people')}</dt>
          <dd>{f.number(people.itemsWithFaces)}</dd>
        </div>
        <div>
          <dt>{$t('frameleaf_analytics_faces_per_item')}</dt>
          <dd>
            {people.itemsWithFaces ? f.number(Math.round((people.faces / people.itemsWithFaces) * 10) / 10) : '0'}
          </dd>
        </div>
        <div>
          <dt>{$t('frameleaf_analytics_pets_recognized')}</dt>
          <dd>{f.number(people.pets)}</dd>
        </div>
      </dl>
      {@render dataTable('people')}
    </AnalyticsPanel>
    <AnalyticsPanel
      id="places"
      kicker={$t('frameleaf_analytics_places_kicker')}
      title={$t('frameleaf_analytics_places_title', { values: { countries: people.countries, cities: people.cities } })}
      caption={$t('frameleaf_analytics_places_caption', {
        values: { count: people.geotagged, value: f.number(people.geotagged) },
      })}
    >
      <AnalyticsLeaderboard rows={places} label={$t('frameleaf_analytics_places')} format={f.number} />
      {@render dataTable('places')}
    </AnalyticsPanel>
  {:else}
    <AnalyticsPanel
      id="people-places"
      wide
      kicker={$t('frameleaf_analytics_people_places_kicker')}
      title={$t('frameleaf_analytics_people_places_hidden_title')}
      caption={$t('frameleaf_analytics_people_places_hidden')}
    >
      <p class="quiet">
        <Icon icon={mdiAccountGroupOutline} size="16" aria-hidden />{$t(
          'frameleaf_analytics_people_places_hidden_help',
        )}
      </p>
    </AnalyticsPanel>
  {/if}

  <!-- Coverage (AnalyticsDashboard.jsx:538-560) -->
  <AnalyticsPanel
    id="coverage"
    wide
    kicker={$t('frameleaf_analytics_coverage_kicker')}
    title={$t('frameleaf_analytics_coverage_title')}
    caption={$t('frameleaf_analytics_coverage_caption')}
    action={{ href: commandCenterUrl('care'), label: $t('frameleaf_analytics_library_care') }}
  >
    <div class="an-rings">
      {#each coverage as row (row.field)}
        <div>
          <AnalyticsRing value={row.percent} size={86} stroke={8} label="{row.label}: {Math.round(row.percent)}%">
            {Math.round(row.percent)}%
          </AnalyticsRing>
          <span>{row.label}</span>
        </div>
      {/each}
    </div>
  </AnalyticsPanel>

  <!-- Records & milestones (AnalyticsDashboard.jsx:562-594) -->
  <AnalyticsPanel
    id="records"
    wide
    kicker={$t('frameleaf_analytics_records_kicker')}
    title={$t('frameleaf_analytics_records_title')}
  >
    <div class="an-records">
      {#if records.oldestCapture}
        <div class="an-record">
          <Icon icon={mdiClockTimeEightOutline} size="20" aria-hidden />
          <span>{$t('frameleaf_analytics_record_oldest')}</span>
          <strong>{f.longDate(records.oldestCapture.date)}</strong>
          <small
            >{$t('frameleaf_analytics_years_ago', { values: { count: yearsAgo(records.oldestCapture.date) } })}</small
          >
        </div>
      {/if}
      {#if days.busiest}
        <div class="an-record">
          <Icon icon={mdiFire} size="20" aria-hidden />
          <span>{$t('frameleaf_analytics_record_busiest')}</span>
          <strong>{$t('frameleaf_analytics_items_count', { values: { count: f.number(days.busiest.count) } })}</strong>
          <small>{f.longDate(days.busiest.date)}</small>
        </div>
      {/if}
      {#if days.streak}
        <div class="an-record">
          <Icon icon={mdiCalendarCheckOutline} size="20" aria-hidden />
          <span>{$t('frameleaf_analytics_record_streak')}</span>
          <strong>{$t('frameleaf_analytics_days_count', { values: { count: days.streak.length } })}</strong>
          <small>{f.longDate(days.streak.from)} – {f.longDate(days.streak.through)}</small>
        </div>
      {/if}
      <div class="an-record">
        <Icon icon={mdiChartLine} size="20" aria-hidden />
        <span>{$t('frameleaf_analytics_record_daily')}</span>
        <strong>{$t('frameleaf_analytics_per_day', { values: { value: f.number(days.perDay) } })}</strong>
        <small>{$t('frameleaf_analytics_in_selected_dates')}</small>
      </div>
      {#if records.largestFile}
        <div class="an-record">
          <Icon icon={mdiFileVideoOutline} size="20" aria-hidden />
          <span>{$t('frameleaf_analytics_record_largest')}</span>
          <strong>{f.size(records.largestFile.bytes)}</strong>
          <small>{records.largestFile.name ?? $t('frameleaf_analytics_name_private')}</small>
        </div>
      {/if}
      {#if records.longestVideo}
        <div class="an-record">
          <Icon icon={mdiTimerOutline} size="20" aria-hidden />
          <span>{$t('frameleaf_analytics_record_longest')}</span>
          <strong>{f.duration(records.longestVideo.durationMs)}</strong>
          <small>{records.longestVideo.name ?? $t('frameleaf_analytics_name_private')}</small>
        </div>
      {/if}
      <div class="an-record">
        <Icon icon={mdiLayersTripleOutline} size="20" aria-hidden />
        <span>{$t('frameleaf_analytics_record_stack')}</span>
        <strong>{$t('frameleaf_analytics_metres_tall', { values: { value: f.number(printStackMetres) } })}</strong>
        <small>{$t('frameleaf_analytics_record_stack_detail')}</small>
      </div>
      <div class="an-record">
        <Icon icon={mdiRuler} size="20" aria-hidden />
        <span>{$t('frameleaf_analytics_record_line')}</span>
        <strong>{$t('frameleaf_analytics_kilometres', { values: { value: f.number(printLineKm) } })}</strong>
        <small>{$t('frameleaf_analytics_record_line_detail')}</small>
      </div>
    </div>
  </AnalyticsPanel>
</div>

<style>
  .an-dashboard {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 18px;
    margin-bottom: 18px;
  }
  .an-dashboard :global(.data-table) {
    margin-top: 14px;
  }
  .an-dashboard :global(.data-table + .data-table) {
    margin-top: 0;
  }
  .empty {
    display: grid;
    place-content: center;
    min-height: 120px;
    margin: 0;
    color: var(--fl-muted);
    text-align: center;
  }
  .note,
  .quiet {
    margin: 12px 0 0;
    color: var(--fl-muted);
    font-size: 11.5px;
    line-height: 1.55;
  }
  .quiet {
    display: flex;
    align-items: center;
    gap: 8px;
    margin: 0;
  }
  .an-subhead {
    margin: 22px 0 10px;
    color: var(--fl-muted);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.06em;
    text-transform: uppercase;
  }

  /* years */
  .an-years {
    display: grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    align-items: end;
    gap: 6px;
    height: 220px;
  }
  .an-year {
    display: grid;
    grid-template-rows: auto 1fr auto;
    align-items: end;
    height: 100%;
    min-width: 0;
    text-align: center;
  }
  .an-year .bar {
    align-self: end;
    min-height: 3px;
    background: color-mix(in srgb, var(--an-1) 55%, transparent);
    border-radius: 6px 6px 2px 2px;
    transition: background 160ms ease;
  }
  .an-year:hover .bar,
  .an-year.best .bar {
    background: var(--an-1);
  }
  .an-year.partial .bar {
    background: color-mix(in srgb, var(--an-1) 28%, transparent);
    outline: 1px dashed color-mix(in srgb, var(--an-1) 70%, transparent);
    outline-offset: -1px;
  }
  .an-year .value {
    color: var(--fl-muted);
    font-size: 10.5px;
    font-variant-numeric: tabular-nums;
    opacity: 0;
    transition: opacity 160ms ease;
  }
  .an-year:hover .value,
  .an-year.best .value {
    opacity: 1;
  }
  .an-year .label {
    margin-top: 6px;
    color: var(--fl-muted);
    font-size: 11px;
    font-variant-numeric: tabular-nums;
  }

  /* punchcard */
  .an-punch {
    display: grid;
    grid-template-columns: 34px repeat(24, minmax(0, 1fr));
    align-items: center;
    gap: 3px;
  }
  .an-punch .hour {
    color: var(--fl-muted);
    font-size: 10px;
    white-space: nowrap;
  }
  .an-punch .day {
    color: var(--fl-muted);
    font-size: 11px;
  }
  .an-punch .cell {
    display: grid;
    place-items: center;
    aspect-ratio: 1;
  }
  .an-punch .cell i {
    width: calc(18% + var(--s) * 82%);
    aspect-ratio: 1;
    background: color-mix(in srgb, var(--an-1) calc(25% + var(--s) * 75%), transparent);
    border-radius: 50%;
  }

  /* heatmap */
  .an-inline-select {
    display: inline-flex;
    flex-direction: row;
    align-items: center;
    gap: 8px;
    margin: -6px 0 14px;
    color: var(--fl-muted);
    font-size: 12px;
  }
  .an-inline-select select {
    width: auto;
    padding: 5px 28px 5px 9px;
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
    font-size: 12px;
  }
  .an-heat-scroll {
    padding-bottom: 4px;
    overflow-x: auto;
  }
  .an-heat {
    display: grid;
    grid-template-rows: repeat(7, auto);
    grid-auto-columns: minmax(10px, 1fr);
    grid-auto-flow: column;
    gap: 3px;
    min-width: calc(var(--weeks) * 13px);
    /* A year of weeks fills the panel; a short range keeps its squares small. */
    max-width: calc(var(--weeks) * 30px);
  }
  .cell {
    display: block;
    aspect-ratio: 1;
    background: var(--an-cell);
    border-radius: 3px;
  }
  .an-heat-legend .cell {
    width: 12px;
  }
  .cell[data-level='none'] {
    background: transparent;
  }
  .cell[data-level='1'] {
    background: color-mix(in srgb, var(--an-1) 30%, transparent);
  }
  .cell[data-level='2'] {
    background: color-mix(in srgb, var(--an-1) 52%, transparent);
  }
  .cell[data-level='3'] {
    background: color-mix(in srgb, var(--an-1) 76%, transparent);
  }
  .cell[data-level='4'] {
    background: var(--an-1);
  }
  .an-heat-legend {
    display: flex;
    align-items: center;
    justify-content: flex-end;
    gap: 4px;
    margin-top: 10px;
    color: var(--fl-muted);
    font-size: 11px;
  }

  /* focal lengths */
  .an-focal {
    display: grid;
    grid-auto-columns: minmax(0, 1fr);
    grid-auto-flow: column;
    align-items: end;
    gap: 8px;
    height: 110px;
  }
  .an-focal > div {
    display: grid;
    grid-template-rows: 1fr auto;
    align-items: end;
    height: 100%;
    min-width: 0;
    text-align: center;
  }
  .an-focal span {
    min-height: 3px;
    background: var(--an-2);
    border-radius: 5px 5px 2px 2px;
  }
  .an-focal .rest span {
    background: var(--an-4);
  }
  .an-focal small {
    margin-top: 6px;
    overflow: hidden;
    color: var(--fl-muted);
    font-size: 10.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  /* chips, mini stats */
  .an-chips {
    display: flex;
    flex-wrap: wrap;
    gap: 8px;
    margin: 14px 0 0;
    padding: 0;
    list-style: none;
  }
  .an-chips li {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 5px 10px;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-pill);
    font-size: 12px;
    font-variant-numeric: tabular-nums;
  }
  .an-chips li :global(svg) {
    color: var(--fl-accent);
  }
  .avatar {
    display: inline-flex;
    width: 32px;
    height: 32px;
    overflow: hidden;
    background: var(--fl-raised);
  }
  .avatar img {
    width: 100%;
    height: 100%;
    object-fit: cover;
  }
  .an-mini-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin: 22px 0 0;
  }
  .an-mini-stats > div {
    padding: 12px 14px;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .an-mini-stats dt {
    color: var(--fl-muted);
    font-size: 11.5px;
  }
  .an-mini-stats dd {
    margin: 4px 0 0;
    font-size: 19px;
    font-variant-numeric: tabular-nums;
    font-weight: 650;
  }

  /* coverage */
  .an-rings {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(110px, 1fr));
    gap: 18px;
  }
  .an-rings > div {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 10px;
    color: var(--fl-muted);
    font-size: 12.5px;
    text-align: center;
  }

  /* records */
  .an-records {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 12px;
  }
  .an-record {
    display: flex;
    flex-direction: column;
    gap: 3px;
    min-width: 0;
    padding: 16px;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .an-record :global(svg) {
    margin-bottom: 8px;
    color: var(--fl-accent);
  }
  .an-record > span {
    color: var(--fl-muted);
    font-size: 12px;
  }
  .an-record strong {
    font-size: 21px;
    font-variant-numeric: tabular-nums;
    font-weight: 650;
    letter-spacing: -0.02em;
  }
  .an-record small {
    overflow: hidden;
    color: var(--fl-muted);
    font-size: 11.5px;
    text-overflow: ellipsis;
    white-space: nowrap;
  }

  @container (max-width: 900px) {
    .an-records {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
    .an-dashboard {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @container (max-width: 520px) {
    .an-punch .hour {
      font-size: 0;
    }
    .an-mini-stats {
      grid-template-columns: minmax(0, 1fr);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .an-year .bar,
    .an-year .value {
      transition: none;
    }
  }
</style>
