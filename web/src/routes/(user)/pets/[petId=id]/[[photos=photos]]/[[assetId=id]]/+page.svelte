<script lang="ts">
  import ResultsAssetViewer from '$lib/components/frameleaf/ResultsAssetViewer.svelte';
  import ResultsView from '$lib/components/frameleaf/ResultsView.svelte';
  import PetDecisions from '$lib/components/frameleaf/pets/PetDecisions.svelte';
  import PetThumbnail from '$lib/components/frameleaf/pets/PetThumbnail.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import EmptyPlaceholder from '$lib/components/shared-components/EmptyPlaceholder.svelte';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import { resolveEntityName } from '$lib/frameleaf/filter-entity-names';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { petAgeInYears, petPhotosFilter, speciesLabelKey } from '$lib/frameleaf/pets';
  import '$lib/frameleaf/tokens.css';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import { navigate } from '$lib/utils/navigation';
  import { toTimelineAsset } from '$lib/utils/timeline-util';
  import { searchAssets, type AssetResponseDto } from '@immich/sdk';
  import { Icon, LoadingSpinner } from '@immich/ui';
  import { mdiArrowLeft, mdiEyeOffOutline } from '@mdi/js';
  import { onMount, untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * One pet's photos (FL-58).
   *
   * The results are an ordinary structured search — `filter.petIds` plus the timeline's own
   * visibility and trash rules, see `petPhotosFilter` — shown through the shared `ResultsView`, so
   * selection, the FL-32 bulk actions and the viewer behave exactly as they do for search results.
   * Only photos the owner confirmed this pet in appear; a model's suggestion is not a photo of the
   * pet until it is accepted on the Pets page.
   *
   * A download is named after the pet through the FL-45 `pet` name lookup, which returns nothing for
   * a hidden or unnamed pet, so such a download falls back to the generic "Pet" rather than leaking a
   * hidden name into a filename.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const PAGE_SIZE = 250;

  const pet = $derived(data.pet);
  const name = $derived(pet.name || $t('frameleaf_pets_unnamed'));
  const age = $derived(petAgeInYears(pet.birthDate));

  let assets: AssetResponseDto[] = $state([]);
  let cursor = $state<string | null>(null);
  let hasMore = $state(true);
  let isLoading = $state(true);
  let loadedFor = '';
  let downloadName = $state<string | null>(null);

  const timelineAssets = $derived(assets.map((asset) => toTimelineAsset(asset)));
  const downloadFileName = $derived(namedArchiveName(downloadName, $t('frameleaf_archive_name_pet')));

  const loadNextPage = async (force = false) => {
    if (!hasMore || (isLoading && !force)) {
      return;
    }

    const petId = pet.id;
    isLoading = true;
    try {
      const { assets: page } = await searchAssets({
        metadataSearchDto: {
          filter: petPhotosFilter(petId),
          size: PAGE_SIZE,
          withExif: true,
          ...(cursor && { cursor }),
        },
      });
      // A late page for a pet this page has already moved away from is dropped
      if (petId !== pet.id) {
        return;
      }
      assets.push(...page.items);
      cursor = page.nextCursor;
      hasMore = !!page.nextCursor;
    } catch (error) {
      handleError(error, $t('failed_to_load_assets'));
    } finally {
      isLoading = false;
    }
  };

  const reload = async () => {
    assets = [];
    cursor = null;
    hasMore = true;
    await loadNextPage(true);
  };

  const onRemoved = (assetIds: string[]) => {
    const removed = new Set(assetIds);
    assets = assets.filter((asset) => !removed.has(asset.id));
  };

  const updateAsset = (updated: AssetResponseDto) => {
    const index = assets.findIndex((asset) => asset.id === updated.id);
    if (index !== -1) {
      assets[index] = updated;
    }
  };

  // Select everything the page holds; later pages load as the grid scrolls, as on search results.
  const handleSelectAll = () => librarySession.selectAll(assets.map((asset) => asset.id));

  // Reload only when the pet itself changes: opening a photo re-runs the loader with the same pet,
  // and the paging state this reads must not become a dependency of the effect.
  $effect(() => {
    const petId = pet.id;
    untrack(() => {
      if (petId === loadedFor) {
        return;
      }
      loadedFor = petId;
      downloadName = null;
      void resolveEntityName('pet', petId).then((resolved) => {
        if (petId === pet.id) {
          downloadName = resolved;
        }
      });
      void reload();
    });
  });

  onMount(() => {
    librarySession.clearSelection();
  });
</script>

<UserPageLayout title={data.meta.title} scrollbar={false}>
  <section class="frameleaf pet-photos m-4 mb-12">
    <ResultsView
      assets={timelineAssets}
      {downloadFileName}
      onEndReached={() => void loadNextPage()}
      {onRemoved}
      onSelectAll={handleSelectAll}
      onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
    >
      {#snippet header()}
        <header class="pet-header">
          <a class="back" href={Route.pets()}>
            <Icon icon={mdiArrowLeft} size="1.125em" aria-hidden={true} />
            <span>{$t('frameleaf_pet_photos_back')}</span>
          </a>
          <div class="identity">
            <PetThumbnail assetId={pet.featuredAssetId} cacheKey={pet.updatedAt} size={72} />
            <div>
              <h1 class:unnamed={!pet.name}>{name}</h1>
              <p class="sub">
                <span>{$t(speciesLabelKey(pet.species))}</span>
                {#if age !== null}
                  <span aria-hidden="true">&middot;</span>
                  <span>{$t('frameleaf_pets_age_years', { values: { count: age } })}</span>
                {/if}
                <span aria-hidden="true">&middot;</span>
                <span>{$t('frameleaf_pets_confirmed_photos', { values: { count: pet.assetCount } })}</span>
              </p>
              {#if pet.isHidden}
                <p class="sub">
                  <Icon icon={mdiEyeOffOutline} size="1em" aria-hidden={true} />
                  <span>{$t('frameleaf_pet_photos_hidden_note')}</span>
                </p>
              {/if}
            </div>
          </div>
          <!-- FL-58: every decision about this pet, with remove/undo and review of changed photos. -->
          <PetDecisions petId={pet.id} onChanged={() => void reload()} />
        </header>
      {/snippet}

      {#snippet empty()}
        {#if !isLoading}
          <div class="flex min-h-[calc(66vh-11rem)] w-full place-content-center items-center">
            <EmptyPlaceholder text={$t('frameleaf_pet_photos_empty', { values: { name } })} />
          </div>
        {/if}
      {/snippet}
    </ResultsView>

    {#if isLoading}
      <div class="flex items-center justify-center py-16">
        <LoadingSpinner size="giant" />
      </div>
    {/if}
  </section>
</UserPageLayout>

<ResultsAssetViewer
  {assets}
  emptyRoute={Route.viewPet({ id: pet.id })}
  onAssetChange={updateAsset}
  onRemove={(id) => onRemoved([id])}
/>

<style>
  .pet-header {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding-block: 0.5rem 1rem;
    color: var(--fl-text);
  }
  .back {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    align-self: flex-start;
    min-height: 44px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .back:hover {
    color: var(--fl-text);
  }
  .identity {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  h1 {
    margin: 0;
    font-size: 1.5rem;
    font-weight: 600;
  }
  h1.unnamed {
    color: var(--fl-muted);
  }
  .sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 0.25rem;
    margin: 0.25rem 0 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
</style>
