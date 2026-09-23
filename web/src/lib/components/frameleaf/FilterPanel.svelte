<script lang="ts" module>
  import type { PersonResponseDto, PetResponseDto } from '@immich/sdk';

  /** Option lists for the panel's controls, loaded by the caller from the production APIs. */
  export type FilterPanelOptions = {
    people: PersonResponseDto[];
    /** FL-58: the account's own visible pets. */
    pets: PetResponseDto[];
    tags: { value: string; label: string }[];
    albums: { value: string; label: string }[];
    cities: string[];
    states: string[];
    countries: string[];
    makes: string[];
    models: string[];
    lenses: string[];
  };
</script>

<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import FilterMultiSelect from '$lib/components/frameleaf/FilterMultiSelect.svelte';
  import Picker from '$lib/components/frameleaf/Picker.svelte';
  import SegmentedControl from '$lib/components/frameleaf/SegmentedControl.svelte';
  import type { ComboBoxOption } from '$lib/components/shared-components/Combobox.svelte';
  import {
    withDiscoveryEnrichment,
    withoutDiscoveryFilters,
    type DiscoveryFilterSection,
    type DiscoveryQuery,
  } from '$lib/components/discovery/query';
  import {
    captureDateControlValue,
    captureDateHasCustomCondition,
    CUSTOM_CONDITION,
    ENRICHMENT_OPTIONS,
    equalityControlValue,
    flagToggleActive,
    ratingConditionForValue,
    ratingControlValue,
    toggleFlagCondition,
    updateCaptureDate,
    withFilterCondition,
    type SetCondition,
  } from '$lib/frameleaf/search-filters';
  import '$lib/frameleaf/tokens.css';
  import { AssetTypeEnum, AssetVisibility, ImageEnrichmentFilter } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  /**
   * The full Frameleaf filter panel (FL-49), ported from `design/frameleaf/template/src/FilterPanel.jsx`.
   *
   * FL-33 owns the Filter control in the results toolbar; this is the panel that control opens,
   * and `section` is the deep link it passes. Every control writes a condition on a real
   * `SearchFilter` field, or — for enrichment — the real `imageEnrichment` DTO enum. Where a
   * stored condition is richer than a control can express, the control reads "custom
   * condition (see chip)", makes no edit of its own and leaves the chip as the way to clear it.
   *
   * The panel is a controlled component: it never mutates the query it is given, it hands a new
   * one to `onChange`. Option lists (people, tags, albums, places, cameras) come from the caller,
   * which loads them from the production APIs.
   */

  let {
    query,
    options,
    section = 'people',
    matchingLabel,
    scopeLabel,
    onChange,
    onClose,
  }: {
    query: DiscoveryQuery;
    options: FilterPanelOptions;
    /** Which section the Filter control deep-linked into. */
    section?: DiscoveryFilterSection;
    /** Already-translated live count, e.g. "1,204 matching items". */
    matchingLabel?: string;
    /** Already-translated name of the scope being filtered. */
    scopeLabel?: string;
    onChange: (query: DiscoveryQuery) => void;
    onClose?: () => void;
  } = $props();

  let panel = $state<HTMLElement>();
  let heading = $state<HTMLElement>();

  const filter = $derived(query.filter as Record<string, Record<string, unknown> | undefined>);

  /**
   * The Filter menu's sections and the panel's anchors are the same vocabulary, so a deep link
   * is a scroll to the matching `data-section`. `all` opens at the top, which is where the
   * fields no other section claims already are.
   */
  $effect(() => {
    const target = section === 'all' ? undefined : panel?.querySelector(`[data-section="${section}"]`);
    target?.scrollIntoView({ block: 'nearest' });
    heading?.focus({ preventScroll: true });
  });

  const setCondition = (field: string, condition: Record<string, unknown> | SetCondition | null) =>
    onChange(withFilterCondition(query, field, condition as Record<string, unknown> | null));

  const asOption = (value: string, label: string): ComboBoxOption => ({ value, label });

  /**
   * A single-value facet select over a list of values the account's own library reports. An
   * unrecognised stored value is still offered, so opening the panel on a shared URL never
   * silently drops the condition it carries.
   */
  const facetOptions = (field: string, label: string, values: string[]): ComboBoxOption[] => {
    const current = equalityControlValue(filter[field]);
    const list = [asOption('', $t('frameleaf_search_any_of_field', { values: { label: label.toLowerCase() } }))];
    if (current === CUSTOM_CONDITION) {
      list.push(asOption(CUSTOM_CONDITION, $t('frameleaf_search_custom_condition')));
    }
    for (const value of values) {
      list.push(asOption(value, value));
    }
    if (current && current !== CUSTOM_CONDITION && !values.includes(current)) {
      list.push(asOption(current, current));
    }
    return list;
  };

  const selectedFacet = (field: string, label: string, values: string[]) => {
    const current = equalityControlValue(filter[field]);
    return facetOptions(field, label, values).find((option) => option.value === current);
  };

  const onFacet = (field: string) => (option: ComboBoxOption | undefined) => {
    const value = option?.value ?? '';
    if (value === CUSTOM_CONDITION) {
      // The disabled placeholder is not an edit; leave the stored condition alone.
      return;
    }
    setCondition(field, value ? { eq: value } : null);
  };

  const typeValue = $derived(
    equalityControlValue(filter.type, (value) => value === AssetTypeEnum.Image || value === AssetTypeEnum.Video),
  );
  const ratingValue = $derived(ratingControlValue(filter.rating));
  const visibilityValue = $derived(
    equalityControlValue(filter.visibility, (value) =>
      Object.values(AssetVisibility).includes(value as AssetVisibility),
    ),
  );

  const ratingOptions = $derived<ComboBoxOption[]>([
    asOption('', $t('frameleaf_search_any_rating')),
    ...(ratingValue === CUSTOM_CONDITION ? [asOption(CUSTOM_CONDITION, $t('frameleaf_search_custom_condition'))] : []),
    asOption('null', $t('frameleaf_search_rating_unset')),
    asOption('0', $t('frameleaf_search_rating_unrated')),
    asOption('-1', $t('frameleaf_search_rating_rejected')),
    ...[1, 2, 3, 4, 5].map((value) =>
      asOption(String(value), $t('frameleaf_search_rating_exactly', { values: { count: value } })),
    ),
    ...[0, 1, 2, 3, 4, 5].map((value) =>
      asOption(`min${value}`, $t('frameleaf_search_rating_at_least', { values: { count: value } })),
    ),
  ]);

  const enrichmentOptions = $derived<ComboBoxOption[]>([
    asOption('', $t('all')),
    ...ENRICHMENT_OPTIONS.map((option) => asOption(option.value, $t(option.labelKey))),
  ]);

  const flagOptions = $derived<ComboBoxOption[]>([
    asOption('', $t('frameleaf_search_any')),
    asOption('true', $t('yes')),
    asOption('false', $t('no')),
  ]);

  const placeFacets = $derived([
    { field: 'country', label: $t('country'), values: options.countries },
    { field: 'state', label: $t('state'), values: options.states },
    { field: 'city', label: $t('city'), values: options.cities },
  ]);

  const cameraFacets = $derived([
    { field: 'make', label: $t('camera_brand'), values: options.makes },
    { field: 'model', label: $t('camera_model'), values: options.models },
    { field: 'lensModel', label: $t('lens_model'), values: options.lenses },
  ]);

  const statusFlags = $derived([
    { field: 'hasPeople', label: $t('frameleaf_search_has_people') },
    { field: 'hasAlbums', label: $t('frameleaf_search_in_an_album') },
    { field: 'hasTags', label: $t('frameleaf_search_tagged') },
    { field: 'isMotion', label: $t('motion') },
    { field: 'isOffline', label: $t('offline') },
  ]);

  const dateBounds = $derived([
    { operator: 'gte' as const, label: $t('start_date') },
    { operator: 'lte' as const, label: $t('end_date') },
  ]);

  const visibilityOptions = $derived(facetOptions('visibility', $t('visibility'), Object.values(AssetVisibility)));

  const flagValue = (field: string) => equalityControlValue(filter[field], (value) => typeof value === 'boolean');

  const onFlag = (field: string) => (option: ComboBoxOption | undefined) => {
    const value = option?.value ?? '';
    if (value === CUSTOM_CONDITION) {
      return;
    }
    setCondition(field, value === '' ? null : { eq: value === 'true' });
  };
</script>

<aside class="filter-panel frameleaf" aria-label={$t('frameleaf_search_filters')} bind:this={panel}>
  <header>
    <div>
      <h2 tabindex="-1" bind:this={heading}>{$t('frameleaf_search_filters')}</h2>
      {#if matchingLabel || scopeLabel}
        <p class="muted" aria-live="polite">{[matchingLabel, scopeLabel].filter(Boolean).join(' · ')}</p>
      {/if}
    </div>
    {#if onClose}
      <Button variant="quiet" label={$t('frameleaf_search_close_filters')} onclick={onClose}>
        <span aria-hidden="true">&times;</span>
      </Button>
    {/if}
  </header>

  <div class="scroll">
    <FilterMultiSelect
      field="personIds"
      anchor="people"
      label={$t('people')}
      options={options.people.map((person) => ({ value: person.id, label: person.name || $t('no_name') }))}
      condition={filter.personIds as SetCondition}
      people={options.people}
      onChange={setCondition}
    />

    <!-- FL-58: shown once the account has a pet, or while a link carries a pet condition to remove -->
    {#if options.pets.length > 0 || filter.petIds}
      <FilterMultiSelect
        field="petIds"
        anchor="pets"
        label={$t('frameleaf_pets_title')}
        options={options.pets.map((pet) => ({ value: pet.id, label: pet.name || $t('frameleaf_pets_unnamed') }))}
        condition={filter.petIds as SetCondition}
        onChange={setCondition}
      />
    {/if}

    <section class="filter-section" data-section="media">
      <h3>{$t('media_type')}</h3>
      {#if typeValue === CUSTOM_CONDITION}
        <p class="muted">{$t('frameleaf_search_custom_condition')}</p>
      {/if}
      <SegmentedControl
        label={$t('media_type')}
        value={typeValue === CUSTOM_CONDITION ? '' : typeValue}
        options={[
          { value: '', label: $t('all') },
          { value: AssetTypeEnum.Image, label: $t('photos') },
          { value: AssetTypeEnum.Video, label: $t('videos') },
        ]}
        onChange={(value) => setCondition('type', value ? { eq: value } : null)}
      />
    </section>

    <section class="filter-section" data-section="date">
      <h3>{$t('frameleaf_search_field_taken_at')}</h3>
      {#if captureDateHasCustomCondition(filter.takenAt)}
        <p class="muted">{$t('frameleaf_search_date_custom_condition')}</p>
      {/if}
      <div class="dates">
        {#each dateBounds as bound (bound.operator)}
          <label>
            {bound.label}
            <input
              type="date"
              value={captureDateControlValue(filter.takenAt, bound.operator)}
              oninput={(event) =>
                setCondition('takenAt', updateCaptureDate(filter.takenAt, bound.operator, event.currentTarget.value))}
            />
          </label>
        {/each}
      </div>
    </section>

    <section class="filter-section" data-section="places">
      <h3>{$t('places')}</h3>
      {#each placeFacets as facet (facet.field)}
        <Picker
          label={facet.label}
          options={facetOptions(facet.field, facet.label, facet.values)}
          selectedOption={selectedFacet(facet.field, facet.label, facet.values)}
          onSelect={onFacet(facet.field)}
        />
      {/each}
    </section>

    <section class="filter-section" data-section="rating">
      <h3>{$t('frameleaf_search_rating_and_favorites')}</h3>
      <Picker
        label={$t('rating')}
        options={ratingOptions}
        selectedOption={ratingOptions.find((option) => option.value === ratingValue)}
        onSelect={(option) => {
          if (option?.value === CUSTOM_CONDITION) {
            return;
          }
          const next = ratingConditionForValue(option?.value ?? '');
          if (next !== undefined) {
            setCondition('rating', next);
          }
        }}
      />
      <Picker
        label={$t('favorites')}
        options={flagOptions}
        selectedOption={flagOptions.find((option) => option.value === flagValue('isFavorite'))}
        onSelect={onFlag('isFavorite')}
      />
    </section>

    <FilterMultiSelect
      field="tagIds"
      anchor="tags"
      label={$t('tags')}
      options={options.tags}
      condition={filter.tagIds as SetCondition}
      onChange={setCondition}
    />

    <FilterMultiSelect
      field="albumIds"
      anchor="albums"
      label={$t('albums')}
      options={options.albums}
      condition={filter.albumIds as SetCondition}
      onChange={setCondition}
    />

    <section class="filter-section" data-section="camera">
      <h3>{$t('frameleaf_search_camera_and_lens')}</h3>
      {#each cameraFacets as facet (facet.field)}
        <Picker
          label={facet.label}
          options={facetOptions(facet.field, facet.label, facet.values)}
          selectedOption={selectedFacet(facet.field, facet.label, facet.values)}
          onSelect={onFacet(facet.field)}
        />
      {/each}
    </section>

    <section class="filter-section" data-section="enrichment">
      <h3>{$t('image_enrichment')}</h3>
      <p class="muted">{$t('frameleaf_search_enrichment_help')}</p>
      <Picker
        label={$t('image_enrichment')}
        options={enrichmentOptions}
        selectedOption={enrichmentOptions.find((option) => option.value === (query.imageEnrichment ?? ''))}
        onSelect={(option) =>
          onChange(withDiscoveryEnrichment(query, (option?.value || undefined) as ImageEnrichmentFilter | undefined))}
      />
    </section>

    <section class="filter-section" data-section="status">
      <h3>{$t('frameleaf_search_library_status')}</h3>
      <div class="toggles" role="group" aria-label={$t('frameleaf_search_quick_status')}>
        <!-- The two quick toggles named in the September 22 revision. Both are ordinary
             SearchFilter boolean conditions, so the chip row can remove them like any other. -->
        <Button
          pressed={flagToggleActive(filter.hasAlbums, false)}
          onclick={() => setCondition('hasAlbums', toggleFlagCondition(filter.hasAlbums, false))}
        >
          {$t('not_in_any_album')}
        </Button>
        <Button
          pressed={flagToggleActive(filter.hasTags, false)}
          onclick={() => setCondition('hasTags', toggleFlagCondition(filter.hasTags, false))}
        >
          {$t('untagged')}
        </Button>
      </div>

      <Picker
        label={$t('visibility')}
        options={visibilityOptions}
        selectedOption={visibilityOptions.find((option) => option.value === visibilityValue)}
        onSelect={onFacet('visibility')}
      />

      {#each statusFlags as flag (flag.field)}
        <Picker
          label={flag.label}
          options={flagOptions}
          selectedOption={flagOptions.find((option) => option.value === flagValue(flag.field))}
          onSelect={onFlag(flag.field)}
        />
      {/each}
    </section>
  </div>

  <footer>
    <Button onclick={() => onChange(withoutDiscoveryFilters(query))}>{$t('frameleaf_search_reset_filters')}</Button>
  </footer>
</aside>

<style>
  .filter-panel {
    display: flex;
    flex-direction: column;
    min-height: 0;
    color: var(--fl-text);
    background: var(--fl-panel);
  }
  header,
  footer {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 0.75rem;
    padding-block: 0.75rem;
  }
  footer {
    border-top: 1px solid var(--fl-border);
  }
  h2 {
    font-size: 1rem;
    font-weight: 600;
  }
  h3 {
    font-size: 0.875rem;
    font-weight: 600;
  }
  .muted {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .scroll {
    min-height: 0;
    overflow-y: auto;
  }
  .filter-section {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    padding-block: 0.875rem;
    border-bottom: 1px solid var(--fl-border);
  }
  .dates {
    display: grid;
    grid-template-columns: repeat(auto-fit, minmax(9rem, 1fr));
    gap: 0.75rem;
  }
  .dates label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .dates input {
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: 0.375rem 0.5rem;
    min-height: 36px;
  }
  .toggles {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
