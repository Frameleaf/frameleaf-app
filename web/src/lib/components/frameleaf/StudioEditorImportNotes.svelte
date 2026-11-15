<script lang="ts">
  /**
   * Import notes in the editor (FL-1545, approved mock 2026-11-13): for a project imported from
   * another editor, a banner and, under it, each note with the time it applies to. Choosing a time
   * moves the playhead there. A project that was not imported shows nothing.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import {
    EDITOR_IMPORT_APPS,
    editorImportClock,
    editorImportNoteKey,
    type EditorImportSource,
  } from '$lib/frameleaf/studio/editor-import';
  import { getStudioEditorImportNotes, type StudioEditorImportProjectNotesDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose, mdiFileImportOutline } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  let { projectId, onGo }: { projectId: string; onGo: (seconds: number) => void } = $props();

  let notes = $state<StudioEditorImportProjectNotesDto | null>(null);
  let open = $state(true);
  let shown = $state(true);

  const load = async (id: string, isCurrent: () => boolean) => {
    try {
      const found = await getStudioEditorImportNotes({ id });
      if (isCurrent() && found) {
        notes = found;
      }
    } catch {
      // Not imported, or not the owner's: nothing to show.
    }
  };

  $effect(() => {
    const id = projectId;
    notes = null;
    let current = true;
    void load(id, () => current);
    return () => {
      current = false;
    };
  });

  const app = $derived(notes ? EDITOR_IMPORT_APPS[notes.source as EditorImportSource] : undefined);
  const sorted = $derived(notes ? [...notes.notes].sort((a, b) => a.atSeconds - b.atSeconds) : []);
</script>

{#if notes && shown}
  <div class="banner" role="status">
    <Icon icon={mdiFileImportOutline} size={18} />
    <span class="text">
      <b>
        {app
          ? $t('frameleaf_studio_editor_import_banner_title', { values: { app } })
          : $t('frameleaf_studio_editor_import_banner_title_plain')}
      </b>
      <span class="muted">
        {$t('frameleaf_studio_editor_import_banner_meta', { values: { file: notes.fileName, count: sorted.length } })}
      </span>
    </span>
    {#if sorted.length > 0}
      <Button variant="quiet" pressed={open} onclick={() => (open = !open)}>
        {open ? $t('frameleaf_studio_editor_import_hide_notes') : $t('frameleaf_studio_editor_import_show_notes')}
      </Button>
    {/if}
    <Button variant="quiet" label={$t('frameleaf_studio_editor_import_hide_banner')} onclick={() => (shown = false)}>
      <Icon icon={mdiClose} size={18} />
    </Button>
  </div>
  {#if open && sorted.length > 0}
    <ul class="notes" aria-label={$t('frameleaf_studio_editor_import_notes_label')}>
      {#each sorted as note, index (index)}
        <li>
          <button
            type="button"
            onclick={() => onGo(note.atSeconds)}
            aria-label={$t('frameleaf_studio_editor_import_go_to', {
              values: { time: editorImportClock(note.atSeconds) },
            })}
          >
            {editorImportClock(note.atSeconds)}
          </button>
          <span>
            <strong>{note.clip}</strong>
            <small>{$t(`${editorImportNoteKey(note.code)}_reason` as Translations)}</small>
          </span>
        </li>
      {/each}
    </ul>
  {/if}
{/if}

<style>
  .banner {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: var(--fl-space-2);
    padding: var(--fl-space-2) var(--fl-space-4);
    border-bottom: 1px solid var(--fl-border);
    background: var(--fl-raised);
  }
  .text {
    display: flex;
    flex: 1;
    flex-wrap: wrap;
    gap: var(--fl-space-2);
    min-width: 0;
  }
  .muted,
  small {
    color: var(--fl-muted);
  }
  .notes {
    display: grid;
    gap: var(--fl-space-1);
    max-height: 9rem;
    margin: 0;
    padding: var(--fl-space-2) var(--fl-space-4);
    overflow-y: auto;
    border-bottom: 1px solid var(--fl-border);
    list-style: none;
  }
  .notes li {
    display: flex;
    align-items: baseline;
    gap: var(--fl-space-3);
  }
  .notes li > span {
    display: grid;
  }
  .notes button {
    padding: 0 var(--fl-space-1);
    border: 0;
    background: none;
    color: var(--fl-accent);
    font: inherit;
    font-variant-numeric: tabular-nums;
    cursor: pointer;
  }
  .notes button:focus-visible {
    outline: var(--fl-focus-ring);
    outline-offset: var(--fl-focus-offset);
  }
</style>
