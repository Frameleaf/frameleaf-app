<script lang="ts">
  /**
   * FL-326 (spec §5.1): Getting Ready's "Combining duplicate files" step, the prototype's
   * `CombiningDuplicates` (`design/frameleaf/template/src/AuthScreens.jsx`). Shown inside the Getting
   * Ready card after the safety copy and the upgrade while the server's one-time universal storage
   * migration runs: each stage as X of Y, how many missing originals were relinked and how many are left
   * for review, space freed and the time left. There is no Continue until it finishes. "Run in
   * background instead" asks first, because the extra copies are not freed until it completes; it is an
   * administrator's choice, so a visitor who is not signed in as one is asked to sign in.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import {
    STORAGE_MIGRATION_POLL_MS,
    fetchStorageMigrationStatus,
    runStorageMigrationInBackground,
    storageMigrationView,
    timeLeftParts,
    type StorageMigrationStatus,
    type StorageMigrationTaskStatus,
  } from '$lib/frameleaf/storage-migration';
  import { getByteUnitString } from '$lib/utils/byte-units';
  import { Icon } from '@immich/ui';
  import {
    mdiCheckCircle,
    mdiClockOutline,
    mdiFileTree,
    mdiInformationOutline,
    mdiProgressClock,
    mdiShieldCheckOutline,
  } from '@mdi/js';
  import { onMount } from 'svelte';
  import { locale, t } from 'svelte-i18n';

  let {
    initial,
    onContinue,
    onOpenLibraryCare,
    onSignIn,
  }: {
    initial: StorageMigrationStatus;
    onContinue: () => void;
    onOpenLibraryCare: () => void;
    /** Not signed in as an administrator: sign in, then come back. */
    onSignIn: () => void;
  } = $props();

  // svelte-ignore state_referenced_locally
  let status = $state<StorageMigrationStatus>(initial);
  const view = $derived(storageMigrationView(status));
  const finished = $derived(view.kind === 'done' || view.kind === 'review');
  let confirming = $state(false);
  let sending = $state(false);
  let notice = $state<'sign-in' | 'failed' | undefined>();

  onMount(() => {
    let stopped = false;
    let timer: ReturnType<typeof setTimeout> | undefined;
    const tick = async () => {
      const next = await fetchStorageMigrationStatus();
      if (stopped) {
        return;
      }
      if (next) {
        status = next;
      }
      if (status.stage !== 'done') {
        timer = setTimeout(() => void tick(), STORAGE_MIGRATION_POLL_MS);
      }
    };
    timer = setTimeout(() => void tick(), STORAGE_MIGRATION_POLL_MS);
    return () => {
      stopped = true;
      clearTimeout(timer);
    };
  });

  const icons: Record<StorageMigrationTaskStatus, string> = {
    done: mdiCheckCircle,
    running: mdiProgressClock,
    queued: mdiClockOutline,
  };

  const number = (value: number) => value.toLocaleString($locale ?? undefined);
  const bytes = (value: number) => getByteUnitString(value, $locale ?? undefined);

  const timeLeft = $derived.by(() => {
    const parts = timeLeftParts(view.estimatedSecondsLeft);
    switch (parts.kind) {
      case 'under-minute': {
        return $t('frameleaf_storage_migration_time_under_minute');
      }
      case 'minutes': {
        return $t('frameleaf_storage_migration_time_minutes', { values: { minutes: parts.minutes } });
      }
      case 'hours': {
        return parts.minutes === 0
          ? $t('frameleaf_storage_migration_time_hours', { values: { hours: parts.hours } })
          : $t('frameleaf_storage_migration_time_hours_minutes', {
              values: { hours: parts.hours, minutes: parts.minutes },
            });
      }
      default: {
        return '';
      }
    }
  });

  const runInBackground = async () => {
    sending = true;
    const result = await runStorageMigrationInBackground();
    sending = false;
    confirming = false;
    if (result.kind === 'ok') {
      status = result.status;
      onContinue();
    } else if (result.kind === 'sign-in') {
      notice = 'sign-in';
    } else {
      notice = 'failed';
    }
  };
</script>

<span class="pin-mark">
  <Icon icon={finished ? mdiCheckCircle : mdiFileTree} size="26" aria-hidden={true} />
</span>
<div class="auth-heading">
  {#if view.kind === 'done'}
    <h1>{$t('frameleaf_storage_migration_done_title')}</h1>
    <p>{$t('frameleaf_storage_migration_done_body')}</p>
  {:else if view.kind === 'review'}
    <h1>{$t('frameleaf_storage_migration_review_title', { values: { count: view.toReview } })}</h1>
    <p>{$t('frameleaf_storage_migration_review_body')}</p>
  {:else if view.kind === 'background'}
    <h1>{$t('frameleaf_storage_migration_background_title')}</h1>
    <p>{$t('frameleaf_storage_migration_background_body')}</p>
  {:else}
    <h1>{$t('frameleaf_storage_migration_title')}</h1>
    <p>{$t('frameleaf_storage_migration_body')}</p>
  {/if}
</div>

<div
  class="fl-bar"
  role="progressbar"
  aria-label={$t('frameleaf_storage_migration_progress')}
  aria-valuemin={0}
  aria-valuemax={100}
  aria-valuenow={view.percent}
>
  <span style:width="{view.percent}%"></span>
</div>

<ul class="maint-tasks">
  {#each view.tasks as task (task.id)}
    <li data-status={task.status}>
      <span class="maint-icon"><Icon icon={icons[task.status]} size="20" aria-hidden={true} /></span>
      <div>
        <strong>{$t(`frameleaf_storage_migration_stage_${task.id}`)}</strong>
        <span>
          {task.id === 'relinking' && task.status !== 'queued'
            ? $t('frameleaf_storage_migration_relink_line', {
                values: { relinked: number(view.relinked), toReview: number(view.toReview) },
              })
            : $t(`frameleaf_storage_migration_stage_${task.id}_detail`)}
        </span>
      </div>
      <span class="maint-pct">
        {task.status === 'running'
          ? $t('frameleaf_storage_migration_stage_count', {
              values: { done: number(task.done), total: number(task.total) },
            })
          : task.status === 'done'
            ? $t('frameleaf_storage_migration_stage_done')
            : $t('frameleaf_storage_migration_stage_waiting')}
      </span>
      {#if task.status === 'running'}
        <div class="fl-bar" aria-hidden="true"><span style:width="{task.percent}%"></span></div>
      {/if}
    </li>
  {/each}
</ul>

<div class="maint-status">
  <span role="status" aria-live="polite">
    {finished
      ? $t('frameleaf_storage_migration_freed_final', { values: { size: bytes(view.bytesFreed) } })
      : $t('frameleaf_storage_migration_freed', { values: { size: bytes(view.bytesFreed) } })}
  </span>
  {#if !finished && timeLeft}<span>{timeLeft}</span>{/if}
</div>

<div class="maint-actions">
  {#if view.canContinue}
    {#if view.kind === 'review' || view.kind === 'background'}
      <Button onclick={onOpenLibraryCare}>
        <Icon icon={mdiShieldCheckOutline} size="18" aria-hidden={true} />
        {$t('frameleaf_storage_migration_open_library_care')}
      </Button>
    {/if}
    <Button variant="primary" onclick={onContinue}>{$t('frameleaf_storage_migration_continue')}</Button>
  {:else}
    <button type="button" class="auth-link" onclick={() => (confirming = true)}>
      {$t('frameleaf_storage_migration_run_in_background')}
    </button>
  {/if}
</div>

{#if notice === 'sign-in'}
  <p class="auth-info" role="alert">
    <Icon icon={mdiInformationOutline} size="16" aria-hidden={true} />
    <span>{$t('frameleaf_storage_migration_sign_in')}</span>
    <button type="button" class="auth-link" onclick={onSignIn}>{$t('frameleaf_auth_sign_in')}</button>
  </p>
{:else if notice === 'failed'}
  <p class="auth-info" role="alert">
    <Icon icon={mdiInformationOutline} size="16" aria-hidden={true} />
    <span>{$t('frameleaf_storage_migration_background_failed')}</span>
  </p>
{:else if !finished && view.kind === 'working'}
  <p class="auth-info">
    <Icon icon={mdiInformationOutline} size="16" aria-hidden={true} />
    <span>{$t('frameleaf_storage_migration_keep_open')}</span>
  </p>
{/if}

<Dialog
  title={$t('frameleaf_storage_migration_background_confirm_title')}
  closeLabel={$t('frameleaf_storage_migration_keep_waiting')}
  bind:open={confirming}
>
  <p>{$t('frameleaf_storage_migration_background_confirm_body')}</p>
  {#snippet actions()}
    <Button initialFocus onclick={() => (confirming = false)}>{$t('frameleaf_storage_migration_keep_waiting')}</Button>
    <Button variant="primary" disabled={sending} onclick={() => void runInBackground()}>
      {$t('frameleaf_storage_migration_background_confirm')}
    </Button>
  {/snippet}
</Dialog>
