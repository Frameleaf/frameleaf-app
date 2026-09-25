<script lang="ts">
  /**
   * Maintenance → Database backups → Recovery readiness (FL-71 CC-9): the template's recovery review
   * (`CommandCenter.jsx:2362-2375`, stages Metadata · Originals · Restore drill) on the server's record
   * of restore tests (`getBackupRestoreVerification`). An administrator restores a backup into an
   * isolated destination, checks it, then records which parts restored; the Overview's "Prove your
   * backup can restore" (`CommandCenter.jsx:1790-1800`) reads the same record. Recording is a
   * statement by the administrator, not a check the server runs, and the dialog says so.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import {
    getBackupRestoreVerification,
    recordBackupRestoreVerification,
    type BackupRestoreVerificationResponseDto,
  } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import { mdiBackupRestore } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';

  let verification = $state<BackupRestoreVerificationResponseDto>();
  let failed = $state(false);
  let open = $state(false);
  let metadata = $state(false);
  let originals = $state(false);
  let working = $state(false);

  onMount(() => {
    getBackupRestoreVerification()
      .then((result) => (verification = result))
      .catch(() => (failed = true));
  });

  const when = (value: string) =>
    new Intl.DateTimeFormat($locale, { dateStyle: 'medium', timeStyle: 'short' }).format(new Date(value));
  const proved = (value: string | null) =>
    value
      ? $t('admin.frameleaf_restore_test_proved', { values: { date: when(value) } })
      : $t('admin.frameleaf_restore_test_not_recorded');

  const start = () => {
    metadata = false;
    originals = false;
    open = true;
  };

  const save = async (event: SubmitEvent) => {
    event.preventDefault();
    if (working || !(metadata || originals)) {
      return;
    }
    working = true;
    try {
      verification = await recordBackupRestoreVerification({
        backupRestoreVerificationRecordDto: { metadata, originals },
      });
      open = false;
    } catch (error) {
      handleError(error, $t('errors.something_went_wrong'));
    } finally {
      working = false;
    }
  };
</script>

<section class="restore-test" aria-labelledby="fl-restore-test-title">
  <header>
    <div>
      <h2 id="fl-restore-test-title">{$t('admin.frameleaf_restore_test_title')}</h2>
      <p>{$t('admin.frameleaf_restore_test_intro')}</p>
    </div>
    <Button onclick={start} disabled={!verification}>
      <Icon icon={mdiBackupRestore} size="16" aria-hidden={true} />
      {$t('admin.frameleaf_restore_test_record')}
    </Button>
  </header>
  {#if failed}
    <p role="alert">{$t('frameleaf_cc_load_failed')}</p>
  {:else if verification}
    <dl>
      <div>
        <dt>{$t('admin.frameleaf_restore_test_database')}</dt>
        <dd>{proved(verification.metadataVerifiedAt)}</dd>
      </div>
      <div>
        <dt>{$t('admin.frameleaf_restore_test_originals')}</dt>
        <dd>{proved(verification.originalsVerifiedAt)}</dd>
      </div>
      <div>
        <dt>{$t('admin.frameleaf_restore_test_next')}</dt>
        <dd>
          {verification.overdue
            ? $t('admin.frameleaf_restore_test_due_now')
            : $t('admin.frameleaf_restore_test_due', { values: { date: when(verification.dueAt!) } })}
        </dd>
      </div>
    </dl>
    {#if verification.verifiedBy}
      <p class="muted">
        {$t('admin.frameleaf_restore_test_recorded_by', { values: { name: verification.verifiedBy.name } })}
      </p>
    {/if}
  {:else}
    <p role="status">{$t('loading')}</p>
  {/if}
</section>

<Dialog title={$t('admin.frameleaf_restore_test_record')} closeLabel={$t('close')} bind:open>
  <form onsubmit={save}>
    <p>{$t('admin.frameleaf_restore_test_steps')}</p>
    <label>
      <input type="checkbox" bind:checked={metadata} disabled={working} />
      {$t('admin.frameleaf_restore_test_metadata_check')}
    </label>
    <label>
      <input type="checkbox" bind:checked={originals} disabled={working} />
      {$t('admin.frameleaf_restore_test_originals_check')}
    </label>
    <p class="muted">
      {$t('admin.frameleaf_restore_test_statement', { values: { days: verification?.intervalDays ?? 90 } })}
    </p>
    <footer>
      <Button type="button" disabled={working} onclick={() => (open = false)}>{$t('cancel')}</Button>
      <Button type="submit" variant="primary" disabled={working || !(metadata || originals)}>
        {$t('admin.frameleaf_restore_test_save')}
      </Button>
    </footer>
  </form>
</Dialog>

<style>
  /* Maintenance.jsx `.mt-card`, as the backups card above it. */
  .restore-test {
    margin-top: 16px;
    padding: 20px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-start;
    justify-content: space-between;
    gap: 16px;
    margin-bottom: 12px;
  }
  h2 {
    margin: 0 0 4px;
    font-size: 16px;
    font-weight: 600;
  }
  header p,
  .muted {
    margin: 0;
    font-size: var(--fl-font-small);
    line-height: 1.6;
    color: var(--fl-muted);
  }
  dl {
    display: grid;
    gap: 6px;
    margin: 0;
    font-size: var(--fl-font-small);
  }
  dl div {
    display: flex;
    justify-content: space-between;
    gap: 16px;
  }
  dt {
    color: var(--fl-muted);
  }
  dd {
    margin: 0;
    text-align: end;
  }
  form {
    display: grid;
    gap: 12px;
    min-width: min(28rem, 100%);
  }
  form p {
    margin: 0;
  }
  label {
    display: flex;
    align-items: center;
    gap: 8px;
  }
  footer {
    display: flex;
    justify-content: flex-end;
    gap: 8px;
  }
</style>
