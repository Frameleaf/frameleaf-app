<script lang="ts">
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import {
    histogramBarLabel,
    histogramBars,
    operatorToken,
    PALETTE_ENRICHMENT_FILTERS,
    type HistogramBar,
    type HistogramUnit,
    type PaletteFacets,
  } from '$lib/frameleaf/search-palette';
  import { getAssetMediaUrl } from '$lib/utils';
  import {
    AssetMediaSize,
    AssetTypeEnum,
    ImageEnrichmentFilter,
    SearchFacetField,
    type AssetResponseDto,
    type PersonResponseDto,
    type SearchHistogramBucketDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiEyeOffOutline, mdiTextBoxOutline } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  /**
   * The search palette's side column (`<aside className="sp-side">` in `SearchPalette.jsx`): a preview
   * of the active result, the "When" histogram that narrows on click, and facet refinement for people,
   * media, places, cameras, rating and the enrichment quick filters. It only shows the palette's
   * server answers and reports picks back; it holds no search state of its own.
   */

  let {
    previewAsset,
    histogram,
    typing,
    facets,
    people,
    selectedPeople,
    tokens,
    enrichment,
    enrichmentCounts,
    onNarrow,
    onAddToken,
    onPickPerson,
    onToggleEnrichment,
  }: {
    previewAsset?: AssetResponseDto;
    histogram: { unit: HistogramUnit; buckets: SearchHistogramBucketDto[] };
    /** Whether anything is typed: the refinement facets show only then, the places facet only before. */
    typing: boolean;
    facets: PaletteFacets;
    people: PersonResponseDto[];
    selectedPeople: Set<string>;
    tokens: string[];
    enrichment?: ImageEnrichmentFilter;
    enrichmentCounts: Partial<Record<ImageEnrichmentFilter, number>>;
    onNarrow: (bar: HistogramBar) => void;
    onAddToken: (raw: string) => void;
    onPickPerson: (id: string, name: string | undefined) => void;
    onToggleEnrichment: (value: ImageEnrichmentFilter) => void;
  } = $props();

  const ENRICHMENT_ICONS = { description: mdiTextBoxOutline, failed: mdiAlertCircleOutline, review: mdiEyeOffOutline };

  const bars = $derived(histogramBars(histogram.buckets, histogram.unit));
  const barMax = $derived(Math.max(1, ...bars.map((bar) => bar.count)));
  const barLabel = (bar: (typeof bars)[number]) => histogramBarLabel(bar, histogram.unit, $locale ?? undefined);

  const tokenSet = $derived(new Set(tokens));
  const refine = $derived(
    [
      {
        key: 'type',
        labelKey: 'media' as const,
        values: facets[SearchFacetField.Type] ?? [],
        token: (value: string) => operatorToken('type', value === AssetTypeEnum.Video ? 'video' : 'photo'),
        label: (value: string) => $t(value === AssetTypeEnum.Video ? 'videos' : 'photos'),
      },
      {
        key: 'place',
        labelKey: 'places' as const,
        values: facets[SearchFacetField.City] ?? [],
        token: (value: string) => operatorToken('place', value),
        label: (value: string) => value,
      },
      {
        key: 'camera',
        labelKey: 'frameleaf_search_cameras' as const,
        values: facets[SearchFacetField.Make] ?? [],
        token: (value: string) => operatorToken('camera', value),
        label: (value: string) => value,
      },
      {
        key: 'rating',
        labelKey: 'rating' as const,
        values: (facets[SearchFacetField.Rating] ?? []).filter((item) => Number(item.value) >= 3),
        token: (value: string) => operatorToken('rating', value),
        label: (value: string) => $t('frameleaf_search_rating_facet', { values: { count: Number(value) } }),
      },
    ].map((group) => ({ ...group, values: group.values.filter((item) => item.count > 0).slice(0, 5) })),
  );

  const peopleFacet = $derived(
    (facets[SearchFacetField.People] ?? [])
      .filter((item) => item.count > 0)
      .slice(0, 6)
      .map((item) => ({ ...item, person: people.find((person) => person.id === item.value) }))
      .filter((item) => item.person),
  );

  const quickEnrichment = $derived(
    PALETTE_ENRICHMENT_FILTERS.filter(
      (item) => enrichmentCounts[item.value] !== undefined || enrichment === item.value,
    ),
  );

  const formatDate = (value: string | undefined) =>
    value ? new Date(value).toLocaleDateString($locale ?? undefined, { dateStyle: 'medium', timeZone: 'UTC' }) : '';

  const thumbnail = (asset: AssetResponseDto) =>
    getAssetMediaUrl({ id: asset.id, size: AssetMediaSize.Preview, cacheKey: asset.thumbhash });
</script>

<aside class="sp-side" aria-label={$t('frameleaf_search_refine')}>
  {#if previewAsset}
    <figure class="sp-preview">
      <img src={thumbnail(previewAsset)} alt={previewAsset.originalFileName} />
      <figcaption>
        <strong>{previewAsset.originalFileName}</strong>
        <span>
          {[formatDate(previewAsset.localDateTime), previewAsset.exifInfo?.city].filter(Boolean).join(' · ')}
        </span>
      </figcaption>
    </figure>
  {/if}

  {#if bars.length > 1}
    <section>
      <h3>{$t('frameleaf_search_when')}</h3>
      <div
        class="sp-histogram"
        role="group"
        aria-label={$t('frameleaf_search_matches_by', { values: { unit: histogram.unit } })}
      >
        {#each bars as bar (bar.start)}
          <button
            type="button"
            disabled={bar.count === 0}
            title="{barLabel(bar)}: {bar.count.toLocaleString()}"
            aria-label={$t('frameleaf_search_bar_label', {
              values: { label: barLabel(bar), count: bar.count },
            })}
            style:--h="{Math.max(4, (bar.count / barMax) * 100)}%"
            onclick={() => onNarrow(bar)}
          ></button>
        {/each}
      </div>
      <div class="sp-histogram-axis">
        <span>{barLabel(bars[0])}</span>
        <span>{barLabel(bars.at(-1)!)}</span>
      </div>
    </section>
  {/if}

  {#if typing && peopleFacet.length > 0}
    <section>
      <h3>{$t('people')}</h3>
      <div class="sp-facet-people">
        {#each peopleFacet as item (item.value)}
          <button
            type="button"
            aria-pressed={selectedPeople.has(item.value)}
            aria-label={item.person?.name || $t('no_name')}
            onclick={() => onPickPerson(item.value, item.person?.name)}
          >
            <PersonAvatar person={item.person} size={28} />
            <small>{item.count.toLocaleString()}</small>
          </button>
        {/each}
      </div>
    </section>
  {/if}

  {#if typing}
    {#each refine as group (group.key)}
      {#if group.values.length > 0}
        <section>
          <h3>{$t(group.labelKey)}</h3>
          <div class="sp-facets">
            {#each group.values as item (item.value)}
              <button
                type="button"
                aria-pressed={tokenSet.has(group.token(item.value))}
                onclick={() => onAddToken(group.token(item.value))}
              >
                {group.label(item.value)}
                <small>{item.count.toLocaleString()}</small>
              </button>
            {/each}
          </div>
        </section>
      {/if}
    {/each}
  {/if}

  {#if quickEnrichment.length > 0}
    <section>
      <h3>{$t('frameleaf_search_enrichment')}</h3>
      <div class="sp-facets">
        {#each quickEnrichment as item (item.value)}
          <button type="button" aria-pressed={enrichment === item.value} onclick={() => onToggleEnrichment(item.value)}>
            <Icon icon={ENRICHMENT_ICONS[item.icon]} size="14" aria-hidden={true} />
            {$t(item.labelKey)}
            {#if enrichmentCounts[item.value] !== undefined}
              <small>{enrichmentCounts[item.value]?.toLocaleString()}</small>
            {/if}
          </button>
        {/each}
      </div>
    </section>
  {/if}

  {#if !typing && (facets[SearchFacetField.City] ?? []).length > 0}
    <section>
      <h3>{$t('places')}</h3>
      <div class="sp-facets">
        {#each facets[SearchFacetField.City] ?? [] as item (item.value)}
          <button type="button" onclick={() => onAddToken(operatorToken('place', item.value))}>
            {item.value}
            <small>{item.count.toLocaleString()}</small>
          </button>
        {/each}
      </div>
    </section>
  {/if}
</aside>

<style>
  .sp-side {
    overflow: auto;
    padding: 14px 18px;
    display: grid;
    align-content: start;
    gap: 18px;
    border-inline-start: 1px solid var(--sp-edge);
    background: color-mix(in srgb, var(--fl-canvas) 30%, transparent);
    font-size: 13px;
  }
  button {
    font: inherit;
    color: inherit;
    cursor: pointer;
  }
  h3 {
    margin: 0 0 6px;
    font-size: 11px;
    font-weight: 600;
    letter-spacing: 0.04em;
    text-transform: uppercase;
    color: var(--fl-muted);
  }
  small {
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
  /* side: preview, histogram, facets */
  .sp-preview {
    margin: 0;
    display: grid;
    gap: 8px;
  }
  .sp-preview img {
    width: 100%;
    aspect-ratio: 4 / 3;
    object-fit: cover;
    border-radius: 12px;
  }
  .sp-preview figcaption {
    display: grid;
    gap: 2px;
    overflow-wrap: anywhere;
  }
  .sp-preview figcaption span {
    color: var(--fl-muted);
  }
  .sp-histogram {
    display: flex;
    align-items: flex-end;
    gap: 2px;
    height: 64px;
  }
  .sp-histogram button {
    flex: 1;
    min-width: 3px;
    height: var(--h);
    border: 0;
    padding: 0;
    border-radius: 3px 3px 1px 1px;
    background: color-mix(in srgb, var(--fl-accent) 55%, transparent);
    transition: background-color 120ms ease;
  }
  .sp-histogram button:hover {
    background: var(--fl-accent);
  }
  .sp-histogram button:disabled {
    background: var(--sp-row);
    cursor: default;
  }
  .sp-histogram-axis {
    display: flex;
    justify-content: space-between;
    margin-top: 4px;
    color: var(--fl-muted);
    font-size: 11px;
  }
  .sp-facets,
  .sp-facet-people {
    display: flex;
    flex-wrap: wrap;
    gap: 6px;
  }
  .sp-facets button,
  .sp-facet-people button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    padding: 4px 10px;
    border: 1px solid var(--sp-edge);
    border-radius: 999px;
    background: transparent;
  }
  .sp-facet-people button {
    padding: 3px 8px 3px 3px;
  }
  .sp-facets button:hover,
  .sp-facet-people button:hover {
    background: var(--sp-row);
  }
  .sp-facets button[aria-pressed='true'],
  .sp-facet-people button[aria-pressed='true'] {
    background: var(--sp-active);
    border-color: transparent;
  }

  @media (max-width: 760px) {
    .sp-side {
      border-inline-start: 0;
      border-top: 1px solid var(--sp-edge);
    }
    .sp-preview {
      display: none;
    }
  }
</style>
