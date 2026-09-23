<script lang="ts">
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { showDeleteModal } from '$lib/stores/preferences.store';
  import { Button, Checkbox, HStack, Label, Modal, ModalBody, ModalFooter } from '@immich/ui';
  import { mdiDeleteForeverOutline } from '@mdi/js';
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

  let checked = $state(false);

  const onClose = (confirmed: boolean) => {
    if (confirmed && suppressible && checked) {
      $showDeleteModal = false;
    }

    onCloseParent(confirmed);
  };
</script>

<Modal
  title={assetName
    ? $t('frameleaf_viewer_delete_permanently_title')
    : $t('permanently_delete_assets_count', { values: { count: size } })}
  icon={mdiDeleteForeverOutline}
  size="small"
  onClose={() => onClose(false)}
  focusOnOpen
>
  <ModalBody>
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
      <div class="flex items-center justify-center gap-2 pt-4">
        <Checkbox id="confirm-deletion-input" bind:checked color="secondary" />
        <Label label={$t('do_not_show_again')} for="confirm-deletion-input" />
      </div>
    {/if}
  </ModalBody>

  <ModalFooter>
    <HStack fullWidth>
      <Button shape="round" color="secondary" fullWidth onclick={() => onClose(false)}>
        {assetName ? $t('frameleaf_viewer_delete_keep') : $t('cancel')}
      </Button>
      <Button shape="round" color="danger" fullWidth onclick={() => onClose(true)}>
        {assetName ? $t('frameleaf_viewer_delete_permanently') : $t('delete')}
      </Button>
    </HStack>
  </ModalFooter>
</Modal>
