<script lang="ts">
  /**
   * Backup › Restore, the restore drill (FL-900, the prototype's `RestoreDrillCard` in `RestoreDrill.jsx`,
   * prototype PR 41): whether the backup has been proven to restore, the steps while a drill runs, and
   * the last result with the next drill. A drill (FL-879) takes a sample back from the newest backup into a
   * scratch copy and checks it; it changes nothing. Backup is for administrators only, so members never see it.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { backupPageUrl } from '$lib/frameleaf/settings-areas';
  import { drillCardState, DRILL_STEPS, runningStep, type DrillStepId } from '$lib/frameleaf/restore-drill';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { getCloudBackupStatus, startCloudBackupDrill, type CloudBackupStatusResponseDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiCheck,
    mdiChevronRight,
    mdiPlayCircleOutline,
    mdiShieldAlertOutline,
    mdiShieldCheckOutline,
    mdiShieldOutline,
  } from '@mdi/js';
  import { onDestroy } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let {
    status,
    onStatus,
  }: {
    status: CloudBackupStatusResponseDto;
    /** The newer status, after a drill was started or while one runs. */
    onStatus: (status: CloudBackupStatusResponseDto) => void;
  } = $props();

  const STEP_WORDS: Record<DrillStepId, Translations> = {
    fetch: 'frameleaf_restore_drill_step_fetch',
    unlock: 'frameleaf_restore_drill_step_unlock',
    rebuild: 'frameleaf_restore_drill_step_rebuild',
    compare: 'frameleaf_restore_drill_step_compare',
  };

  let starting = $state(false);
  const cardState = $derived(drillCardState(status));
  const last = $derived(status.lastDrill);
  const step = $derived(runningStep(status.activeRun?.progress ?? 0));

  // While a drill runs the card follows it, so its steps tick over and its result appears.
  let timer: ReturnType<typeof setTimeout> | undefined;
  const follow = () => {
    clearTimeout(timer);
    timer = setTimeout(async () => {
      let next = status;
      try {
        next = await getCloudBackupStatus();
        onStatus(next);
      } catch {
        // the next look tries again
      }
      if (drillCardState(next) === 'running') follow();
    }, 3000);
  };
  $effect(() => {
    if (cardState === 'running') follow();
  });
  onDestroy(() => clearTimeout(timer));

  const day = (iso: string) =>
    new Intl.DateTimeFormat($locale, { month: 'short', day: 'numeric' }).format(new Date(iso));
  const date = (iso: string) => new Intl.DateTimeFormat($locale, { dateStyle: 'full' }).format(new Date(iso));
  const moment = (iso: string) =>
    new Intl.DateTimeFormat($locale, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso));

  const title = $derived(
    {
      never: $t('frameleaf_restore_drill_never'),
      running: $t('frameleaf_restore_drill_running'),
      passed: $t('frameleaf_restore_drill_passed'),
      failed: $t('frameleaf_restore_drill_failed'),
    }[cardState],
  );
  const body = $derived.by(() => {
    if (cardState === 'never') return $t('frameleaf_restore_drill_never_body');
    if (cardState === 'running') return $t('frameleaf_restore_drill_running_body');
    if (!last) return '';
    const when = moment(last.startedAt);
    return cardState === 'passed'
      ? $t('frameleaf_restore_drill_passed_body', {
          values: { when, matched: last.matched, sample: last.sampleSize },
        })
      : $t('frameleaf_restore_drill_failed_body', {
          values: {
            when,
            failure: $t(`frameleaf_restore_drill_failure_${last.failedStep ?? 'fetch'}` as Translations),
          },
        });
  });
  const icon = $derived(
    {
      never: mdiShieldOutline,
      running: mdiShieldOutline,
      passed: mdiShieldCheckOutline,
      failed: mdiShieldAlertOutline,
    }[cardState],
  );

  const run = async () => {
    starting = true;
    try {
      onStatus(await startCloudBackupDrill());
    } catch (error) {
      handleError(error, $t('frameleaf_restore_drill_start_failed'));
    } finally {
      starting = false;
    }
  };
</script>

<section
  class="drill"
  class:is-passed={cardState === 'passed'}
  class:is-failed={cardState === 'failed'}
  aria-label={$t('frameleaf_restore_drill_label')}
>
  <div class="head">
    <span class="icon"><Icon {icon} size="28" aria-hidden /></span>
    <div>
      <h2>{title}</h2>
      <p>{body}</p>
    </div>
  </div>

  {#if cardState === 'running'}
    <ol class="steps" aria-label={$t('frameleaf_restore_drill_steps')}>
      {#each DRILL_STEPS as id, index (id)}
        <li data-state={index < step ? 'done' : index === step ? 'running' : 'waiting'}>
          <span>
            {#if index < step}<Icon icon={mdiCheck} size="14" aria-hidden />{:else if index === step}<span class="spin"
              ></span>{/if}
          </span>
          {$t(STEP_WORDS[id])}
        </li>
      {/each}
    </ol>
  {:else}
    <dl class="facts">
      <div>
        <dt>{$t('frameleaf_restore_drill_last')}</dt>
        <dd>
          {last
            ? $t(
                last.result === 'failed'
                  ? 'frameleaf_restore_drill_last_failed'
                  : 'frameleaf_restore_drill_last_passed',
                {
                  values: { day: day(last.startedAt) },
                },
              )
            : $t('frameleaf_restore_drill_last_never')}
        </dd>
      </div>
      <div>
        <dt>{$t('frameleaf_restore_drill_next')}</dt>
        <dd>
          {status.nextDrillAt ? date(status.nextDrillAt) : $t('frameleaf_restore_drill_next_tonight')}
        </dd>
      </div>
      <div>
        <dt>{$t('frameleaf_restore_drill_from')}</dt>
        <dd>
          {status.target === 'managed'
            ? $t('frameleaf_restore_drill_from_cloud')
            : $t('frameleaf_restore_drill_from_own')}
        </dd>
      </div>
    </dl>
  {/if}

  {#if cardState !== 'running'}
    <div class="actions">
      {#if cardState === 'failed' && last?.failedStep === 'unlock'}
        <a class="button primary" href={backupPageUrl('cloud')}>{$t('frameleaf_restore_drill_check_key')}</a>
      {/if}
      <Button variant={cardState === 'never' ? 'primary' : 'default'} disabled={starting} onclick={run}>
        <Icon icon={mdiPlayCircleOutline} size="18" aria-hidden />
        {$t('frameleaf_restore_drill_run')}
      </Button>
      {#if last}
        <a class="button" href={backupPageUrl('restore', { drill: last.id })}>
          {$t('frameleaf_restore_drill_see_report')}
          <Icon icon={mdiChevronRight} size="18" aria-hidden />
        </a>
      {/if}
    </div>
  {/if}
</section>

<style>
  .drill {
    display: grid;
    gap: 20px;
    padding: 24px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .drill.is-failed {
    border-color: color-mix(in srgb, var(--fl-danger) 50%, var(--fl-border));
  }
  .head {
    display: grid;
    grid-template-columns: 56px minmax(0, 1fr);
    gap: var(--fl-space-4);
    align-items: center;
  }
  h2 {
    margin: 0;
    font-size: var(--fl-font-headline);
    font-weight: 600;
  }
  .head p {
    margin: 6px 0 0;
    color: var(--fl-muted);
    line-height: 1.55;
  }
  .icon {
    display: grid;
    place-items: center;
    width: 56px;
    height: 56px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-card);
  }
  .is-passed .icon {
    color: var(--fl-accent);
    background: color-mix(in srgb, var(--fl-accent) 13%, transparent);
  }
  .is-failed .icon {
    color: var(--fl-danger);
    background: color-mix(in srgb, var(--fl-danger) 13%, transparent);
  }
  .facts {
    display: grid;
    grid-template-columns: repeat(3, minmax(0, 1fr));
    gap: var(--fl-space-4);
    margin: 0;
  }
  .facts div {
    padding: 14px var(--fl-space-4);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-control);
  }
  dt {
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  dd {
    margin: 4px 0 0;
    font-weight: 600;
    overflow-wrap: anywhere;
  }
  .actions {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
  }
  .steps {
    display: grid;
    gap: var(--fl-space-3);
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .steps li {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr);
    gap: var(--fl-space-3);
    align-items: center;
    color: var(--fl-muted);
  }
  .steps li > span {
    display: grid;
    place-items: center;
    width: 24px;
    height: 24px;
    border: 1px solid var(--fl-border);
    border-radius: 50%;
  }
  .steps li[data-state='done'] {
    color: var(--fl-text);
  }
  .steps li[data-state='done'] > span {
    color: white;
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .steps li[data-state='running'] {
    color: var(--fl-text);
    font-weight: 600;
  }
  .spin {
    width: 12px;
    height: 12px;
    border: 2px solid var(--fl-border);
    border-top-color: var(--fl-accent);
    border-radius: 50%;
    animation: spin 0.9s linear infinite;
  }
  @keyframes spin {
    to {
      transform: rotate(360deg);
    }
  }
  @media (prefers-reduced-motion: reduce) {
    .spin {
      animation: none;
    }
  }
  @media (max-width: 720px) {
    .drill {
      padding: var(--fl-space-4);
    }
    .facts {
      grid-template-columns: minmax(0, 1fr);
      gap: var(--fl-space-2);
    }
  }
</style>
