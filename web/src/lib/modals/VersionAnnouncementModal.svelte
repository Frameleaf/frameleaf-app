<script lang="ts">
  /**
   * New version announcement (FL-80 S-4): shown to administrators when the server's check of
   * Frameleaf's own GitHub releases finds a newer version. A Frameleaf Dialog (the prototype's sheet
   * pattern, as `AboutDialog`) with the release notes of that version; nothing links to Immich.
   */
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { releaseNotesUrl } from '$lib/frameleaf/version-check';
  import { t } from 'svelte-i18n';

  type Props = {
    serverVersion: string;
    releaseVersion: string;
    onClose: () => void;
  };

  const { serverVersion, releaseVersion, onClose }: Props = $props();

  let open = $state(true);
  $effect(() => {
    if (!open) {
      onClose();
    }
  });

  // releaseVersion comes from semverToName (e.g. v2.1.0); the notes are the GitHub releases that
  // .github/frameleaf-release.cjs publishes as frameleaf-v<version>-<n>.
  const notesUrl = $derived(releaseNotesUrl(releaseVersion));
</script>

<Dialog title={$t('frameleaf_version_announcement_title')} closeLabel={$t('close')} bind:open>
  <p class="message">
    <FormatMessage key="version_announcement_message">
      {#snippet children({ tag, message })}
        {#if tag === 'link'}
          <a href={notesUrl} target="_blank" rel="noopener noreferrer">{message}</a>
        {:else if tag === 'code'}
          <code>{message}</code>
        {/if}
      {/snippet}
    </FormatMessage>
  </p>
  <dl class="versions">
    <div>
      <dt>{$t('server_version')}</dt>
      <dd><code>{serverVersion}</code></dd>
    </div>
    <div>
      <dt>{$t('latest_version')}</dt>
      <dd><code>{releaseVersion}</code></dd>
    </div>
  </dl>
  {#snippet actions()}
    <button type="button" class="button primary" data-initial-focus onclick={() => (open = false)}>
      {$t('acknowledge')}
    </button>
  {/snippet}
</Dialog>

<style>
  .message {
    margin: 0;
    font-size: var(--fl-font-size);
  }
  .message a {
    color: var(--fl-text);
    text-decoration: underline;
  }
  .versions {
    margin: 14px 0 0;
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 10px 16px;
    padding: 14px;
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
  }
  .versions div {
    display: grid;
    gap: 1px;
  }
  .versions dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-micro);
    text-transform: uppercase;
    letter-spacing: 0.4px;
  }
  .versions dd {
    margin: 0;
    font-size: var(--fl-font-small);
  }
</style>
