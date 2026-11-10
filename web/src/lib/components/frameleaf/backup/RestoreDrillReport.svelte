<script lang="ts">
  /**
   * Backup › Restore › a drill's report (FL-900, the prototype's `DrillReport`): what was checked step by
   * step, the numbers, and the key that signed it. "Download report" saves the signed file (FL-879), which
   * names the same key fingerprint; "Print" prints the report alone (the print styles below).
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import InlineError from '$lib/components/frameleaf/InlineError.svelte';
  import Skeleton from '$lib/components/frameleaf/Skeleton.svelte';
  import BackLink from '$lib/components/frameleaf/settings/kit/BackLink.svelte';
  import {
    durationParts,
    groupedFingerprint,
    reportFileName,
    stepStates,
    type DrillStepId,
  } from '$lib/frameleaf/restore-drill';
  import { backupPageUrl } from '$lib/frameleaf/settings-areas';
  import { locale } from '$lib/stores/preferences.store';
  import { handleError } from '$lib/utils/handle-error';
  import { getCloudBackupDrill, getCloudBackupDrillReport, type CloudBackupDrillDto } from '@frameleaf/sdk';
  import { Icon } from '@frameleaf/ui';
  import { mdiCheck, mdiClose, mdiDownloadOutline, mdiPrinterOutline } from '@mdi/js';
  import { onMount } from 'svelte';
  import { t, type Translations } from 'svelte-i18n';

  let { id }: { id: string } = $props();

  let drill = $state<CloudBackupDrillDto | null>(null);
  let failed = $state(false);
  let saving = $state(false);

  const load = async () => {
    failed = false;
    try {
      drill = await getCloudBackupDrill({ id });
    } catch {
      failed = true;
    }
  };
  onMount(() => void load());

  const moment = (iso: string) =>
    new Intl.DateTimeFormat($locale, { dateStyle: 'full', timeStyle: 'short' }).format(new Date(iso));
  const number = (value: number) => value.toLocaleString($locale);
  const STEP_WORDS: Record<DrillStepId, Translations> = {
    fetch: 'frameleaf_restore_drill_step_fetch',
    unlock: 'frameleaf_restore_drill_step_unlock',
    rebuild: 'frameleaf_restore_drill_step_rebuild',
    compare: 'frameleaf_restore_drill_step_compare',
  };

  const rows = $derived.by(() => {
    if (!drill) {
      return [];
    }
    const duration = drill.durationSeconds === null ? null : durationParts(drill.durationSeconds);
    return [
      [
        $t('frameleaf_restore_drill_report_backup'),
        drill.backupFrom
          ? $t('frameleaf_restore_drill_report_backup_value', {
              values: {
                source:
                  drill.target === 'managed'
                    ? $t('frameleaf_restore_drill_from_cloud')
                    : $t('frameleaf_restore_drill_from_own'),
                when: moment(drill.backupFrom),
              },
            })
          : $t('frameleaf_restore_drill_report_not_reached'),
      ],
      [
        $t('frameleaf_restore_drill_report_library'),
        drill.library && drill.library.items > 0
          ? $t('frameleaf_restore_drill_report_library_value', {
              values: { photos: drill.library.photos, videos: drill.library.videos },
            })
          : $t('frameleaf_restore_drill_report_not_reached'),
      ],
      [
        $t('frameleaf_restore_drill_report_sample'),
        $t('frameleaf_restore_drill_report_sample_value', { values: { count: drill.sampleSize } }),
      ],
      [
        $t('frameleaf_restore_drill_report_matched'),
        drill.checked > 0
          ? $t('frameleaf_restore_drill_report_matched_value', {
              values: { matched: number(drill.matched), checked: number(drill.checked) },
            })
          : $t('frameleaf_restore_drill_report_not_reached'),
      ],
      [
        $t('frameleaf_restore_drill_report_mismatched'),
        drill.mismatches.length > 0 ? number(drill.mismatches.length) : $t('frameleaf_restore_drill_report_none'),
      ],
      [
        $t('frameleaf_restore_drill_report_took'),
        duration ? $t('frameleaf_restore_drill_report_took_value', { values: duration }) : '—',
      ],
      [
        $t('frameleaf_restore_drill_report_signed'),
        drill.keyFingerprint ? groupedFingerprint(drill.keyFingerprint) : '—',
      ],
    ];
  });

  const download = async () => {
    if (!drill) {
      return;
    }
    saving = true;
    try {
      const signed = await getCloudBackupDrillReport({ id });
      const url = URL.createObjectURL(new Blob([JSON.stringify(signed, null, 2)], { type: 'application/json' }));
      const link = document.createElement('a');
      link.href = url;
      link.download = reportFileName(drill.startedAt);
      link.click();
      URL.revokeObjectURL(url);
    } catch (error) {
      handleError(error, $t('frameleaf_restore_drill_report_download_failed'));
    } finally {
      saving = false;
    }
  };
</script>

<div class="report">
  <div class="no-print"><BackLink href={backupPageUrl('restore')} label={$t('frameleaf_backup_tab_restore')} /></div>
  {#if failed}
    <InlineError message={$t('frameleaf_restore_drill_report_unread')} onRetry={load} />
  {:else if !drill}
    <div role="status" aria-busy="true">
      <span class="sr-only">{$t('loading')}</span>
      <Skeleton variant="block" height="12rem" />
    </div>
  {:else}
    <header>
      <div>
        <p class="kicker">{$t('frameleaf_restore_drill_report_kicker')}</p>
        <h2>
          {$t(
            drill.result === 'failed'
              ? 'frameleaf_restore_drill_report_failed'
              : drill.result === 'passed'
                ? 'frameleaf_restore_drill_report_passed'
                : 'frameleaf_restore_drill_report_running',
            { values: { when: moment(drill.startedAt) } },
          )}
        </h2>
      </div>
      <div class="buttons no-print">
        <Button disabled={!drill.signed || saving} onclick={download}>
          <Icon icon={mdiDownloadOutline} size="18" aria-hidden />
          {$t('frameleaf_restore_drill_report_download')}
        </Button>
        <Button onclick={() => print()}>
          <Icon icon={mdiPrinterOutline} size="18" aria-hidden />
          {$t('frameleaf_restore_drill_report_print')}
        </Button>
      </div>
    </header>

    <section aria-labelledby="drill-checked">
      <h3 id="drill-checked">{$t('frameleaf_restore_drill_report_checked')}</h3>
      <ol class="steps">
        {#each stepStates(drill) as { step, state: stepState } (step)}
          <li data-state={stepState}>
            <span>
              {#if stepState === 'done'}<Icon
                  icon={mdiCheck}
                  size="14"
                  aria-hidden
                />{:else if stepState === 'failed'}<Icon icon={mdiClose} size="14" aria-hidden />{/if}
            </span>
            <div>
              {$t(STEP_WORDS[step])}
              {#if stepState === 'failed'}
                <small>{$t(`frameleaf_restore_drill_failure_${step}` as Translations)}</small>
              {:else if stepState === 'skipped'}
                <small>{$t('frameleaf_restore_drill_report_not_reached')}</small>
              {/if}
            </div>
          </li>
        {/each}
      </ol>
    </section>

    <section aria-labelledby="drill-numbers">
      <h3 id="drill-numbers">{$t('frameleaf_restore_drill_report_numbers')}</h3>
      <dl>
        {#each rows as [name, value] (name)}
          <div>
            <dt>{name}</dt>
            <dd>{value}</dd>
          </div>
        {/each}
      </dl>
      <p class="note">{$t('frameleaf_restore_drill_report_note')}</p>
    </section>
  {/if}
</div>

<style>
  .report {
    display: grid;
    gap: 24px;
  }
  header {
    display: flex;
    flex-wrap: wrap;
    align-items: flex-end;
    justify-content: space-between;
    gap: var(--fl-space-4) 24px;
  }
  h2 {
    margin: 4px 0 0;
    font-size: var(--fl-font-title);
    font-weight: 600;
  }
  .kicker {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    font-weight: 600;
  }
  .buttons {
    display: flex;
    flex-wrap: wrap;
    gap: var(--fl-space-3);
  }
  section {
    padding: 24px;
    background: var(--fl-panel);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
  }
  h3 {
    margin: 0 0 20px;
    font-size: var(--fl-font-callout);
    font-weight: 600;
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
    align-items: start;
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
  .steps li[data-state='done'],
  .steps li[data-state='failed'] {
    color: var(--fl-text);
  }
  .steps li[data-state='done'] > span {
    color: white;
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .steps li[data-state='failed'] > span {
    color: white;
    background: var(--fl-danger);
    border-color: var(--fl-danger);
  }
  small {
    display: block;
    margin-top: 4px;
    color: var(--fl-muted);
  }
  dl {
    display: grid;
    margin: 0;
  }
  dl div {
    display: grid;
    grid-template-columns: 200px minmax(0, 1fr);
    gap: var(--fl-space-4);
    padding: 12px 0;
    border-top: 1px solid var(--fl-border);
  }
  dl div:first-child {
    border-top: 0;
  }
  dt {
    color: var(--fl-muted);
  }
  dd {
    margin: 0;
    font-weight: 600;
    font-variant-numeric: tabular-nums;
    overflow-wrap: anywhere;
  }
  .note {
    margin: var(--fl-space-4) 0 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    line-height: 1.5;
  }
  @media (max-width: 720px) {
    section {
      padding: var(--fl-space-4);
    }
    dl div {
      grid-template-columns: minmax(0, 1fr);
      gap: 2px;
    }
  }
  /* Print: the report alone, on white. */
  @media print {
    :global(body *) {
      visibility: hidden;
    }
    .report,
    .report :global(*) {
      visibility: visible;
    }
    .report {
      position: absolute;
      inset: 0;
      color: #000;
      background: #fff;
    }
    .no-print {
      display: none;
    }
    section {
      background: #fff;
      border-color: #ccc;
    }
  }
</style>
