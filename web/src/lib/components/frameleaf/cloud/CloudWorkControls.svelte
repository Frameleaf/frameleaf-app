<script lang="ts">
  /**
   * FL-164: Pause, Resume and Cancel for a cloud backup run, check, clean-up or restore in progress
   * (`POST admin/cloud/backup/runs/:id/pause|resume|cancel`). Shown on the Cloud backup page and in
   * Settings › Background work; Activity's rows stay read-only and point here. Cancelling asks first:
   * files already uploaded or restored stay where they are.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { cloudWorkActions } from '$lib/frameleaf/cloud-backup';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    cancelCloudBackupRun,
    CloudBackupRunState,
    pauseCloudBackupRun,
    resumeCloudBackupRun,
    type CloudBackupStatusResponseDto,
  } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiClose, mdiPause, mdiPlay } from '@mdi/js';
  import { t } from 'svelte-i18n';

  type Props = {
    operationId: string;
    runState: CloudBackupRunState;
    /** What the operation is, as its row names it ("Cloud backup", "Restore from cloud backup"…). */
    title: string;
    /** Whether it is a restore, for the cancel dialog's wording. */
    restore?: boolean;
    onStatus: (status: CloudBackupStatusResponseDto) => void;
  };

  let { operationId, runState, title, restore = false, onStatus }: Props = $props();

  const allowed = $derived(cloudWorkActions(runState));
  let busy = $state(false);
  let failure = $state('');
  let confirmOpen = $state(false);

  const act = async (call: () => Promise<CloudBackupStatusResponseDto>) => {
    busy = true;
    failure = '';
    try {
      onStatus(await call());
      return true;
    } catch (error) {
      failure = getServerErrorMessage(error) ?? $t('frameleaf_cloud_action_failed');
      return false;
    } finally {
      busy = false;
    }
  };

  const pause = () => act(() => pauseCloudBackupRun({ id: operationId }));
  const resume = () => act(() => resumeCloudBackupRun({ id: operationId }));
  const cancel = async () => {
    if (await act(() => cancelCloudBackupRun({ id: operationId }))) {
      confirmOpen = false;
    }
  };
</script>

<div class="fc-actions" role="group" aria-label={$t('frameleaf_cloud_work_controls', { values: { title } })}>
  {#if allowed.resume}
    <Button disabled={busy} onclick={() => void resume()}>
      <Icon icon={mdiPlay} size="16" />
      {$t('frameleaf_cloud_work_resume')}
    </Button>
  {:else}
    <Button disabled={busy || !allowed.pause} onclick={() => void pause()}>
      <Icon icon={mdiPause} size="16" />
      {runState === CloudBackupRunState.Pausing ? $t('frameleaf_cloud_work_pausing') : $t('frameleaf_cloud_work_pause')}
    </Button>
  {/if}
  <Button disabled={busy || !allowed.cancel} onclick={() => (confirmOpen = true)}>
    <Icon icon={mdiClose} size="16" />
    {runState === CloudBackupRunState.Cancelling
      ? $t('frameleaf_cloud_work_cancelling')
      : $t('frameleaf_cloud_work_cancel')}
  </Button>
</div>
{#if failure}
  <p class="fc-notice is-error" role="alert">{failure}</p>
{/if}

<Dialog
  bind:open={confirmOpen}
  title={$t('frameleaf_cloud_work_cancel_title', { values: { title } })}
  closeLabel={$t('close')}
  onRequestClose={() => (confirmOpen = false)}
>
  <p>{restore ? $t('frameleaf_cloud_work_cancel_restore_body') : $t('frameleaf_cloud_work_cancel_body')}</p>
  {#snippet actions()}
    <Button onclick={() => (confirmOpen = false)}>{$t('frameleaf_cloud_work_keep_going')}</Button>
    <Button variant="primary" disabled={busy} onclick={() => void cancel()}>{$t('frameleaf_cloud_work_cancel')}</Button>
  {/snippet}
</Dialog>
