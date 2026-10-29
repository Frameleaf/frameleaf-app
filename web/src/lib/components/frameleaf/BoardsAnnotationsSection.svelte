<script lang="ts">
  /**
   * The Annotations section of the Boards details panel (FL-652, approved prototype
   * `AnnotationsSection`): a count, Annotate, the "Show on the picture" switch and the numbered
   * list. Choosing an annotation highlights it on the preview above. Here the list is the way in for
   * screen readers; the drawing on the preview is hidden from them.
   */
  import BoardsAnnotationList from '$lib/components/frameleaf/BoardsAnnotationList.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Toggle from '$lib/components/frameleaf/Toggle.svelte';
  import type { BoardsAnnotationsState } from '$lib/frameleaf/boards-annotations-store.svelte';
  import { Icon } from '@frameleaf/ui';
  import { mdiDrawPen } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    annotations: BoardsAnnotationsState;
    show: boolean;
    onShowChange: (show: boolean) => void;
    onAnnotate: () => void;
  };

  let { annotations, show, onShowChange, onAnnotate }: Props = $props();
  const headingId = $props.id();
  const count = $derived(annotations.items.length);
</script>

{#if annotations.status === 'failed'}
  <section class="annotations" aria-labelledby={headingId}>
    <h3 id={headingId}>{$t('frameleaf_boards_annotations')}</h3>
    <InlineError compact message={$t('frameleaf_boards_annotations_unavailable')} onRetry={() => annotations.load()} />
  </section>
{:else if annotations.status === 'ready' && (annotations.canEdit || count > 0)}
  <section class="annotations" aria-labelledby={headingId} data-testid="boards-annotations">
    <div class="head">
      <h3 id={headingId}>
        {count > 0
          ? $t('frameleaf_boards_annotations_count', { values: { count } })
          : $t('frameleaf_boards_annotations')}
      </h3>
      {#if annotations.canEdit}
        <button type="button" class="link" onclick={onAnnotate}>
          <Icon icon={mdiDrawPen} size="16" aria-hidden />
          {$t('frameleaf_boards_annotate')}
        </button>
      {/if}
    </div>
    {#if count > 0}
      <div class="switch">
        <strong id="{headingId}-show">{$t('frameleaf_boards_annotations_show_on_picture')}</strong>
        <Toggle
          label={$t('frameleaf_boards_annotations_show_on_picture')}
          checked={show}
          onLabel={$t('frameleaf_boards_on')}
          offLabel={$t('frameleaf_boards_off')}
          onChange={onShowChange}
        />
      </div>
      <BoardsAnnotationList
        items={annotations.items}
        selected={annotations.selected}
        onSelect={(id) => (annotations.selected = id)}
      />
      <p class="muted">{$t('frameleaf_boards_annotations_kept')}</p>
    {:else}
      <p class="muted">{$t('frameleaf_boards_annotations_none')}</p>
    {/if}
  </section>
{/if}

<style>
  .annotations {
    display: grid;
    gap: 10px;
  }
  .head {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 8px;
  }
  h3 {
    margin: 0;
    color: var(--fl-muted);
    font-size: 12px;
  }
  .link {
    display: inline-flex;
    align-items: center;
    gap: 6px;
    min-height: 32px;
    color: var(--fl-accent);
    font-size: 13px;
  }
  .switch {
    display: flex;
    align-items: center;
    justify-content: space-between;
    gap: 12px;
    font-size: 13px;
  }
  .switch strong {
    font-weight: 600;
  }
  .muted {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  button:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 2px;
  }
</style>
