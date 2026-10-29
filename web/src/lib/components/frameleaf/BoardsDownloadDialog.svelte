<script lang="ts">
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { Icon } from '@frameleaf/ui';
  import { mdiDownload } from '@mdi/js';
  import { t } from 'svelte-i18n';

  /**
   * Boards' Download dialog (FL-660, prototype `ExportDialog`, README point 10, screen 11). It
   * downloads the originals as a .zip and, with "Include a library file" (on by default, as in the
   * design), adds `frameleaf-library.json` so the work can move to another app. Backup stays the way
   * to make a full copy that can be restored.
   */
  let {
    open = $bindable(false),
    count,
    name,
    libraryAvailable = true,
    onDownload,
  }: {
    open?: boolean;
    /** The items being downloaded, saved links included. */
    count: number;
    /** Where they come from: the collection, or Boards. */
    name: string;
    /** False when the library file cannot be made: shared items, or too many of them. */
    libraryAvailable?: boolean;
    onDownload: (includeLibrary: boolean) => void;
  } = $props();

  let includeLibrary = $state(true);
  const hintId = $props.id();

  const download = () => {
    onDownload(libraryAvailable && includeLibrary);
    open = false;
  };
</script>

<Dialog title={$t('frameleaf_boards_download_title', { values: { count } })} closeLabel={$t('close')} bind:open>
  <div class="body">
    <p>
      <FormatMessage key="frameleaf_boards_download_originals" values={{ name }}>
        {#snippet children({ message })}<strong>{message}</strong>{/snippet}
      </FormatMessage>
    </p>
    <label class="switch">
      <span class="text">
        <strong>{$t('frameleaf_boards_download_library')}</strong>
        <small id="{hintId}-hint">{$t('frameleaf_boards_download_library_hint')}</small>
        {#if !libraryAvailable}
          <small id="{hintId}-unavailable">{$t('frameleaf_boards_download_library_unavailable')}</small>
        {/if}
      </span>
      <input
        type="checkbox"
        role="switch"
        checked={libraryAvailable && includeLibrary}
        disabled={!libraryAvailable}
        aria-describedby={libraryAvailable ? `${hintId}-hint` : `${hintId}-hint ${hintId}-unavailable`}
        onchange={(event) => (includeLibrary = event.currentTarget.checked)}
      />
    </label>
    <p class="note">{$t('frameleaf_boards_download_backup_note')}</p>
  </div>
  {#snippet actions()}
    <button type="button" class="button" onclick={() => (open = false)}>{$t('cancel')}</button>
    <button type="button" class="button primary" data-initial-focus onclick={download}>
      <Icon icon={mdiDownload} size="18" aria-hidden={true} />
      {$t('frameleaf_boards_download_zip')}
    </button>
  {/snippet}
</Dialog>

<style>
  .body {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-4);
    width: min(30rem, 100%);
    color: var(--fl-text);
    font-size: 0.875rem;
  }
  .body p {
    margin: 0;
  }
  .switch {
    display: flex;
    align-items: flex-start;
    gap: var(--fl-space-4);
    cursor: pointer;
  }
  .text {
    flex: 1;
    display: flex;
    flex-direction: column;
    gap: 0.25rem;
  }
  .text small,
  .note {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.45;
  }
  input[role='switch'] {
    appearance: none;
    flex: 0 0 40px;
    position: relative;
    width: 40px;
    height: 24px;
    margin: 0;
    padding: 0;
    border: 0;
    border-radius: var(--fl-radius-pill);
    background: var(--fl-border);
    cursor: pointer;
    transition: background var(--fl-motion-fast) var(--fl-ease);
  }
  input[role='switch']::after {
    content: '';
    position: absolute;
    top: 3px;
    left: 3px;
    width: 18px;
    height: 18px;
    border-radius: 50%;
    background: var(--fl-text);
    transition: translate var(--fl-motion-fast) var(--fl-ease);
  }
  input[role='switch']:checked {
    background: var(--fl-accent);
  }
  input[role='switch']:checked::after {
    translate: 16px 0;
    background: var(--fl-accent-text);
  }
  input[role='switch']:disabled {
    cursor: not-allowed;
    opacity: 0.5;
  }
  input[role='switch']:focus-visible {
    outline: 2px solid var(--fl-text);
    outline-offset: 2px;
  }
  .button {
    display: inline-flex;
    align-items: center;
    gap: 0.375rem;
  }
</style>
