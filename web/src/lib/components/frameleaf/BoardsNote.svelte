<script lang="ts">
  /**
   * A file's note in the Boards details panel (approved prototype `Inspector` note): a textarea
   * saved when it loses focus, stored as the asset's description through the asset update API.
   * A failed save keeps the typed text and shows an error with Retry. Anyone but the owner sees
   * the note as text, or nothing when there is none.
   */
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import { updateAsset } from '@frameleaf/sdk';
  import { untrack } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    assetId,
    value,
    canEdit = false,
    labelledBy,
  }: {
    assetId: string;
    /** The stored note. */
    value: string;
    canEdit?: boolean;
    /** Id of the section heading that names the field. */
    labelledBy: string;
  } = $props();

  let text = $state('');
  let saved = $state('');
  let busy = $state(false);
  let failed = $state(false);

  $effect.pre(() => {
    void assetId;
    const stored = untrack(() => value);
    text = stored;
    saved = stored;
    busy = false;
    failed = false;
  });

  const save = async () => {
    const id = assetId;
    const next = text;
    if (!canEdit || busy || next === saved) {
      return;
    }
    busy = true;
    failed = false;
    try {
      await updateAsset({ id, updateAssetDto: { description: next } });
      if (assetId === id) {
        saved = next;
      }
    } catch {
      if (assetId === id) {
        failed = true;
      }
    } finally {
      if (assetId === id) {
        busy = false;
      }
    }
  };
</script>

{#if canEdit}
  <textarea
    bind:value={text}
    rows="3"
    maxlength="20000"
    aria-labelledby={labelledBy}
    placeholder={$t('frameleaf_boards_note_placeholder')}
    aria-busy={busy}
    onblur={() => void save()}></textarea>
  {#if failed}
    <InlineError compact message={$t('frameleaf_boards_note_failed')} retrying={busy} onRetry={save} />
  {/if}
{:else if value}
  <p>{value}</p>
{/if}

<style>
  textarea {
    width: 100%;
    min-height: 5rem;
    padding: var(--fl-space-2) var(--fl-space-3);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    color: var(--fl-text);
    background: var(--fl-raised);
    font: inherit;
    font-size: var(--fl-font-small);
    resize: vertical;
  }
  textarea::placeholder {
    color: var(--fl-muted);
  }
  textarea:focus-visible {
    outline: 2px solid var(--fl-accent);
    outline-offset: 1px;
  }
  p {
    margin: 0;
    white-space: pre-wrap;
    overflow-wrap: anywhere;
    font-size: var(--fl-font-small);
  }
</style>
