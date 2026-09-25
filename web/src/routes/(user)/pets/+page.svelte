<script lang="ts">
  /**
   * Frameleaf Pets (FL-58).
   *
   * The grid mirrors the People grid on the Frameleaf primitives, and the review panel
   * below it turns recognition proposals into durable decisions. The split the server
   * enforces is visible here: renaming, hiding, favoriting, merging and deleting act on
   * the identity, while accept, reassign and reject act on a proposal and leave one
   * durable record behind.
   *
   * Every mutation goes through the real `@immich/sdk` pet services. Nothing on this page
   * is a fixture, and the empty review state says which of the two empty cases applies.
   */
  import { goto } from '$app/navigation';
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PetCard from '$lib/components/frameleaf/pets/PetCard.svelte';
  import PetRecognitionPanel from '$lib/components/frameleaf/pets/PetRecognitionPanel.svelte';
  import PetReviewPanel from '$lib/components/frameleaf/pets/PetReviewPanel.svelte';
  import UserPageLayout from '$lib/components/layouts/UserPageLayout.svelte';
  import { toastPetDecision } from '$lib/frameleaf/pet-undo';
  import {
    filterPetsByName,
    findPet,
    isRecognitionRunActive,
    isSourceConflict,
    petSpeciesOptions,
    sortPets,
    speciesLabelKey,
  } from '$lib/frameleaf/pets';
  import { authManager } from '$lib/managers/auth-manager.svelte';
  import { Route } from '$lib/route';
  import { handleError } from '$lib/utils/handle-error';
  import {
    PetSpecies,
    acceptPetCandidate,
    cancelPetRecognition,
    createPet,
    deletePet,
    deletePetObservation,
    getAllPets,
    getPetCandidates,
    getPetRecognition,
    mergePets,
    rejectPetCandidate,
    startPetRecognition,
    updatePet,
    type PetCandidateResponseDto,
    type PetObservationResponseDto,
    type PetRecognitionStatusResponseDto,
    type PetResponseDto,
  } from '@immich/sdk';
  import { Icon, modalManager, toastManager } from '@immich/ui';
  import { mdiPawOutline, mdiPlus } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  interface Props {
    data: PageData;
  }

  let { data }: Props = $props();

  let pets = $state<PetResponseDto[]>(data.pets);
  let candidates = $state<PetCandidateResponseDto[]>(data.candidates.candidates);
  let recognitionAvailable = $state(data.candidates.recognitionAvailable);
  let recognition = $state<PetRecognitionStatusResponseDto>(data.candidates.recognition);
  let recognitionBusy = $state(false);

  /** How often a running recognition run is re-read, so progress and new suggestions appear. */
  const RUN_POLL_MS = 4000;
  let pollTimer: ReturnType<typeof setTimeout> | undefined;

  let search = $state('');
  let showHidden = $state(false);
  let editingId = $state<string | null>(null);
  let busyCandidateId = $state<string | null>(null);

  let createOpen = $state(false);
  let createName = $state('');
  let createSpecies = $state<PetSpecies>(PetSpecies.Dog);
  let createBirthDate = $state('');

  // The dialogs keep their own open flag so `bind:open` owns the element state and
  // the payload state stays separate from it.
  let detailsOpen = $state(false);
  let detailsFor = $state<PetResponseDto | null>(null);
  let detailsSpecies = $state<PetSpecies>(PetSpecies.Dog);
  let detailsBirthDate = $state('');

  let mergeOpen = $state(false);
  let mergeFrom = $state<PetResponseDto | null>(null);
  let mergeTarget = $state('');

  const visible = $derived(sortPets(filterPetsByName(pets, search)).filter((pet) => showHidden || !pet.isHidden));
  const hiddenCount = $derived(pets.filter((pet) => pet.isHidden).length);
  const mergeOptions = $derived(pets.filter((pet) => pet.id !== mergeFrom?.id));

  const replacePet = (updated: PetResponseDto) => {
    pets = pets.map((pet) => (pet.id === updated.id ? updated : pet));
  };

  const refreshPets = async () => {
    pets = await getAllPets({ withHidden: true });
  };

  const refreshCandidates = async () => {
    const response = await getPetCandidates({});
    candidates = response.candidates;
    recognitionAvailable = response.recognitionAvailable;
    recognition = response.recognition;
  };

  // FL-58: while a run is going the page follows it; a reload picks the same run up from the
  // server, because the run is durable there, not state of this page.
  const schedulePoll = () => {
    clearTimeout(pollTimer);
    if (!isRecognitionRunActive(recognition.run)) {
      return;
    }
    pollTimer = setTimeout(() => {
      // a failed read is left to the next poll or a reload
      void refreshCandidates()
        .catch(() => {})
        .finally(() => schedulePoll());
    }, RUN_POLL_MS);
  };

  $effect(() => {
    void recognition.run?.status;
    schedulePoll();
  });

  onDestroy(() => clearTimeout(pollTimer));

  const handleStartRecognition = async () => {
    recognitionBusy = true;
    try {
      recognition = await startPetRecognition();
      toastManager.primary($t('frameleaf_pets_recognition_started'));
    } catch (error) {
      handleError(error, $t('frameleaf_pets_recognition_error'));
      recognition = await getPetRecognition().catch(() => recognition);
    } finally {
      recognitionBusy = false;
    }
  };

  const handleCancelRecognition = async () => {
    recognitionBusy = true;
    try {
      recognition = await cancelPetRecognition();
      toastManager.primary($t('frameleaf_pets_recognition_stopped'));
    } catch (error) {
      handleError(error, $t('frameleaf_pets_recognition_error'));
    } finally {
      recognitionBusy = false;
    }
  };

  const handleCreate = async (event: Event) => {
    event.preventDefault();
    try {
      const created = await createPet({
        petCreateDto: {
          name: createName.trim(),
          species: createSpecies,
          birthDate: createBirthDate || null,
        },
      });
      pets = [...pets, created];
      createOpen = false;
      createName = '';
      createBirthDate = '';
      createSpecies = PetSpecies.Dog;
      toastManager.primary($t('frameleaf_pets_created'));
    } catch (error) {
      handleError(error, $t('frameleaf_pets_error_create'));
    }
  };

  const handleRename = async (pet: PetResponseDto, name: string) => {
    editingId = null;
    if (name === pet.name) {
      return;
    }

    try {
      replacePet(await updatePet({ id: pet.id, petUpdateDto: { name } }));
    } catch (error) {
      handleError(error, $t('frameleaf_pets_error_update'));
    }
  };

  const handleToggle = async (pet: PetResponseDto, petUpdateDto: { isHidden?: boolean; isFavorite?: boolean }) => {
    try {
      replacePet(await updatePet({ id: pet.id, petUpdateDto }));
    } catch (error) {
      handleError(error, $t('frameleaf_pets_error_update'));
    }
  };

  const openDetails = (pet: PetResponseDto) => {
    detailsFor = pet;
    detailsOpen = true;
    detailsSpecies = pet.species;
    detailsBirthDate = pet.birthDate ?? '';
  };

  const handleDetails = async (event: Event) => {
    event.preventDefault();
    if (!detailsFor) {
      return;
    }

    try {
      replacePet(
        await updatePet({
          id: detailsFor.id,
          petUpdateDto: { species: detailsSpecies, birthDate: detailsBirthDate || null },
        }),
      );
      detailsOpen = false;
    } catch (error) {
      handleError(error, $t('frameleaf_pets_error_update'));
    }
  };

  const handleDelete = async (pet: PetResponseDto) => {
    const confirmed = await modalManager.showDialog({
      title: $t('frameleaf_pets_delete'),
      prompt: $t('frameleaf_pets_delete_prompt', { values: { name: pet.name || $t('frameleaf_pets_unnamed') } }),
      confirmText: $t('delete'),
    });
    if (!confirmed) {
      return;
    }

    try {
      await deletePet({ id: pet.id });
      pets = pets.filter((entry) => entry.id !== pet.id);
      // Deleting an identity takes its proposals with it on the server, so the queue is
      // reloaded rather than filtered client side.
      await refreshCandidates();
      toastManager.primary($t('frameleaf_pets_deleted'));
    } catch (error) {
      handleError(error, $t('frameleaf_pets_error_delete'));
    }
  };

  const handleMerge = async (event: Event) => {
    event.preventDefault();
    if (!mergeFrom || !mergeTarget) {
      return;
    }

    const source = mergeFrom;
    try {
      // The target keeps every durable observation of both pets; the server resolves a
      // photo both pets answered for in favour of the confirmation.
      await mergePets({ id: mergeTarget, petMergeDto: { ids: [source.id] } });
      mergeOpen = false;
      mergeTarget = '';
      await Promise.all([refreshPets(), refreshCandidates()]);
      toastManager.primary($t('frameleaf_pets_merged'));
    } catch (error) {
      handleError(error, $t('frameleaf_pets_error_merge'));
    }
  };

  const petName = (id: string) => findPet(pets, id)?.name || $t('frameleaf_pets_unnamed');

  /**
   * One review answer, then a toast whose Undo removes the durable decision it left (FL-58). Every
   * answer names the checksum of the photo as it was proposed, so an answer about a replaced
   * original is refused (409) and the queue is reloaded instead.
   */
  const reviewed = async (
    candidate: PetCandidateResponseDto,
    action: () => Promise<PetObservationResponseDto>,
    message: string,
  ) => {
    busyCandidateId = candidate.id;
    try {
      const observation = await action();
      await Promise.all([refreshPets(), refreshCandidates()]);
      toastPetDecision(message, async () => {
        try {
          await deletePetObservation({ id: observation.id, expectedChecksum: candidate.assetChecksum });
          // The server sends the photo back through recognition; the proposal returns with it.
          candidates = [...candidates, candidate];
          await refreshPets();
          toastManager.primary($t('frameleaf_pets_undone'));
        } catch (error) {
          handleError(error, $t('frameleaf_pets_error_review'));
        }
      });
    } catch (error) {
      if (isSourceConflict(error)) {
        toastManager.warning($t('frameleaf_pets_photo_changed'));
        await refreshCandidates().catch(() => {});
      } else {
        handleError(error, $t('frameleaf_pets_error_review'));
      }
    } finally {
      busyCandidateId = null;
    }
  };

  const handleAccept = (candidate: PetCandidateResponseDto) =>
    reviewed(
      candidate,
      () =>
        acceptPetCandidate({
          id: candidate.id,
          petCandidateReviewDto: { expectedChecksum: candidate.assetChecksum },
        }),
      $t('frameleaf_pets_review_accepted', { values: { name: petName(candidate.petId) } }),
    );

  const handleReassign = (candidate: PetCandidateResponseDto, petId: string) =>
    reviewed(
      candidate,
      () =>
        acceptPetCandidate({
          id: candidate.id,
          petCandidateReviewDto: { petId, expectedChecksum: candidate.assetChecksum },
        }),
      $t('frameleaf_pets_review_accepted', { values: { name: petName(petId) } }),
    );

  const handleReject = (candidate: PetCandidateResponseDto) =>
    reviewed(
      candidate,
      () =>
        rejectPetCandidate({
          id: candidate.id,
          petCandidateRejectDto: { expectedChecksum: candidate.assetChecksum },
        }),
      $t('frameleaf_pets_review_ignored'),
    );
</script>

<UserPageLayout title={data.meta.title} scrollbar={true}>
  <section class="pets">
    <div class="toolbar">
      <input
        type="search"
        bind:value={search}
        placeholder={$t('frameleaf_pets_search_placeholder')}
        aria-label={$t('frameleaf_pets_search_placeholder')}
      />
      {#if hiddenCount > 0}
        <label class="show-hidden">
          <input type="checkbox" bind:checked={showHidden} />
          {$t('frameleaf_pets_show_hidden', { values: { count: hiddenCount } })}
        </label>
      {/if}
      <FrameleafButton variant="primary" onclick={() => (createOpen = true)}>
        <Icon icon={mdiPlus} size="16" />
        {$t('frameleaf_pets_create')}
      </FrameleafButton>
    </div>

    {#if visible.length === 0}
      <p class="empty">
        <Icon icon={mdiPawOutline} size="24" />
        <span>{pets.length === 0 ? $t('frameleaf_pets_empty') : $t('frameleaf_pets_no_matches')}</span>
      </p>
    {:else}
      <ul class="grid">
        {#each visible as pet (pet.id)}
          <li>
            <PetCard
              {pet}
              editing={editingId === pet.id}
              onOpen={() => void goto(Route.viewPet({ id: pet.id }))}
              onStartRename={() => (editingId = pet.id)}
              onCommitRename={(name) => void handleRename(pet, name)}
              onCancelRename={() => (editingId = null)}
              onToggleFavorite={() => void handleToggle(pet, { isFavorite: !pet.isFavorite })}
              onToggleHide={() => void handleToggle(pet, { isHidden: !pet.isHidden })}
              onMerge={() => {
                mergeFrom = pet;
                mergeTarget = '';
                mergeOpen = true;
              }}
              onEditDetails={() => openDetails(pet)}
              onDelete={() => void handleDelete(pet)}
            />
          </li>
        {/each}
      </ul>
    {/if}

    <PetRecognitionPanel
      {recognition}
      isAdmin={authManager.user.isAdmin}
      busy={recognitionBusy}
      onStart={() => void handleStartRecognition()}
      onCancel={() => void handleCancelRecognition()}
    />

    <PetReviewPanel
      {candidates}
      {pets}
      {recognitionAvailable}
      {busyCandidateId}
      onAccept={handleAccept}
      onReassign={handleReassign}
      onReject={handleReject}
    />
  </section>
</UserPageLayout>

<Dialog bind:open={createOpen} title={$t('frameleaf_pets_create')} closeLabel={$t('close')}>
  <form class="form" onsubmit={handleCreate}>
    <label>
      {$t('frameleaf_pets_name')}
      <input type="text" bind:value={createName} maxlength="100" placeholder={$t('frameleaf_pets_add_a_name')} />
    </label>
    <label>
      {$t('frameleaf_pets_species')}
      <select bind:value={createSpecies}>
        {#each petSpeciesOptions() as species (species)}
          <option value={species}>{$t(speciesLabelKey(species))}</option>
        {/each}
      </select>
    </label>
    <label>
      {$t('frameleaf_pets_birthday')}
      <input type="date" bind:value={createBirthDate} />
    </label>
    <div class="form-actions">
      <FrameleafButton variant="quiet" onclick={() => (createOpen = false)}>{$t('cancel')}</FrameleafButton>
      <FrameleafButton variant="primary" type="submit">{$t('frameleaf_pets_create')}</FrameleafButton>
    </div>
  </form>
</Dialog>

<Dialog bind:open={detailsOpen} title={$t('frameleaf_pets_edit_details')} closeLabel={$t('close')}>
  {#if detailsFor}
    <form class="form" onsubmit={handleDetails}>
      <label>
        {$t('frameleaf_pets_species')}
        <select bind:value={detailsSpecies}>
          {#each petSpeciesOptions() as species (species)}
            <option value={species}>{$t(speciesLabelKey(species))}</option>
          {/each}
        </select>
      </label>
      <label>
        {$t('frameleaf_pets_birthday')}
        <input type="date" bind:value={detailsBirthDate} />
      </label>
      <p class="hint">{$t('frameleaf_pets_confirmed_photos', { values: { count: detailsFor.assetCount } })}</p>
      <div class="form-actions">
        <FrameleafButton variant="quiet" onclick={() => (detailsOpen = false)}>{$t('cancel')}</FrameleafButton>
        <FrameleafButton variant="primary" type="submit">{$t('save')}</FrameleafButton>
      </div>
    </form>
  {/if}
</Dialog>

<Dialog bind:open={mergeOpen} title={$t('frameleaf_pets_merge_into')} closeLabel={$t('close')}>
  {#if mergeFrom}
    <form class="form" onsubmit={handleMerge}>
      <p class="hint">
        {$t('frameleaf_pets_merge_prompt', {
          values: { name: mergeFrom.name || $t('frameleaf_pets_unnamed') },
        })}
      </p>
      <label>
        {$t('frameleaf_pets_merge_target')}
        <select bind:value={mergeTarget}>
          <option value="">{$t('frameleaf_pets_merge_target_placeholder')}</option>
          {#each mergeOptions as option (option.id)}
            <option value={option.id}>{option.name || $t('frameleaf_pets_unnamed')}</option>
          {/each}
        </select>
      </label>
      <div class="form-actions">
        <FrameleafButton variant="quiet" onclick={() => (mergeOpen = false)}>{$t('cancel')}</FrameleafButton>
        <FrameleafButton variant="primary" type="submit">{$t('frameleaf_pets_merge_confirm')}</FrameleafButton>
      </div>
    </form>
  {/if}
</Dialog>

<style>
  .pets {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    padding: 1rem;
  }
  .toolbar {
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem;
    align-items: center;
  }
  .toolbar input[type='search'] {
    flex: 1;
    min-width: 12rem;
    padding: 0.5rem 0.75rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .show-hidden {
    display: inline-flex;
    gap: 0.375rem;
    align-items: center;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .grid {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(11rem, 1fr));
    gap: 0.5rem;
    padding: 0;
    margin: 0;
    list-style: none;
  }
  .empty {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    justify-content: center;
    padding: 2rem;
    color: var(--fl-muted);
  }
  .form {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    min-width: min(24rem, 100%);
  }
  .form label {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .form input,
  .form select {
    padding: 0.5rem 0.625rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .form-actions {
    display: flex;
    gap: 0.5rem;
    justify-content: flex-end;
  }
  .hint {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
</style>
