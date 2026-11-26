<script lang="ts">
  /**
   * Notes on the person page (FL-941), the Notes card of `PersonAbout` in the approved prototype's
   * QuickWinsJanMar.jsx: a short private note, plain text, with web links shown as links. The server
   * only ever sends `notes` to the person's owner, so a person read without the field (a partner's)
   * shows no card at all. Saving an empty note clears it.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { PERSON_NOTES_MAX, noteParts } from '$lib/frameleaf/person-notes';
  import { eventManager } from '$lib/managers/event-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { updatePerson, type PersonResponseDto } from '@frameleaf/sdk';
  import { Icon, toastManager } from '@frameleaf/ui';
  import { mdiPencilOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  interface Props {
    person: PersonResponseDto;
    onPersonChange?: (person: PersonResponseDto) => void;
  }
  let { person, onPersonChange }: Props = $props();

  let editing = $state(false);
  let draft = $state('');
  let busy = $state(false);
  const note = $derived(person.notes ?? '');
  const label = $derived(
    person.name
      ? $t('frameleaf_person_notes_label', { values: { person: person.name } })
      : $t('frameleaf_person_notes_title'),
  );
  // Another person, or the same one read again, starts from what is saved.
  $effect(() => {
    void person.id;
    editing = false;
  });

  const edit = () => {
    draft = note;
    editing = true;
  };
  const save = async () => {
    busy = true;
    try {
      const notes = draft.trim() ? draft : null;
      const updated = await updatePerson({ id: person.id, personUpdateDto: { notes } });
      eventManager.emit('PersonUpdate', updated);
      onPersonChange?.(updated);
      editing = false;
      toastManager.primary($t(notes ? 'frameleaf_person_notes_saved' : 'frameleaf_person_notes_removed'));
    } catch (error) {
      handleError(error, $t('frameleaf_person_notes_error'));
    } finally {
      busy = false;
    }
  };
  const focus = (node: HTMLTextAreaElement) => node.focus();
</script>

{#if person.notes !== undefined}
  <section class="notes" aria-label={label}>
    <div class="card">
      <div class="heading">
        <h2>{$t('frameleaf_person_notes_title')} <small>{$t('frameleaf_person_notes_private')}</small></h2>
        {#if !editing}
          <Button onclick={edit}>
            <Icon icon={mdiPencilOutline} size="18" aria-hidden="true" />
            {$t(note ? 'edit' : 'frameleaf_person_notes_add')}
          </Button>
        {/if}
      </div>
      {#if editing}
        <div class="edit">
          <textarea
            aria-label={label}
            bind:value={draft}
            maxlength={PERSON_NOTES_MAX}
            rows="5"
            placeholder={$t('frameleaf_person_notes_placeholder')}
            disabled={busy}
            use:focus></textarea>
          <div class="actions">
            <small>
              {$t('frameleaf_person_notes_count', {
                values: { count: draft.length.toLocaleString($locale), max: PERSON_NOTES_MAX.toLocaleString($locale) },
              })}
            </small>
            <Button disabled={busy} onclick={() => (editing = false)}>{$t('cancel')}</Button>
            <Button variant="primary" disabled={busy} onclick={save}>{$t('save')}</Button>
          </div>
        </div>
      {:else if note}
        <p class="note">
          {#each noteParts(note) as part, index (index)}{#if part.href}<a
                href={part.href}
                target="_blank"
                rel="noopener noreferrer">{part.text}</a
              >{:else}{part.text}{/if}{/each}
        </p>
      {:else}
        <p class="quiet">{$t('frameleaf_person_notes_empty')}</p>
      {/if}
    </div>
  </section>
{/if}

<style>
  /* The prototype's quick-wins.css `.qw-about*` and `.qw-note*`; the side gutter is the person header's. */
  .notes {
    /* The header's band overlaps the next section by about 12px, so 36px leaves the prototype's 24px. */
    padding: 36px calc(var(--fl-space-2) + var(--fl-page-inline)) 8px;
    background: var(--fl-canvas);
  }
  .card {
    display: grid;
    align-content: start;
    gap: 12px;
    max-width: 880px;
    padding: 20px 24px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-panel);
  }
  .heading {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    min-height: 40px;
  }
  h2 {
    display: flex;
    flex-wrap: wrap;
    align-items: baseline;
    gap: 4px 12px;
    margin: 0;
    font-size: var(--fl-font-size);
    font-weight: var(--fl-weight-semibold);
  }
  h2 small,
  .quiet,
  .actions small {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 400;
    line-height: 1.5;
  }
  .note {
    margin: 0;
    line-height: 1.6;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
  }
  .note a {
    color: var(--fl-accent);
    text-decoration: underline;
    text-underline-offset: 2px;
  }
  .edit {
    display: grid;
    gap: 12px;
  }
  textarea {
    display: block;
    width: 100%;
    min-height: 132px;
    padding: 12px;
    color: var(--fl-text);
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font: inherit;
    line-height: 1.5;
    resize: vertical;
  }
  textarea:focus-visible {
    border-color: var(--fl-accent);
    outline: 2px solid color-mix(in srgb, var(--fl-accent) 35%, transparent);
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: flex-end;
    gap: 8px 12px;
  }
  .actions small {
    margin-inline-end: auto;
  }
</style>
