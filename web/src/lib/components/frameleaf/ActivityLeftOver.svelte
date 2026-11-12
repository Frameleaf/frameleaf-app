<script lang="ts">
  /**
   * FL-1409: finished work that left photos over, on Activity as Recent work shows it (FL-1349): the same state
   * (`runHeadline`), the same count (`leftOver`), the same plain causes, and the same review sheet. Only an
   * administrator is sent these runs.
   */
  import ActivityNotice from '$lib/components/frameleaf/ActivityNotice.svelte';
  import Button from '$lib/components/frameleaf/Button.svelte';
  import type RunFailuresSheet from '$lib/components/frameleaf/jobs/RunFailuresSheet.svelte';
  import { uploadRunTitle } from '$lib/frameleaf/arrivals';
  import { runTitleKey } from '$lib/frameleaf/durable-runs';
  import { jobQueue } from '$lib/frameleaf/job-queues';
  import { CAUSE_VIEW, knowsCauses, leftOver, runCauses } from '$lib/frameleaf/run-failures';
  import { runHeadline } from '$lib/frameleaf/run-headline';
  import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
  import { handleError } from '$lib/utils/handle-error';
  import type { DurableJobRun } from '@frameleaf/sdk';
  import { mdiAlertCircleOutline } from '@mdi/js';
  import { locale, t } from 'svelte-i18n';

  let {
    runs,
    onChanged,
  }: {
    runs: DurableJobRun[];
    /** After Try again or Stop trying in the sheet, so the page reads the runs again. */
    onChanged: () => void;
  } = $props();

  const number = (value: number) => value.toLocaleString($locale ?? undefined);
  const title = (run: DurableJobRun) =>
    uploadRunTitle(run, $t) ??
    (run.nightly
      ? $t('frameleaf_job_runs_kind_nightly')
      : $t(
          runTitleKey(
            run.kind,
            jobQueue(run.kind as Parameters<typeof jobQueue>[0])?.key,
            'frameleaf_job_runs_server_work',
          ),
        ));

  /** The run being reviewed. The sheet follows it as the page reads it again, and keeps it once nothing is left. */
  let opened = $state<DurableJobRun | null>(null);
  const reviewing = $derived(opened && (runs.find((run) => run.id === opened?.id) ?? opened));
  /** Loaded the first time it opens, as Recent work does, so Activity doesn't carry it up front. */
  let Sheet = $state<typeof RunFailuresSheet | null>(null);
  const review = async (run: DurableJobRun) => {
    try {
      Sheet ??= (await import('$lib/components/frameleaf/jobs/RunFailuresSheet.svelte')).default;
      opened = run;
    } catch (error) {
      handleError(error, $t('frameleaf_job_runs_review_unavailable'));
    }
  };
</script>

{#each runs as run (run.id)}
  {@const causes = runCauses(run)}
  <ActivityNotice icon={mdiAlertCircleOutline} title={title(run)}>
    <p>
      {$t(runHeadline(run).status)} ·
      {$t(run.countsPhotos === false ? 'frameleaf_job_runs_need_a_look_tasks' : 'frameleaf_job_runs_need_a_look', {
        values: { count: leftOver(run) },
      })}
    </p>
    {#if !knowsCauses(run)}
      <p>{$t('frameleaf_job_runs_causes_unknown')}</p>
    {:else if causes.length > 0}
      <p>
        {causes
          .map(({ cause, count }) =>
            $t('frameleaf_job_runs_cause_count_line', {
              values: { title: $t(CAUSE_VIEW[cause].title), count: number(count) },
            }),
          )
          .join(', ')}
      </p>
    {/if}
    {#snippet actions()}
      {#if knowsCauses(run)}
        <Button onclick={() => void review(run)}>{$t('frameleaf_job_runs_review')}</Button>
      {:else}
        <!-- Recorded before causes were kept: the per-photo lists are the only place to look. -->
        <a class="fl-control button" href={commandCenterUrl('processing', 'queues')}
          >{$t('frameleaf_job_runs_open_task_list')}</a
        >
      {/if}
    {/snippet}
  </ActivityNotice>
{/each}

{#if Sheet && reviewing}
  <Sheet run={reviewing} name={title(reviewing)} {onChanged} onClose={() => (opened = null)} />
{/if}
