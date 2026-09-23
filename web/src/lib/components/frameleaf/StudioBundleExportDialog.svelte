<script lang="ts">
  /**
   * The Studio editor's project bundle export dialog (FL-91).
   *
   * The same question the project library's export dialog asks, with the same words: whether to
   * include copies of the media the person owns. Only owned media is copied, shared media travels
   * as a reference and nothing Locked is ever copied; the server enforces all three whatever is
   * chosen here. Every opening starts from "no copies", the safe default.
   *
   * The dialog only collects the choice. The route turns it into a `project.exportBundle` command
   * through the typed bridge, so an export started here and one the editor starts take one path.
   */
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';

  let {
    open = $bindable(false),
    projectName,
    onConfirm,
  }: {
    open?: boolean;
    projectName: string;
    /** The person chose Export; closing the dialog any other way is a cancel. */
    onConfirm: (includeMedia: boolean) => void;
  } = $props();

  let includeMedia = $state(false);

  $effect(() => {
    if (open) {
      includeMedia = false;
    }
  });
</script>

<Dialog bind:open title={$t('frameleaf_studio_bundle_export_title')} closeLabel={$t('close')}>
  <div class="dialog-body" data-testid="studio-bundle-export-dialog">
    <p>{$t('frameleaf_studio_bundle_export_body', { values: { name: projectName } })}</p>
    <label class="check">
      <input type="checkbox" bind:checked={includeMedia} />
      <span>{$t('frameleaf_studio_bundle_include_media')}</span>
    </label>
    <p class="note">{$t('frameleaf_studio_bundle_include_media_note')}</p>
    <footer>
      <Button onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button variant="primary" onclick={() => onConfirm(includeMedia)}>
        {$t('frameleaf_studio_bundle_export_start')}
      </Button>
    </footer>
  </div>
</Dialog>

<style>
  .dialog-body {
    display: grid;
    gap: 0.75rem;
    margin-top: 0.75rem;
    min-width: min(28rem, 100%);
  }
  .dialog-body p {
    margin: 0;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .note {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  footer {
    display: flex;
    flex-wrap: wrap;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
