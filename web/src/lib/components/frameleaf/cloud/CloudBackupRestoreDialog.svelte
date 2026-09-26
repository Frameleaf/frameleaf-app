<script lang="ts">
  /**
   * Restore one item from a kept backup (FL-164): the prototype's `ItemRestoreDialog`
   * (design/frameleaf/template/src/FrameleafCloud.jsx). The administrator chooses the backup to restore
   * from; the item's files go back where the library expects them, each checked against its fingerprint
   * before it touches the library, and a file in the way moves to `frameleaf/restore/replaced` and is
   * never deleted. In own-memory mode the key file is asked for first, once per server start.
   */
  import './frameleaf-cloud.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { readBackupKeyFile } from '$lib/frameleaf/cloud-backup';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    CloudBackupRestoreScope,
    restoreCloudBackup,
    unlockCloudBackupKey,
    type CloudBackupManifestDto,
    type CloudBackupStatusResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiBackupRestore, mdiShieldCheckOutline, mdiUpload } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  type Props = {
    open: boolean;
    item: { assetId: string; name: string };
    manifests: CloudBackupManifestDto[];
    /** The backup the list was read from, chosen first. */
    manifestKey: string;
    /** The key must be loaded before anything is restored (own-memory mode after a restart). */
    needsKey: boolean;
    keyFingerprint: string | null;
    formatWhen: (value: string) => string;
    onDone: (status: CloudBackupStatusResponseDto) => void;
  };

  let {
    open = $bindable(),
    item,
    manifests,
    manifestKey,
    needsKey,
    keyFingerprint,
    formatWhen,
    onDone,
  }: Props = $props();

  // svelte-ignore state_referenced_locally
  let chosen = $state(manifestKey);
  // svelte-ignore state_referenced_locally
  let keyReady = $state(!needsKey);
  let keyValue = $state('');
  let keyError = $state<Translations | null>(null);
  let failure = $state('');
  let busy = $state(false);
  let fileInput = $state<HTMLInputElement>();

  const readKeyFile = async (file: File | undefined) => {
    if (!file) {
      return;
    }
    const read = readBackupKeyFile(await file.text(), keyFingerprint);
    if ('error' in read) {
      keyError = read.error;
      return;
    }
    keyValue = read.key;
    keyError = null;
  };

  const loadKey = async () => {
    busy = true;
    failure = '';
    try {
      await unlockCloudBackupKey({ cloudBackupUnlockDto: { key: keyValue } });
      keyReady = true;
      keyValue = '';
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      busy = false;
    }
  };

  const restore = async () => {
    busy = true;
    failure = '';
    try {
      const status = await restoreCloudBackup({
        cloudBackupRestoreDto: {
          manifestKey: chosen,
          scope: CloudBackupRestoreScope.Asset,
          assetIds: [item.assetId],
        },
      });
      onDone(status);
      open = false;
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
    } finally {
      busy = false;
    }
  };
</script>

{#if keyReady}
  <Dialog
    bind:open
    title={$t('frameleaf_cloud_restore_item_title', { values: { name: item.name } })}
    closeLabel={$t('close')}
  >
    <label class="fc-stack">
      {$t('frameleaf_cloud_restore_from')}
      <select data-initial-focus value={chosen} onchange={(event) => (chosen = event.currentTarget.value)}>
        {#each manifests as manifest, index (manifest.key)}
          <option value={manifest.key}>
            {formatWhen(manifest.createdAt)}{index === 0 ? $t('frameleaf_cloud_restore_newest_suffix') : ''}
          </option>
        {/each}
      </select>
    </label>
    <p class="fc-ok">
      <Icon icon={mdiShieldCheckOutline} size="18" />
      <span>{$t('frameleaf_cloud_restore_verified_note', { values: { folder: 'frameleaf/restore/replaced' } })}</span>
    </p>
    {#if failure}
      <p class="cc-error" role="alert">{failure}</p>
    {/if}
    {#snippet actions()}
      <Button onclick={() => (open = false)}>{$t('frameleaf_cloud_cancel')}</Button>
      <Button variant="primary" disabled={!chosen || busy} onclick={() => void restore()}>
        <Icon icon={mdiBackupRestore} size="18" />
        {$t('frameleaf_cloud_restore')}
      </Button>
    {/snippet}
  </Dialog>
{:else}
  <Dialog bind:open title={$t('frameleaf_cloud_restore_key_title')} closeLabel={$t('close')}>
    <p>{$t('frameleaf_cloud_restore_key_body')}</p>
    <input
      bind:this={fileInput}
      type="file"
      accept=".json,application/json"
      hidden
      onchange={(event) => {
        void readKeyFile(event.currentTarget.files?.[0]);
        event.currentTarget.value = '';
      }}
    />
    <div class="fc-actions">
      <Button onclick={() => fileInput?.click()}>
        <Icon icon={mdiUpload} size="18" />
        {$t('frameleaf_cloud_backup_choose_key_file')}
      </Button>
    </div>
    <label class="fc-stack">
      {$t('frameleaf_cloud_backup_paste_key')}
      <input
        type="password"
        autocomplete="off"
        value={keyValue}
        oninput={(event) => (keyValue = event.currentTarget.value)}
      />
    </label>
    {#if keyFingerprint}
      <p class="fc-muted">{$t('frameleaf_cloud_backup_expected_fingerprint')} <code>{keyFingerprint}</code></p>
    {/if}
    {#if keyError}
      <p class="cc-error" role="alert">{$t(keyError)}</p>
    {/if}
    {#if failure}
      <p class="cc-error" role="alert">{failure}</p>
    {/if}
    {#snippet actions()}
      <Button onclick={() => (open = false)}>{$t('frameleaf_cloud_cancel')}</Button>
      <Button variant="primary" disabled={!keyValue.trim() || busy} onclick={() => void loadKey()}>
        {$t('frameleaf_cloud_restore_use_key')}
      </Button>
    {/snippet}
  </Dialog>
{/if}
