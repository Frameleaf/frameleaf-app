<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { Icon } from '@immich/ui';
  import { mdiImageMultipleOutline } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * The deliberate confirmation the album header asks for before deleting an album,
   * collection or shared space, or before leaving one (FL-53). Ported from `DeleteDialog`
   * and `LeaveDialog` in `design/frameleaf/template/src/CollectionHeader.jsx`.
   *
   * `keepNote` carries the promise the prototype makes explicitly: deleting an album never
   * deletes its photos, and deleting a collection never deletes its albums.
   */
  interface Props {
    title: string;
    body: string;
    /** Reassurance about what is kept, shown with the library icon. Omitted for Leave. */
    keepNote?: string;
    confirmLabel: string;
    open?: boolean;
    onConfirm: () => Promise<void> | void;
  }

  let { title, body, keepNote, confirmLabel, open = $bindable(false), onConfirm }: Props = $props();

  let busy = $state(false);

  const confirm = async () => {
    busy = true;
    try {
      await onConfirm();
      open = false;
    } finally {
      busy = false;
    }
  };
</script>

<Dialog {title} closeLabel={$t('close')} bind:open>
  <div class="body">
    <p>{body}</p>
    {#if keepNote}
      <p class="keep">
        <span aria-hidden="true"><Icon icon={mdiImageMultipleOutline} size="18" /></span>
        {keepNote}
      </p>
    {/if}
    <div class="buttons">
      <button type="button" disabled={busy} onclick={() => (open = false)}>{$t('cancel')}</button>
      <button type="button" class="danger" disabled={busy} onclick={() => void confirm()}>{confirmLabel}</button>
    </div>
  </div>
</Dialog>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: 0.75rem;
    margin-block-start: 1rem;
    width: min(28rem, 100%);
  }
  p {
    margin: 0;
    color: var(--fl-text);
    font-size: 0.875rem;
  }
  .keep {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    padding: 0.625rem;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius);
  }
  .buttons {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
  .buttons button {
    padding: 0 1rem;
    min-height: 44px;
    color: var(--fl-text);
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius);
  }
  .buttons .danger {
    color: var(--fl-danger-text);
    background: var(--fl-danger);
    border-color: var(--fl-danger);
  }
  .buttons button:disabled {
    opacity: 0.6;
  }
</style>
