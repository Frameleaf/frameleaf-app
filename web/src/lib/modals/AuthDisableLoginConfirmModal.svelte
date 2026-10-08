<script lang="ts">
  import ConfirmDialog from '$lib/components/frameleaf/ConfirmDialog.svelte';
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { helpLinks } from '$lib/frameleaf/help-links.svelte';
  import { t } from 'svelte-i18n';

  type Props = {
    onClose: (confirmed?: boolean) => void;
  };

  let { onClose }: Props = $props();

  // FL-135: this installation's documentation, or no link at all
  const commandsDocs = $derived(helpLinks.docs('administration/server-commands'));
</script>

<ConfirmDialog title={$t('admin.disable_login')} confirmText={$t('confirm')} danger {onClose}>
  {#snippet prompt()}
    <div class="prompt">
      <p>{$t('admin.authentication_settings_disable_all')}</p>
      <p>
        <FormatMessage key="admin.authentication_settings_reenable">
          {#snippet children({ message })}
            {#if commandsDocs}
              <a href={commandsDocs} target="_blank" rel="noopener noreferrer">{message}</a>
            {:else}
              {message}
            {/if}
          {/snippet}
        </FormatMessage>
      </p>
    </div>
  {/snippet}
</ConfirmDialog>

<style>
  .prompt {
    display: flex;
    flex-direction: column;
    gap: var(--fl-space-3);
    line-height: 1.5;
  }
  p {
    margin: 0;
  }
  a {
    color: var(--fl-text);
    text-decoration: underline;
  }
</style>
