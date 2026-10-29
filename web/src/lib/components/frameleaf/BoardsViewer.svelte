<script lang="ts">
  /**
   * The Boards viewer (FL-652, approved prototype `BoardsViewer`): the picture large with its
   * annotations and an annotate mode. Choose, Rectangle, Arrow and Text, then Undo and Delete, with
   * Done to finish. Drag to draw a rectangle or an arrow, click to place text, drag an annotation to
   * move it. Everything also works from the keyboard (the "Keyboard" list in the side panel). The
   * Library photo viewer is unchanged: annotations live in Boards only.
   */
  import { portal } from '$lib/elements/Portal.svelte';
  import BoardsAnnotatedImage from '$lib/components/frameleaf/BoardsAnnotatedImage.svelte';
  import BoardsAnnotationList from '$lib/components/frameleaf/BoardsAnnotationList.svelte';
  import type { BoardsAnnotationsState } from '$lib/frameleaf/boards-annotations-store.svelte';
  import {
    ANNOTATION_TOOLS,
    annotationLabelValues,
    commit,
    history,
    keyboardAnnotation,
    keyChange,
    newAnnotationId,
    nudge,
    undo,
    type AnnotationTool,
  } from '$lib/frameleaf/boards-annotations';
  import type { AssetAnnotationItem } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiArrowLeft, mdiDrawPen, mdiEyeOffOutline, mdiEyeOutline, mdiTrashCanOutline, mdiUndo } from '@mdi/js';
  import { onMount, tick, untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    name: string;
    src: string;
    annotations: BoardsAnnotationsState;
    startMode: 'view' | 'annotate';
    show: boolean;
    onShowChange: (show: boolean) => void;
    onClose: () => void;
  };

  let { name, src, annotations, startMode, show, onShowChange, onClose }: Props = $props();

  let mode = $state(untrack(() => (startMode === 'annotate' && annotations.canEdit ? 'annotate' : 'view')));
  let tool = $state<AnnotationTool>('select');
  let undoState = $state(history(untrack(() => annotations.items)));
  let moving = false;
  let closeButton = $state<HTMLButtonElement>();

  const annotating = $derived(mode === 'annotate');
  const list = $derived(annotations.items);
  const selected = $derived(annotations.selected);
  const index = $derived(list.findIndex(({ id }) => id === selected));
  const defaultText = $derived($t('frameleaf_boards_annotate_text'));

  const labelFor = (item: AssetAnnotationItem, at: number) =>
    $t('frameleaf_boards_annotation_label', { values: annotationLabelValues(item, at, list.length) });

  const change = (next: AssetAnnotationItem[], merge = false) => {
    undoState = merge ? { ...undoState, present: next } : commit(undoState, next);
    annotations.change(next);
  };
  const select = (id: string | null) => (annotations.selected = id);
  const focusNote = async (id: string) => {
    await tick();
    document.querySelector<HTMLElement>(`[data-note="${CSS.escape(id)}"]`)?.focus();
  };
  const add = (item: AssetAnnotationItem) => {
    const id = newAnnotationId(list);
    change([...list, { ...item, id }]);
    select(id);
    tool = 'select';
    void focusNote(id);
  };
  const remove = (id: string | null) => {
    if (!id) {
      return;
    }
    const before = list;
    const at = before.findIndex((item) => item.id === id);
    change(before.filter((item) => item.id !== id));
    select(before[at + 1]?.id ?? before[at - 1]?.id ?? null);
  };
  const edit = (id: string, patch: Partial<AssetAnnotationItem>, typing = false) =>
    change(
      list.map((item) => (item.id === id ? { ...item, ...patch } : item)),
      typing,
    );
  const stepBack = () => {
    undoState = undo(undoState);
    annotations.change(undoState.present);
  };
  const toggleShow = () => onShowChange(!show);
  const finish = () => {
    mode = 'view';
    tool = 'select';
  };

  /** Keys an annotation on the picture handles itself while it has focus. */
  const ANNOTATION_KEYS = new Set(['ArrowLeft', 'ArrowRight', 'ArrowUp', 'ArrowDown', 'Delete', 'Backspace', 'Enter']);

  /**
   * The viewer is modal: it takes every key first (window, capture phase) so the workspace behind
   * it never acts on one, for example Delete moving the selection to the trash. Default actions
   * such as typing, Tab and pressing a focused button still happen.
   */
  const onWindowKey = (event: KeyboardEvent) => {
    const target = event.target as HTMLElement | null;
    if (target?.closest?.('input, textarea')) {
      event.stopPropagation();
      if (event.key === 'Escape') {
        event.preventDefault();
        target.blur();
      }
      return;
    }
    if (target?.closest?.('[data-annotation]') && ANNOTATION_KEYS.has(event.key)) {
      return;
    }
    event.stopPropagation();
    handleKey(event);
  };

  const handleKey = (event: KeyboardEvent) => {
    const command = event.metaKey || event.ctrlKey;
    if (command && event.key.toLowerCase() === 'z' && annotating) {
      event.preventDefault();
      stepBack();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      if (tool !== 'select') {
        tool = 'select';
      } else if (selected) {
        select(null);
      } else if (annotating) {
        finish();
      } else {
        onClose();
      }
      return;
    }
    if (command || event.altKey) {
      return;
    }
    if (event.key.toLowerCase() === 'h') {
      toggleShow();
      return;
    }
    if (!annotating) {
      return;
    }
    const pick = ANNOTATION_TOOLS.find(({ key }) => key.toLowerCase() === event.key.toLowerCase());
    if (pick) {
      tool = pick.id;
      return;
    }
    if (event.key === 'Enter' && tool !== 'select') {
      event.preventDefault();
      add(keyboardAnnotation(tool, 'new', defaultText));
    }
  };

  const onAnnotationKey = (event: KeyboardEvent, id: string) => {
    const item = list.find((candidate) => candidate.id === id);
    if (!annotating || !item) {
      return;
    }
    const moved = keyChange(item, event);
    if (moved) {
      event.preventDefault();
      event.stopPropagation();
      edit(id, moved);
    } else if (event.key === 'Delete' || event.key === 'Backspace') {
      event.preventDefault();
      event.stopPropagation();
      remove(id);
      void tick().then(() =>
        document.querySelector<HTMLElement>(`[data-annotation="${CSS.escape(selected ?? '')}"]`)?.focus(),
      );
    } else if (event.key === 'Enter') {
      event.preventDefault();
      event.stopPropagation();
      void focusNote(id);
    }
  };

  const onMove = (id: string, dx: number, dy: number, end: boolean) => {
    if (end) {
      moving = false;
      return;
    }
    if (!moving) {
      moving = true;
      undoState = commit(undoState, undoState.present);
    }
    change(
      list.map((item) => (item.id === id ? nudge(item, dx, dy) : item)),
      true,
    );
  };

  const hint = $derived.by(() => {
    if (tool === 'select') {
      return index >= 0
        ? $t('frameleaf_boards_annotate_hint_chosen', { values: { number: index + 1 } })
        : $t('frameleaf_boards_annotate_hint_choose');
    }
    return $t('frameleaf_boards_annotate_hint_draw', { values: { tool } });
  });

  const keys = $derived([
    [$t('frameleaf_boards_annotate_key_tab'), $t('frameleaf_boards_annotate_key_tab_does')],
    [$t('frameleaf_boards_annotate_key_arrows'), $t('frameleaf_boards_annotate_key_arrows_does')],
    [$t('frameleaf_boards_annotate_key_alt_arrows'), $t('frameleaf_boards_annotate_key_alt_arrows_does')],
    [$t('frameleaf_boards_annotate_key_enter'), $t('frameleaf_boards_annotate_key_enter_does')],
    [$t('frameleaf_boards_annotate_key_delete'), $t('frameleaf_boards_annotate_key_delete_does')],
    ['R, A, T', $t('frameleaf_boards_annotate_key_tools_does')],
  ]);

  onMount(() => {
    const opener = document.activeElement as HTMLElement | null;
    addEventListener('keydown', onWindowKey, { capture: true });
    closeButton?.focus();
    return () => {
      removeEventListener('keydown', onWindowKey, { capture: true });
      void annotations.flush();
      opener?.focus?.();
    };
  });
</script>

<div
  class="viewer"
  class:annotating
  role="dialog"
  aria-modal="true"
  aria-label={annotating ? $t('frameleaf_boards_viewer_annotating', { values: { name } }) : name}
  use:portal
  data-testid="boards-viewer"
>
  <header class="bar">
    <button
      bind:this={closeButton}
      type="button"
      class="fl-control icon"
      aria-label={$t('frameleaf_boards_viewer_close')}
      onclick={onClose}
    >
      <Icon icon={mdiArrowLeft} size="20" aria-hidden />
    </button>
    <strong class="name">{name}</strong>
    <span class="spacer"></span>
    {#if annotating}
      <div class="tools" role="toolbar" aria-label={$t('frameleaf_boards_annotate')}>
        {#each ANNOTATION_TOOLS as option (option.id)}
          <button
            type="button"
            class="fl-control icon"
            aria-label="{$t(option.label)} ({option.key})"
            title="{$t(option.label)} · {option.key}"
            aria-pressed={tool === option.id}
            onclick={() => (tool = option.id)}
          >
            <Icon icon={option.icon} size="18" aria-hidden />
          </button>
        {/each}
        <span class="gap" aria-hidden="true"></span>
        <button
          type="button"
          class="fl-control icon"
          aria-label={$t('undo')}
          title="{$t('undo')} · ⌘Z"
          disabled={undoState.past.length === 0}
          onclick={stepBack}
        >
          <Icon icon={mdiUndo} size="18" aria-hidden />
        </button>
        <button
          type="button"
          class="fl-control icon"
          aria-label={$t('frameleaf_boards_annotation_delete')}
          title={$t('frameleaf_boards_annotation_delete_title')}
          disabled={!selected}
          onclick={() => remove(selected)}
        >
          <Icon icon={mdiTrashCanOutline} size="18" aria-hidden />
        </button>
      </div>
    {:else if annotations.canEdit}
      <button type="button" class="fl-control" onclick={() => (mode = 'annotate')}>
        <Icon icon={mdiDrawPen} size="18" aria-hidden />
        {$t('frameleaf_boards_annotate')}
      </button>
    {/if}
    <button
      type="button"
      class="fl-control"
      aria-pressed={!show}
      title={$t('frameleaf_boards_annotations_toggle_title')}
      onclick={toggleShow}
    >
      <Icon icon={show ? mdiEyeOffOutline : mdiEyeOutline} size="18" aria-hidden />
      {show ? $t('frameleaf_boards_annotations_hide') : $t('frameleaf_boards_annotations_show')}
    </button>
    {#if annotating}
      <button type="button" class="fl-control primary" onclick={finish}>{$t('done')}</button>
    {/if}
  </header>

  <div class="stage">
    <BoardsAnnotatedImage
      {src}
      {name}
      items={list}
      {show}
      {selected}
      interactive={annotating}
      {tool}
      {labelFor}
      onSelect={select}
      onDraw={add}
      onKey={onAnnotationKey}
      {onMove}
      maxHeight="calc(100dvh - var(--fl-topbar-height, 56px) - 120px)"
    />
    {#if !show}
      <p class="hidden-note" role="status">
        {$t('frameleaf_boards_annotations_hidden', { values: { count: list.length } })}
      </p>
    {/if}
  </div>

  <aside class="side" aria-label={$t('frameleaf_boards_annotations')}>
    <h2>{$t('frameleaf_boards_annotations')} <small>{list.length}</small></h2>
    {#if list.length > 0}
      <BoardsAnnotationList
        items={list}
        {selected}
        onSelect={(id) => {
          select(id);
          if (annotating && id) {
            document.querySelector<HTMLElement>(`[data-annotation="${CSS.escape(id)}"]`)?.focus();
          }
        }}
        editable={annotating}
        onEdit={edit}
        onDelete={remove}
      />
    {:else}
      <p class="muted">{$t('frameleaf_boards_annotate_none')}</p>
    {/if}
    {#if annotating}
      <p class="muted" aria-live="polite">{hint}</p>
    {/if}
    {#if annotations.saveFailed}
      <p class="error" role="alert">
        {$t('frameleaf_boards_annotations_save_failed')}
        <button type="button" class="fl-control" onclick={() => annotations.retry()}>{$t('retry')}</button>
      </p>
    {/if}
    <details class="keys">
      <summary>{$t('frameleaf_boards_annotate_keyboard')}</summary>
      <dl>
        {#each keys as [key, does] (key)}
          <dt>{key}</dt>
          <dd>{does}</dd>
        {/each}
      </dl>
    </details>
    <p class="muted">{$t('frameleaf_boards_annotations_kept')}</p>
  </aside>
</div>

<style>
  .viewer {
    position: fixed;
    inset: var(--fl-topbar-height, 56px) 0 0 0;
    z-index: 45;
    display: grid;
    grid-template-columns: minmax(0, 1fr) 340px;
    grid-template-rows: auto minmax(0, 1fr);
    background: var(--fl-viewer-canvas);
    color: var(--fl-text);
    font-size: 13px;
  }
  .bar {
    grid-column: 1 / -1;
    display: flex;
    align-items: center;
    gap: 12px;
    padding: 12px 24px 12px 12px;
    border-bottom: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
  .name {
    overflow: hidden;
    text-overflow: ellipsis;
    white-space: nowrap;
    font-size: 15px;
  }
  .spacer {
    flex: 1;
  }
  .bar > button,
  .tools button {
    display: inline-flex;
    align-items: center;
    gap: 8px;
    padding: 0 12px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-raised);
    color: var(--fl-text);
    white-space: nowrap;
  }
  .bar > button.icon {
    padding: 0 10px;
  }
  .bar > button.primary {
    border-color: var(--fl-accent);
    background: var(--fl-accent);
    color: var(--fl-accent-text);
    font-weight: 600;
  }
  .tools {
    display: flex;
    align-items: center;
    gap: 4px;
    padding: 4px;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    background: var(--fl-canvas);
  }
  .tools button {
    min-height: 32px;
    padding: 0 8px;
    border-color: transparent;
    background: transparent;
  }
  .tools button[aria-pressed='true'] {
    border-color: var(--fl-accent);
    background: var(--fl-accent-soft);
    color: var(--fl-accent);
  }
  .tools button:disabled {
    opacity: 0.45;
  }
  .gap {
    width: 1px;
    height: 20px;
    margin: 0 8px;
    background: var(--fl-border);
  }
  .stage {
    position: relative;
    display: grid;
    place-items: center;
    min-height: 0;
    padding: 24px;
    overflow: hidden;
  }
  .hidden-note {
    position: absolute;
    bottom: 24px;
    left: 50%;
    translate: -50% 0;
    margin: 0;
    padding: 8px 12px;
    border-radius: var(--fl-radius-control);
    background: var(--fl-panel);
    color: var(--fl-muted);
  }
  .side {
    display: flex;
    flex-direction: column;
    gap: 16px;
    min-height: 0;
    overflow: auto;
    padding: 24px;
    border-left: 1px solid var(--fl-border);
    background: var(--fl-panel);
  }
  h2 {
    display: flex;
    align-items: baseline;
    gap: 8px;
    margin: 0;
    font-size: 15px;
    font-weight: 600;
  }
  h2 small {
    color: var(--fl-muted);
    font-weight: 400;
    font-size: 13px;
  }
  .muted {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .error {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    gap: 8px;
    margin: 0;
    color: var(--fl-danger, var(--fl-warning));
  }
  .keys summary {
    cursor: pointer;
    color: var(--fl-accent);
  }
  .keys dl {
    display: grid;
    grid-template-columns: 120px 1fr;
    gap: 8px 12px;
    margin: 12px 0 0;
  }
  .keys dt {
    color: var(--fl-muted);
  }
  .keys dd {
    margin: 0;
  }
  button:focus-visible,
  summary:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
  @media (max-width: 760px) {
    .viewer {
      grid-template-columns: 1fr;
      grid-template-rows: auto minmax(0, 1fr) auto;
    }
    .bar {
      flex-wrap: wrap;
    }
    .side {
      max-height: 40vh;
      border-left: 0;
      border-top: 1px solid var(--fl-border);
    }
  }
</style>
