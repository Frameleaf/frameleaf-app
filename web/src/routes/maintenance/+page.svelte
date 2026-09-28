<script lang="ts">
  /**
   * The maintenance page (FL-80 MS-1, M-1…M-6): the prototype's `MaintenanceSplash`
   * (`design/frameleaf/template/src/AuthScreens.jsx:1291-1381`) in place of the upstream `@immich/ui`
   * page — the heading and reassurance, the administrator's reason, a restore's task list with one
   * overall progress bar, "Checking again in N s · Check now", "End maintenance" with its note for a
   * signed-in administrator, and "Maintenance is finished" with "Open Frameleaf".
   *
   * Kept from the page it replaces: the status is loaded once and then follows the websocket; a
   * running restore also re-reads the status every 2 s (an update sent before the socket joined is
   * lost); the maintenance token is stripped from the address; and an administrator choosing a
   * backup to restore gets `MaintenanceRestoreFlow`. A sign-in link the server refused (expired or
   * from an earlier maintenance) is reported instead of silently showing the public page (FL-81).
   */
  /* eslint-disable unicorn/no-optional-chaining-on-undeclared-variable */
  import { page } from '$app/state';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import MaintenanceRestoreFlow from './MaintenanceRestoreFlow.svelte';
  import { maintenancePageState, type MaintenanceTaskStatus } from '$lib/frameleaf/maintenance-page';
  import { handleSetMaintenanceMode } from '$lib/services/maintenance.service';
  import { maintenanceStore } from '$lib/stores/maintenance.store';
  import { loadMaintenanceStatus, maintenanceReturnUrl } from '$lib/utils/maintenance';
  import { websocketEvents } from '$lib/stores/websocket';
  import { MaintenanceAction } from '@immich/sdk';
  import { Icon } from '@immich/ui';
  import {
    mdiAlertCircleOutline,
    mdiBackupRestore,
    mdiCheckCircle,
    mdiClockOutline,
    mdiCloseCircleOutline,
    mdiInformationOutline,
    mdiLockOpenVariantOutline,
    mdiProgressClock,
    mdiWrenchOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t } from 'svelte-i18n';
  import type { PageData } from './$types';

  type Props = {
    data: PageData;
  };

  const { data }: Props = $props();

  const { auth, status } = maintenanceStore;

  /** The prototype's `refreshSeconds`: how long until the page asks the server again. */
  const REFRESH_SECONDS = 30;

  onMount(() => {
    // One-shot initial load — websocket events take over after that.
    void loadMaintenanceStatus().catch(() => undefined);

    // websocket.ts already sets maintenanceStore.status on this event; listening here as well keeps
    // the page reacting even if that wiring changes.
    const cleanup = websocketEvents.on('MaintenanceStatusV1', (event) => {
      maintenanceStore.status.set(event);
    });

    return () => cleanup();
  });

  const view = $derived(maintenancePageState($status, { signedIn: !!$auth }));

  let loading = false;
  const check = () => {
    if (loading) {
      return;
    }
    loading = true;
    void loadMaintenanceStatus()
      .catch(() => undefined)
      .finally(() => (loading = false));
  };

  // Status is only pushed over the websocket, and an update sent before the socket joins its room
  // is lost, so a restore that fails in that window would show its progress forever. While a
  // restore runs without an error, re-read the status as well.
  const restoreRunning = $derived(view.kind === 'restoring');
  $effect(() => {
    if (!restoreRunning) {
      return;
    }
    const timer = setInterval(check, 2000);
    return () => clearInterval(timer);
  });

  // "Checking again in N s · Check now" while the page waits.
  const waiting = $derived(view.kind === 'maintenance' || view.kind === 'restoring');
  let countdown = $state(REFRESH_SECONDS);
  $effect(() => {
    if (!waiting) {
      return;
    }
    countdown = REFRESH_SECONDS;
    const timer = setInterval(() => {
      if (countdown <= 1) {
        countdown = REFRESH_SECONDS;
        check();
      } else {
        countdown -= 1;
      }
    }, 1000);
    return () => clearInterval(timer);
  });

  const checkNow = () => {
    countdown = REFRESH_SECONDS;
    check();
  };

  // strip token from URL after load
  const url = new URL(location.href);
  if (url.searchParams.get('token')) {
    url.searchParams.delete('token');
    history.replaceState({}, document.title, url);
  }

  const end = () =>
    handleSetMaintenanceMode({
      action: MaintenanceAction.End,
    });

  const openFrameleaf = () => location.assign(maintenanceReturnUrl(page.url.searchParams));

  const taskIcons: Record<MaintenanceTaskStatus, string> = {
    done: mdiCheckCircle,
    running: mdiProgressClock,
    queued: mdiClockOutline,
    standby: mdiBackupRestore,
    failed: mdiCloseCircleOutline,
  };
</script>

<AuthShell withHeader={false}>
  {#if view.kind === 'select-restore'}
    <MaintenanceRestoreFlow {end} expectedVersion={data.expectedVersion} />
  {:else}
    <div class="auth-card">
      <span class="pin-mark">
        <Icon
          icon={view.kind === 'finished'
            ? mdiCheckCircle
            : view.kind === 'restore-failed'
              ? mdiAlertCircleOutline
              : mdiWrenchOutline}
          size="26"
          aria-hidden={true}
        />
      </span>
      <div class="auth-heading">
        {#if view.kind === 'finished'}
          <h1>{$t('frameleaf_maintenance_finished_title')}</h1>
          <p>{$t('frameleaf_maintenance_finished_body')}</p>
        {:else if view.kind === 'restore-failed'}
          <h1>{$t('frameleaf_maintenance_restore_failed_title')}</h1>
          <p>{$t('frameleaf_maintenance_restore_failed_body')}</p>
        {:else if view.kind === 'restoring'}
          <h1>{$t('frameleaf_maintenance_updating_title')}</h1>
          <p>{$t('frameleaf_maintenance_updating_body')}</p>
        {:else}
          <h1>{$t('frameleaf_maintenance_page_title')}</h1>
          <p>{$t('frameleaf_maintenance_page_body')}</p>
        {/if}
      </div>

      {#if $status?.reason && view.kind !== 'finished'}
        <p class="maint-reason">
          <strong>{$t('frameleaf_maintenance_reason')}</strong>
          {$status.reason}
        </p>
      {/if}

      {#if view.kind === 'restoring'}
        <div
          class="fl-bar"
          role="progressbar"
          aria-label={$t('frameleaf_maintenance_progress')}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={view.percent}
        >
          <span style:width="{view.percent}%"></span>
        </div>
        <ul class="maint-tasks">
          {#each view.tasks as task (task.id)}
            <li data-status={task.status}>
              <span class="maint-icon"><Icon icon={taskIcons[task.status]} size="20" aria-hidden={true} /></span>
              <div>
                <strong>{$t(`frameleaf_maintenance_task_${task.id}`)}</strong>
                <span>{$t(`frameleaf_maintenance_task_${task.id}_detail`)}</span>
              </div>
              <span class="maint-pct">{$t(`frameleaf_maintenance_status_${task.status}`)}</span>
            </li>
          {/each}
        </ul>
      {/if}

      {#if view.kind === 'restore-failed'}
        <pre class="maint-error"><code>{view.error}</code></pre>
      {/if}

      {#if waiting}
        <div class="maint-status">
          <span role="status" aria-live="polite">
            {view.kind === 'restoring' && view.current
              ? $t('frameleaf_maintenance_in_progress', {
                  values: { task: $t(`frameleaf_maintenance_task_${view.current}`) },
                })
              : $t('frameleaf_maintenance_waiting')}
          </span>
          <span>
            {$t('frameleaf_maintenance_checking_again', { values: { seconds: countdown } })} ·
            <button type="button" class="auth-link" onclick={checkNow}>{$t('frameleaf_maintenance_check_now')}</button>
          </span>
        </div>
      {/if}

      {#if data.signInLinkRejected && !$auth && view.kind !== 'finished'}
        <p class="auth-error" role="alert">
          <Icon icon={mdiAlertCircleOutline} size="16" aria-hidden={true} />
          <span>{$t('frameleaf_maintenance_link_rejected')}</span>
        </p>
      {/if}

      {#if view.kind === 'maintenance' && $auth}
        <p class="signed-in">{$t('maintenance_logged_in_as', { values: { user: $auth.username } })}</p>
      {/if}

      <div class="maint-actions">
        {#if view.kind === 'finished'}
          <button type="button" class="button primary" onclick={openFrameleaf}
            >{$t('frameleaf_maintenance_open')}</button
          >
        {:else if view.kind === 'restore-failed' || (view.kind === 'maintenance' && $auth)}
          <button type="button" class="button" onclick={end}>
            <Icon icon={mdiLockOpenVariantOutline} size="18" aria-hidden={true} />
            {$t('frameleaf_maintenance_end')}
          </button>
        {/if}
      </div>

      {#if view.kind === 'maintenance' && $auth}
        <p class="auth-info">
          <Icon icon={mdiInformationOutline} size="16" aria-hidden={true} />
          <span>{$t('frameleaf_maintenance_end_note')}</span>
        </p>
      {/if}
    </div>
  {/if}
</AuthShell>

<style>
  .signed-in {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .maint-actions .button {
    display: inline-flex;
    align-items: center;
    gap: 6px;
  }
</style>
