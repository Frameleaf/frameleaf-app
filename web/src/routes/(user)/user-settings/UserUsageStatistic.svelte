<script lang="ts">
  /**
   * Your preferences › Your library in numbers (FL-368, after the approved prototype
   * `settings-v2/server/preferences.jsx`): the headline first ("You have 216 photos and 6 videos.
   * They use 12.4 GB of your 50 GB."), then the smaller counts as facts, then the two year grids
   * under names that say what they count. Every figure is the account's own, from the same calls
   * the page made before.
   */
  import { goto } from '$app/navigation';
  import { getHeatmapRange } from '$lib';
  import CalendarHeatmap from '$lib/components/CalendarHeatmap.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Hero from '$lib/components/frameleaf/settings/kit/Hero.svelte';
  import KitPage from '$lib/components/frameleaf/settings/kit/KitPage.svelte';
  import Meter from '$lib/components/frameleaf/settings/kit/Meter.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import Skeleton from '$lib/elements/Skeleton.svelte';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import {
    AssetVisibility,
    CalendarHeatmapType,
    getAlbumStatistics,
    getAssetStatistics,
    getMyCalendarHeatmap,
    type AlbumStatisticsResponseDto,
    type AssetStatsResponseDto,
  } from '@frameleaf/sdk';
  import { mdiAlertOutline, mdiImageMultipleOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  type Usage = {
    timeline: AssetStatsResponseDto;
    favorites: AssetStatsResponseDto;
    archive: AssetStatsResponseDto;
    trash: AssetStatsResponseDto;
    albums: AlbumStatisticsResponseDto;
  };
  let usage = $state<Usage | null>(null);
  let failed = $state(false);

  const load = async () => {
    failed = false;
    try {
      const [timeline, favorites, archive, trash, albums] = await Promise.all([
        getAssetStatistics({ visibility: AssetVisibility.Timeline }),
        getAssetStatistics({ isFavorite: true }),
        getAssetStatistics({ visibility: AssetVisibility.Archive }),
        getAssetStatistics({ isTrashed: true }),
        getAlbumStatistics(),
      ]);
      usage = { timeline, favorites, archive, trash, albums };
    } catch {
      failed = true;
    }
  };
  onMount(load);

  const count = (value: number) => value.toLocaleString($locale);
  const size = (bytes: number) => getByteUnitString(bytes, $locale);

  // The room used and the limit are on the person's own record.
  const used = $derived(authManager.user.quotaUsageInBytes ?? 0);
  const limit = $derived(authManager.user.quotaSizeInBytes ?? 0);
  const fraction = $derived(limit > 0 ? used / limit : undefined);
  const nearlyFull = $derived(fraction !== undefined && fraction >= 0.9);

  const title = $derived(
    usage
      ? usage.timeline.total === 0
        ? $t('frameleaf_prefs_numbers_empty')
        : $t('frameleaf_prefs_numbers_have', {
            values: { photos: usage.timeline.images, videos: usage.timeline.videos },
          })
      : $t('loading'),
  );
  const body = $derived(
    limit > 0
      ? $t('frameleaf_prefs_numbers_use_limit', { values: { used: size(used), limit: size(limit) } })
      : $t('frameleaf_prefs_numbers_use', { values: { used: size(used) } }),
  );
</script>

<KitPage>
  {#if failed}
    <InlineError message={$t('frameleaf_prefs_numbers_failed')} onRetry={load} />
  {:else}
    <Hero
      tone={nearlyFull ? 'warn' : 'good'}
      icon={nearlyFull ? mdiAlertOutline : mdiImageMultipleOutline}
      {title}
      body={nearlyFull ? `${body} ${$t('frameleaf_prefs_numbers_nearly_full')}` : body}
      label={$t('frameleaf_prefs_numbers_title')}
    >
      {#snippet actions()}
        {#if nearlyFull}
          <Button onclick={() => goto(commandCenterUrl('trash'))}>{$t('frameleaf_prefs_numbers_open_trash')}</Button>
        {/if}
      {/snippet}
      {#if fraction !== undefined}
        <div class="meter">
          <Meter
            label={$t('frameleaf_prefs_numbers_meter')}
            value={size(used)}
            max={$t('frameleaf_prefs_numbers_of', { values: { limit: size(limit) } })}
            {fraction}
          />
        </div>
      {/if}
    </Hero>

    {#if usage}
      <Section
        title={$t('frameleaf_prefs_numbers_inside')}
        description={$t('frameleaf_prefs_numbers_inside_description')}
      >
        <Facts
          rows={[
            { label: $t('favorites'), value: count(usage.favorites.total) },
            { label: $t('frameleaf_prefs_numbers_archived'), value: count(usage.archive.total) },
            { label: $t('frameleaf_prefs_numbers_trash'), value: count(usage.trash.total) },
            {
              label: $t('albums'),
              value: count(usage.albums.owned),
              detail: $t('frameleaf_prefs_numbers_albums_shared', { values: { count: usage.albums.shared } }),
            },
          ]}
        />
      </Section>
    {/if}
  {/if}

  <Section title={$t('frameleaf_prefs_numbers_added')}>
    <div class="grid">
      {#await getMyCalendarHeatmap({ ...getHeatmapRange(), $type: CalendarHeatmapType.Upload })}
        <Skeleton height={80} class="rounded-lg" />
      {:then data}
        <CalendarHeatmap
          {data}
          itemLabel={(item) => $t('upload_day_count', { values: item })}
          totalLabel={(total) => $t('frameleaf_prefs_numbers_added_total', { values: { count: total } })}
        />
      {/await}
    </div>
  </Section>

  <Section title={$t('frameleaf_prefs_numbers_taken')}>
    <div class="grid">
      {#await getMyCalendarHeatmap({ ...getHeatmapRange(), $type: CalendarHeatmapType.Taken })}
        <Skeleton height={80} class="rounded-lg" />
      {:then data}
        <CalendarHeatmap
          {data}
          itemLabel={(item) => $t('asset_day_count', { values: item })}
          totalLabel={(total) => $t('frameleaf_prefs_numbers_taken_total', { values: { count: total } })}
        />
      {/await}
    </div>
  </Section>
</KitPage>

<style>
  .meter {
    padding: var(--fl-space-4) var(--fl-space-6);
    border-top: 1px solid var(--fl-border);
  }
  /* A year of days is wider than a phone: the grid scrolls sideways inside its group. */
  .grid {
    padding-bottom: var(--fl-space-5);
    overflow-x: auto;
  }
  /* As the prototype's year grids: the whole year fits the card, the weekday names in their own
     column and every week sharing the rest, so today's square is in view instead of past the edge. */
  .grid :global(.grid-flow-col) {
    grid-template-columns: auto;
    grid-auto-columns: minmax(0, 1fr);
  }
</style>
