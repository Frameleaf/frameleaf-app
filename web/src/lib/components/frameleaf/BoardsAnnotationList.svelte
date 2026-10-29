<script lang="ts">
  /**
   * The annotations as a list (FL-652, approved prototype `AnnotationList`): the same order and
   * numbers as on the picture. In the viewer's annotate mode the chosen one opens its note (and,
   * for text, the words on the picture) and each row has Delete.
   */
  import { ANNOTATION_ICON, annotationLabelValues, NOTE_MAX, TEXT_MAX } from '$lib/frameleaf/boards-annotations';
  import { AssetAnnotationKind, type AssetAnnotationItem } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiTrashCanOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    items: AssetAnnotationItem[];
    selected: string | null;
    onSelect: (id: string | null) => void;
    editable?: boolean;
    /** `typing` merges the change into the last undo step, as the prototype does for notes. */
    onEdit?: (id: string, patch: Partial<AssetAnnotationItem>, typing: boolean) => void;
    onDelete?: (id: string) => void;
  };

  let { items, selected, onSelect, editable = false, onEdit, onDelete }: Props = $props();
  const listId = $props.id();
</script>

{#if items.length > 0}
  <ol class="list" aria-label={$t('frameleaf_boards_annotations')}>
    {#each items as item, index (item.id)}
      <li class:on={selected === item.id}>
        <div class="row">
          <button
            type="button"
            class="pick"
            aria-pressed={selected === item.id}
            aria-label={$t('frameleaf_boards_annotation_label', {
              values: annotationLabelValues(item, index, items.length),
            })}
            onclick={() => onSelect(selected === item.id && !editable ? null : item.id)}
          >
            <span class="num" aria-hidden="true">{index + 1}</span>
            <Icon icon={ANNOTATION_ICON[item.kind]} size="15" aria-hidden />
            <span class="text">
              {#if item.kind === AssetAnnotationKind.Text && item.text}<strong>“{item.text}” </strong>{/if}
              {#if item.note}{item.note}{:else}<em>{$t('frameleaf_boards_annotation_no_note')}</em>{/if}
              {#if item.origin === 'eagle'}<small>{$t('frameleaf_boards_annotation_from_eagle')}</small>{/if}
            </span>
          </button>
          {#if editable}
            <button
              type="button"
              class="fl-control delete"
              aria-label={$t('frameleaf_boards_annotation_delete_number', { values: { number: index + 1 } })}
              onclick={() => onDelete?.(item.id)}
            >
              <Icon icon={mdiTrashCanOutline} size="18" aria-hidden />
            </button>
          {/if}
        </div>
        {#if editable && selected === item.id}
          <div class="edit">
            {#if item.kind === AssetAnnotationKind.Text}
              <label>
                <span>{$t('frameleaf_boards_annotation_text_on_picture')}</span>
                <input
                  class="fl-control"
                  maxlength={TEXT_MAX}
                  value={item.text ?? ''}
                  oninput={(event) => onEdit?.(item.id, { text: event.currentTarget.value }, true)}
                />
              </label>
            {/if}
            <label>
              <span>{$t('frameleaf_boards_note')}</span>
              <textarea
                id="{listId}-{item.id}"
                class="fl-control"
                data-note={item.id}
                rows="2"
                maxlength={NOTE_MAX}
                placeholder={$t('frameleaf_boards_annotation_note_placeholder', { values: { kind: item.kind } })}
                value={item.note ?? ''}
                oninput={(event) => onEdit?.(item.id, { note: event.currentTarget.value }, true)}></textarea>
            </label>
          </div>
        {/if}
      </li>
    {/each}
  </ol>
{/if}

<style>
  .list {
    display: flex;
    flex-direction: column;
    gap: 8px;
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .row {
    display: flex;
    align-items: flex-start;
    gap: 4px;
  }
  .pick {
    flex: 1;
    display: flex;
    align-items: flex-start;
    gap: 8px;
    min-height: 36px;
    padding: 8px;
    border: 1px solid transparent;
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    text-align: left;
    font-size: 13px;
    line-height: 1.4;
    cursor: pointer;
  }
  li.on .pick {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
  }
  .pick > :global(svg) {
    flex: none;
    margin-top: 1px;
    color: var(--fl-muted);
  }
  .num {
    flex: none;
    display: grid;
    place-items: center;
    width: 20px;
    height: 20px;
    border-radius: 50%;
    background: var(--fl-warning);
    color: #111;
    font-size: var(--fl-font-micro);
    font-weight: 700;
  }
  li.on .num {
    background: var(--fl-accent);
  }
  .text {
    display: flex;
    flex-direction: column;
    gap: 2px;
    min-width: 0;
    overflow-wrap: anywhere;
  }
  .text em {
    color: var(--fl-muted);
  }
  .text small {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
  }
  .delete {
    display: grid;
    place-items: center;
    min-width: 36px;
    min-height: 36px;
    padding: 0 8px;
    color: var(--fl-muted);
  }
  .edit {
    display: flex;
    flex-direction: column;
    gap: 8px;
    padding: 8px 0 4px 28px;
  }
  .edit label {
    display: flex;
    flex-direction: column;
    gap: 4px;
    font-size: var(--fl-font-small);
    color: var(--fl-muted);
  }
  .edit textarea {
    resize: vertical;
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
</style>
