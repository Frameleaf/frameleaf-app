<script lang="ts">
  /**
   * Frameleaf FL-57: the guided merge-suggestion verdict banner, ported from the
   * prototype's `pl-suggestion` in `design/frameleaf/template/src/People.jsx:808-860`
   * (`PeopleLibrary`): two face crops, "Are these the same person?", the pair's names,
   * "N more to review", "Yes, merge" and "No". Unlike the prototype (which invents pairs
   * from sample data), the suggestion comes from the real `GET /people/merge-suggestions`,
   * which reuses the face-embedding distance the facial-recognition job clusters with.
   *
   * The story asks every verdict to show evidence: each person's reference face (the crop,
   * as the prototype's `PersonAvatar` with a face box) and the complete photo it is in, with
   * the face outlined. The server only ever returns a photo the viewer may see (their own, not
   * trashed, not Locked, not hidden); without one the person's avatar and "No photo you can
   * view" show instead. The photo pair follows the prototype's compare pattern
   * (`DuplicateReview.jsx` side-by-side photos).
   *
   * "Yes, merge" answers `same` (the server merges and records it in the correction history);
   * "No" (`different`), "Ask me later" (`later`) and "Stop suggesting {name}" (`ignore`: this
   * person is never suggested again, with anyone) are stored by the caller as verdicts and can
   * be undone from the toast. The two quiet answers are the prototype's skip affordance.
   */
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import FaceCrop from '$lib/components/frameleaf/people/FaceCrop.svelte';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type FaceEvidenceDto, type PersonMergeSuggestionDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  interface Props {
    suggestion: PersonMergeSuggestionDto;
    /** Suggestions still waiting behind this one, this session. */
    remaining: number;
    busy?: boolean;
    onAccept: () => void;
    onReject: () => void;
    onSkip: () => void;
    onIgnore: () => void;
  }

  let { suggestion, remaining, busy = false, onAccept, onReject, onSkip, onIgnore }: Props = $props();

  const personName = $derived(suggestion.person.name || $t('add_a_name'));
  const suggestionName = $derived(suggestion.suggestion.name || $t('add_a_name'));
  const sides = $derived([
    { person: suggestion.person, name: personName, evidence: suggestion.personEvidence },
    { person: suggestion.suggestion, name: suggestionName, evidence: suggestion.suggestionEvidence },
  ]);

  const photoUrl = (evidence: FaceEvidenceDto, size: AssetMediaSize) =>
    getAssetMediaUrl({ id: evidence.assetId, size });
</script>

<section class="fl-merge-suggestion" aria-label={$t('frameleaf_people_merge_suggestion_label')}>
  <div class="fl-merge-suggestion-main">
    <div class="fl-merge-suggestion-faces" aria-hidden="true">
      {#each sides as side (side.person.id)}
        {#if side.evidence}
          <FaceCrop src={photoUrl(side.evidence, AssetMediaSize.Preview)} box={side.evidence.box} size={64} />
        {:else}
          <PersonAvatar person={side.person} size={64} />
        {/if}
      {/each}
    </div>
    <div class="fl-merge-suggestion-copy">
      <strong>{$t('frameleaf_people_merge_suggestion_question')}</strong>
      <span
        >{$t('frameleaf_people_merge_suggestion_pair', { values: { first: personName, second: suggestionName } })}</span
      >
      {#if remaining > 0}
        <small>{$t('frameleaf_people_merge_suggestion_more', { values: { count: remaining } })}</small>
      {/if}
    </div>
    <div class="fl-merge-suggestion-actions">
      <FrameleafButton variant="primary" disabled={busy} onclick={onAccept}>
        {$t('frameleaf_people_merge_suggestion_accept')}
      </FrameleafButton>
      <FrameleafButton disabled={busy} onclick={onReject}>
        {$t('frameleaf_people_merge_suggestion_reject')}
      </FrameleafButton>
      <FrameleafButton variant="quiet" disabled={busy} onclick={onSkip}>
        {$t('frameleaf_people_merge_suggestion_skip')}
      </FrameleafButton>
      <FrameleafButton variant="quiet" disabled={busy} onclick={onIgnore}>
        {$t('frameleaf_people_merge_suggestion_ignore', { values: { name: personName } })}
      </FrameleafButton>
    </div>
  </div>
  <div class="fl-merge-suggestion-photos">
    {#each sides as side (side.person.id)}
      <figure class="fl-merge-suggestion-photo">
        {#if side.evidence}
          <span class="fl-merge-suggestion-frame">
            <img
              src={photoUrl(side.evidence, AssetMediaSize.Thumbnail)}
              alt={$t('frameleaf_people_merge_suggestion_photo', { values: { name: side.name } })}
              loading="lazy"
            />
            {#if side.evidence.box}
              <span
                class="fl-merge-suggestion-box"
                aria-hidden="true"
                style:left="{side.evidence.box.x * 100}%"
                style:top="{side.evidence.box.y * 100}%"
                style:width="{side.evidence.box.width * 100}%"
                style:height="{side.evidence.box.height * 100}%"
              ></span>
            {/if}
          </span>
        {:else}
          <span class="fl-merge-suggestion-frame is-empty">{$t('frameleaf_people_merge_suggestion_no_photo')}</span>
        {/if}
        <figcaption>{side.name}</figcaption>
      </figure>
    {/each}
  </div>
</section>

<style>
  .fl-merge-suggestion {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    padding: 0.75rem 1rem;
    margin: 0 0.5rem 0.75rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .fl-merge-suggestion-main {
    display: flex;
    align-items: center;
    gap: 1rem;
  }
  .fl-merge-suggestion-faces {
    display: flex;
    flex-shrink: 0;
  }
  .fl-merge-suggestion-faces > :global(:not(:first-child)) {
    margin-inline-start: -1rem;
    border: 2px solid var(--fl-panel);
  }
  .fl-merge-suggestion-copy {
    display: flex;
    flex: 1;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .fl-merge-suggestion-copy strong {
    font-size: 1rem;
    color: var(--fl-text);
  }
  .fl-merge-suggestion-actions {
    display: flex;
    flex-shrink: 0;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .fl-merge-suggestion-photos {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 12rem));
    gap: 0.75rem;
  }
  .fl-merge-suggestion-photo {
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  /* the frame is exactly the photo, so the face outline lines up with it */
  .fl-merge-suggestion-frame {
    position: relative;
    display: block;
    overflow: hidden;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .fl-merge-suggestion-frame img {
    display: block;
    width: 100%;
    height: auto;
  }
  .fl-merge-suggestion-frame.is-empty {
    aspect-ratio: 4 / 3;
    display: flex;
    align-items: center;
    justify-content: center;
    padding: 0.5rem;
    text-align: center;
  }
  .fl-merge-suggestion-box {
    position: absolute;
    border: 2px solid var(--fl-accent);
    border-radius: 6px;
  }
  @media (max-width: 700px) {
    .fl-merge-suggestion-main {
      flex-wrap: wrap;
    }
    .fl-merge-suggestion-actions {
      justify-content: flex-start;
      width: 100%;
    }
    .fl-merge-suggestion-photos {
      grid-template-columns: repeat(2, minmax(0, 1fr));
    }
  }
</style>
