<script lang="ts">
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import { t } from 'svelte-i18n';

  /**
   * The one confirmation in the selection bar. Everything reversible offers undo instead: the
   * interaction requirements are explicit that routine decisions must not be interrupted by
   * confirmation popups, so this exists only where there is nothing to undo to.
   */
  let {
    count,
    open = $bindable(true),
    onConfirm,
  }: { count: number; open?: boolean; onConfirm: () => void } = $props();
</script>

<BulkFormDialog
  bind:open
  danger
  title={$t('frameleaf_bulk_delete_permanently')}
  submitLabel={$t('frameleaf_bulk_delete_permanently')}
  onSubmit={onConfirm}
>
  <p>{$t('frameleaf_bulk_delete_permanently_confirm', { values: { count } })}</p>
</BulkFormDialog>

<style>
  p {
    margin: 0;
    color: var(--fl-text);
  }
</style>
