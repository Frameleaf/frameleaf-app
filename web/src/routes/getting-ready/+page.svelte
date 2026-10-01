<script lang="ts">
  /**
   * FL-295: the "Getting Ready…" screen. On the first start on a library the official server created,
   * the server shows only this page while it makes a safety copy of the database before upgrading.
   * Laid out like the maintenance page, the prototype's `MaintenanceSplash`
   * (`design/frameleaf/template/src/AuthScreens.jsx`): the heading and reassurance, one progress bar and
   * the task list (here the copy and the upgrade). It follows the server's status every second and, once
   * the normal server is back, moves on to the page that was asked for (sign-in or setup) by itself.
   */
  import { page } from '$app/state';
  import AuthShell from '$lib/components/frameleaf/AuthShell.svelte';
  import {
    GETTING_READY_POLL_MS,
    advanceGettingReady,
    gettingReadyView,
    pollGettingReady,
    type GettingReadyStatus,
    type GettingReadyTaskStatus,
  } from '$lib/frameleaf/getting-ready';
  import { Route } from '$lib/route';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { Icon } from '@immich/ui';
  import {
    mdiAlertCircleOutline,
    mdiCheckCircle,
    mdiClockOutline,
    mdiCloseCircleOutline,
    mdiDatabaseLockOutline,
    mdiInformationOutline,
    mdiMinus,
    mdiProgressClock,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  let status = $state<GettingReadyStatus | undefined>();
  const view = $derived(gettingReadyView(status));

  /** Where to go once the server is ready: the page that was asked for, never this one again. */
  const continueUrl = () => {
    const target = Route.continue(page.url.searchParams.get('continue'), '/');
    const path = typeof target === 'string' ? target : target.pathname;
    return path.startsWith(Route.gettingReady()) ? '/' : target.toString();
  };

  onMount(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;

    const tick = async () => {
      const next = advanceGettingReady(status, await pollGettingReady());
      if (stopped) {
        return;
      }
      if (next === 'finished') {
        location.assign(continueUrl());
        return;
      }
      status = next;
      timer = setTimeout(() => void tick(), GETTING_READY_POLL_MS);
    };

    void tick();
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  const taskIcons: Record<GettingReadyTaskStatus, string> = {
    done: mdiCheckCircle,
    running: mdiProgressClock,
    queued: mdiClockOutline,
    skipped: mdiMinus,
    failed: mdiCloseCircleOutline,
  };

  const taskStatusLabel = (taskStatus: GettingReadyTaskStatus) =>
    taskStatus === 'skipped'
      ? $t('frameleaf_getting_ready_status_skipped')
      : $t(`frameleaf_maintenance_status_${taskStatus}`);

  const formatDate = (iso: string) => {
    const date = new Date(iso);
    return Number.isNaN(date.getTime())
      ? iso
      : date.toLocaleString($locale ?? undefined, { dateStyle: 'medium', timeStyle: 'short' });
  };

  const bytes = (value: number) => getByteUnitString(value, $locale ?? undefined);

  const statusLine = $derived.by(() => {
    switch (view.kind) {
      case 'working': {
        return view.state === 'backing-up'
          ? $t('frameleaf_getting_ready_state_backing_up')
          : $t('frameleaf_getting_ready_state_checking');
      }
      case 'skipped':
      case 'saved': {
        return $t('frameleaf_getting_ready_state_moving_on');
      }
      case 'finishing': {
        return $t('frameleaf_getting_ready_state_finishing');
      }
      case 'failed': {
        return $t('frameleaf_getting_ready_state_failed');
      }
    }
  });
</script>

<AuthShell withHeader={false}>
  <div class="auth-card getting-ready">
    <span class="pin-mark">
      <Icon
        icon={view.kind === 'failed'
          ? mdiAlertCircleOutline
          : view.kind === 'saved' || view.kind === 'skipped'
            ? mdiCheckCircle
            : mdiDatabaseLockOutline}
        size="26"
        aria-hidden={true}
      />
    </span>
    <div class="auth-heading">
      {#if view.kind === 'failed'}
        <h1>{$t('frameleaf_getting_ready_failed_title')}</h1>
        {#if view.reason === 'disk-space'}
          <p>
            {view.requiredBytes === undefined || view.availableBytes === undefined
              ? $t('frameleaf_getting_ready_failed_space_body_plain')
              : $t('frameleaf_getting_ready_failed_space_body', {
                  values: { required: bytes(view.requiredBytes), available: bytes(view.availableBytes) },
                })}
          </p>
        {:else}
          <p>{$t('frameleaf_getting_ready_failed_body')}</p>
        {/if}
      {:else if view.kind === 'skipped'}
        <h1>{$t('frameleaf_getting_ready_skipped_title')}</h1>
        <p>
          {$t('frameleaf_getting_ready_skipped_body', {
            values: { date: view.backup ? formatDate(view.backup.takenAt) : '' },
          })}
        </p>
      {:else if view.kind === 'saved'}
        <h1>{$t('frameleaf_getting_ready_saved_title')}</h1>
        <p>{$t('frameleaf_getting_ready_saved_body')}</p>
      {:else if view.kind === 'finishing'}
        <h1>{$t('frameleaf_getting_ready_finishing_title')}</h1>
        <p>{$t('frameleaf_getting_ready_finishing_body')}</p>
      {:else}
        <h1>{$t('frameleaf_getting_ready_title')}</h1>
        <p>{$t('frameleaf_getting_ready_body')}</p>
      {/if}
    </div>

    {#if view.kind !== 'failed'}
      <div class="fl-bar busy" role="progressbar" aria-label={$t('frameleaf_getting_ready_progress')} aria-busy="true">
        <span></span>
      </div>
    {/if}

    <ul class="maint-tasks">
      {#each view.tasks as task (task.id)}
        <li data-status={task.status}>
          <span class="maint-icon"><Icon icon={taskIcons[task.status]} size="20" aria-hidden={true} /></span>
          <div>
            <strong>{$t(`frameleaf_getting_ready_task_${task.id}`)}</strong>
            <span>{$t(`frameleaf_getting_ready_task_${task.id}_detail`)}</span>
          </div>
          <span class="maint-pct">{taskStatusLabel(task.status)}</span>
        </li>
      {/each}
    </ul>

    {#if (view.kind === 'skipped' || view.kind === 'saved') && view.backup}
      <p class="backup-name">
        {view.kind === 'skipped'
          ? $t('frameleaf_getting_ready_backup_found', { values: { filename: view.backup.filename } })
          : $t('frameleaf_getting_ready_backup_saved', { values: { filename: view.backup.filename } })}
      </p>
    {/if}

    <div class="maint-status">
      <span role="status" aria-live="polite">{statusLine}</span>
    </div>

    {#if view.kind === 'failed'}
      <p class="auth-info">
        <Icon icon={mdiInformationOutline} size="16" aria-hidden={true} />
        <span>
          {view.reason === 'disk-space'
            ? $t('frameleaf_getting_ready_failed_space_action')
            : $t('frameleaf_getting_ready_failed_action')}
        </span>
      </p>
    {/if}
  </div>
</AuthShell>

<style>
  .backup-name {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    overflow-wrap: anywhere;
  }
  /* busy, not a percentage: the copy's length depends on the library */
  .busy span {
    width: 35%;
    animation: getting-ready-busy 1.6s ease-in-out infinite;
  }
  @keyframes getting-ready-busy {
    from {
      transform: translateX(-100%);
    }
    to {
      transform: translateX(290%);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .busy span {
      width: 100%;
      animation: none;
      opacity: 0.6;
    }
  }
</style>
