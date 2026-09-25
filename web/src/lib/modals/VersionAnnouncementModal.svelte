<script lang="ts">
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { BasicModal } from '@immich/ui';
  import { t } from 'svelte-i18n';

  type Props = {
    serverVersion: string;
    releaseVersion: string;
    onClose: () => void;
  };

  const { serverVersion, releaseVersion, onClose }: Props = $props();

  // releaseVersion comes from semverToName and already carries the leading "v" (e.g. v2.1.0).
  // Release notes are the GitHub release notes that .github/frameleaf-release.cjs generates.
  const releaseNotesUrl = $derived(`https://github.com/Frameleaf/frameleaf-app/releases/tag/${releaseVersion}`);
</script>

<BasicModal
  size="small"
  title="🎉 {$t('new_version_available')}"
  closeText={$t('acknowledge')}
  closeColor="primary"
  {onClose}
  icon={false}
>
  <FormatMessage key="version_announcement_message">
    {#snippet children({ tag, message })}
      {#if tag === 'link'}
        <span class="font-medium underline">
          <a href={releaseNotesUrl} target="_blank" rel="noopener noreferrer">
            {message}
          </a>
        </span>
      {:else if tag === 'code'}
        <code>{message}</code>
      {/if}
    {/snippet}
  </FormatMessage>

  <div class="font-sm mt-8">
    <code>{$t('server_version')}: {serverVersion}</code>
    <br />
    <code>{$t('latest_version')}: {releaseVersion}</code>
  </div>
</BasicModal>
