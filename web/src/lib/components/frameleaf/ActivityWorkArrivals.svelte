<script lang="ts">
  /**
   * FL-1459: Activity's In progress, by what came in (prototype `ActivityWorkV3.jsx` "By what came in", activity.css
   * `.fw3-batches`). One card for each upload, folder scan or import that is not finished: what came in and from
   * where, when, its state in Recent work's words, and how far each feature has got with it. `arrivals.ts` says what
   * the server reports.
   */
  import { arrivalTitle, type Arrival, type ArrivalStep, type ArrivalStepState } from '$lib/frameleaf/arrivals';
  import { Icon } from '@frameleaf/ui';
  import {
    mdiAlertCircle,
    mdiApplicationOutline,
    mdiCellphone,
    mdiCheckCircle,
    mdiClockOutline,
    mdiDatabaseImportOutline,
    mdiFolderOutline,
    mdiLinkVariant,
    mdiMonitor,
    mdiPauseCircleOutline,
    mdiProgressClock,
    mdiTrayArrowDown,
    mdiWeatherNight,
  } from '@mdi/js';
  import { locale, t, type Translations } from 'svelte-i18n';

  let { arrivals, viewerId = null }: { arrivals: Arrival[]; viewerId?: string | null } = $props();

  const ORIGIN_ICONS: Record<string, string> = {
    phone: mdiCellphone,
    computer: mdiMonitor,
    client: mdiApplicationOutline,
    link: mdiLinkVariant,
    library: mdiFolderOutline,
    import: mdiDatabaseImportOutline,
  };
  const STEP_ICONS: Record<ArrivalStepState, string> = {
    done: mdiCheckCircle,
    running: mdiProgressClock,
    waiting: mdiClockOutline,
    tonight: mdiWeatherNight,
    paused: mdiPauseCircleOutline,
    failed: mdiAlertCircle,
  };

  const number = (value: number) => value.toLocaleString($locale ?? undefined);

  const titleOf = (arrival: Arrival) => arrivalTitle(arrival, $t);

  /** Today's time alone; an earlier day's weekday too. */
  const timeOf = (iso: string) => {
    const at = new Date(iso);
    const today = new Date().toDateString() === at.toDateString();
    return new Intl.DateTimeFormat($locale ?? undefined, {
      ...(today ? {} : { weekday: 'short' }),
      hour: 'numeric',
      minute: '2-digit',
    }).format(at);
  };

  /** "Taylor · Uploaded 9:41 AM · Running"; the viewer's own photos leave the owner out. */
  const detailOf = (arrival: Arrival) => {
    const time = timeOf(arrival.run.createdAt);
    const when = $t(
      arrival.origin === 'library'
        ? 'frameleaf_activity_arrival_when_scanned'
        : arrival.origin === 'import'
          ? 'frameleaf_activity_arrival_when_imported'
          : 'frameleaf_activity_arrival_when_uploaded',
      { values: { time } },
    );
    const owner = arrival.ownerName && arrival.ownerId !== viewerId ? arrival.ownerName : null;
    return [owner, when, $t(arrival.headline.status)].filter(Boolean).join(' · ');
  };

  /** The prototype's `stageText`. */
  const stepText = (step: ArrivalStep) => {
    switch (step.state) {
      case 'done': {
        return $t('frameleaf_activity_stage_done');
      }
      case 'running': {
        return $t('frameleaf_activity_work_of', { values: { done: number(step.done), total: number(step.total) } });
      }
      case 'tonight': {
        return $t('frameleaf_activity_work_tonight_tag');
      }
      case 'paused': {
        return $t('frameleaf_bgwork_state_paused');
      }
      case 'failed': {
        return $t('frameleaf_bgwork_state_failed', { values: { count: step.failed } });
      }
      default: {
        return $t('frameleaf_activity_work_up_next');
      }
    }
  };
  const nameOf = (step: ArrivalStep) => $t(`frameleaf_work_feature_${step.feature.id}` as Translations);
</script>

{#if arrivals.length > 0}
  <ul class="fw3-batches">
    {#each arrivals as arrival (arrival.run.id)}
      {@const title = titleOf(arrival)}
      <li class="fw3-batch">
        <div class="fw3-batch-head">
          <span class="fw3-icon" aria-hidden="true">
            <Icon icon={ORIGIN_ICONS[arrival.origin] ?? mdiTrayArrowDown} size="20" />
          </span>
          <div class="fw3-batch-text">
            <strong>{title}</strong>
            <small>{detailOf(arrival)}</small>
          </div>
        </div>
        {#if arrival.steps.length > 0}
          <ol class="fw3-stages" aria-label={$t('frameleaf_activity_arrival_steps', { values: { name: title } })}>
            {#each arrival.steps as step (step.feature.id)}
              {@const name = nameOf(step)}
              <li class="fw3-stage is-{step.state}">
                <Icon icon={STEP_ICONS[step.state]} size="16" aria-hidden />
                <span class="fw3-stage-text">
                  <strong>{name}</strong>
                  <small>{stepText(step)}</small>
                </span>
                {#if step.state === 'running' && step.total > 0}
                  <span
                    class="fw3-meter"
                    role="progressbar"
                    aria-valuemin={0}
                    aria-valuemax={step.total}
                    aria-valuenow={step.done}
                    aria-label={$t('frameleaf_activity_progress_for', { values: { name } })}
                    ><span style:width="{Math.min(100, (step.done / step.total) * 100)}%"></span></span
                  >
                {/if}
              </li>
            {/each}
          </ol>
        {/if}
      </li>
    {/each}
  </ul>
{:else}
  <p class="fw3-quiet">{$t('frameleaf_activity_arrival_quiet')}</p>
{/if}

<style>
  /* activity.css `.fw3-batches`: one card per arrival, its steps in order. */
  .fw3-batches,
  .fw3-stages {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .fw3-batches {
    display: grid;
    gap: var(--fl-space-3);
  }
  .fw3-batch {
    display: grid;
    gap: 14px;
    padding: var(--fl-space-4);
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  .fw3-batch-head {
    display: flex;
    align-items: center;
    gap: var(--fl-space-3);
    min-width: 0;
  }
  .fw3-icon {
    display: grid;
    flex: none;
    place-items: center;
    width: 36px;
    height: 36px;
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-sm);
  }
  .fw3-batch-text {
    min-width: 0;
  }
  .fw3-batch-text strong,
  .fw3-stage-text strong {
    display: block;
    font-weight: 600;
  }
  .fw3-batch-text small,
  .fw3-stage-text small {
    display: block;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-variant-numeric: tabular-nums;
  }
  .fw3-stages {
    display: grid;
    grid-template-columns: repeat(auto-fill, minmax(190px, 1fr));
    gap: var(--fl-space-2);
  }
  .fw3-stage {
    display: grid;
    grid-template-columns: auto minmax(0, 1fr);
    align-items: start;
    gap: var(--fl-space-2);
    padding: 10px var(--fl-space-3);
    color: var(--fl-muted);
    background: var(--fl-raised);
    border-radius: var(--fl-radius-sm);
  }
  .fw3-stage-text strong {
    color: var(--fl-text);
    font-size: var(--fl-font-callout);
    font-weight: 500;
  }
  .fw3-stage.is-done {
    color: var(--fl-accent);
  }
  .fw3-stage.is-done strong {
    color: var(--fl-muted);
  }
  .fw3-stage.is-running {
    color: var(--fl-blue);
  }
  /* The ink of the AI colour: the fill itself is too dark to read on a dark panel. */
  .fw3-stage.is-tonight {
    color: var(--fl-ai-ink);
  }
  .fw3-stage.is-failed,
  .fw3-stage.is-paused {
    color: var(--fl-warning);
    background: color-mix(in srgb, var(--fl-warning) 9%, var(--fl-raised));
  }
  .fw3-meter {
    display: block;
    grid-column: 1 / -1;
    height: 4px;
    background: var(--fl-border);
    border-radius: var(--fl-radius-pill);
    overflow: hidden;
  }
  .fw3-meter > span {
    display: block;
    height: 100%;
    background: var(--fl-blue);
    border-radius: var(--fl-radius-pill);
  }
  .fw3-quiet {
    margin: 0;
    padding: var(--fl-space-4);
    color: var(--fl-muted);
    font-size: var(--fl-font-callout);
    border: 1px dashed var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  @media (max-width: 700px) {
    .fw3-stages {
      grid-template-columns: 1fr;
    }
  }
</style>
