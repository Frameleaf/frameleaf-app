<script lang="ts">
  /**
   * FL-58: every decision the owner made about one pet — confirmed in a photo or not, marked by
   * hand or answered from a suggestion, a region or the whole photo — with Remove (and Undo in its
   * toast). A region drawn on a photo whose original was later replaced is flagged; the owner keeps
   * it as a whole-photo decision or removes it. Composed from the prototype's grouped list rows
   * (apple-style.css `.grouped`) with squircle photos, as the People correction history lists do.
   */
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import PetThumbnail from '$lib/components/frameleaf/pets/PetThumbnail.svelte';
  import { toastPetDecision } from '$lib/frameleaf/pet-undo';
  import { hasRegion, isSourceConflict, isStaleObservation, observationToCreate } from '$lib/frameleaf/pets';
  import { handleError } from '$lib/utils/handle-error';
  import {
    PetObservationSource,
    PetObservationState,
    createPetObservation,
    deletePetObservation,
    getPetObservations,
    type PetObservationResponseDto,
  } from '@immich/sdk';
  import { Icon, toastManager } from '@immich/ui';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    petId: string;
    /** Called after a decision changed, so the page can reload the pet's photos. */
    onChanged?: () => void;
  }

  let { petId, onChanged }: Props = $props();

  let observations = $state<PetObservationResponseDto[]>([]);
  let loadedFor = $state<string | null>(null);
  let busyId = $state<string | null>(null);

  const staleCount = $derived(observations.filter((observation) => isStaleObservation(observation)).length);
  const ordered = $derived(
    [...observations].sort(
      (a, b) => Number(isStaleObservation(b)) - Number(isStaleObservation(a)) || b.updatedAt.localeCompare(a.updatedAt),
    ),
  );

  const load = async (id: string) => {
    try {
      const found = await getPetObservations({ id });
      if (id === petId) {
        observations = found;
        loadedFor = id;
      }
    } catch (error) {
      handleError(error, $t('frameleaf_pet_decisions_error'));
    }
  };

  $effect(() => {
    if (loadedFor !== petId) {
      void load(petId);
    }
  });

  const fail = (error: unknown) => {
    if (isSourceConflict(error)) {
      toastManager.warning($t('frameleaf_pets_photo_changed'));
      void load(petId);
    } else {
      handleError(error, $t('frameleaf_pet_decisions_error'));
    }
  };

  // A current decision names the photo it was made on; a stale one is being resolved on purpose.
  const expectedOf = (observation: PetObservationResponseDto) =>
    isStaleObservation(observation) ? undefined : (observation.sourceChecksum ?? undefined);

  const remove = async (observation: PetObservationResponseDto) => {
    busyId = observation.id;
    try {
      await deletePetObservation({ id: observation.id, expectedChecksum: expectedOf(observation) });
      observations = observations.filter((entry) => entry.id !== observation.id);
      onChanged?.();
      toastPetDecision($t('frameleaf_pet_decision_removed'), async () => {
        try {
          if (observation.state === PetObservationState.Confirmed) {
            await createPetObservation({
              id: observation.petId,
              petObservationCreateDto: observationToCreate(observation, expectedOf(observation)),
            });
          }
          await load(petId);
          onChanged?.();
          toastManager.primary($t('frameleaf_pets_undone'));
        } catch (error) {
          fail(error);
        }
      });
    } catch (error) {
      fail(error);
    } finally {
      busyId = null;
    }
  };

  const keepWholePhoto = async (observation: PetObservationResponseDto) => {
    busyId = observation.id;
    try {
      const updated = await createPetObservation({
        id: observation.petId,
        petObservationCreateDto: { assetId: observation.assetId },
      });
      observations = observations.map((entry) => (entry.id === observation.id ? updated : entry));
    } catch (error) {
      fail(error);
    } finally {
      busyId = null;
    }
  };
</script>

<details class="decisions fl-continuous-corners" open={staleCount > 0} data-testid="pet-decisions">
  <summary>
    {$t('frameleaf_pet_decisions_title')}
    <span class="count">{$t('frameleaf_pet_decisions_count', { values: { count: observations.length } })}</span>
    {#if staleCount > 0}
      <span class="stale-count">
        <Icon icon={mdiAlertCircleOutline} size="14" aria-hidden={true} />
        {$t('frameleaf_pet_decisions_stale_count', { values: { count: staleCount } })}
      </span>
    {/if}
  </summary>

  {#if loadedFor === petId && observations.length === 0}
    <p class="muted">{$t('frameleaf_pet_decisions_empty')}</p>
  {:else}
    <ul>
      {#each ordered as observation (observation.id)}
        <li class:stale={isStaleObservation(observation)} data-testid="pet-decision">
          <PetThumbnail assetId={observation.assetId} size={56} alt="" />
          <div class="text">
            <p>
              {observation.state === PetObservationState.Confirmed
                ? $t('frameleaf_pet_decision_confirmed')
                : $t('frameleaf_pet_decision_rejected')}
            </p>
            <p class="muted">
              {observation.source === PetObservationSource.Manual
                ? $t('frameleaf_pet_decision_manual')
                : $t('frameleaf_pet_decision_review')}
              <span aria-hidden="true">&middot;</span>
              {hasRegion(observation) ? $t('frameleaf_pet_decision_region') : $t('frameleaf_pet_decision_whole')}
            </p>
            {#if isStaleObservation(observation)}
              <p class="warning">{$t('frameleaf_pet_decision_stale')}</p>
            {/if}
          </div>
          <div class="actions">
            {#if isStaleObservation(observation)}
              <FrameleafButton disabled={busyId === observation.id} onclick={() => void keepWholePhoto(observation)}>
                {$t('frameleaf_pet_decision_keep_whole')}
              </FrameleafButton>
            {/if}
            <FrameleafButton
              variant="quiet"
              disabled={busyId === observation.id}
              onclick={() => void remove(observation)}
            >
              {$t('frameleaf_pet_decision_remove')}
            </FrameleafButton>
          </div>
        </li>
      {/each}
    </ul>
  {/if}
</details>

<style>
  .decisions {
    padding: 0.75rem 1rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  summary {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    min-height: 44px;
    font-weight: 600;
    cursor: pointer;
  }
  .count,
  .muted {
    font-size: var(--fl-font-small);
    font-weight: 400;
    color: var(--fl-muted);
  }
  .stale-count,
  .warning {
    display: inline-flex;
    gap: 0.25rem;
    align-items: center;
    font-size: var(--fl-font-small);
    font-weight: 400;
    color: var(--fl-warning-text);
  }
  ul {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0.5rem 0 0;
    padding: 0;
    list-style: none;
  }
  li {
    display: flex;
    gap: 0.75rem;
    align-items: center;
    padding: 0.5rem;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  li.stale {
    outline: 1px solid var(--fl-warning);
  }
  .text {
    flex: 1;
    min-width: 0;
  }
  .text p {
    margin: 0;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
  }
</style>
