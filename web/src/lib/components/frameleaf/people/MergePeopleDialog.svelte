<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import { isUnnamedPerson, sortMergeCandidates } from '$lib/frameleaf/people';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { getAllPeople, getPerson, mergePeople, type PeopleListItemDto, type PersonResponseDto } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiAccountOutline, mdiArrowRight, mdiCallMerge, mdiCheck } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * "Merge people" (FL-37, PD-4), ported from `MergePeopleDialog` in
   * design/frameleaf/template/src/People.jsx:434-536. It replaces the legacy full-screen
   * `MergeFaceSelector`: pick one person and everything tagged as `person` moves to them via
   * the existing `POST /people/merge`, whose first id survives (so the chosen person keeps
   * their name, birthday and favorite status).
   *
   * Candidates are the caller's already-loaded people when it has them (the People grid);
   * otherwise the dialog reads them with `getAllPeople`, hidden people included, as the
   * prototype lists them.
   */
  interface Props {
    person: PersonResponseDto & { assetCount?: number };
    candidates?: PeopleListItemDto[];
    /** A person to preselect, e.g. the one a rename just collided with. */
    initialChoice?: string | null;
    open?: boolean;
    onMerged: (target: PersonResponseDto) => void | Promise<void>;
  }

  let { person, candidates, initialChoice = null, open = $bindable(false), onMerged }: Props = $props();

  type Candidate = PersonResponseDto & { assetCount?: number };
  let loaded: PeopleListItemDto[] = $state([]);
  // The preselected person when the list does not include them (a library past the first page).
  let preselected: Candidate | null = $state(null);
  let query = $state('');
  let choice: string | null = $state(null);
  let busy = $state(false);

  const listed = $derived<Candidate[]>(candidates ?? loaded);
  const people = $derived<Candidate[]>(
    preselected && listed.every(({ id }) => id !== preselected!.id) ? [preselected, ...listed] : listed,
  );
  const rows = $derived(sortMergeCandidates(people, person.id, query));
  const target = $derived(people.find((candidate) => candidate.id === choice) ?? null);
  const self = $derived(people.find((candidate) => candidate.id === person.id));
  const nameOf = (candidate: { name: string }) => (isUnnamedPerson(candidate) ? $t('unnamed_person') : candidate.name);
  const itemCount = (count: number | undefined) =>
    count === undefined ? '' : $t('frameleaf_people_items_count', { values: { count } });

  $effect(() => {
    if (!open) {
      return;
    }
    query = '';
    choice = initialChoice;
    preselected = null;
    void (async () => {
      try {
        if (!candidates) {
          loaded = (await getAllPeople({ withHidden: true, size: 1000 })).people;
        }
        if (initialChoice && (candidates ?? loaded).every(({ id }) => id !== initialChoice)) {
          preselected = await getPerson({ id: initialChoice });
        }
      } catch (error) {
        handleError(error, $t('errors.failed_to_load_people'));
      }
    })();
  });

  const merge = async () => {
    if (!target || busy) {
      return;
    }
    busy = true;
    try {
      await mergePeople({ mergePersonDto: { ids: [target.id, person.id] } });
      // FL-37: every face of `person` now belongs to `target`; open face chips, search chips and
      // person pages re-read them
      eventManager.emit('PersonFacesChange', { personIds: [target.id, person.id], removedPersonIds: [person.id] });
      open = false;
      await onMerged(target);
    } catch (error) {
      handleError(error, $t('errors.unable_to_merge_people'));
    } finally {
      busy = false;
    }
  };
</script>

<Dialog title={$t('merge_people')} closeLabel={$t('close')} bind:open>
  <div class="preview" aria-live="polite">
    <div class="side">
      <PersonAvatar {person} size={72} />
      <strong>{nameOf(person)}</strong>
      <span>{itemCount(person.assetCount ?? self?.assetCount)}</span>
    </div>
    <span class="arrow" aria-hidden="true"><Icon icon={mdiArrowRight} size="22" /></span>
    <div class="side" class:empty={!target}>
      {#if target}
        <PersonAvatar person={target} size={72} />
        <strong>{nameOf(target)}</strong>
        <span>{itemCount(target.assetCount)}</span>
      {:else}
        <span class="placeholder" aria-hidden="true"><Icon icon={mdiAccountOutline} size="28" /></span>
        <strong>{$t('frameleaf_people_merge_choose')}</strong>
        <span>{$t('frameleaf_people_merge_choose_hint')}</span>
      {/if}
    </div>
  </div>
  <p class="hint">{$t('frameleaf_people_merge_description', { values: { name: nameOf(person) } })}</p>
  <input
    type="search"
    class="search"
    aria-label={$t('frameleaf_people_merge_find')}
    placeholder={$t('frameleaf_people_find_a_person')}
    bind:value={query}
    data-initial-focus
  />
  <ul class="list" aria-label={$t('people')}>
    {#each rows as candidate (candidate.id)}
      <li>
        <button type="button" aria-pressed={candidate.id === choice} onclick={() => (choice = candidate.id)}>
          <PersonAvatar person={candidate} size={40} />
          <span class="name" class:unnamed={isUnnamedPerson(candidate)}>{nameOf(candidate)}</span>
          <span class="count">{itemCount(candidate.assetCount)}</span>
          {#if candidate.id === choice}
            <Icon icon={mdiCheck} size="18" aria-hidden="true" />
          {/if}
        </button>
      </li>
    {:else}
      <li class="empty">{$t('frameleaf_people_merge_no_match')}</li>
    {/each}
  </ul>
  {#snippet actions()}
    <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
    <Button variant="primary" disabled={!target || busy} onclick={merge}>
      <Icon icon={mdiCallMerge} size="18" aria-hidden="true" />
      {$t('frameleaf_people_merge')}
    </Button>
  {/snippet}
</Dialog>

<style>
  /* template/src/people.css `.pp-merge-*`, `.pp-dialog-hint`, `.pp-search`, `.pp-person-list`. */
  .preview {
    display: grid;
    grid-template-columns: 1fr auto 1fr;
    align-items: center;
    gap: 12px;
    padding: 16px;
    margin-bottom: 16px;
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .side {
    display: flex;
    flex-direction: column;
    align-items: center;
    gap: 6px;
    min-width: 0;
    text-align: center;
  }
  .side strong {
    max-width: 100%;
    overflow: hidden;
    font-weight: 600;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .side span {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .side.empty strong {
    color: var(--fl-muted);
    font-weight: 500;
  }
  .arrow {
    display: inline-flex;
    color: var(--fl-muted);
  }
  .side .placeholder {
    display: inline-flex;
    align-items: center;
    justify-content: center;
    width: 72px;
    height: 72px;
    color: var(--fl-muted);
    border: 1px dashed var(--fl-border);
    border-radius: 50%;
  }
  .hint {
    margin: 0 0 16px;
    color: var(--fl-muted);
    line-height: 1.5;
  }
  .search {
    width: 100%;
    min-height: 44px;
    margin-bottom: 10px;
    font-size: var(--fl-font-size);
  }
  .list {
    display: flex;
    flex-direction: column;
    gap: 4px;
    max-height: 300px;
    margin: 0;
    padding: 0;
    overflow: auto;
    list-style: none;
  }
  .list button {
    display: flex;
    align-items: center;
    gap: 12px;
    width: 100%;
    min-height: 52px;
    padding: 6px 10px;
    color: var(--fl-text);
    text-align: start;
    background: none;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
  }
  .list button:hover {
    background: var(--fl-raised);
  }
  .list button[aria-pressed='true'] {
    background: var(--fl-accent-soft);
    border-color: var(--fl-accent);
  }
  .name {
    flex: 1;
    min-width: 0;
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
  }
  .name.unnamed {
    color: var(--fl-muted);
    font-style: italic;
  }
  .count {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .empty {
    padding: 16px;
    color: var(--fl-muted);
    text-align: center;
  }
  @media (max-width: 700px) {
    .preview {
      gap: 8px;
      padding: 12px;
    }
  }
</style>
