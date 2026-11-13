<script lang="ts">
  import BulkFormDialog from '$lib/components/frameleaf/BulkFormDialog.svelte';
  import type { BulkPayload } from '$lib/frameleaf/bulk-operations';
  import { t } from 'svelte-i18n';

  let {
    count,
    open = $bindable(true),
    onSubmit,
  }: {
    count: number;
    open?: boolean;
    onSubmit: (payload: BulkPayload) => void;
  } = $props();
  const fields = [
    { key: 'title', label: 'frameleaf_metadata_title', action: 'frameleaf_metadata_change_title' },
    { key: 'artist', label: 'frameleaf_metadata_artist', action: 'frameleaf_metadata_change_artist' },
    { key: 'copyright', label: 'frameleaf_metadata_copyright', action: 'frameleaf_metadata_change_copyright' },
  ] as const;
  let values = $state({ title: '', artist: '', copyright: '' });
  let enabled = $state({ title: false, artist: false, copyright: false });
</script>

<BulkFormDialog
  bind:open
  title={$t('frameleaf_metadata_bulk')}
  submitLabel={$t('frameleaf_bulk_apply_to', { values: { count } })}
  preview={$t('frameleaf_metadata_bulk_help')}
  valid={Object.values(enabled).some(Boolean)}
  onSubmit={() =>
    onSubmit({
      credits: Object.fromEntries(
        fields.filter(({ key }) => enabled[key]).map(({ key }) => [key, values[key].trim() || null]),
      ),
    })}
>
  {#each fields as { key, label, action } (key)}
    <label class="check"><input type="checkbox" bind:checked={enabled[key]} /> {$t(action)}</label>
    {#if enabled[key]}
      <label>{$t(label)} <input bind:value={values[key]} maxlength="500" /></label>
    {/if}
  {/each}
</BulkFormDialog>

<style>
  .check {
    display: flex;
    flex-direction: row;
    align-items: center;
    gap: 0.5rem;
  }
</style>
