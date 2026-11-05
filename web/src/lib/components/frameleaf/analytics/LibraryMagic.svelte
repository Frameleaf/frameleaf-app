<script lang="ts">
  /**
   * Library magic (approved design, 2026-11-04, `settings-v2/overnight/analytics/Dashboard.jsx`):
   * the year in colour, the light, seasons, your tags, far and wide, looking ahead and under the hood.
   * The server works the numbers out from the photos (`insights.magic`); the forecast is the report's
   * own pace (`forecast`). Shutter counts and altitude are not recorded, so they are left out.
   */
  import AnalyticsPanel from '$lib/components/frameleaf/analytics/AnalyticsPanel.svelte';
  import { analyticsFormats, type Translate } from '$lib/frameleaf/analytics';
  import { colourName, forecast, laps } from '$lib/frameleaf/library-magic';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { locale } from '$lib/stores/preferences.store';
  import type { AnalyticsInsightsDto, AnalyticsMagicDto, AnalyticsReportResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAirplane,
    mdiArrowDownBold,
    mdiCameraOutline,
    mdiImageFilterHdr,
    mdiArrowUpBold,
    mdiDatabaseOutline,
    mdiFaceRecognition,
    mdiFlowerOutline,
    mdiImageMultipleOutline,
    mdiImageSearchOutline,
    mdiLeaf,
    mdiSnowflake,
    mdiWhiteBalanceSunny,
  } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  type Props = { report: AnalyticsReportResponseDto; insights: AnalyticsInsightsDto; magic: AnalyticsMagicDto };
  let { report, insights, magic }: Props = $props();

  const tr: Translate = (key, values) => $t(key as Translations, { values });
  const f = $derived(analyticsFormats($locale, tr));
  const pct = (part: number, whole: number) => (whole > 0 ? Math.round((part / whole) * 100) : 0);
  const monthName = (month: number, style: 'short' | 'long' = 'short') =>
    new Intl.DateTimeFormat($locale, { month: style, timeZone: 'UTC' }).format(Date.UTC(2026, month - 1, 15));
  const monthYear = (date: Date) => new Intl.DateTimeFormat($locale, { month: 'short', year: 'numeric' }).format(date);
  const colourWord = (hex: string) => $t(`frameleaf_magic_colour_${colourName(hex)}` as Translations);

  // ── Your year in colour ──
  const months = $derived(
    Array.from({ length: 12 }, (_, index) => magic.colourByMonth.find((row) => row.month === index + 1) ?? null),
  );
  /** July and October, as the design writes it; otherwise the two months with the most photos. */
  const colourTitle = $derived.by(() => {
    const pair = [months[6], months[9]].every(Boolean)
      ? [months[6]!, months[9]!]
      : [...magic.colourByMonth].sort((a, b) => b.photos - a.photos).slice(0, 2);
    if (pair.length === 0) {
      return '';
    }
    const [first, second] = pair;
    const one = $t('frameleaf_magic_colour_in', {
      values: { colour: colourWord(first.colour), month: monthName(first.month, 'long') },
    });
    return second
      ? `${one}, ${$t('frameleaf_magic_colour_in', { values: { colour: colourWord(second.colour).toLocaleLowerCase($locale), month: monthName(second.month, 'long') } })}`
      : one;
  });

  // ── Light ──
  const light = $derived(magic.light);
  const golden = $derived(light.goldenMorning + light.goldenEvening);
  const lit = $derived(golden + light.blueHour + light.daylight + light.night);
  const hours = $derived(
    Array.from({ length: 24 }, (_, hour) =>
      insights.punchcard.filter((cell) => cell.hour === hour).reduce((sum, cell) => sum + cell.count, 0),
    ),
  );
  const hourMax = $derived(Math.max(1, ...hours));
  /** Where the sun usually is at each hour, for the bars' colour only; the counts are the server's. */
  const zone = (hour: number) =>
    hour < 5 || hour > 21 ? 'night' : hour === 5 || hour === 21 ? 'blue' : hour === 6 || hour === 20 ? 'golden' : 'day';
  const lightRows = $derived([
    ['golden', golden],
    ['blue', light.blueHour],
    ['day', light.daylight],
    ['night', light.night],
  ] as const);

  // ── Seasons ──
  const SEASONS = [
    ['spring', mdiFlowerOutline],
    ['summer', mdiWhiteBalanceSunny],
    ['autumn', mdiLeaf],
    ['winter', mdiSnowflake],
  ] as const;
  const seasonTotal = $derived(SEASONS.reduce((sum, [id]) => sum + magic.seasons[id], 0));
  const favourite = $derived([...SEASONS].sort((a, b) => magic.seasons[b[0]] - magic.seasons[a[0]])[0][0]);

  // ── Far and wide ──
  const geo = $derived(magic.farAndWide);

  // ── Looking ahead ──
  const ahead = $derived(forecast(report.series, report.summary, report.host));

  // ── Under the hood ──
  const hood = $derived(magic.underTheHood);

  // ── What the AI sees ──
  const seen = $derived(magic.seen);
  const seenName = (id: string) => $t(`frameleaf_magic_seen_${id}` as Translations);
  const listFormat = $derived(new Intl.ListFormat($locale, { style: 'long', type: 'conjunction' }));

  // ── Shutter count ──
  /** A typical mechanical shutter rating, for scale: makers rate mid-range bodies at 150,000 to 300,000. */
  const SHUTTER_RATING = 200_000;
  const shutterTop = $derived(magic.shutter[0]);
</script>

<header class="an-band" id="an-magic">
  <p class="an-kicker">{$t('frameleaf_magic_kicker')}</p>
  <h2>{$t('frameleaf_magic_title')}</h2>
  <p>{$t('frameleaf_magic_body')}</p>
</header>

{#if magic.colourByMonth.length > 0}
  <AnalyticsPanel
    id="colour"
    wide
    kicker={$t('frameleaf_magic_colour_kicker')}
    title={colourTitle}
    caption={$t('frameleaf_magic_colour_caption')}
  >
    <ol class="an-colours" aria-label={$t('frameleaf_magic_colour_label')}>
      {#each months as month, index (index)}
        <li>
          <span class="swatch" class:empty={!month} style:background={month?.colour} aria-hidden="true"></span>
          <strong>{monthName(index + 1)}</strong>
          <small>{month ? colourWord(month.colour) : $t('frameleaf_magic_colour_none')}</small>
        </li>
      {/each}
    </ol>
  </AnalyticsPanel>
{/if}

{#if lit > 0}
  <AnalyticsPanel
    id="light"
    kicker={$t('frameleaf_magic_light_kicker')}
    title={$t('frameleaf_magic_light_title', { values: { percent: pct(golden, lit) } })}
    caption={$t('frameleaf_magic_light_caption')}
  >
    <div class="an-light" role="img" aria-label={$t('frameleaf_magic_light_chart')}>
      {#each hours as count, hour (hour)}
        <span class="hour" data-zone={zone(hour)}><i style:height="{Math.max(3, (count / hourMax) * 100)}%"></i></span>
      {/each}
    </div>
    <div class="an-light-axis" aria-hidden="true">
      {#each [0, 6, 12, 18, 0] as hour, index (index)}<span
          >{new Intl.DateTimeFormat($locale, { hour: 'numeric' }).format(new Date(2026, 0, 1, hour))}</span
        >{/each}
    </div>
    <ul class="an-light-key">
      {#each lightRows as [id, count] (id)}
        <li data-zone={id}>
          <i aria-hidden="true"></i>{$t(`frameleaf_magic_light_${id}` as Translations)}
          <strong>{f.number(count)}</strong>
          <small>{pct(count, lit)}%</small>
        </li>
      {/each}
    </ul>
    {#if golden > 0}<p class="an-note">
        {light.goldenEvening >= light.goldenMorning
          ? $t('frameleaf_magic_light_sunset', { values: { percent: pct(light.goldenEvening, golden) } })
          : $t('frameleaf_magic_light_sunrise', { values: { percent: pct(light.goldenMorning, golden) } })}
        {$t('frameleaf_magic_light_dark', { values: { count: f.number(light.blueHour + light.night) } })}
      </p>{/if}
  </AnalyticsPanel>
{/if}

{#if seasonTotal > 0}
  <AnalyticsPanel
    id="seasons"
    kicker={$t('frameleaf_magic_seasons_kicker')}
    title={$t('frameleaf_magic_seasons_title', {
      values: { season: $t(`frameleaf_magic_season_${favourite}` as Translations) },
    })}
    caption={$t('frameleaf_magic_seasons_caption', { values: { percent: pct(magic.seasons[favourite], seasonTotal) } })}
  >
    <ul class="an-seasons">
      {#each SEASONS as [id, icon] (id)}
        <li>
          <Icon {icon} size="22" aria-hidden />
          <span>{$t(`frameleaf_magic_season_${id}` as Translations)}</span>
          <strong>{pct(magic.seasons[id], seasonTotal)}%</strong>
          <small>{f.number(magic.seasons[id])}</small>
          <span class="bar" aria-hidden="true"
            ><i style:width="{pct(magic.seasons[id], magic.seasons[favourite])}%"></i></span
          >
        </li>
      {/each}
    </ul>
  </AnalyticsPanel>
{/if}

{#if seen && seen.labels.length > 0}
  {@const max = Math.max(1, ...seen.labels.map((row) => row.count))}
  <AnalyticsPanel
    id="seen"
    kicker={$t('frameleaf_magic_seen_kicker')}
    title={$t('frameleaf_magic_seen_title', {
      values: {
        names: listFormat.format(seen.labels.slice(0, 3).map((row) => seenName(row.id))),
      },
    })}
    caption={$t('frameleaf_magic_seen_caption', {
      values: { count: seen.described, shown: f.number(seen.described) },
    })}
    action={{ href: commandCenterUrl('intelligence', 'smart-search'), label: $t('frameleaf_magic_seen_link') }}
  >
    <ul class="an-cloud" aria-label={$t('frameleaf_magic_seen_kicker')}>
      {#each seen.labels.slice(0, 16) as row (row.id)}
        <li style:--w={(0.55 + (row.count / max) * 0.45).toFixed(2)}>
          {seenName(row.id)}<small>{f.compact(row.count)}</small>
        </li>
      {/each}
    </ul>
  </AnalyticsPanel>
{/if}

{#if magic.topTags.length > 0}
  {@const max = Math.max(1, ...magic.topTags.map((row) => row.count))}
  <AnalyticsPanel
    id="tags"
    kicker={$t('frameleaf_magic_tags_kicker')}
    title={$t('frameleaf_magic_tags_title', {
      values: {
        names: magic.topTags
          .slice(0, 3)
          .map((row) => row.name)
          .join(', '),
      },
    })}
    caption={$t('frameleaf_magic_tags_caption')}
  >
    <ul class="an-cloud" aria-label={$t('frameleaf_magic_tags_kicker')}>
      {#each magic.topTags as row (row.name)}
        <li style:--w={(0.55 + (row.count / max) * 0.45).toFixed(2)}>
          {row.name}<small>{f.compact(row.count)}</small>
        </li>
      {/each}
    </ul>
  </AnalyticsPanel>
{/if}

{#if geo}
  <AnalyticsPanel
    id="far"
    kicker={$t('frameleaf_magic_far_kicker')}
    title={$t('frameleaf_magic_far_title', {
      values: { km: f.number(Math.round(geo.travelledKm)), laps: f.number(laps(geo.travelledKm)) },
    })}
    caption={$t('frameleaf_magic_far_caption')}
    action={{ href: commandCenterUrl('care'), label: $t('frameleaf_magic_far_link') }}
  >
    <ul class="an-extremes">
      {#if geo.farthest}<li>
          <Icon icon={mdiAirplane} size="18" aria-hidden /><span
            ><small>{$t('frameleaf_magic_far_farthest')}</small>{geo.farthest.place ??
              $t('frameleaf_magic_far_unnamed')}</span
          ><strong
            >{$t('frameleaf_analytics_kilometres', {
              values: { value: f.number(Math.round(geo.farthest.km)) },
            })}</strong
          >
        </li>{/if}
      {#if geo.northernmost}<li>
          <Icon icon={mdiArrowUpBold} size="18" aria-hidden /><span
            ><small>{$t('frameleaf_magic_far_north')}</small>{geo.northernmost.place ??
              $t('frameleaf_magic_far_unnamed')}</span
          ><strong>{f.number(Math.round(geo.northernmost.latitude * 10) / 10)}°</strong>
        </li>{/if}
      {#if geo.southernmost}<li>
          <Icon icon={mdiArrowDownBold} size="18" aria-hidden /><span
            ><small>{$t('frameleaf_magic_far_south')}</small>{geo.southernmost.place ??
              $t('frameleaf_magic_far_unnamed')}</span
          ><strong>{f.number(Math.round(geo.southernmost.latitude * 10) / 10)}°</strong>
        </li>{/if}
      {#if geo.highest}<li>
          <Icon icon={mdiImageFilterHdr} size="18" aria-hidden /><span
            ><small>{$t('frameleaf_magic_far_highest')}</small>{geo.highest.place ??
              $t('frameleaf_magic_far_unnamed')}</span
          ><strong>{$t('frameleaf_magic_metres', { values: { value: f.number(geo.highest.metres) } })}</strong>
        </li>{/if}
    </ul>
  </AnalyticsPanel>
{/if}

<AnalyticsPanel
  id="ahead"
  kicker={$t('frameleaf_magic_ahead_kicker')}
  title={ahead
    ? $t('frameleaf_magic_ahead_title', {
        values: { count: ahead.milestone, shown: f.number(ahead.milestone), date: monthYear(ahead.milestoneOn) },
      })
    : $t('frameleaf_magic_ahead_none_title')}
  caption={ahead ? $t('frameleaf_magic_ahead_caption') : $t('frameleaf_magic_ahead_none_caption')}
  action={ahead ? { href: commandCenterUrl('storage'), label: $t('frameleaf_analytics_storage_settings') } : undefined}
>
  {#if ahead}<dl class="an-mini-stats">
      <div>
        <dt>{$t('frameleaf_magic_ahead_per_month')}</dt>
        <dd>{f.number(ahead.perMonth)}</dd>
      </div>
      <div>
        <dt>{$t('frameleaf_magic_ahead_growing')}</dt>
        <dd>{$t('frameleaf_magic_ahead_per_month_size', { values: { size: f.size(ahead.bytesPerMonth) } })}</dd>
      </div>
      <div>
        <dt>{$t('frameleaf_magic_ahead_full')}</dt>
        <dd>{ahead.fullOn ? monthYear(ahead.fullOn) : $t('frameleaf_magic_ahead_not_at_pace')}</dd>
      </div>
    </dl>{/if}
</AnalyticsPanel>

<AnalyticsPanel
  id="shutter"
  kicker={$t('frameleaf_magic_shutter_kicker')}
  title={shutterTop
    ? $t('frameleaf_magic_shutter_title', {
        values: { camera: shutterTop.camera, count: f.number(shutterTop.count) },
      })
    : $t('frameleaf_magic_shutter_none_title')}
  caption={shutterTop
    ? $t('frameleaf_magic_shutter_caption', { values: { rated: f.number(SHUTTER_RATING) } })
    : $t('frameleaf_magic_shutter_none_caption')}
>
  {#if shutterTop}<ul class="an-shutters">
      {#each magic.shutter as row (row.camera)}
        {@const share = Math.min(100, Math.round((row.count / SHUTTER_RATING) * 100))}
        <li>
          <span class="name"><Icon icon={mdiCameraOutline} size="16" aria-hidden />{row.camera}</span>
          <strong>{f.number(row.count)}</strong>
          <span class="life" aria-hidden="true"><i style:width="{share}%"></i></span>
          <small>{$t('frameleaf_magic_shutter_share', { values: { percent: share } })}</small>
        </li>
      {/each}
    </ul>{/if}
</AnalyticsPanel>

<AnalyticsPanel
  id="hood"
  wide
  kicker={$t('frameleaf_magic_hood_kicker')}
  title={$t('frameleaf_magic_hood_title', {
    values: {
      count: hood.searchVectors + hood.faceVectors,
      shown: f.compact(hood.searchVectors + hood.faceVectors),
    },
  })}
  caption={$t('frameleaf_magic_hood_caption')}
  action={{ href: commandCenterUrl('processing'), label: $t('frameleaf_magic_hood_link') }}
>
  <dl class="an-hood">
    {#each [[mdiImageSearchOutline, 'frameleaf_magic_hood_search', f.number(hood.searchVectors)], [mdiFaceRecognition, 'frameleaf_magic_hood_faces', f.number(hood.faceVectors)], [mdiImageMultipleOutline, 'frameleaf_magic_hood_previews', f.number(hood.previews)], [mdiDatabaseOutline, 'frameleaf_magic_hood_rows', f.compact(hood.databaseRows)]] as const as [icon, label, value] (label)}
      <div>
        <Icon {icon} size="18" aria-hidden />
        <dt>{$t(label)}</dt>
        <dd>{value}</dd>
      </div>
    {/each}
  </dl>
</AnalyticsPanel>

<style>
  .an-band {
    grid-column: 1 / -1;
    margin: 18px 0 0;
  }
  .an-band h2 {
    margin: 0;
    font-size: var(--fl-font-display);
    font-weight: 650;
    letter-spacing: -0.02em;
  }
  .an-band p:last-child {
    margin: 6px 0 0;
    color: var(--fl-muted);
  }
  .an-kicker {
    margin: 0 0 6px;
    color: var(--fl-accent);
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.08em;
    text-transform: uppercase;
  }
  .an-colours {
    display: grid;
    grid-template-columns: repeat(12, minmax(0, 1fr));
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .an-colours li {
    display: grid;
    gap: 4px;
    text-align: center;
  }
  .an-colours .swatch {
    height: 72px;
    border-radius: var(--fl-radius-sm);
    box-shadow: inset 0 0 0 1px rgb(0 0 0 / 8%);
  }
  .an-colours .swatch.empty {
    background: repeating-linear-gradient(135deg, var(--fl-raised) 0 6px, transparent 6px 12px);
  }
  .an-colours strong {
    font-size: var(--fl-font-small);
  }
  .an-colours small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .an-light {
    display: grid;
    grid-template-columns: repeat(24, minmax(0, 1fr));
    align-items: end;
    gap: 2px;
    height: 96px;
  }
  .an-light .hour {
    display: flex;
    align-items: flex-end;
    height: 100%;
    border-radius: 3px;
  }
  .an-light .hour i {
    width: 100%;
    border-radius: 3px;
  }
  [data-zone='night'] {
    --tone: #3b4a6b;
  }
  [data-zone='blue'] {
    --tone: #4f7fc4;
  }
  [data-zone='golden'] {
    --tone: #e0a43a;
  }
  [data-zone='day'] {
    --tone: #8fb6d9;
  }
  .an-light .hour {
    background: color-mix(in srgb, var(--tone), transparent 85%);
  }
  .an-light .hour i {
    background: var(--tone);
  }
  .an-light-axis {
    display: flex;
    justify-content: space-between;
    margin-top: 6px;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .an-light-key {
    display: grid;
    gap: 6px;
    margin: 14px 0 0;
    padding: 0;
    list-style: none;
  }
  .an-light-key li {
    display: grid;
    grid-template-columns: 12px 1fr auto 3.5em;
    align-items: center;
    gap: 8px;
  }
  .an-light-key i {
    width: 10px;
    height: 10px;
    border-radius: 3px;
    background: var(--tone);
  }
  .an-light-key strong,
  .an-seasons strong,
  .an-extremes strong,
  .an-hood dd {
    font-variant-numeric: tabular-nums;
  }
  .an-light-key small,
  .an-seasons small {
    color: var(--fl-muted);
    text-align: end;
  }
  .an-note {
    margin: 14px 0 0;
    color: var(--fl-muted);
  }
  .an-seasons {
    display: grid;
    gap: 10px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .an-seasons li {
    display: grid;
    grid-template-columns: 22px 1fr auto 4em;
    align-items: center;
    gap: 4px 10px;
  }
  .an-seasons .bar {
    grid-column: 2 / -1;
    height: 6px;
    border-radius: 3px;
    background: var(--fl-raised);
  }
  .an-seasons .bar i {
    display: block;
    height: 100%;
    border-radius: 3px;
    background: var(--fl-accent);
  }
  .an-cloud {
    display: flex;
    flex-wrap: wrap;
    gap: 8px 14px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .an-cloud li {
    font-size: calc(var(--fl-font-headline) * var(--w));
    font-weight: 600;
  }
  .an-cloud small {
    margin-inline-start: 4px;
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    font-weight: 400;
  }
  .an-shutters {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .an-shutters li {
    display: grid;
    grid-template-columns: minmax(0, 1fr) auto;
    gap: 6px 12px;
    align-items: center;
  }
  .an-shutters .name {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
  .an-shutters strong {
    font-variant-numeric: tabular-nums;
  }
  .an-shutters .life {
    height: 6px;
    border-radius: 3px;
    background: var(--fl-raised);
  }
  .an-shutters .life i {
    display: block;
    height: 100%;
    border-radius: 3px;
    background: var(--fl-accent);
  }
  .an-shutters small {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .an-extremes {
    display: grid;
    gap: 12px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .an-extremes li {
    display: grid;
    grid-template-columns: 18px 1fr auto;
    align-items: center;
    gap: 10px;
  }
  .an-extremes small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .an-mini-stats {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 10px;
    margin: 0;
  }
  .an-mini-stats > div,
  .an-hood > div {
    padding: 12px 14px;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .an-mini-stats dt,
  .an-hood dt {
    color: var(--fl-muted);
    font-size: 11.5px;
  }
  .an-mini-stats dd,
  .an-hood dd {
    margin: 4px 0 0;
    font-size: 19px;
    font-weight: 650;
    font-variant-numeric: tabular-nums;
  }
  .an-hood {
    display: grid;
    grid-template-columns: repeat(4, minmax(0, 1fr));
    gap: 10px;
    margin: 0;
  }
  @media (max-width: 700px) {
    .an-colours {
      grid-template-columns: repeat(6, minmax(0, 1fr));
    }
    .an-hood,
    .an-mini-stats {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
