<script lang="ts">
  import { goto } from '$app/navigation';
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import LibraryView from '$lib/components/frameleaf/LibraryView.svelte';
  import PetDecisions from '$lib/components/frameleaf/pets/PetDecisions.svelte';
  import PetThumbnail from '$lib/components/frameleaf/pets/PetThumbnail.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import TimelineAssetViewer from '$lib/components/timeline/TimelineAssetViewer.svelte';
  import Portal from '$lib/elements/Portal.svelte';
  import { namedArchiveName } from '$lib/frameleaf/archive-name';
  import { resolveEntityName } from '$lib/frameleaf/filter-entity-names';
  import { librarySession } from '$lib/frameleaf/library-session.svelte';
  import { petAgeInYears, speciesLabelKey } from '$lib/frameleaf/pets';
  import { assetViewerManager } from '$lib/managers/asset-viewer-manager.svelte';
  import { TimelineManager } from '$lib/managers/timeline-manager/timeline-manager.svelte';
  import { Route } from '$lib/route';
  import { navigate } from '$lib/utils/navigation';
  import { AssetVisibility } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowLeft, mdiEyeOffOutline } from '@mdi/js';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  /**
   * One pet's photos (FL-58), in the Library view (prototype `PetsLibrary` → `navigate("Pets")`):
   * the pet's own header above Timeline, Browse and Work, the results toolbar and the grid, exactly
   * as a person's page (`/people/{id}`) shows a person.
   *
   * The photos are the timeline's own `petId` scope — the server's `hasPets` rule, so only photos the
   * owner confirmed this pet in appear; a model's suggestion is not a photo of the pet until it is
   * accepted on the Pets page. Selection, the bulk actions, the filters and the viewer are the
   * Library's.
   *
   * A download is named after the pet through the FL-45 `pet` name lookup, which returns nothing for
   * a hidden or unnamed pet, so such a download falls back to the generic "Pet" rather than leaking a
   * hidden name into a filename.
   */
  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  const pet = $derived(data.pet);
  const name = $derived(pet.name || $t('frameleaf_pets_unnamed'));
  const age = $derived(petAgeInYears(pet.birthDate));
  const options = $derived({ visibility: AssetVisibility.Timeline, petId: pet.id });

  let timelineManager = $state<TimelineManager>() as TimelineManager;
  let viewerInvisible = $state(false);
  /** Bumped when a decision about this pet changes which photos it is in: the view reads them again. */
  let refresh = $state(0);

  let downloadName = $state<string | null>(null);
  let namedFor = '';
  $effect(() => {
    const petId = pet.id;
    untrack(() => {
      if (petId === namedFor) {
        return;
      }
      namedFor = petId;
      downloadName = null;
      void resolveEntityName('pet', petId).then((resolved) => {
        if (petId === pet.id) {
          downloadName = resolved;
        }
      });
    });
  });

  const handleEscape = async () => {
    if (librarySession.selection.length > 0) {
      librarySession.clearSelection();
      return;
    }
    await goto(Route.pets());
  };
</script>

<!-- The same shell as a person's page: LibraryView is the page area's own child, so the header and the
     toolbar band span the page and the grid keeps the Library's gutter. -->
<UserPageLayout scrollbar={false}>
  {#key `${pet.id}:${refresh}`}
    <LibraryView
      enableRouting
      selectAll="loaded"
      bind:timelineManager
      {options}
      destination={{ kind: 'pet', id: pet.id }}
      downloadFileName={namedArchiveName(downloadName, $t('frameleaf_archive_name_pet'))}
      onOpen={(asset) => void navigate({ targetRoute: 'current', assetId: asset.id })}
      onShortcut={(shortcut) => {
        // Escape with nothing open and nothing selected goes back to Pets.
        if (shortcut.id === 'close') {
          void handleEscape();
        }
      }}
    >
      <header class="pet-head">
        <div class="pet-identity">
          <IconButton variant="default" label={$t('frameleaf_pet_photos_back')} href={Route.pets()}>
            <Icon icon={mdiArrowLeft} size="20" />
          </IconButton>
          <PetThumbnail
            assetId={pet.featuredAssetId}
            cacheKey={pet.updatedAt}
            species={pet.species}
            size={64}
            heroKey="pet:{pet.id}"
            heroPage
          />
          <div class="pet-copy">
            <h1 class:unnamed={!pet.name}>{name}</h1>
            <p class="pet-sub">
              <span>{$t(speciesLabelKey(pet.species))}</span>
              {#if age !== null}
                <span aria-hidden="true">&middot;</span>
                <span>{$t('frameleaf_pets_age_years', { values: { count: age } })}</span>
              {/if}
              <span aria-hidden="true">&middot;</span>
              <span>{$t('frameleaf_pets_confirmed_photos', { values: { count: pet.assetCount } })}</span>
              {#if pet.isHidden}
                <span aria-hidden="true">&middot;</span>
                <Icon icon={mdiEyeOffOutline} size="1em" aria-hidden={true} />
                <span>{$t('frameleaf_pet_photos_hidden_note')}</span>
              {/if}
            </p>
          </div>
        </div>
        <!-- FL-58: every decision about this pet, with remove/undo and review of changed photos. -->
        <PetDecisions petId={pet.id} species={pet.species} onChanged={() => refresh++} />
      </header>

      {#snippet viewer()}
        <Portal target="body">
          {#if assetViewerManager.isViewing}
            <TimelineAssetViewer bind:invisible={viewerInvisible} {timelineManager} />
          {/if}
        </Portal>
      {/snippet}
    </LibraryView>
  {/key}
</UserPageLayout>

<style>
  /* The Library's header (`.fl-library-header.has-title`): the title at the page top, 12px above the rule. */
  .pet-head {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    padding-top: var(--fl-page-top);
    color: var(--fl-text);
  }
  .pet-identity {
    display: flex;
    align-items: center;
    gap: var(--fl-space-4);
    min-width: 0;
  }
  .pet-copy {
    min-width: 0;
  }
  /* The Library's title (`.fl-library-title`). */
  h1 {
    margin: 0;
    overflow: hidden;
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.02em;
    line-height: 1.15;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  h1.unnamed {
    color: var(--fl-muted);
  }
  .pet-sub {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-1);
    margin: var(--fl-space-1) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  @media (max-width: 767px) {
    .pet-identity {
      gap: var(--fl-space-3);
    }
  }
</style>
