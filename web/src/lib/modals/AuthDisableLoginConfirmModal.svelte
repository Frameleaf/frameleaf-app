<script lang="ts">
  import FormatMessage from '$lib/elements/FormatMessage.svelte';
  import { helpLinks } from '$lib/frameleaf/help-links.svelte';
  import { ConfirmModal, Link } from '@immich/ui';
  import { mdiCancel } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    onClose: (confirmed?: boolean) => void;
  };

  let { onClose }: Props = $props();

  // FL-135: this installation's documentation, or no link at all
  const commandsDocs = $derived(helpLinks.docs('administration/server-commands'));
</script>

<ConfirmModal title={$t('admin.disable_login')} icon={mdiCancel} size="small" {onClose}>
  {#snippet prompt()}
    <div class="flex flex-col gap-4 text-center">
      <p>{$t('admin.authentication_settings_disable_all')}</p>
      <p>
        <FormatMessage key="admin.authentication_settings_reenable">
          {#snippet children({ message })}
            {#if commandsDocs}
              <Link href={commandsDocs}>{message}</Link>
            {:else}
              {message}
            {/if}
          {/snippet}
        </FormatMessage>
      </p>
    </div>
  {/snippet}
</ConfirmModal>
