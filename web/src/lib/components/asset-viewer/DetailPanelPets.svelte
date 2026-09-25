<script lang="ts">
  /**
   * FL-58: "Pets in this photo" in the viewer's information panel, next to People
   * (DetailPanelPeople.svelte, the prototype's MediaViewer.jsx people section): the owner's pets
   * confirmed in this photo as squircle chips, an "Add pet" menu that marks the whole photo, and a
   * region tagger (`PetTagger`). Removing or adding offers Undo in its toast.
   *
   * Pets are owner-only and never shared: nothing renders on a shared link or for anyone but the
   * owner, and a Locked photo only while the owner's session is unlocked. Every write names the
   * checksum of the photo on screen, so a decision about a replaced original is refused (409).
   */
  import IconButton from '$lib/components/frameleaf/IconButton.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import PetTagger from '$lib/components/frameleaf/pets/PetTagger.svelte';
  import PetThumbnail from '$lib/components/frameleaf/pets/PetThumbnail.svelte';
  import { toastPetDecision } from '$lib/frameleaf/pet-undo';
  import {
    confirmedObservations,
    isSourceConflict,
    isStaleObservation,
    observationToCreate,
  } from '$lib/frameleaf/pets';
  import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import {
    AssetVisibility,
    createPetObservation,
    deletePetObservation,
    getAllPets,
    getAssetPetObservations,
    type AssetResponseDto,
    type PetObservationResponseDto,
    type PetResponseDto,
  } from '@immich/sdk';
  import { Icon, toastManager } from '@immich/ui';
  import { mdiAlertCircleOutline, mdiClose, mdiPlus, mdiVectorRectangle } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    asset: AssetResponseDto;
    isOwner: boolean;
  };

  const { asset, isOwner }: Props = $props();

  let pets = $state<PetResponseDto[]>([]);
  let observations = $state<PetObservationResponseDto[]>([]);
  let loadedFor = $state<string | null>(null);
  let taggerOpen = $state(false);
  let busy = $state(false);

  // FaceTagger's rule (face-tags.mjs `canTagAsset`): the owner only, never on a shared link or a
  // trashed photo, and a Locked photo only while the session is unlocked.
  const available = $derived(
    authManager.authenticated &&
      !authManager.isSharedLink &&
      isOwner &&
      asset.ownerId === authManager.user.id &&
      (asset.visibility !== AssetVisibility.Locked || sessionAccess.isElevated) &&
      !sessionAccess.lockPending &&
      !sessionAccess.concealed,
  );
  const editable = $derived(available && !asset.isTrashed);
  const petsById = $derived(new Map(pets.map((pet) => [pet.id, pet])));
  const confirmed = $derived(
    confirmedObservations(observations).filter((observation) => petsById.has(observation.petId)),
  );
  const addable = $derived(pets.filter((pet) => confirmed.every((observation) => observation.petId !== pet.id)));
  const nameOf = (pet: PetResponseDto | undefined) => pet?.name || $t('frameleaf_pets_unnamed');

  const load = async (assetId: string) => {
    try {
      const [allPets, found] = await Promise.all([
        getAllPets({ withHidden: false }),
        getAssetPetObservations({ assetId }),
      ]);
      // A late answer for a photo the viewer has moved away from is dropped.
      if (assetId !== asset.id) {
        return;
      }
      pets = allPets;
      observations = found;
      loadedFor = assetId;
    } catch (error) {
      handleError(error, $t('frameleaf_viewer_pets_error'));
    }
  };

  $effect(() => {
    if (available && loadedFor !== asset.id) {
      void load(asset.id);
    }
  });

  const reportFailure = (error: unknown) => {
    if (isSourceConflict(error)) {
      toastManager.warning($t('frameleaf_pets_photo_changed'));
    } else {
      handleError(error, $t('frameleaf_viewer_pets_error'));
    }
  };

  const upsertLocal = (observation: PetObservationResponseDto) => {
    observations = [...observations.filter((entry) => entry.id !== observation.id), observation];
  };

  const removeLocal = (id: string) => {
    observations = observations.filter((entry) => entry.id !== id);
  };

  const undoAdd = (observation: PetObservationResponseDto) => async () => {
    try {
      await deletePetObservation({ id: observation.id, expectedChecksum: asset.checksum });
      removeLocal(observation.id);
      toastManager.primary($t('frameleaf_pets_undone'));
    } catch (error) {
      reportFailure(error);
    }
  };

  const added = (observation: PetObservationResponseDto, pet: PetResponseDto) => {
    upsertLocal(observation);
    toastPetDecision($t('frameleaf_viewer_pets_added', { values: { name: nameOf(pet) } }), undoAdd(observation));
  };

  const addWholePhoto = async (pet: PetResponseDto) => {
    busy = true;
    try {
      const observation = await createPetObservation({
        id: pet.id,
        petObservationCreateDto: { assetId: asset.id, expectedChecksum: asset.checksum },
      });
      added(observation, pet);
    } catch (error) {
      reportFailure(error);
    } finally {
      busy = false;
    }
  };

  const remove = async (observation: PetObservationResponseDto) => {
    const pet = petsById.get(observation.petId);
    busy = true;
    try {
      await deletePetObservation({ id: observation.id, expectedChecksum: asset.checksum });
      removeLocal(observation.id);
      toastPetDecision($t('frameleaf_viewer_pets_removed', { values: { name: nameOf(pet) } }), async () => {
        try {
          // Undo writes the same decision back, region and all, on the photo still on screen.
          upsertLocal(
            await createPetObservation({
              id: observation.petId,
              petObservationCreateDto: observationToCreate(observation, asset.checksum),
            }),
          );
          toastManager.primary($t('frameleaf_pets_undone'));
        } catch (error) {
          reportFailure(error);
        }
      });
    } catch (error) {
      reportFailure(error);
    } finally {
      busy = false;
    }
  };
</script>

{#if available}
  <section class="px-4 pt-4 text-sm" aria-labelledby="viewer-pets-heading" data-testid="viewer-pets">
    <div class="flex h-10 w-full items-center justify-between">
      <h3 id="viewer-pets-heading" class="text-sm text-immich-fg/70 dark:text-immich-dark-fg/70">
        {$t('frameleaf_viewer_pets')}
      </h3>
      {#if editable && pets.length > 0}
        <Menu label={$t('frameleaf_viewer_pets_add_label')} align="end">
          {#snippet trigger()}
            <span class="add"
              ><Icon icon={mdiPlus} size="16" aria-hidden={true} />{$t('frameleaf_viewer_pets_add')}</span
            >
          {/snippet}
          {#each addable as pet (pet.id)}
            <MenuItem disabled={busy} onSelect={() => void addWholePhoto(pet)}>{nameOf(pet)}</MenuItem>
          {/each}
          <MenuItem disabled={busy} onSelect={() => (taggerOpen = true)}>
            <Icon icon={mdiVectorRectangle} size="16" aria-hidden={true} />
            {$t('frameleaf_viewer_pets_draw')}
          </MenuItem>
        </Menu>
      {/if}
    </div>

    {#if pets.length === 0 && loadedFor === asset.id}
      <p class="muted">
        <a href={Route.pets()}>{$t('frameleaf_viewer_pets_no_pets')}</a>
      </p>
    {:else if confirmed.length === 0}
      <p class="muted">{$t('frameleaf_viewer_pets_none')}</p>
    {/if}

    <ul class="pets">
      {#each confirmed as observation (observation.id)}
        {@const pet = petsById.get(observation.petId)}
        <li class="pet" data-testid="viewer-pet">
          <a href={Route.viewPet({ id: observation.petId })} class="pet-link">
            <!-- Pets get the squircle photo shape, as people do (owner decision, FL-146). -->
            <PetThumbnail assetId={pet?.featuredAssetId} cacheKey={pet?.updatedAt} size={72} alt="" />
            <span class="name">{nameOf(pet)}</span>
          </a>
          {#if isStaleObservation(observation)}
            <span class="stale" title={$t('frameleaf_viewer_pets_stale')}>
              <Icon icon={mdiAlertCircleOutline} size="14" aria-hidden={true} />
              {$t('frameleaf_viewer_pets_stale')}
            </span>
          {/if}
          {#if editable}
            <span class="remove">
              <IconButton
                label={$t('frameleaf_viewer_pets_remove_label', { values: { name: nameOf(pet) } })}
                disabled={busy}
                onclick={() => void remove(observation)}
              >
                <Icon icon={mdiClose} size="14" />
              </IconButton>
            </span>
          {/if}
        </li>
      {/each}
    </ul>
  </section>

  {#if taggerOpen}
    <PetTagger {asset} {pets} onClose={() => (taggerOpen = false)} onSaved={added} />
  {/if}
{/if}

<style>
  .add {
    display: inline-flex;
    align-items: center;
    gap: 0.25rem;
  }
  .muted {
    margin: 0;
    color: var(--fl-muted, currentColor);
  }
  .muted a {
    text-decoration: underline;
  }
  .pets {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: 0.75rem;
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
  }
  .pet {
    position: relative;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .pet-link {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    border-radius: 0.75rem;
  }
  .pet-link:focus-visible {
    outline: 2px solid var(--fl-accent, currentColor);
    outline-offset: 2px;
  }
  .name {
    overflow: hidden;
    font-weight: 500;
    white-space: nowrap;
    text-overflow: ellipsis;
  }
  .stale {
    display: inline-flex;
    gap: 0.25rem;
    align-items: center;
    font-size: 0.75rem;
    color: var(--fl-warning-text, currentColor);
  }
  .remove {
    position: absolute;
    top: -0.25rem;
    inset-inline-end: -0.25rem;
  }
</style>
