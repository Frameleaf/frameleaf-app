<script lang="ts">
  /**
   * "Permanently delete" confirmation, on the Frameleaf Dialog so it is the same sheet as every
   * other confirmation. Cancel takes first focus; the destructive action is the danger button.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { showDeleteModal } from '$lib/stores/preferences.store';
  import { t } from 'svelte-i18n';

  type Props = {
    size: number;
    /** When false the "do not show this message again" checkbox is hidden and the confirmation cannot be suppressed. */
    suppressible?: boolean;
    /** The single asset's file name; switches to the viewer's single-asset copy. */
    assetName?: string;
    onClose: (confirmed?: boolean) => void;
  };

  let { size, suppressible = true, assetName, onClose: onCloseParent }: Props = $props();

  let open = $state(true);
  let checked = $state(false);
  let confirmed = false;

  const onClosed = () => {
    if (confirmed && suppressible && checked) {
      $showDeleteModal = false;
    }

    onCloseParent(confirmed);
  };

  const confirm = () => {
    confirmed = true;
    open = false;
  };
</script>

<Dialog
  bind:open
  title={assetName
    ? $t('frameleaf_viewer_delete_permanently_title')
    : $t('permanently_delete_assets_count', { values: { count: size } })}
  closeLabel={$t('close')}
  {onClosed}
>
  {#if assetName}
    <p>{$t('frameleaf_viewer_delete_permanently_prompt', { values: { name: assetName } })}</p>
  {:else}
    <p>
      <FormatMessage key="permanently_delete_assets_prompt" values={{ count: size }}>
        {#snippet children({ message })}
          <b>{message}</b>
        {/snippet}
      </FormatMessage>
    </p>
    <p><b>{$t('cannot_undo_this_action')}</b></p>
  {/if}

  {#if suppressible}
    <label class="suppress">
      <input id="confirm-deletion-input" type="checkbox" bind:checked />
      {$t('do_not_show_again')}
    </label>
  {/if}

  {#snippet actions()}
    <button type="button" class="button" data-initial-focus onclick={() => (open = false)}>
      {assetName ? $t('frameleaf_viewer_delete_keep') : $t('cancel')}
    </button>
    <button type="button" class="button fl-danger" onclick={confirm}>
      {assetName ? $t('frameleaf_viewer_delete_permanently') : $t('delete')}
    </button>
  {/snippet}
</Dialog>

<style>
  p {
    margin: 0 0 var(--fl-space-2);
    line-height: 1.5;
  }
  .suppress {
    display: flex;
    align-items: center;
    gap: var(--fl-space-2);
    min-height: var(--fl-control-height);
    margin-top: var(--fl-space-2);
    color: var(--fl-muted);
  }
  .suppress input {
    min-height: 0;
    width: var(--fl-icon-lg);
    height: var(--fl-icon-lg);
  }
</style>
