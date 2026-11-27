<script lang="ts">
  /**
   * The one confirmation in the app (FL-1814; the prototype's `ConfirmDialog` in
   * `ComponentsSheet.jsx`). The title names the action ("Delete “Lake days”?"), the text says what
   * happens and whether it can be undone, and the button repeats the action ("Delete album", never
   * "OK" or "Yes"). A destructive action takes the danger button, and then Cancel takes the first
   * focus: Enter on open must not delete.
   *
   * Two ways to use it:
   * - from script, `confirmFrameleaf` in `$lib/frameleaf/confirm` opens it and resolves `true` only
   *   when the action button was pressed (`onClose`);
   * - in markup, `bind:open` with `onConfirm`: the dialog stays open and busy while `onConfirm`
   *   runs, closes when it resolves, and reports the failure and stays open if it throws.
   *
   * `$lib/frameleaf/kit-bridge` also routes the kit's `modalManager.showDialog` here.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { ICON_SIZE } from '$lib/frameleaf/tokens';
  import { handleError } from '$lib/utils/handle-error';
  import { Icon } from '@frameleaf/ui';
  import { mdiImageMultipleOutline } from '@mdi/js';
  import type { Snippet } from 'svelte';
  import { t } from 'svelte-i18n';

  let {
    title,
    prompt,
    keepNote,
    confirmText,
    cancelText,
    danger = false,
    disabled = false,
    open = $bindable(true),
    onConfirm,
    onClose,
  }: {
    title: string;
    prompt?: string | Snippet;
    /** Reassurance about what is kept ("Its 37 photos stay in your library"), with the library icon. */
    keepNote?: string;
    confirmText: string;
    cancelText?: string;
    danger?: boolean;
    /** Keeps the action unavailable, for a confirmation that depends on something still loading. */
    disabled?: boolean;
    open?: boolean;
    onConfirm?: () => Promise<unknown> | unknown;
    onClose?: (confirmed?: boolean) => void;
  } = $props();

  let busy = $state(false);
  let confirmed = false;

  const confirm = async () => {
    if (onConfirm) {
      busy = true;
      try {
        await onConfirm();
      } catch (error) {
        // Stay open: the action did not happen, and the person can try again or cancel.
        handleError(error, $t('error'));
        return;
      } finally {
        busy = false;
      }
    }
    confirmed = true;
    open = false;
  };

  // The answer is reported once the sheet has finished leaving, so the exit is not cut short.
  const onClosed = () => {
    const answer = confirmed;
    confirmed = false;
    onClose?.(answer);
  };
</script>

<Dialog bind:open {title} closeLabel={$t('close')} {onClosed}>
  <div class="body">
    {#if typeof prompt === 'string'}
      <p>{prompt}</p>
    {:else if prompt}
      {@render prompt()}
    {/if}
    {#if keepNote}
      <p class="keep">
        <span aria-hidden="true"><Icon icon={mdiImageMultipleOutline} size={ICON_SIZE.lg} /></span>
        {keepNote}
      </p>
    {/if}
  </div>
  {#snippet actions()}
    <button
      type="button"
      class="button"
      data-initial-focus={danger ? '' : undefined}
      disabled={busy}
      onclick={() => (open = false)}>{cancelText ?? $t('cancel')}</button
    >
    <button
      type="button"
      class="button"
      class:primary={!danger}
      class:fl-danger={danger}
      data-initial-focus={danger ? undefined : ''}
      disabled={disabled || busy}
      onclick={() => void confirm()}>{confirmText}</button
    >
  {/snippet}
</Dialog>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    max-width: 28rem;
  }
  p {
    margin: 0;
    color: var(--fl-text);
    line-height: 1.5;
  }
  .keep {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-2);
    padding: var(--fl-space-3);
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius);
  }
</style>
