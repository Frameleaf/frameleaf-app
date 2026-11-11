<script lang="ts">
  /**
   * FL-1385: "Is this all one person?", ported from the approved mock (`pl-mixed` in the prototype's
   * People.jsx, prototype PR 43). It sits where the merge suggestion sits and waits behind it. The
   * person, how many of their photos look like someone else, and a few faces from each side: most of
   * the person's photos, and the ones that look different. The server only ever returns faces on
   * photos the viewer may see.
   *
   * "No, split them" moves those faces to a new, unnamed person; "Yes, all {name}" never asks again;
   * "Ask me later" is the quiet answer in the same "More answers" menu the merge suggestion has. The
   * banner never calls the network: the People page owns the answers and their undo.
   */
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import Menu from '$lib/components/frameleaf/Menu.svelte';
  import MenuItem from '$lib/components/frameleaf/MenuItem.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import FaceCrop from '$lib/components/frameleaf/people/FaceCrop.svelte';
  import { reveal } from '$lib/frameleaf/motion';
  import { isUnnamedPerson } from '$lib/frameleaf/people';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { getAssetMediaUrl } from '$lib/utils';
  import { AssetMediaSize, type FaceEvidenceDto, type PersonSplitSuggestionDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCallSplit, mdiClockOutline, mdiDotsHorizontal } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    suggestion: PersonSplitSuggestionDto;
    /** Suggestions still waiting behind this one, this session. */
    remaining: number;
    busy?: boolean;
    onSplit: () => void;
    onSame: () => void;
    onSkip: () => void;
  }

  let { suggestion, remaining, busy = false, onSplit, onSame, onSkip }: Props = $props();

  const unnamed = $derived(isUnnamedPerson(suggestion.person));
  const name = $derived(suggestion.person.name);
  const firstName = $derived(name.trim().split(/\s+/, 1)[0]);
  const groups = $derived([
    {
      key: 'person',
      label: unnamed
        ? $t('frameleaf_people_split_suggestion_most_unnamed')
        : $t('frameleaf_people_split_suggestion_most', { values: { name } }),
      faces: suggestion.personEvidence,
    },
    {
      key: 'other',
      label: $t('frameleaf_people_split_suggestion_different', { values: { count: suggestion.faceCount } }),
      faces: suggestion.otherEvidence,
    },
  ]);

  const photoUrl = (evidence: FaceEvidenceDto) =>
    getAssetMediaUrl({ id: evidence.assetId, size: AssetMediaSize.Preview });
</script>

<section class="fl-mixed-person" aria-label={$t('frameleaf_people_split_suggestion_label')}>
  {#key suggestion.person.id}
    <div class="fl-mixed-person-main" in:reveal>
      <div class="fl-mixed-person-face" aria-hidden="true">
        <PersonAvatar person={suggestion.person} size={64} />
      </div>
      <div class="fl-mixed-person-copy">
        <strong>
          {unnamed
            ? $t('frameleaf_people_split_suggestion_question_unnamed')
            : $t('frameleaf_people_split_suggestion_question', { values: { name } })}
        </strong>
        <span>
          {unnamed
            ? $t('frameleaf_people_split_suggestion_summary_unnamed', {
                values: { count: suggestion.faceCount, total: suggestion.totalFaceCount },
              })
            : $t('frameleaf_people_split_suggestion_summary', {
                values: { count: suggestion.faceCount, total: suggestion.totalFaceCount, name },
              })}
        </span>
        {#if remaining > 0}
          <small>{$t('frameleaf_people_merge_suggestion_more', { values: { count: remaining } })}</small>
        {/if}
      </div>
      <div class="fl-mixed-person-actions">
        <FrameleafButton variant="primary" disabled={busy} onclick={onSplit}>
          <Icon icon={mdiCallSplit} size={ICON_SIZE.lg} aria-hidden="true" />
          {$t('frameleaf_people_split_suggestion_split')}
        </FrameleafButton>
        <FrameleafButton disabled={busy} onclick={onSame}>
          {unnamed
            ? $t('frameleaf_people_split_suggestion_same_unnamed')
            : $t('frameleaf_people_split_suggestion_same', { values: { name: firstName } })}
        </FrameleafButton>
        <Menu label={$t('frameleaf_people_merge_suggestion_more_answers')} align="end">
          {#snippet trigger()}
            <Icon icon={mdiDotsHorizontal} size={ICON_SIZE.lg} aria-hidden="true" />
          {/snippet}
          <MenuItem disabled={busy} onSelect={onSkip}>
            <Icon icon={mdiClockOutline} size={ICON_SIZE.md} aria-hidden="true" />
            {$t('frameleaf_people_merge_suggestion_skip')}
          </MenuItem>
        </Menu>
      </div>
      <div class="fl-mixed-person-evidence">
        {#each groups as group (group.key)}
          {#if group.faces.length > 0}
            <figure>
              <div class="fl-mixed-person-faces">
                {#each group.faces as face (face.faceId ?? face.assetId)}
                  <FaceCrop src={photoUrl(face)} box={face.box} size={56} />
                {/each}
              </div>
              <figcaption>{group.label}</figcaption>
            </figure>
          {/if}
        {/each}
      </div>
    </div>
  {/key}
</section>

<style>
  /* The merge suggestion's card (`fl-merge-suggestion`), with the faces of both sides under the question. */
  .fl-mixed-person {
    padding: 0.75rem 1rem;
    margin: 0 0.5rem 0.75rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .fl-mixed-person-main {
    display: grid;
    grid-template-columns: auto 1fr auto;
    align-items: center;
    gap: 0.75rem 1rem;
  }
  .fl-mixed-person-face {
    display: flex;
  }
  .fl-mixed-person-copy {
    display: flex;
    flex-direction: column;
    gap: 0.125rem;
    min-width: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .fl-mixed-person-copy strong {
    font-size: 1rem;
    color: var(--fl-text);
  }
  .fl-mixed-person-actions {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .fl-mixed-person-evidence {
    grid-column: 2 / -1;
    display: flex;
    flex-wrap: wrap;
    gap: 0.75rem 2rem;
  }
  .fl-mixed-person-evidence figure {
    display: flex;
    flex-direction: column;
    gap: 0.5rem;
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .fl-mixed-person-faces {
    display: flex;
    gap: 0.5rem;
  }
  @media (max-width: 700px) {
    .fl-mixed-person-main {
      grid-template-columns: auto 1fr;
    }
    .fl-mixed-person-actions,
    .fl-mixed-person-evidence {
      grid-column: 1 / -1;
      justify-content: flex-start;
    }
  }
</style>
