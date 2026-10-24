<script lang="ts">
  /**
   * Library care › "Checking your Immich library" (FL-416, after the approved prototype
   * `settings-v2/care/import-check.jsx`). After an Immich import the identical-files check reads every
   * imported file once: identical files are merged as they are found (the oldest is kept), files Immich had
   * lost track of go back to their owner in Recovered Media, and extra copies wait in Unused files.
   *
   * Pause and Resume pause the storage queue the check runs on; the check stops between batches and
   * carries on from where it stopped (`IdenticalFilesService.shouldYield`).
   */
  import { goto } from '$app/navigation';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import { immichCheckView, type ImmichCheckStep } from '$lib/components/frameleaf/settings/care/immich-check';
  import Facts from '$lib/components/frameleaf/settings/kit/Facts.svelte';
  import Section from '$lib/components/frameleaf/settings/kit/Section.svelte';
  import { backupWhen } from '$lib/frameleaf/backup-overview';
  import { formatBytes } from '$lib/frameleaf/format-bytes';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { Route } from '$lib/route';
  import { locale } from '$lib/stores/preferences.store';
  import type { IdenticalFilesStatusDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheckCircle, mdiChevronRight, mdiCircleOutline, mdiPause, mdiPlay, mdiProgressClock } from '@mdi/js';
  import { t, type Translations } from 'svelte-i18n';

  let {
    status,
    paused,
    busy = false,
    recoveredAlbumId,
    onPause,
    onResume,
  }: {
    status: IdenticalFilesStatusDto;
    paused: boolean;
    busy?: boolean;
    /** The reader's own Recovered Media album, when the check made one. */
    recoveredAlbumId?: string;
    onPause: () => void;
    onResume: () => void;
  } = $props();

  const view = $derived(immichCheckView(status));
  const ICONS = { done: mdiCheckCircle, running: mdiProgressClock, queued: mdiCircleOutline };
  const STEP_COPY: Record<ImmichCheckStep, { title: Translations; detail: Translations }> = {
    read: { title: 'frameleaf_immich_check_step_read', detail: 'frameleaf_immich_check_step_read_detail' },
    recover: { title: 'frameleaf_immich_check_step_recover', detail: 'frameleaf_immich_check_step_recover_detail' },
    move: { title: 'frameleaf_immich_check_step_move', detail: 'frameleaf_immich_check_step_move_detail' },
  };
  const when = (value: string | null) => {
    if (!value) {
      return '';
    }
    const words = backupWhen(new Date(value), { locale: $locale, sentence: true });
    return $t(words.key, { values: words.values });
  };
  const running = $derived(view.steps.find((step) => step.status === 'running'));
</script>

<Section
  title={view.finished ? $t('frameleaf_immich_check_done_title') : $t('frameleaf_immich_check_title')}
  description={view.finished ? $t('frameleaf_immich_check_done_description') : $t('frameleaf_immich_check_description')}
>
  {#snippet action()}
    {#if !view.finished}
      <Button disabled={busy} onclick={paused ? onResume : onPause}>
        <Icon icon={paused ? mdiPlay : mdiPause} size="1em" aria-hidden />
        {paused ? $t('frameleaf_immich_check_resume') : $t('frameleaf_immich_check_pause')}
      </Button>
    {:else if recoveredAlbumId}
      <Button onclick={() => goto(Route.viewAlbum({ id: recoveredAlbumId }))}>
        {$t('frameleaf_immich_check_open_recovered')}
        <Icon icon={mdiChevronRight} size="1em" aria-hidden />
      </Button>
    {/if}
  {/snippet}
  {#if !view.finished}
    <div
      class="bar"
      role="progressbar"
      aria-label={$t('frameleaf_immich_check_title')}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={view.percent}
    >
      <span style:width="{view.percent}%"></span>
    </div>
  {/if}
  <div class="facts">
    <Facts
      rows={[
        {
          label: $t('frameleaf_immich_check_checked'),
          value: $t('frameleaf_immich_check_checked_value', { values: { checked: view.checked, total: view.total } }),
          detail: view.finished
            ? $t('frameleaf_immich_check_all_read')
            : paused
              ? $t('frameleaf_immich_check_paused')
              : view.minutesLeft === undefined
                ? undefined
                : $t('frameleaf_immich_check_minutes_left', { values: { count: view.minutesLeft } }),
        },
        {
          label: $t('frameleaf_immich_check_merged'),
          value: view.merged.toLocaleString($locale),
          detail: $t('frameleaf_immich_check_merged_detail'),
        },
        {
          label: $t('frameleaf_immich_check_recovered'),
          value: view.recovered.toLocaleString($locale),
          detail:
            view.recovered > 0 || view.finished
              ? $t('frameleaf_immich_check_recovered_detail')
              : $t('frameleaf_immich_check_recovered_later'),
        },
        {
          label: $t('frameleaf_immich_check_moved'),
          value: formatBytes(view.movedBytes, $locale),
          detail: $t('frameleaf_immich_check_moved_detail'),
        },
      ]}
    />
  </div>
  {#if !view.finished}
    <ul class="stages">
      {#each view.steps as step (step.id)}
        <li data-status={step.status}>
          <Icon icon={ICONS[step.status]} size="20" aria-hidden />
          <div>
            <strong>{$t(STEP_COPY[step.id].title)}</strong>
            <small>{$t(STEP_COPY[step.id].detail)}</small>
          </div>
          <span>
            {step.status === 'done'
              ? $t('frameleaf_immich_check_step_done')
              : step.status === 'running'
                ? paused
                  ? $t('frameleaf_immich_check_paused')
                  : step.percent === undefined
                    ? $t('frameleaf_immich_check_step_running')
                    : `${step.percent}%`
                : $t('frameleaf_immich_check_step_waiting')}
          </span>
        </li>
      {/each}
    </ul>
  {/if}
  <div class="foot">
    <span>
      {view.finished
        ? $t('frameleaf_immich_check_finished', { values: { when: when(status.finishedAt) } })
        : running
          ? $t('frameleaf_immich_check_now', {
              values: { step: $t(STEP_COPY[running.id].title).toLowerCase(), when: when(status.startedAt) },
            })
          : ''}
    </span>
    <Button onclick={() => goto(commandCenterUrl('care', 'duplicates'))}>
      {$t('frameleaf_cc_section_duplicates')}
      <Icon icon={mdiChevronRight} size="1em" aria-hidden />
    </Button>
  </div>
</Section>

<style>
  /* settings-v2/care.css .care-import */
  .bar {
    height: 6px;
    margin: 0 0 var(--fl-space-5);
    overflow: hidden;
    border-radius: 999px;
    background: var(--fl-border);
  }
  .bar > span {
    display: block;
    height: 100%;
    border-radius: inherit;
    background: var(--fl-accent);
    transition: width var(--fl-motion) var(--fl-ease);
  }
  .facts {
    padding-top: var(--fl-space-5);
    border-top: 1px solid var(--fl-border);
  }
  .stages {
    margin: 0;
    padding: 0;
    list-style: none;
  }
  .stages li {
    display: grid;
    grid-template-columns: 24px minmax(0, 1fr) auto;
    align-items: center;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3) 0;
    border-top: 1px solid var(--fl-border);
    font-size: var(--fl-font-small);
  }
  .stages small {
    display: block;
    margin-top: var(--fl-space-1);
    color: var(--fl-muted);
  }
  .stages li > span {
    color: var(--fl-muted);
    font-variant-numeric: tabular-nums;
  }
  .stages li[data-status='done'] > :global(svg) {
    color: var(--fl-accent);
  }
  .stages li[data-status='queued'] {
    color: var(--fl-muted);
  }
  .foot {
    display: flex;
    flex-wrap: wrap;
    align-items: center;
    justify-content: space-between;
    gap: var(--fl-space-3);
    padding: var(--fl-space-3) 0 var(--fl-space-6);
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
</style>
