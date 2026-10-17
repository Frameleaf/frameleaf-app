<script lang="ts">
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { t } from 'svelte-i18n';

  /**
   * Change description. One description is written to every selected item through the bulk update
   * endpoint; an empty field clears it. There is no undo because the endpoint does not return the
   * previous values, so the dialog says plainly that it replaces what is there.
   */
  let {
    count,
    initialDescription = '',
    open = $bindable(true),
    onSubmit,
  }: {
    count: number;
    initialDescription?: string;
    open?: boolean;
    onSubmit: (payload: BulkPayload) => void;
  } = $props();

  let description = $state(count === 1 ? initialDescription : '');
</script>

<BulkFormDialog
  bind:open
  title={$t('frameleaf_bulk_change_description')}
  submitLabel={$t('frameleaf_bulk_apply_to', { values: { count } })}
  preview={count > 1
    ? $t('frameleaf_bulk_description_replaces', { values: { count } })
    : $t('frameleaf_bulk_description_clear')}
  onSubmit={() => onSubmit({ description: description.trim() })}
>
  <label>
    {$t('description')}
    <textarea
      rows="4"
      maxlength="1000"
      bind:value={description}
      placeholder={$t('frameleaf_bulk_description_placeholder')}></textarea>
  </label>
</BulkFormDialog>
