<script lang="ts">
  import Dialog from './Dialog.svelte';
  import SharedLinkFormBody from './SharedLinkFormBody.svelte';
  import type { SharedLinkResponseDto, SharedLinkType } from '@frameleaf/sdk';
  import { t } from 'svelte-i18n';

  /**
   * Create or edit a shared link in a dialog of its own: the design's `SharedLinkForm`
   * (`SharedLinkForm.jsx:88-509`). The fields, the rules between them and the "Link ready" step
   * live in `SharedLinkFormBody`, which the share sheet also shows in place.
   *
   * Creating ends on the "Link ready" step (address, Copy, QR code, Open) in the same dialog;
   * editing saves and closes.
   */
  let {
    open = $bindable(false),
    target,
    link,
    onClosed,
  }: {
    open?: boolean;
    target?: {
      type: SharedLinkType;
      albumId?: string;
      assetIds?: string[];
      name: string;
      /** For an album, the items its preview shows (its cover), since the form does not load the album. */
      previewAssetIds?: string[];
      /** For an album, how many items it holds. */
      count?: number;
    };
    link?: SharedLinkResponseDto;
    /** Called once the form (or its "Link ready" step) has closed. */
    onClosed?: () => void;
  } = $props();

  const ids = $props.id();
  const formId = `${ids}-form`;
  const editing = $derived(!!link);
  /** The link just created: the dialog shows the "Link ready" step while it is set. */
  let created = $state<SharedLinkResponseDto | undefined>();
  let saving = $state(false);

  let wasOpen = false;
  $effect(() => {
    if (!open && wasOpen) {
      created = undefined;
      onClosed?.();
    }
    wasOpen = open;
  });
</script>

<!-- One dialog for both steps: swapping dialogs would close the first and, with it, the whole form. -->
<Dialog
  title={created
    ? $t('frameleaf_sharing.link_ready_title')
    : editing
      ? $t('frameleaf_sharing.edit_shared_link_title')
      : $t('frameleaf_sharing.create_shared_link_title')}
  closeLabel={$t('close')}
  bind:open
>
  <SharedLinkFormBody active={open} {target} {link} {formId} bind:created bind:saving onSaved={() => (open = false)} />
  {#snippet actions()}
    {#if created}
      <button type="button" class="primary" onclick={() => (open = false)}>{$t('done')}</button>
    {:else}
      <button type="button" onclick={() => (open = false)}>{$t('cancel')}</button>
      <button type="submit" form={formId} class="primary" disabled={saving}>
        {editing ? $t('save') : $t('create_link')}
      </button>
    {/if}
  {/snippet}
</Dialog>
