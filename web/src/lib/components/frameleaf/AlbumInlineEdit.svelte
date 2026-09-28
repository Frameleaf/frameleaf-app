<script lang="ts">
  import { Icon } from '@immich/ui';
  import { mdiPencilOutline } from '@mdi/js';

  /**
   * Inline title and description editing on the album detail header (FL-53), ported from
   * `InlineEdit` in `design/frameleaf/template/src/CollectionHeader.jsx`.
   *
   * The control is a button until it is clicked; then it becomes a field that commits on
   * blur and on Enter, and abandons the edit on Escape. A single-line value is never
   * allowed to become empty — the previous value comes back instead — while a description
   * may be cleared. Saving is the caller's business: `onSave` returns false when the write
   * failed, and the field reopens with the text the person typed so nothing is lost.
   */
  interface Props {
    value: string;
    /** Accessible name of the field, already translated. */
    label: string;
    placeholder?: string;
    editable?: boolean;
    multiline?: boolean;
    /** Heading level for the read-only rendering; a description renders as a paragraph. */
    as?: 'h1' | 'p';
    onSave: (value: string) => Promise<boolean> | boolean;
  }

  let { value, label, placeholder = '', editable = true, multiline = false, as = 'h1', onSave }: Props = $props();

  let editing = $state(false);
  let draft = $state(value);
  let saving = $state(false);
  let field = $state<HTMLInputElement | HTMLTextAreaElement>();
  /** Set by Escape so the blur that follows does not commit the abandoned draft. */
  let cancelled = false;

  $effect(() => {
    if (!editing) {
      draft = value;
    }
  });

  $effect(() => {
    if (!editing) {
      return;
    }

    field?.focus();
    field?.select();
  });

  const start = () => {
    if (!editable) {
      return;
    }
    cancelled = false;
    draft = value;
    editing = true;
  };

  const commit = async () => {
    if (cancelled || saving) {
      return;
    }
    const next = draft.trim();
    if (!multiline && !next) {
      // A title cannot be emptied by accident; the stored name comes back.
      draft = value;
      editing = false;
      return;
    }
    if (next === value) {
      editing = false;
      return;
    }
    saving = true;
    try {
      const saved = await onSave(next);
      // A refused write keeps the field open with the typed text so it can be retried.
      editing = !saved;
    } finally {
      saving = false;
    }
  };

  const onKeydown = (event: KeyboardEvent) => {
    if (event.key === 'Enter' && !(multiline && event.shiftKey)) {
      event.preventDefault();
      void commit();
      return;
    }
    if (event.key === 'Escape') {
      event.preventDefault();
      // Escape here must not also close a surrounding dialog or clear the selection.
      event.stopPropagation();
      cancelled = true;
      draft = value;
      editing = false;
    }
  };
</script>

{#if !editable}
  {#if as === 'h1'}
    <h1 class="text">{value || placeholder}</h1>
  {:else if value}
    <p class="text">{value}</p>
  {/if}
{:else if editing}
  {#if multiline}
    <textarea
      bind:this={field}
      class="field"
      rows="2"
      maxlength="2000"
      aria-label={label}
      disabled={saving}
      bind:value={draft}
      onblur={() => void commit()}
      onkeydown={onKeydown}></textarea>
  {:else}
    <input
      bind:this={field}
      class="field title"
      type="text"
      maxlength="120"
      aria-label={label}
      disabled={saving}
      bind:value={draft}
      onblur={() => void commit()}
      onkeydown={onKeydown}
    />
  {/if}
{:else if as === 'h1'}
  <h1 class="text">
    <button type="button" class="trigger" aria-label={label} onclick={start}>
      <span class:muted={!value}>{value || placeholder}</span>
      <span class="pencil" aria-hidden="true"><Icon icon={mdiPencilOutline} size="16" /></span>
    </button>
  </h1>
{:else}
  <p class="text">
    <button type="button" class="trigger" aria-label={label} onclick={start}>
      <span class:muted={!value}>{value || placeholder}</span>
      <span class="pencil" aria-hidden="true"><Icon icon={mdiPencilOutline} size="14" /></span>
    </button>
  </p>
{/if}

<style>
  .text {
    margin: 0;
    color: var(--fl-text);
  }
  h1.text {
    font-size: 1.5rem;
    font-weight: 650;
  }
  p.text {
    font-size: 0.875rem;
    color: var(--fl-muted);
  }
  .trigger {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
    max-inline-size: 100%;
    padding: 0.125rem 0.25rem;
    margin-inline-start: -0.25rem;
    text-align: start;
    font: inherit;
    color: inherit;
    background: transparent;
    border: 1px solid transparent;
    border-radius: var(--fl-radius);
  }
  .trigger:hover {
    background: var(--fl-raised);
    border-color: var(--fl-border);
  }
  .pencil {
    display: inline-flex;
    opacity: 0;
    color: var(--fl-muted);
    flex-shrink: 0;
  }
  .trigger:hover .pencil,
  .trigger:focus-visible .pencil {
    opacity: 1;
  }
  .muted {
    color: var(--fl-muted);
  }
  .field {
    inline-size: 100%;
    max-inline-size: 36rem;
    padding: 0.25rem 0.375rem;
    font: inherit;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  .field.title {
    font-size: 1.5rem;
    font-weight: 650;
  }
</style>
