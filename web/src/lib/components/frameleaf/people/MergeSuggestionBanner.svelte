<script lang="ts">
  /**
   * Frameleaf FL-57: the guided merge-suggestion verdict banner, ported from the
   * prototype's `pl-suggestion` in `design/frameleaf/template/src/People.jsx:808-860`
   * (`PeopleLibrary`): two face crops, "Are these the same person?", the pair's names,
   * "N more to review", "Yes, merge" and "No". The pair line is the prototype's "{A} and {B} · {reason}."
   * (FL-83 PG-10): a shared first name, otherwise that their faces look alike. Unlike the prototype (which invents pairs
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
   * be undone from the toast. The two quiet answers are the prototype's skip affordance; they sit
   * in a small "More answers" menu so the row is the question's two real answers.
   *
   * A person without a name is "Unnamed person" here, never the "Add a name" button label. On
   * "Yes, merge" the two faces slide together while the merge is saved, and the next suggestion
   * fades in (movement is dropped under Reduce Motion by the shared rules).
   */
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import FaceCrop from '$lib/components/frameleaf/people/FaceCrop.svelte';
  import { sharedFirstName } from '$lib/frameleaf/merge-suggestion';
  import { reveal } from '$lib/frameleaf/motion';
  import { isUnnamedPerson } from '$lib/frameleaf/people';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type FaceEvidenceDto, type PersonMergeSuggestionDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiClockOutline, mdiDotsHorizontal, mdiEyeOffOutline } from '@mdi/js';
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

  const personUnnamed = $derived(isUnnamedPerson(suggestion.person));
  const personName = $derived(personUnnamed ? $t('unnamed_person') : suggestion.person.name);
  const suggestionName = $derived(
    isUnnamedPerson(suggestion.suggestion) ? $t('unnamed_person') : suggestion.suggestion.name,
  );
  const pairKey = $derived(`${suggestion.person.id}|${suggestion.suggestion.id}`);
  // "Yes, merge" was pressed for this pair: the faces slide together until the next pair arrives.
  let mergingKey = $state<string | undefined>();
  const merging = $derived(busy && mergingKey === pairKey);
  const accept = () => {
    mergingKey = pairKey;
    onAccept();
  };
  // FL-83 (PG-10): the prototype's "{A} and {B} · {reason}." line.
  const sameName = $derived(sharedFirstName(suggestion.person.name, suggestion.suggestion.name));
  const reason = $derived(
    sameName
      ? $t('frameleaf_people_merge_suggestion_reason_name', { values: { name: sameName } })
      : $t('frameleaf_people_merge_suggestion_reason_faces'),
  );
  const sides = $derived([
    { person: suggestion.person, name: personName, evidence: suggestion.personEvidence },
    { person: suggestion.suggestion, name: suggestionName, evidence: suggestion.suggestionEvidence },
  ]);

  const photoUrl = (evidence: FaceEvidenceDto, size: AssetMediaSize) =>
    getAssetMediaUrl({ id: evidence.assetId, size });
</script>

<section class="fl-merge-suggestion" aria-label={$t('frameleaf_people_merge_suggestion_label')}>
  {#key pairKey}
    <div class="fl-merge-suggestion-pair" in:reveal>
      <div class="fl-merge-suggestion-main">
        <div class="fl-merge-suggestion-faces" class:is-merging={merging} aria-hidden="true">
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
            >{$t('frameleaf_people_merge_suggestion_pair', {
              values: { first: personName, second: suggestionName, reason },
            })}</span
          >
          {#if remaining > 0}
            <small>{$t('frameleaf_people_merge_suggestion_more', { values: { count: remaining } })}</small>
          {/if}
        </div>
        <div class="fl-merge-suggestion-actions">
          <FrameleafButton variant="primary" disabled={busy} onclick={accept}>
            {$t('frameleaf_people_merge_suggestion_accept')}
          </FrameleafButton>
          <FrameleafButton disabled={busy} onclick={onReject}>
            {$t('frameleaf_people_merge_suggestion_reject')}
          </FrameleafButton>
          <Menu label={$t('frameleaf_people_merge_suggestion_more_answers')} align="end">
            {#snippet trigger()}
              <Icon icon={mdiDotsHorizontal} size={ICON_SIZE.lg} aria-hidden="true" />
            {/snippet}
            <MenuItem disabled={busy} onSelect={onSkip}>
              <Icon icon={mdiClockOutline} size={ICON_SIZE.md} aria-hidden="true" />
              {$t('frameleaf_people_merge_suggestion_skip')}
            </MenuItem>
            <MenuItem disabled={busy} onSelect={onIgnore}>
              <Icon icon={mdiEyeOffOutline} size={ICON_SIZE.md} aria-hidden="true" />
              {personUnnamed
                ? $t('frameleaf_people_merge_suggestion_ignore_unnamed')
                : $t('frameleaf_people_merge_suggestion_ignore', { values: { name: personName } })}
            </MenuItem>
          </Menu>
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
    </div>
  {/key}
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
  .fl-merge-suggestion-pair {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
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
  .fl-merge-suggestion-faces > :global(*) {
    transition: translate var(--fl-duration) var(--fl-spring);
  }
  .fl-merge-suggestion-faces > :global(:not(:first-child)) {
    margin-inline-start: -1rem;
    border: 2px solid var(--fl-panel);
  }
  /* "Yes, merge": the two faces meet in the middle while the merge is saved. */
  .fl-merge-suggestion-faces.is-merging > :global(:first-child) {
    translate: 1.5rem 0;
  }
  .fl-merge-suggestion-faces.is-merging > :global(:not(:first-child)) {
    translate: -1.5rem 0;
  }
  :global([dir='rtl']) .fl-merge-suggestion-faces.is-merging > :global(:first-child) {
    translate: -1.5rem 0;
  }
  :global([dir='rtl']) .fl-merge-suggestion-faces.is-merging > :global(:not(:first-child)) {
    translate: 1.5rem 0;
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
    border-radius: var(--fl-radius-sm);
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
