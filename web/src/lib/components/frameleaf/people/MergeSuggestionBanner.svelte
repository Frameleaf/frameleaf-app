<script lang="ts">
  /**
   * Frameleaf FL-57: the guided merge-suggestion verdict banner, ported from the
   * prototype's `pl-suggestion` in `design/frameleaf/template/src/People.jsx`
   * (`PeopleLibrary`). Unlike the prototype (which invents pairs from sample data), the
   * suggestion here comes from the real `GET /people/merge-suggestions` endpoint added
   * for this story, which reuses the same face-embedding distance the facial-recognition
   * job already clusters faces with.
   *
   * "Accept" calls the real `POST /people/merge` (via the caller's `onAccept`). "Reject"
   * and "skip" have no server-side memory yet — see the FL-57 handoff report — so both
   * only affect which suggestion the caller shows next in this browsing session:
   * "reject" ("not the same person") drops the pair outright, "skip" ("ask me later")
   * re-queues it behind the others so it can resurface later in the same session.
   */
  import FrameleafButton from '$lib/components/frameleaf/Button.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import type { PersonMergeSuggestionDto } from '@immich/sdk';
  import { t } from 'svelte-i18n';

  interface Props {
    suggestion: PersonMergeSuggestionDto;
    /** Suggestions still waiting behind this one, this session. */
    remaining: number;
    busy?: boolean;
    onAccept: () => void;
    onReject: () => void;
    onSkip: () => void;
  }

  let { suggestion, remaining, busy = false, onAccept, onReject, onSkip }: Props = $props();

  const personName = $derived(suggestion.person.name || $t('add_a_name'));
  const suggestionName = $derived(suggestion.suggestion.name || $t('add_a_name'));
</script>

<section class="fl-merge-suggestion" aria-label={$t('frameleaf_people_merge_suggestion_label')}>
  <div class="fl-merge-suggestion-faces" aria-hidden="true">
    <PersonAvatar person={suggestion.person} size={64} />
    <PersonAvatar person={suggestion.suggestion} size={64} />
  </div>
  <div class="fl-merge-suggestion-copy">
    <strong>{$t('frameleaf_people_merge_suggestion_question')}</strong>
    <span>{$t('frameleaf_people_merge_suggestion_pair', { values: { first: personName, second: suggestionName } })}</span>
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
  </div>
</section>

<style>
  .fl-merge-suggestion {
    display: flex;
    align-items: center;
    gap: 1rem;
    padding: 0.75rem 1rem;
    margin: 0 0.5rem 0.75rem;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .fl-merge-suggestion-faces {
    display: flex;
    flex-shrink: 0;
  }
  .fl-merge-suggestion-faces :global(.avatar:not(:first-child)) {
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
    gap: 0.5rem;
  }
  @media (max-width: 700px) {
    .fl-merge-suggestion {
      flex-wrap: wrap;
    }
    .fl-merge-suggestion-actions {
      flex-wrap: wrap;
      width: 100%;
    }
  }
</style>
