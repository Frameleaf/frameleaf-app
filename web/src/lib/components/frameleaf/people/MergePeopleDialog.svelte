<script lang="ts">
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import PersonAvatar from '$lib/components/frameleaf/PersonAvatar.svelte';
  import PersonPicker from '$lib/components/frameleaf/people/PersonPicker.svelte';
  import { isUnnamedPerson } from '$lib/frameleaf/people';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { handleError } from '$lib/utils/handle-error';
  import { getPerson, mergePeople, type PersonResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiAccountOutline, mdiArrowRight, mdiCallMerge } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * "Merge people" (FL-37, PD-4), ported from `MergePeopleDialog` in
   * design/frameleaf/template/src/People.jsx:434-536. Pick one person and everything tagged as
   * `person` moves to them via `POST /people/merge`, whose first id survives (so the chosen person
   * keeps their name, birthday and favorite status).
   *
   * The list is the one person picker (FL-1814): it searches everyone on the server by name and
   * shows more on request, so nobody past the first page is out of reach.
   */
  type Candidate = Pick<PersonResponseDto, 'id' | 'name' | 'updatedAt'> & { assetCount?: number };
  interface Props {
    person: PersonResponseDto & { assetCount?: number };
    /** A person to preselect, e.g. the one a rename just collided with. */
    initialChoice?: string | null;
    open?: boolean;
    onMerged: (target: Candidate) => void | Promise<void>;
  }

  let { person, initialChoice = null, open = $bindable(false), onMerged }: Props = $props();

  let target: Candidate | null = $state(null);
  let busy = $state(false);

  const nameOf = (candidate: { name: string }) => (isUnnamedPerson(candidate) ? $t('unnamed_person') : candidate.name);
  const itemCount = (count: number | undefined) =>
    count === undefined ? '' : $t('frameleaf_people_items_count', { values: { count } });

  $effect(() => {
    if (!open) {
      return;
    }
    target = null;
    if (initialChoice) {
      const id = initialChoice;
      getPerson({ id })
        .then((found) => {
          if (open && !target) {
            target = found;
          }
        })
        .catch((error: unknown) => handleError(error, $t('errors.failed_to_load_people')));
    }
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
      <span>{itemCount(person.assetCount)}</span>
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
  {#if open}
    <PersonPicker
      excludeId={person.id}
      label={$t('frameleaf_people_merge_find')}
      selectedId={target?.id ?? ''}
      onPick={(picked) => (target = picked)}
    />
  {/if}
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
</style>
