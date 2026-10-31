<script lang="ts">
  import type { Translations } from 'svelte-i18n';
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
    /** The action being confirmed. Defaults to the permanent delete this dialog was written for. */
    labelKey = 'frameleaf_bulk_delete_permanently',
    messageKey = 'frameleaf_bulk_delete_permanently_confirm',
    danger = true,
    onConfirm,
  }: {
    count: number;
    open?: boolean;
    labelKey?: Translations;
    messageKey?: Translations;
    danger?: boolean;
    onConfirm: () => void;
  } = $props();
</script>

<BulkFormDialog bind:open {danger} title={$t(labelKey)} submitLabel={$t(labelKey)} onSubmit={onConfirm}>
  <p>{$t(messageKey, { values: { count } })}</p>
</BulkFormDialog>

<style>
  p {
    margin: 0;
    color: var(--fl-text);
  }
</style>
