<script lang="ts">
  import { t } from 'svelte-i18n';
  import './frameleaf-cloud.css';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import BuddyRestoreSection from '$lib/components/frameleaf/cloud/BuddyRestoreSection.svelte';
  import { buddyBackupPresentation } from '$lib/frameleaf/buddy-backup';
  import { formatDateTime } from '$lib/frameleaf/cloud-ml';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { cloudManager } from '$lib/managers/cloud-manager.svelte';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    Action as BuddyControlAction,
    Action2 as BuddyRelationshipAction,
    getBuddyBackupStatus,
    checkBuddyBackupCoverage,
    type BuddyPreflightDto,
    refreshBuddyBackup,
    configureBuddyBackup,
    inviteBackupBuddy,
    acceptBackupBuddy,
    changeBuddyRelationship,
    generateBuddyRecoveryKit,
    verifyBuddyRecoveryKit,
    importBuddyRecoveryKit,
    rotateBuddyRecoveryKit,
    controlBuddyBackup,
    testBuddyBackup,
    wrapBuddyRecoveryKit,
    unlockBuddyRecoveryKit,
    type BuddyEscrowDto,
    type BuddyStatusDto,
    type BuddyKitDto,
    type BuddySettingsDto,
    EnvironmentKeys,
    Version,
  } from '@frameleaf/sdk';
  import { onMount } from 'svelte';

  let { view = 'all' }: { view?: 'all' | 'status' | 'controls' | 'restore' } = $props();
  const showStatus = $derived(view === 'all' || view === 'status');
  const showControls = $derived(view === 'all' || view === 'controls');
  const showRecovery = $derived(view === 'all' || view === 'restore');

  let status = $state<BuddyStatusDto | null>(null);
  let coverage = $state<BuddyPreflightDto | null>(null);
  const linked = $derived(cloudManager.status?.state === 'linked');
  const entitled = $derived(linked && !!cloudManager.license?.entitlements.cloudBackup);
  const presentation = $derived(buddyBackupPresentation(status, linked, entitled));
  let failure = $state('');
  let notice = $state('');
  let busy = $state(false);
  let setup = $state(false);
  let step = $state(0);
  let settingsOpen = $state(false);
  let directory = $state('');
  let quotaGiB = $state(500);
  let upload = $state(20);
  let download = $state(20);
  let schedule = $state('0 2 * * *');
  let timezone = $state('UTC');
  let windowStart = $state('00:00');
  let windowEnd = $state('00:00');
  let configurationFiles = $state('');
  let environmentKeys = $state<EnvironmentKeys[]>([]);
  let includeDerived = $state(false);
  let buddyAccount = $state('');
  let invitation = $state('');
  let invitationLink = $state('');
  let kit = $state<BuddyKitDto | null>(null);
  let kitSaved = $state(false);
  let passphrase = $state('');
  let repeatPassphrase = $state('');
  let confirmAction = $state<'end' | 'block' | 'restart' | 'rotate' | null>(null);
  const mine = $derived(status?.pairing?.vaults.find((vault) => vault.sourceInstanceId === status?.instanceId));
  const hosted = $derived(status?.pairing?.vaults.find((vault) => vault.destinationInstanceId === status?.instanceId));
  const formatTime = (value: string | null | undefined) =>
    value ? formatDateTime(value, $locale) : $t('frameleaf_buddy_not_yet');
  const bytes = (value: number) => getByteUnitString(value);
  const action = async (run: () => Promise<void>) => {
    busy = true;
    failure = '';
    notice = '';
    try {
      await run();
    } catch (error) {
      failure =
        getServerErrorMessage(error) ??
        (error instanceof Error ? error.message : $t('frameleaf_buddy_buddy_backup_is_unavailable_try_again'));
    } finally {
      busy = false;
    }
  };
  const load = async () => {
    status = await getBuddyBackupStatus();
  };
  const editSettings = () => {
    const s = status?.settings;
    if (s) {
      directory = s.directory;
      quotaGiB = s.quotaBytes / 1024 ** 3;
      upload = s.uploadMbps ?? 20;
      download = s.downloadMbps ?? 20;
      schedule = s.schedule ?? '0 2 * * *';
      timezone = s.timezone;
      windowStart = s.windowStart ?? '00:00';
      windowEnd = s.windowEnd ?? '00:00';
      configurationFiles = (s.configurationFiles ?? []).join('\n');
      environmentKeys = [...(s.bootConfiguration?.environmentKeys ?? [])];
      includeDerived = s.includeDerived ?? false;
    }
  };
  const checkCoverage = async () => {
    coverage = await checkBuddyBackupCoverage({
      buddyPreflightRequestDto: {
        directory,
        configurationFiles: configurationFiles
          .split('\n')
          .map((path) => path.trim())
          .filter(Boolean),
      },
    });
    if (!status?.settings) {
      timezone = coverage.timezone;
    }
    return coverage;
  };
  const beginSetup = () =>
    action(async () => {
      editSettings();
      await checkCoverage();
      setup = true;
      step = status?.configured ? 1 : 0;
    });
  const saveSettings = () =>
    action(async () => {
      const checked = await checkCoverage();
      if (
        checked.mounts.some((mount) => !mount.available) ||
        checked.configurationFiles.some((file) => !file.available)
      ) {
        throw new Error($t('frameleaf_buddy_coverage_unavailable'));
      }
      const buddySettingsDto: BuddySettingsDto = {
        directory,
        quotaBytes: Math.floor(quotaGiB * 1024 ** 3),
        uploadMbps: upload,
        downloadMbps: download,
        schedule,
        timezone,
        windowStart,
        windowEnd,
        configurationFiles: configurationFiles
          .split('\n')
          .map((path) => path.trim())
          .filter(Boolean),
        includeDerived,
        pausedSending: status?.settings?.pausedSending ?? false,
        pausedReceiving: status?.settings?.pausedReceiving ?? false,
        ...(environmentKeys.length > 0 && { bootConfiguration: { version: Version.$1, environmentKeys } }),
      };
      status = await configureBuddyBackup({ buddySettingsDto });
      settingsOpen = false;
      step = 1;
    });
  const pair = (accept: boolean) =>
    action(async () => {
      if (!status?.settings) {
        return;
      }
      const common = {
        version: 1 as const,
        instanceId: status.instanceId,
        quotaBytes: status.settings.quotaBytes,
        retention: { days: 30 as const, monthly: 12 as const },
      };
      if (accept) {
        let token = invitation.trim();
        try {
          const url = new URL(token);
          token = url.searchParams.get('invite') ?? url.hash.slice(1);
        } catch {
          /* a copied invitation code is also accepted */
        }
        status = await acceptBackupBuddy({ buddyAcceptDto: { ...common, token } });
        step = 2;
      } else {
        const invite = await inviteBackupBuddy({ buddyInviteDto: { ...common, targetAccountId: buddyAccount.trim() } });
        invitationLink = `https://frameleaf.cloud/buddy?invite=${encodeURIComponent(invite.token)}`;
        notice = $t('frameleaf_buddy_send_this_private_invitation_to_your_buddy_it_expires_in_24_hours');
      }
    });
  const savePackage = (value: unknown, filename: string) => {
    const url = URL.createObjectURL(new Blob([JSON.stringify(value, null, 2)], { type: 'application/json' }));
    const link = document.createElement('a');
    link.href = url;
    link.download = filename;
    link.click();
    setTimeout(() => URL.revokeObjectURL(url), 1000);
  };
  const wrapKit = () =>
    action(async () => {
      if (passphrase !== repeatPassphrase) {
        throw new Error($t('frameleaf_buddy_the_passphrases_do_not_match'));
      }
      try {
        const encrypted = await wrapBuddyRecoveryKit({ buddyEscrowWrapDto: { passphrase } });
        savePackage(encrypted, `frameleaf-buddy-escrow-${encrypted.vaultId}.json`);
        notice = $t(
          'frameleaf_buddy_upload_this_encrypted_package_on_the_buddy_page_in_your_cloud_account_keep_the_pas',
        );
      } finally {
        passphrase = '';
        repeatPassphrase = '';
      }
    });
  const unlockKit = (file: File | undefined) =>
    action(async () => {
      if (!file) {
        return;
      }
      if (file.size > 40 * 1024) {
        throw new Error($t('frameleaf_buddy_choose_an_encrypted_recovery_package_under_40_kib'));
      }
      try {
        const escrow = JSON.parse(await file.text()) as BuddyEscrowDto;
        status = await unlockBuddyRecoveryKit({ buddyEscrowImportDto: { escrow, passphrase } });
        notice = $t('frameleaf_buddy_recovery_package_unlocked_and_imported_on_this_server');
      } finally {
        passphrase = '';
        repeatPassphrase = '';
      }
    });
  const saveKit = () => {
    if (!kit) {
      return;
    }
    savePackage(kit, `frameleaf-buddy-recovery-${kit.vaultId}.json`);
    kitSaved = true;
  };
  const readKit = async (file: File | undefined, recovering = false) =>
    action(async () => {
      if (!file) {
        return;
      }
      if (file.size > 64 * 1024) {
        throw new Error($t('frameleaf_buddy_choose_a_frameleaf_buddy_recovery_kit_under_64_kib'));
      }
      const buddyKitDto = JSON.parse(await file.text()) as BuddyKitDto;
      status = recovering
        ? await importBuddyRecoveryKit({ buddyKitDto })
        : await verifyBuddyRecoveryKit({ buddyKitDto });
      kit = null;
      kitSaved = false;
      step = 4;
      notice = recovering
        ? $t('frameleaf_buddy_recovery_kit_imported_your_restore_points_are_available_below')
        : $t('frameleaf_buddy_your_saved_recovery_kit_is_verified');
    });
  const control = (value: BuddyControlAction) =>
    action(async () => {
      status = await controlBuddyBackup({ buddyControlDto: { action: value } });
    });
  const confirm = () =>
    action(async () => {
      if (confirmAction === 'rotate') {
        kit = await rotateBuddyRecoveryKit();
        setup = true;
        step = 3;
      } else if (confirmAction === 'restart') {
        status = await controlBuddyBackup({ buddyControlDto: { action: BuddyControlAction.Restart } });
      } else if (confirmAction) {
        status = await changeBuddyRelationship({
          buddyRelationshipDto: {
            action: confirmAction === 'end' ? BuddyRelationshipAction.End : BuddyRelationshipAction.Block,
          },
        });
      }
      confirmAction = null;
      await load();
    });
  onMount(() => {
    const stopCloud = cloudManager.listen();
    void action(load);
    const timer = setInterval(() => {
      if (!document.hidden && !busy) {
        void load().catch(() => {});
      }
    }, 15_000);
    return () => {
      clearInterval(timer);
      stopCloud();
      kit = null;
      passphrase = '';
      repeatPassphrase = '';
    };
  });
</script>

<div class="frameleaf-cloud buddy" class:status-grid={view === 'status'} data-section="buddy-backup">
  {#if failure}<p class="fc-notice is-error" role="alert">{failure}</p>{/if}
  {#if notice}<p class="fc-notice" role="status">{notice}</p>{/if}
  {#if !status}<p role="status">{$t('frameleaf_buddy_loading_buddy_backup')}</p>
  {:else}
    {#if !status.enabled}<p class="fc-notice">
        {$t('frameleaf_buddy_new_buddy_backups_are_not_enabled_on_this_server_existing_restore_points_remain_av')}
      </p>{/if}
    {#if showStatus || !status.pairing}
      <CloudCard
        title={$t('frameleaf_buddy_my_backup')}
        description={$t(
          'frameleaf_buddy_an_encrypted_copy_of_your_library_on_your_buddy_s_frameleaf_server_cloud_backup_ca',
        )}
        status={$t(presentation.outgoing)}
        tone={!presentation.send || status.run?.state === 'incomplete'
          ? 'warning'
          : status.lastCompleteAt
            ? 'ok'
            : 'muted'}
      >
        {#if !status.pairing}
          {#if !linked}<p class="fc-notice">{$t('frameleaf_buddy_link_required')}</p>
          {:else if !entitled}<p class="fc-notice">{$t('frameleaf_buddy_subscription_required')}</p>{/if}
          <p class="explain">
            {$t('frameleaf_buddy_pair_two_cloud_linked_frameleaf_servers_each_owner_chooses_how_much_storage_to_off')}
          </p>
          <Button variant="primary" disabled={busy || !status.enabled || !entitled} onclick={beginSetup}
            >{$t('frameleaf_buddy_set_up_buddy_backup')}</Button
          >
        {:else}
          <dl class="facts">
            <div>
              <dt>{$t('frameleaf_buddy_last_complete_restore_point')}</dt>
              <dd>{formatTime(status.lastCompleteAt)}</dd>
            </div>
            <div>
              <dt>{$t('frameleaf_buddy_last_successful_recovery_check')}</dt>
              <dd>{formatTime(status.lastVerifiedAt)}</dd>
            </div>
            <div>
              <dt>{$t('frameleaf_buddy_storage_offered_by_your_buddy')}</dt>
              <dd>{bytes(mine?.quotaBytes ?? 0)}</dd>
            </div>
            <div>
              <dt>{$t('frameleaf_buddy_connection')}</dt>
              <dd>{status.connection ?? $t('frameleaf_buddy_waiting_for_a_transfer')}</dd>
            </div>
            <div>
              <dt>{$t('frameleaf_buddy_transfer_speed')}</dt>
              <dd>{status.transferMbps.toFixed(1)} Mbit/s</dd>
            </div>
            <div>
              <dt>{$t('frameleaf_buddy_objects_pending')}</dt>
              <dd>{status.pendingObjects}</dd>
            </div>
            <div>
              <dt>{$t('frameleaf_buddy_reported_available_capacity')}</dt>
              <dd>
                {status.availableBytes === null
                  ? $t('frameleaf_buddy_waiting_for_your_buddy_s_report')
                  : bytes(status.availableBytes)}
              </dd>
            </div>
            <div>
              <dt>{$t('frameleaf_buddy_recovery_kit')}</dt>
              <dd>
                {status.recoveryVerified
                  ? $t('frameleaf_buddy_saved_and_verified')
                  : $t('frameleaf_buddy_verification_required')}
              </dd>
            </div>
          </dl>
          {#if status.run}
            <progress
              max={status.run.objects || 1}
              value={status.run.uploadedObjects}
              aria-label={$t('frameleaf_buddy_backup_progress')}
            ></progress>
            <p>
              {$t('frameleaf_buddy_checked_of_total_objects_checked_sent_sent', {
                values: {
                  checked: status.run.uploadedObjects,
                  total: status.run.objects,
                  sent: bytes(status.run.uploadedBytes),
                },
              })}
            </p>
            {#if status.run.error}<p role="status">{status.run.error}</p>{/if}
          {/if}
          <div class="actions">
            <Button
              variant="primary"
              disabled={busy || !presentation.send}
              onclick={() => control(BuddyControlAction.Start)}>{$t('frameleaf_buddy_back_up_now')}</Button
            >
            <Button
              disabled={busy || (!!status.settings?.pausedSending && !presentation.send)}
              onclick={() =>
                control(
                  status?.settings?.pausedSending ? BuddyControlAction.ResumeSending : BuddyControlAction.PauseSending,
                )}
              >{status.settings?.pausedSending
                ? $t('frameleaf_buddy_resume_sending')
                : $t('frameleaf_buddy_pause_sending')}</Button
            >
            <Button
              disabled={busy || !presentation.read || !status.lastCompleteAt}
              onclick={() => control(BuddyControlAction.Verify)}>{$t('frameleaf_buddy_verify_recovery')}</Button
            >
            <Button
              disabled={busy}
              onclick={() => {
                setup = true;
                step = status?.pairing?.state === 'pending' ? 2 : 3;
              }}>{$t('frameleaf_buddy_recovery_kit_pairing')}</Button
            >
          </div>
        {/if}
      </CloudCard>
    {/if}

    {#if showRecovery}
      {#if presentation.read}<BuddyRestoreSection admin />
      {:else}<p class="fc-notice">{$t('frameleaf_backup_recovery_unavailable')}</p>{/if}
      <CloudCard
        title={$t('frameleaf_backup_replacement')}
        description={$t('frameleaf_backup_replacement_description')}
      >
        <p>
          <a href="https://frameleaf.cloud/buddy" target="_blank" rel="noreferrer"
            >{$t('frameleaf_buddy_open_buddy_backup_in_your_cloud_account')}</a
          >
        </p>
        <Button
          disabled={busy}
          onclick={() =>
            action(async () => {
              status = await refreshBuddyBackup();
            })}>{$t('frameleaf_backup_refresh_authorization')}</Button
        >
      </CloudCard>
    {/if}

    {#if showStatus || showControls}
      <CloudCard
        title={$t('frameleaf_buddy_hosting_for_my_buddy')}
        description={$t(
          'frameleaf_buddy_only_encrypted_storage_is_visible_here_your_buddy_s_filenames_albums_and_photos_st',
        )}
        status={$t(presentation.incoming)}
      >
        <dl class="facts">
          <div>
            <dt>{$t('frameleaf_buddy_disk_used')}</dt>
            <dd>{bytes(status.hosting.committedBytes)}</dd>
          </div>
          <div>
            <dt>{$t('frameleaf_buddy_reserved_for_transfers')}</dt>
            <dd>{bytes(status.hosting.reservedBytes)}</dd>
          </div>
          <div>
            <dt>{$t('frameleaf_buddy_storage_you_offer')}</dt>
            <dd>{bytes(hosted?.quotaBytes ?? status.hosting.quotaBytes)}</dd>
          </div>
          <div>
            <dt>{$t('frameleaf_buddy_retention')}</dt>
            <dd>{$t('frameleaf_buddy_30_days_12_monthly_points_and_the_latest_complete_backup')}</dd>
          </div>
        </dl>
        {#if (hosted?.quotaBytes ?? status.hosting.quotaBytes) > 0}<meter
            min="0"
            max={hosted?.quotaBytes ?? status.hosting.quotaBytes}
            value={status.hosting.committedBytes + status.hosting.reservedBytes}
            aria-label={$t('frameleaf_backup_hosting_meter')}
          ></meter>{/if}
        <div class="actions">
          <Button
            disabled={busy}
            onclick={() => {
              editSettings();
              settingsOpen = true;
            }}>{$t('frameleaf_buddy_hosting_transfer_settings')}</Button
          >
          {#if status.configured}<Button
              disabled={busy || (!!status.settings?.pausedReceiving && !presentation.write)}
              onclick={() =>
                control(
                  status?.settings?.pausedReceiving
                    ? BuddyControlAction.ResumeReceiving
                    : BuddyControlAction.PauseReceiving,
                )}
              >{status.settings?.pausedReceiving
                ? $t('frameleaf_buddy_resume_receiving')
                : $t('frameleaf_buddy_pause_receiving')}</Button
            >{/if}
        </div>
      </CloudCard>
    {/if}

    {#if showStatus && status.pairing}
      <p>
        <a href={commandCenterUrl('backups', undefined, { backupView: 'restore' })}>{$t('frameleaf_backup_recover')}</a>
        ·
        <a href={commandCenterUrl('backups', undefined, { backupView: 'controls' })}
          >{$t('frameleaf_backup_controls')}</a
        >
      </p>
    {/if}

    {#if status.pairing && (showControls || showRecovery)}<details open>
        <summary>{$t('frameleaf_buddy_pairing_and_recovery_controls')}</summary>
        <p>
          {$t('frameleaf_buddy_ending_a_pairing_stops_uploads_and_keeps_restore_access_for_30_days_blocking_revok')}
        </p>
        {#if showControls}<div class="actions">
            <Button disabled={busy || !presentation.send} onclick={() => (confirmAction = 'restart')}
              >{$t('frameleaf_buddy_restart_incomplete_backup')}</Button
            >
            <Button disabled={busy || !presentation.send} onclick={() => (confirmAction = 'rotate')}
              >{$t('frameleaf_buddy_rotate_encryption_key')}</Button
            >
            <Button
              variant="danger"
              disabled={busy || status.pairing.state === 'ended' || status.pairing.state === 'blocked'}
              onclick={() => (confirmAction = 'end')}>{$t('frameleaf_buddy_end_pairing')}</Button
            >
            <Button
              variant="danger"
              disabled={busy || status.pairing.state === 'blocked'}
              onclick={() => (confirmAction = 'block')}>{$t('frameleaf_buddy_block_access_now')}</Button
            >
          </div>{/if}
        <label
          >{$t('frameleaf_buddy_import_a_saved_recovery_kit')}<input
            type="file"
            accept="application/json,.json"
            onchange={(event) => readKit(event.currentTarget.files?.[0], true)}
            disabled={busy}
          /></label
        >
        <p>
          <a href="https://frameleaf.cloud/buddy" target="_blank" rel="noreferrer"
            >{$t('frameleaf_buddy_open_buddy_backup_in_your_cloud_account')}</a
          >
        </p>
        <p>{$t('frameleaf_buddy_for_a_replacement_server_sign_in_to_cloud_and_rebind_the_pairing_before_importing')}</p>
        <fieldset>
          <legend>{$t('frameleaf_buddy_encrypted_recovery_package')}</legend>
          <p>
            {$t('frameleaf_buddy_wrapping_and_unlocking_happen_on_this_frameleaf_server_cloud_stores_only_the_encry')}
          </p>
          <label
            >{$t('frameleaf_buddy_recovery_passphrase')}<input
              type="password"
              minlength="12"
              maxlength="1024"
              autocomplete="off"
              bind:value={passphrase}
            /></label
          >
          {#if status.keyFingerprint}<label
              >{$t('frameleaf_buddy_repeat_passphrase')}<input
                type="password"
                minlength="12"
                maxlength="1024"
                autocomplete="off"
                bind:value={repeatPassphrase}
              /></label
            >
            <Button disabled={busy || passphrase.length < 12 || passphrase !== repeatPassphrase} onclick={wrapKit}
              >{$t('frameleaf_buddy_save_encrypted_package_for_cloud')}</Button
            >{/if}
          <label
            >{$t('frameleaf_buddy_unlock_a_package_downloaded_from_cloud')}<input
              type="file"
              accept="application/json,.json"
              disabled={busy || passphrase.length < 12}
              onchange={(event) => unlockKit(event.currentTarget.files?.[0])}
            /></label
          >
        </fieldset>
      </details>{/if}
  {/if}
</div>

{#snippet coverageSummary()}
  {#if coverage}
    <dl class="facts">
      <div>
        <dt>{$t('frameleaf_buddy_original_estimate')}</dt>
        <dd>
          {bytes(coverage.originalBytes)} · {coverage.items.toLocaleString($locale)}
          {$t('frameleaf_buddy_items')}
        </dd>
      </div>
      <div>
        <dt>{$t('frameleaf_buddy_database_estimate')}</dt>
        <dd>{bytes(coverage.databaseBytes)}</dd>
      </div>
      <div>
        <dt>{$t('frameleaf_buddy_staging_capacity')}</dt>
        <dd>{bytes(coverage.stagingAvailableBytes)}</dd>
      </div>
      {#if coverage.hostingAvailableBytes !== null}<div>
          <dt>{$t('frameleaf_buddy_hosting_capacity')}</dt>
          <dd>{bytes(coverage.hostingAvailableBytes)}</dd>
        </div>{/if}
    </dl>
    <p>{$t('frameleaf_buddy_estimate_detail')}</p>
    {#if coverage.unknownSizes}<p class="fc-notice">
        {$t('frameleaf_buddy_unknown_sizes', { values: { count: coverage.unknownSizes } })}
      </p>{/if}
    <ul class="coverage">
      {#each [...coverage.mounts, ...coverage.configurationFiles] as entry, index (`${index}:${entry.path}`)}
        <li>
          <span class="identifier">{entry.path}</span> — {entry.available
            ? $t('frameleaf_buddy_accessible')
            : $t('frameleaf_buddy_unavailable')}
        </li>
      {/each}
    </ul>
    {#if mine && coverage.originalBytes > mine.quotaBytes}<p class="fc-notice">
        {$t('frameleaf_buddy_capacity_too_small')}
      </p>{/if}
  {/if}
{/snippet}

{#snippet storageForm()}
  <div class="buddy form">
    {@render coverageSummary()}
    <label
      >{$t('frameleaf_buddy_dedicated_hosting_directory')}<input
        bind:value={directory}
        placeholder="/buddy-backups"
        required
      /></label
    >
    <p>{$t('frameleaf_buddy_choose_an_empty_directory_outside_all_photo_and_external_library_paths_receiving_s')}</p>
    <label
      >{$t('frameleaf_buddy_storage_to_offer_gib')}<input
        type="number"
        min="10"
        max="8388608"
        bind:value={quotaGiB}
        required
      /></label
    >
    <div class="columns">
      <label
        >{$t('frameleaf_buddy_upload_limit_mbit_s')}<input
          type="number"
          min="1"
          max="10000"
          bind:value={upload}
        /></label
      >
      <label
        >{$t('frameleaf_buddy_download_limit_mbit_s')}<input
          type="number"
          min="1"
          max="10000"
          bind:value={download}
        /></label
      >
    </div>
    <label
      >{$t('frameleaf_buddy_schedule')}<select bind:value={schedule}
        ><option value="0 2 * * *">{$t('frameleaf_buddy_every_night_at_02_00')}</option><option value="0 */6 * * *"
          >{$t('frameleaf_buddy_every_six_hours')}</option
        ><option value="0 2 * * 0">{$t('frameleaf_buddy_sunday_at_02_00')}</option></select
      ></label
    >
    <label>{$t('frameleaf_buddy_timezone')}<input bind:value={timezone} /></label>
    <div class="columns">
      <label>{$t('frameleaf_buddy_transfer_window_starts')}<input type="time" bind:value={windowStart} /></label><label
        >{$t('frameleaf_buddy_ends')}<input type="time" bind:value={windowEnd} /></label
      >
    </div>
    <p>{$t('frameleaf_buddy_matching_start_and_end_times_allow_transfers_all_day_restores_take_priority_and_us')}</p>
    <label
      >{$t('frameleaf_buddy_deployment_configuration_files_one_absolute_path_per_line')}<textarea
        rows="3"
        bind:value={configurationFiles}></textarea></label
    >
    <p>{$t('frameleaf_buddy_all_users_media_metadata_the_database_frameleaf_settings_preferences_and_locally_c')}</p>
    <label
      >{$t('frameleaf_buddy_deployment_settings_and_secrets')}<select multiple size="6" bind:value={environmentKeys}>
        {#each Object.values(EnvironmentKeys) as key (key)}<option value={key}>{key}</option>{/each}
      </select></label
    >
    <p>{$t('frameleaf_buddy_deployment_settings_help')}</p>
    <label class="check"
      ><input type="checkbox" bind:checked={includeDerived} />{$t(
        'frameleaf_buddy_also_include_thumbnails_and_transcoded_copies',
      )}</label
    >
    <Button
      disabled={busy}
      onclick={() =>
        action(async () => {
          await checkCoverage();
        })}>{$t('frameleaf_buddy_check_coverage')}</Button
    >
    <Button variant="primary" disabled={busy || !directory || !quotaGiB} onclick={saveSettings}
      >{$t('frameleaf_buddy_save_hosting_settings')}</Button
    >
  </div>
{/snippet}

<Dialog
  bind:open={settingsOpen}
  title={$t('frameleaf_buddy_hosting_transfer_settings')}
  closeLabel={$t('frameleaf_buddy_close_settings')}>{@render storageForm()}</Dialog
>
<Dialog
  bind:open={setup}
  title={$t('frameleaf_buddy_set_up_buddy_backup')}
  closeLabel={$t('frameleaf_buddy_close_setup')}
  wide
>
  <div class="buddy form">
    <p class="step" aria-live="polite">
      {[
        $t('frameleaf_buddy_1_choose_storage'),
        $t('frameleaf_buddy_2_invite_your_buddy'),
        $t('frameleaf_buddy_3_confirm_your_agreement'),
        $t('frameleaf_buddy_4_save_your_recovery_kit'),
        $t('frameleaf_buddy_5_check_the_connection'),
      ][step]}
    </p>
    {#if failure}<p role="alert" class="fc-notice is-error">{failure}</p>{/if}
    {#if step === 0}{@render storageForm()}
    {:else if step === 1}
      <p>{$t('frameleaf_buddy_both_servers_need_a_compatible_frameleaf_version_cloud_sign_in_and_an_active_subsc')}</p>
      <p>
        {$t('frameleaf_buddy_find_your_account_id_and_pending_invitations_on_the')}<a
          href="https://frameleaf.cloud/buddy"
          target="_blank"
          rel="noreferrer">{$t('frameleaf_buddy_cloud_buddy_page')}</a
        >.
      </p>
      <label
        >{$t('frameleaf_buddy_your_buddy_s_cloud_account_id')}<input
          bind:value={buddyAccount}
          autocomplete="off"
        /></label
      >
      <Button disabled={busy || !buddyAccount} onclick={() => pair(false)}
        >{$t('frameleaf_buddy_create_invitation')}</Button
      >
      {#if invitationLink}<label
          >{$t('frameleaf_buddy_private_invitation_link')}<input readonly value={invitationLink} /></label
        >
        <p>
          {$t('frameleaf_buddy_your_buddy_can_open_this_cloud_invitation_or_paste_it_into_buddy_backup_on_their_o')}
        </p>{/if}
      <label
        >{$t('frameleaf_buddy_invitation_from_your_buddy')}<input bind:value={invitation} autocomplete="off" /></label
      ><Button disabled={busy || !invitation} onclick={() => pair(true)}
        >{$t('frameleaf_buddy_accept_invitation')}</Button
      >
      <Button
        disabled={busy}
        onclick={() =>
          action(async () => {
            status = await refreshBuddyBackup();
            if (status.pairing) {
              step = 2;
            }
          })}>{$t('frameleaf_buddy_check_for_acceptance')}</Button
      >
    {:else if step === 2}
      {@render coverageSummary()}
      <p>{$t('frameleaf_buddy_confirm_the_other_server_and_key_with_your_buddy_before_continuing_storage_contrib')}</p>
      {#if mine && hosted}<dl class="facts">
          <div>
            <dt>{$t('frameleaf_buddy_buddy_server')}</dt>
            <dd class="identifier">{mine.destinationInstanceId}</dd>
          </div>
          <div>
            <dt>{$t('frameleaf_buddy_buddy_identity_key')}</dt>
            <dd class="identifier">{mine.destinationKey.x}</dd>
          </div>
          <div>
            <dt>{$t('frameleaf_buddy_they_host_for_you')}</dt>
            <dd>{bytes(mine.quotaBytes)}</dd>
          </div>
          <div>
            <dt>{$t('frameleaf_buddy_you_host_for_them')}</dt>
            <dd>{bytes(hosted.quotaBytes)}</dd>
          </div>
        </dl>{/if}
      <p>{$t('frameleaf_buddy_each_direction_keeps_30_days_and_12_monthly_restore_points_both_sides_enforce_thei')}</p>
      <Button
        variant="primary"
        disabled={busy || !status?.pairing}
        onclick={() =>
          action(async () => {
            if (status?.pairing?.state !== 'active') {
              status = await changeBuddyRelationship({
                buddyRelationshipDto: { action: BuddyRelationshipAction.Confirm },
              });
            }
            step = 3;
          })}>{$t('frameleaf_buddy_confirm_agreement')}</Button
      >
    {:else if step === 3}
      <p>{$t('frameleaf_buddy_this_recovery_kit_unlocks_your_backups_save_it_somewhere_other_than_this_server_th')}</p>
      {#if !kit}<Button
          disabled={busy || !!status?.keyFingerprint}
          onclick={() =>
            action(async () => {
              kit = await generateBuddyRecoveryKit();
            })}>{$t('frameleaf_buddy_generate_recovery_kit')}</Button
        >{/if}
      {#if kit}<Button variant="primary" onclick={saveKit}>{$t('frameleaf_buddy_save_recovery_kit')}</Button>{/if}
      <label
        >{$t('frameleaf_buddy_verify_the_saved_kit')}<input
          type="file"
          accept="application/json,.json"
          disabled={busy || (!!kit && !kitSaved)}
          onchange={(event) => readKit(event.currentTarget.files?.[0])}
        /></label
      >
      {#if status?.recoveryVerified}<Button onclick={() => (step = 4)}>{$t('frameleaf_buddy_continue')}</Button>{/if}
    {:else}
      <p>{$t('frameleaf_buddy_send_a_small_encrypted_file_download_it_and_verify_it_before_the_first_library_bac')}</p>
      <Button
        variant="primary"
        disabled={busy || !presentation.send}
        onclick={() =>
          action(async () => {
            await testBuddyBackup();
            status = await controlBuddyBackup({ buddyControlDto: { action: BuddyControlAction.Start } });
            setup = false;
            notice = $t('frameleaf_buddy_the_encrypted_connection_is_verified_your_initial_backup_is_queued');
          })}>{$t('frameleaf_buddy_verify_connection_start_backup')}</Button
      >
    {/if}
  </div>
</Dialog>
<Dialog
  open={confirmAction !== null}
  title={$t('frameleaf_buddy_confirm_buddy_backup_change')}
  closeLabel={$t('frameleaf_buddy_cancel')}
  onRequestClose={() => (confirmAction = null)}
>
  <div class="buddy form">
    <p>
      {confirmAction === 'block'
        ? $t('frameleaf_buddy_block_all_peer_access_immediately_the_encrypted_vault_stays_on_disk')
        : confirmAction === 'end'
          ? $t('frameleaf_buddy_end_this_pairing_uploads_stop_now_restore_access_lasts_30_days')
          : confirmAction === 'rotate'
            ? $t('frameleaf_buddy_generate_a_new_key_version_save_and_verify_the_replacement_kit_which_also_contains')
            : $t('frameleaf_buddy_abandon_the_incomplete_run_and_rescan_complete_restore_points_stay_protected_and_v')}
    </p>
    <div class="actions">
      <Button onclick={() => (confirmAction = null)}>{$t('frameleaf_buddy_cancel')}</Button><Button
        variant="danger"
        disabled={busy}
        onclick={confirm}>{$t('frameleaf_buddy_confirm')}</Button
      >
    </div>
  </div>
</Dialog>

<style>
  .buddy {
    color: var(--fl-text);
  }
  .status-grid {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    align-items: start;
    gap: 1rem;
  }
  .status-grid > p {
    grid-column: 1 / -1;
  }
  .buddy :global(.fc-card) {
    margin-bottom: 1rem;
  }
  .explain,
  .buddy p {
    max-width: 68ch;
    line-height: 1.55;
    margin: 0.75rem 0;
    color: var(--fl-muted);
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(2, minmax(0, 1fr));
    gap: 1rem;
    margin: 1.25rem 0;
  }
  .facts dt {
    color: var(--fl-muted);
    font-size: 0.8125rem;
    margin-bottom: 0.25rem;
  }
  .facts dd {
    margin: 0;
    font-size: 0.9375rem;
    font-weight: 550;
  }
  .identifier {
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: 0.5rem;
    margin-top: 1rem;
  }
  .form {
    display: grid;
    gap: 1rem;
    padding: 1.25rem;
  }
  .form .form {
    padding: 0;
  }
  label {
    display: grid;
    gap: 0.4rem;
    font-size: 0.875rem;
  }
  input:not([type='checkbox']),
  select,
  textarea {
    width: 100%;
    min-height: 2.75rem;
    padding: 0.625rem;
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .columns {
    display: grid;
    grid-template-columns: 1fr 1fr;
    gap: 1rem;
  }
  .check {
    display: flex;
    align-items: center;
    gap: 0.5rem;
  }
  .step {
    color: var(--fl-text) !important;
    font-weight: 600;
  }
  progress,
  meter {
    width: 100%;
    height: 0.6rem;
    accent-color: var(--fl-accent);
  }
  details {
    margin: 1rem 0;
    padding: 1rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  summary {
    cursor: pointer;
    min-height: 2.75rem;
    align-content: center;
  }
  @media (max-width: 600px) {
    .status-grid,
    .facts,
    .columns {
      grid-template-columns: 1fr;
    }
  }
</style>
