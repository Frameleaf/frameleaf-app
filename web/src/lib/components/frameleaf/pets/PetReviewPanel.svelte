<script lang="ts">
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import PetThumbnail from '$lib/components/frameleaf/pets/PetThumbnail.svelte';
  import {
    confidencePercent,
    findPet,
    groupCandidatesByAsset,
    reviewEmptyState,
    speciesLabelKey,
  } from '$lib/frameleaf/pets';
  import type { PetCandidateResponseDto, PetResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiCheck, mdiClose, mdiSwapHorizontal } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Recognition review (FL-58).
   *
   * Accept, reassign and reject each produce one durable decision on the server; this
   * panel only renders the queue and calls the caller's handlers.
   *
   * The empty state is deliberately two different messages. "Nothing left to review"
   * would be a false claim on a server with no pet recognition model, where nothing can
   * ever be proposed; the server reports which case applies and the panel says so.
   */
  interface Props {
    candidates: PetCandidateResponseDto[];
    pets: PetResponseDto[];
    /** Why it is unavailable is said by `PetRecognitionPanel` above this panel (FL-58). */
    recognitionAvailable: boolean;
    busyCandidateId?: string | null;
    onAccept: (candidate: PetCandidateResponseDto) => void;
    onReassign: (candidate: PetCandidateResponseDto, petId: string) => void;
    onReject: (candidate: PetCandidateResponseDto) => void;
  }

  let {
    candidates,
    pets,
    recognitionAvailable,
    busyCandidateId = null,
    onAccept,
    onReassign,
    onReject,
  }: Props = $props();

  const groups = $derived(groupCandidatesByAsset(candidates));
  const emptyState = $derived(reviewEmptyState({ candidateCount: candidates.length, recognitionAvailable }));

  let reassigning = $state<string | null>(null);
  let reassignTarget = $state('');

  const petName = (id: string) => findPet(pets, id)?.name || $t('frameleaf_pets_unnamed');

  const startReassign = (candidate: PetCandidateResponseDto) => {
    reassigning = candidate.id;
    reassignTarget = '';
  };

  const confirmReassign = (candidate: PetCandidateResponseDto) => {
    if (!reassignTarget) {
      return;
    }
    onReassign(candidate, reassignTarget);
    reassigning = null;
  };
</script>

<section class="review" aria-labelledby="pet-review-heading">
  <header>
    <h2 id="pet-review-heading">{$t('frameleaf_pets_review_title')}</h2>
    {#if candidates.length > 0}
      <p class="count">{$t('frameleaf_pets_review_count', { values: { count: candidates.length } })}</p>
    {/if}
  </header>

  {#if emptyState !== 'none'}
    <p class="empty">
      {#if emptyState === 'unavailable'}
        {$t('frameleaf_pets_review_unavailable')}
      {:else}
        {$t('frameleaf_pets_review_all_done')}
      {/if}
    </p>
  {:else}
    <ul class="groups">
      {#each groups as group (group.assetId)}
        <li class="group">
          <PetThumbnail assetId={group.assetId} size={112} alt="" />
          <ul class="proposals">
            {#each group.candidates as candidate (candidate.id)}
              <li class="proposal">
                <div class="proposal-text">
                  <p class="headline">
                    {$t('frameleaf_pets_review_question', { values: { name: petName(candidate.petId) } })}
                  </p>
                  <p class="evidence">
                    <span>
                      {$t('frameleaf_pets_review_confidence', {
                        values: { percent: confidencePercent(candidate.score) },
                      })}
                    </span>
                    <span aria-hidden="true">&middot;</span>
                    <!-- The model identity is shown because a proposal is only as good as
                         the revision that made it, and that revision can change. -->
                    <span>
                      {$t('frameleaf_pets_review_model', {
                        values: { model: candidate.modelName, revision: candidate.modelRevision },
                      })}
                    </span>
                    {#if candidate.detectedSpecies}
                      <span aria-hidden="true">&middot;</span>
                      <span>
                        {$t('frameleaf_pets_review_detected_species', {
                          values: { species: candidate.detectedSpecies },
                        })}
                      </span>
                    {/if}
                  </p>
                </div>

                {#if reassigning === candidate.id}
                  <div class="reassign">
                    <label for="reassign-{candidate.id}">{$t('frameleaf_pets_review_reassign_label')}</label>
                    <select id="reassign-{candidate.id}" bind:value={reassignTarget}>
                      <option value="">{$t('frameleaf_pets_review_reassign_placeholder')}</option>
                      {#each pets as option (option.id)}
                        <option value={option.id}>
                          {option.name || $t('frameleaf_pets_unnamed')} &middot; {$t(speciesLabelKey(option.species))}
                        </option>
                      {/each}
                    </select>
                    <FrameleafButton
                      variant="primary"
                      disabled={!reassignTarget || busyCandidateId === candidate.id}
                      onclick={() => confirmReassign(candidate)}
                    >
                      {$t('frameleaf_pets_review_reassign_confirm')}
                    </FrameleafButton>
                    <FrameleafButton variant="quiet" onclick={() => (reassigning = null)}>
                      {$t('cancel')}
                    </FrameleafButton>
                  </div>
                {:else}
                  <div class="actions">
                    <FrameleafButton
                      variant="primary"
                      disabled={busyCandidateId === candidate.id}
                      onclick={() => onAccept(candidate)}
                    >
                      <Icon icon={mdiCheck} size="16" />
                      {$t('frameleaf_pets_review_accept')}
                    </FrameleafButton>
                    <FrameleafButton
                      disabled={busyCandidateId === candidate.id || pets.length < 2}
                      onclick={() => startReassign(candidate)}
                    >
                      <Icon icon={mdiSwapHorizontal} size="16" />
                      {$t('frameleaf_pets_review_reassign')}
                    </FrameleafButton>
                    <FrameleafButton
                      variant="quiet"
                      disabled={busyCandidateId === candidate.id}
                      onclick={() => onReject(candidate)}
                    >
                      <Icon icon={mdiClose} size="16" />
                      {$t('frameleaf_pets_review_reject')}
                    </FrameleafButton>
                  </div>
                {/if}
              </li>
            {/each}
          </ul>
        </li>
      {/each}
    </ul>
  {/if}
</section>

<style>
  .review {
    padding: 1rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  header {
    display: flex;
    align-items: baseline;
    gap: 0.5rem;
    margin-bottom: 0.75rem;
  }
  h2 {
    margin: 0;
    font-size: 1rem;
    font-weight: 600;
    color: var(--fl-text);
  }
  .count,
  .empty,
  .evidence {
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .groups,
  .proposals {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0;
    margin: 0;
    list-style: none;
  }
  .group {
    display: flex;
    gap: 0.75rem;
    align-items: flex-start;
    padding: 0.75rem;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .proposals {
    flex: 1;
    min-width: 0;
  }
  .proposal {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
    justify-content: space-between;
  }
  .headline {
    margin: 0;
    color: var(--fl-text);
  }
  .evidence {
    display: flex;
    flex-wrap: wrap;
    gap: 0.25rem;
  }
  .actions,
  .reassign {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    align-items: center;
  }
  .reassign label {
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .reassign select {
    padding: 0.375rem 0.5rem;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }

  @media (max-width: 48rem) {
    .group {
      flex-direction: column;
      align-items: stretch;
    }
  }
</style>
