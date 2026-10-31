<script lang="ts">
  import { t } from 'svelte-i18n';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import CloudCard from '$lib/components/frameleaf/cloud/CloudCard.svelte';
  import { formatDateTime } from '$lib/frameleaf/cloud-ml';
  import { locale } from '$lib/stores/preferences.store';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { getServerErrorMessage } from '$lib/utils/handle-error';
  import {
    applyBuddyRecovery,
    browseBuddyBackup,
    browseOwnBuddyBackup,
    getBuddyRestoreStatus,
    getOwnBuddyRestoreStatus,
    getBuddyRestoreCheckpoint,
    getOwnBuddyRestoreCheckpoint,
    listBuddyBackupSnapshots,
    listOwnBuddySnapshots,
    restoreBuddyBackup,
    restoreOwnBuddyBackup,
    type BuddyBrowseDto,
    type BuddyRestoreDto,
    type BuddyRestoreResponseDto,
    type BuddyRestoreStatusDto,
    type BuddySnapshotListDto,
  } from '@frameleaf/sdk';
  import { onDestroy } from 'svelte';

  let { admin = false }: { admin?: boolean } = $props();
  let open = $state(false);
  let busy = $state(false);
  let failure = $state('');
  let snapshots = $state<BuddySnapshotListDto['snapshots']>([]);
  let nextOffset = $state<number | null>(null);
  let chosen = $state('');
  let items = $state<BuddyBrowseDto | null>(null);
  let selected = $state<string[]>([]);
  let scope = $state('asset');
  let album = $state('');
  let mode = $state('keep');
  let preview = $state<BuddyRestoreResponseDto | null>(null);
  let progress = $state<BuddyRestoreStatusDto | null>(null);
  let confirmation = $state('');
  let timer: ReturnType<typeof setTimeout> | undefined;
  const act = async (run: () => Promise<void>) => {
    busy = true;
    failure = '';
    try {
      await run();
    } catch (error) {
      failure =
        getServerErrorMessage(error) ??
        (error instanceof Error
          ? error.message
          : $t('frameleaf_buddy_this_restore_is_unavailable_unlock_your_pin_and_try_again'));
    } finally {
      busy = false;
    }
  };
  const browse = async (offset = 0) => {
    items = await (admin ? browseBuddyBackup : browseOwnBuddyBackup)({ id: chosen, offset });
    preview = null;
  };
  const launch = () =>
    act(async () => {
      progress = (await (admin ? getBuddyRestoreCheckpoint : getOwnBuddyRestoreCheckpoint)()).operation;
      if (
        progress &&
        (progress.phase === 'ready-to-apply' || !['completed', 'failed', 'cancelled'].includes(progress.state))
      ) {
        open = true;
        await poll(progress.id);
        return;
      }
      progress = null;
      clearTimeout(timer);
      const page = await (admin ? listBuddyBackupSnapshots : listOwnBuddySnapshots)({ offset: 0 });
      snapshots = page.snapshots;
      nextOffset = page.nextOffset;
      chosen = snapshots[0]?.id ?? '';
      selected = [];
      preview = null;
      confirmation = '';
      open = true;
      if (chosen) {
        await browse();
      }
    });
  const older = () =>
    act(async () => {
      if (nextOffset === null) {
        return;
      }
      const page = await (admin ? listBuddyBackupSnapshots : listOwnBuddySnapshots)({ offset: nextOffset });
      const known = new Set(snapshots.map((snapshot) => snapshot.id));
      snapshots = [...snapshots, ...page.snapshots.filter((snapshot) => !known.has(snapshot.id))];
      nextOffset = page.nextOffset;
      if (!chosen && snapshots[0]) {
        chosen = snapshots[0].id;
        await browse();
      }
    });
  const poll = async (id: string) => {
    try {
      progress = await (admin ? getBuddyRestoreStatus : getOwnBuddyRestoreStatus)({ id });
      if (!['completed', 'failed', 'cancelled'].includes(progress.state)) {
        timer = setTimeout(() => void poll(id), 15_000);
      }
    } catch {
      failure = $t('frameleaf_buddy_restore_status_is_unavailable_unlock_your_pin_and_refresh_the_verified_checkpoint');
    }
  };
  const request = (confirm = false) =>
    act(async () => {
      const buddyRestoreDto = {
        snapshotId: chosen,
        scope,
        ...(scope === 'asset' && { assetIds: selected }),
        ...(scope === 'album' && { albumId: album }),
        mode,
        confirm,
      } as BuddyRestoreDto;
      preview = await (admin ? restoreBuddyBackup : restoreOwnBuddyBackup)({ buddyRestoreDto });
      if (preview.operationId) {
        clearTimeout(timer);
        await poll(preview.operationId);
      }
    });
  const apply = () =>
    act(async () => {
      if (!progress?.recoveryId || confirmation !== 'RESTORE') {
        return;
      }
      const result = await applyBuddyRecovery({ buddyApplyDto: { operationId: progress.recoveryId, confirm: true } });
      location.assign(`/maintenance?token=${encodeURIComponent(result.jwt)}`);
    });
  onDestroy(() => clearTimeout(timer));
</script>

<CloudCard
  title={$t('frameleaf_buddy_restore_from_buddy_backup')}
  description={admin
    ? $t('frameleaf_buddy_recover_selected_photos_an_album_your_library_settings_or_the_entire_server')
    : $t('frameleaf_buddy_recover_your_own_photos_and_albums_from_a_dated_backup_unlock_your_pin_to_continue')}
>
  {#if failure}<p role="alert" class="error">{failure}</p>{/if}
  <Button disabled={busy} onclick={launch}>{$t('frameleaf_buddy_choose_a_restore_point')}</Button>
  {#if progress}<p role="status">
      {progress.phase === 'ready-to-apply'
        ? $t('frameleaf_buddy_verified_and_staged_apply_this_recovery_to_continue')
        : $t('frameleaf_buddy_restore_state', { values: { state: progress.state } })}
    </p>
    <progress max="100" value={progress.progress ?? 0} aria-label={$t('frameleaf_buddy_restore_progress')}></progress>
    {#if progress.error}<p role="alert" class="error">{progress.error}</p>{/if}
  {/if}
</CloudCard>

<Dialog
  bind:open
  title={$t('frameleaf_buddy_restore_from_buddy_backup')}
  closeLabel={$t('frameleaf_buddy_close_restore')}
  wide
>
  <div class="restore">
    {#if failure}<p role="alert" class="error">{failure}</p>{/if}
    {#if !progress && nextOffset !== null}<Button disabled={busy} onclick={older}
        >{$t('frameleaf_buddy_older_snapshots')}</Button
      >{/if}
    {#if progress?.phase === 'ready-to-apply'}
      <p>{$t('frameleaf_buddy_the_files_have_been_downloaded_and_verified_applying_this_recovery_closes_the_libr')}</p>
      <p>{$t('frameleaf_buddy_reattach_the_original_storage_mounts_first_existing_overwritten_files_and_the_curr')}</p>
      <label>{$t('frameleaf_buddy_type_restore_to_apply')}<input autocomplete="off" bind:value={confirmation} /></label>
      <Button variant="danger" disabled={busy || confirmation !== 'RESTORE'} onclick={apply}
        >{$t('frameleaf_buddy_enter_maintenance_apply_recovery')}</Button
      >
    {:else if progress && !['completed', 'failed', 'cancelled'].includes(progress.state)}
      <p role="status">{progress.state} · {Math.round(progress.progress ?? 0)}%</p>
      <progress max="100" value={progress.progress ?? 0} aria-label={$t('frameleaf_buddy_restore_progress')}></progress>
      <p>{$t('frameleaf_buddy_you_can_close_this_dialog_verified_progress_survives_a_server_restart')}</p>
    {:else if snapshots.length === 0}<p>
        {$t('frameleaf_buddy_no_accessible_complete_restore_points_are_available_check_your_buddy_s_connection')}
      </p>
    {:else}
      <label
        >{$t('frameleaf_buddy_restore_point')}<select
          bind:value={chosen}
          onchange={() =>
            act(async () => {
              selected = [];
              await browse();
            })}
        >
          {#each snapshots as snapshot (snapshot.id)}<option value={snapshot.id}
              >{formatDateTime(snapshot.createdAt, $locale)}</option
            >{/each}
        </select></label
      >
      <label
        >{$t('frameleaf_buddy_what_to_restore')}<select bind:value={scope} onchange={() => (preview = null)}>
          <option value="asset">{$t('frameleaf_buddy_selected_images_or_videos')}</option><option value="album"
            >{$t('frameleaf_buddy_an_album')}</option
          >
          {#if admin}<option value="library">{$t('frameleaf_buddy_whole_library')}</option><option value="settings"
              >{$t('frameleaf_buddy_settings')}</option
            ><option value="server">{$t('frameleaf_buddy_full_server_recovery')}</option>{/if}
        </select></label
      >
      {#if scope === 'album'}<label
          >{$t('frameleaf_buddy_album')}<select bind:value={album} onchange={() => (preview = null)}
            ><option value="">{$t('frameleaf_buddy_choose_an_album')}</option>
            {#each items?.albums ?? [] as entry (entry.id)}<option value={entry.id}>{entry.name} ({entry.items})</option
              >{/each}</select
          ></label
        >
      {:else if scope === 'asset'}
        <div class="items" role="group" aria-label={$t('frameleaf_buddy_items_to_restore')}>
          {#each items?.items ?? [] as item (item.id)}<label class="item"
              ><input
                type="checkbox"
                checked={selected.includes(item.id)}
                disabled={selected.length >= 100 && !selected.includes(item.id)}
                onchange={() => {
                  selected = selected.includes(item.id)
                    ? selected.filter((id) => id !== item.id)
                    : [...selected, item.id];
                  preview = null;
                }}
              />
              <span>{item.name || $t('frameleaf_buddy_unnamed_item')}</span><small
                >{getByteUnitString(item.bytes)}</small
              ></label
            >{/each}
        </div>
        {#if items?.nextOffset !== null && items?.nextOffset !== undefined}<Button
            disabled={busy}
            onclick={() => act(() => browse(items!.nextOffset!))}>{$t('frameleaf_buddy_next_items')}</Button
          >{/if}
        <p>
          {$t('frameleaf_buddy_count_selected_choose_up_to_100_items_or_restore_a_whole_album', {
            values: { count: selected.length },
          })}
        </p>
      {/if}
      <label
        >{$t('frameleaf_buddy_when_something_already_exists')}<select
          bind:value={mode}
          onchange={() => (preview = null)}
        >
          <option value="keep">{$t('frameleaf_buddy_fill_missing_items_and_keep_current_changes')}</option><option
            value="replace">{$t('frameleaf_buddy_overwrite_and_keep_a_rollback_copy')}</option
          >
        </select></label
      >
      {#if scope === 'server'}<p>
          {$t('frameleaf_buddy_full_server_recovery_replaces_the_database_existing_sessions_and_unfinished_jobs_a')}
        </p>{/if}
      {#if preview}<div class="review" role="status">
          <p>
            {$t('frameleaf_buddy_count_items_bytes_to_verify_conflicts_existing_items', {
              values: { count: preview.items, bytes: getByteUnitString(preview.bytes), conflicts: preview.conflicts },
            })}
          </p>
          {#if preview.metadataItems}<p>
              {$t('frameleaf_backup_restore_metadata', { values: { count: preview.metadataItems } })}
            </p>{/if}
          <p>
            {mode === 'keep'
              ? $t('frameleaf_buddy_current_changes_will_be_preserved')
              : $t('frameleaf_buddy_overwritten_files_will_be_kept_in_rollback_copies')}
            {$t('frameleaf_buddy_partial_restores_keep_current_sharing_permissions')}
          </p>
          <Button
            variant={mode === 'replace' || scope === 'server' ? 'danger' : 'primary'}
            disabled={busy}
            onclick={() => request(true)}
          >
            {scope === 'server' || scope === 'settings'
              ? $t('frameleaf_buddy_download_verify_recovery')
              : $t('frameleaf_buddy_start_restore')}</Button
          >
        </div>
      {:else}<Button
          variant="primary"
          disabled={busy || (scope === 'asset' && selected.length === 0) || (scope === 'album' && !album)}
          onclick={() => request(false)}>{$t('frameleaf_buddy_preview_restore')}</Button
        >{/if}
    {/if}
  </div>
</Dialog>

<style>
  .restore {
    display: grid;
    gap: 1rem;
    padding: 1.25rem;
    color: var(--fl-text);
  }
  p {
    max-width: 68ch;
    line-height: 1.55;
    color: var(--fl-muted);
  }
  label {
    display: grid;
    gap: 0.5rem;
    font-size: 0.875rem;
  }
  select,
  input:not([type='checkbox']) {
    min-height: 2.75rem;
    width: 100%;
    background: var(--fl-raised);
    color: var(--fl-text);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    padding: 0.625rem;
  }
  .items {
    max-height: 19rem;
    overflow: auto;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
  }
  .item {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    min-height: 3rem;
    padding: 0.625rem;
    border-bottom: 1px solid var(--fl-border);
  }
  .item span {
    flex: 1;
    overflow-wrap: anywhere;
  }
  .item small {
    color: var(--fl-muted);
  }
  .review {
    border-top: 1px solid var(--fl-border);
    padding-top: 1rem;
  }
  .error {
    color: var(--fl-danger);
  }
  progress {
    width: 100%;
    accent-color: var(--fl-accent);
  }
</style>
