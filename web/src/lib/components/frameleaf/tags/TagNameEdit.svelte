<script lang="ts">
  import { Icon } from '@frameleaf/ui';
  import { mdiPencilOutline } from '@mdi/js';
  import { tick } from 'svelte';

  /**
   * The tag's name as the page heading that turns into a field, like an album's title
   * (`AlbumInlineEdit`, which it is modelled on): Enter or leaving the field saves, Escape abandons
   * the edit. A tag name is at most 60 characters, and a name the page refuses keeps the field open
   * with the reason beside it (`error`), so nothing typed is lost.
   *
   * When the edit ends from the keyboard, focus goes back to the heading's button rather than
   * being dropped with the field.
   */
  let {
    value,
    label,
    error = '',
    onSave,
    onCancel,
  }: {
    value: string;
    /** What pressing the name does ("Edit tag name"), and the field's accessible name; already translated. */
    label: string;
    /** Why the last name was refused; shown by the page, announced with the field. */
    error?: string;
    /** Returns false when the name was refused or could not be saved. */
    onSave: (value: string) => Promise<boolean> | boolean;
    onCancel?: () => void;
  } = $props();

  let editing = $state(false);
  let draft = $state('');
  let saving = $state(false);
  let field = $state<HTMLInputElement>();
  let trigger = $state<HTMLButtonElement>();
  /** Set by Escape so the blur that follows does not save the abandoned draft. */
  let cancelled = false;
  const errorId = $props.id();

  const start = async () => {
    cancelled = false;
    draft = value;
    editing = true;
    await tick();
    field?.focus();
    field?.select();
  };

  const finish = async (refocus: boolean) => {
    editing = false;
    if (refocus) {
      await tick();
      trigger?.focus();
    }
  };

  const commit = async (fromKeyboard: boolean) => {
    if (cancelled || saving || !editing) {
      return;
    }
    const next = draft.trim();
    // A name cannot be emptied by accident, and an unchanged one has nothing to save.
    if (!next || next === value) {
      onCancel?.();
      await finish(fromKeyboard);
      return;
    }
    saving = true;
    try {
      if (await onSave(next)) {
        await finish(fromKeyboard);
      } else {
        // Refused: the field stays, with what was typed, ready to be corrected.
        await tick();
        field?.focus();
      }
    } finally {
      saving = false;
    }
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter') {
      event.preventDefault();
      void commit(true);
    } else if (event.key === 'Escape') {
      event.preventDefault();
      // Escape here must not also reach the page: it only abandons the edit.
      event.stopPropagation();
      cancelled = true;
      onCancel?.();
      void finish(true);
    }
  };
</script>

{#if editing}
  <input
    bind:this={field}
    class="field"
    type="text"
    maxlength="60"
    autocomplete="off"
    aria-label={label}
    aria-invalid={error ? true : undefined}
    aria-describedby={error ? errorId : undefined}
    readonly={saving}
    bind:value={draft}
    onblur={() => void commit(false)}
    onkeydown={onKeydown}
  />
{:else}
  <h1 class="title">
    <!-- Named by the tag itself, so the page's heading reads as the tag; the title says what a press does. -->
    <button bind:this={trigger} type="button" class="trigger" title={label} onclick={start}>
      <span class="label">{value}</span>
      <span class="pencil" aria-hidden="true"><Icon icon={mdiPencilOutline} size="16" /></span>
    </button>
  </h1>
{/if}
{#if error}
  <p id={errorId} class="error" role="alert">{error}</p>
{/if}

<style>
  /* AlbumInlineEdit's title at the album header's size, so a tag's name reads like an album's. */
  .title {
    margin: 0;
    min-inline-size: 0;
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--fl-text);
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: var(--fl-space-2);
    /* The box hangs out by its inset and border, so the name itself lines up with the line under it. */
    max-inline-size: calc(100% + var(--fl-space-2) + 1px);
    margin-inline-start: calc(var(--fl-space-2) * -1 - 1px);
    padding: var(--fl-space-half) var(--fl-space-2);
    text-align: start;
    font: inherit;
    letter-spacing: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--fl-radius);
  }
  .trigger:hover {
    background: var(--fl-raised);
    border-color: var(--fl-border);
  }
  /* One line, cut with an ellipsis only when the row is too narrow; a phone lets it wrap instead. */
  @media (min-width: 701px) {
    .label {
      min-inline-size: 0;
      overflow: hidden;
      text-overflow: ellipsis;
      white-space: nowrap;
    }
  }
  .pencil {
    display: inline-flex;
    flex-shrink: 0;
    color: var(--fl-muted);
    opacity: 0;
  }
  .trigger:hover .pencil,
  .trigger:focus-visible .pencil {
    opacity: 1;
  }
  .field {
    inline-size: 100%;
    max-inline-size: 36rem;
    /* The same inset and overhang as the heading's button, so the name does not move when it becomes a field. */
    margin-inline-start: calc(var(--fl-space-2) * -1 - 1px);
    padding: var(--fl-space-half) var(--fl-space-2);
    font: inherit;
    font-size: 30px;
    font-weight: 700;
    letter-spacing: -0.02em;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  /* On a phone there is no tile beside the name and no hover: nothing hangs into the page gutter. */
  @media (max-width: 700px) {
    .trigger {
      max-inline-size: 100%;
      margin-inline-start: 0;
      padding-inline: 0;
      border-inline-width: 0;
    }
    .field {
      margin-inline-start: 0;
    }
  }
  .error {
    flex-basis: 100%;
    margin: 0;
    font-size: var(--fl-font-small);
    color: var(--fl-danger);
  }
</style>
