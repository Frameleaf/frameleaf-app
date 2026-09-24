<script lang="ts">
  /**
   * "Plan a library move" (FL-75): the design template's migration workflow dialog
   * (`CommandCenter.jsx` `workflows.migration`), opened by "Prepare migration checklist" in
   * Settings → Storage & originals → "Move or export your library". Same three stages
   * (Source, Preflight, Review), Cancel/Back and Continue/Done. The template's sample facts are
   * replaced by the real procedure: server-to-server migration is the resumable command-line
   * tool, so each stage shows its exact commands. The Review stage opens the tool's audit report
   * read-only in this browser. Nothing here runs a migration, asks for an API key or stores
   * anything; the dialog only walks the operator through the checklist.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import Dialog from '$lib/components/frameleaf/Dialog.svelte';
  import MigrationReportDialog from '$lib/components/frameleaf/MigrationReportDialog.svelte';
  import { migrationCommands } from '$lib/frameleaf/migration-commands';
  import {
    MIGRATION_REPORT_MAX_BYTES,
    parseMigrationReport,
    type MigrationReport,
    type MigrationReportError,
  } from '$lib/frameleaf/migration-report';
  import { copyToClipboard } from '$lib/utils';
  import type { Translations } from 'svelte-i18n';
  import { t } from 'svelte-i18n';

  let { open = $bindable(false), onDone }: { open?: boolean; onDone?: () => void } = $props();

  type StepId = 'tool' | 'keys' | 'preflight' | 'dry_run' | 'run' | 'retry' | 'verify';
  type FactId = 'source' | 'destination' | 'verify' | 'rollback';
  const stages: Array<{ id: 'source' | 'preflight' | 'review'; facts: FactId[]; steps: StepId[] }> = [
    { id: 'source', facts: ['source', 'destination'], steps: ['tool', 'keys'] },
    { id: 'preflight', facts: ['destination', 'verify', 'rollback'], steps: ['preflight', 'dry_run'] },
    { id: 'review', facts: ['source', 'destination', 'verify', 'rollback'], steps: ['run', 'retry', 'verify'] },
  ];
  const commands: Record<StepId, string> = {
    tool: migrationCommands.tool,
    keys: migrationCommands.keys,
    preflight: migrationCommands.preflight,
    dry_run: migrationCommands.dryRun,
    run: migrationCommands.run,
    retry: migrationCommands.retry,
    verify: migrationCommands.verify,
  };
  const stepTitle = (id: StepId) => `admin.frameleaf_migration_step_${id}_title` as Translations;
  const stepDescription = (id: StepId) => `admin.frameleaf_migration_step_${id}_description` as Translations;
  const errorMessage = (error: MigrationReportError | 'read_failed') =>
    `admin.frameleaf_migration_report_error_${error.replaceAll('-', '_')}` as Translations;

  let step = $state(0);
  const stage = $derived(stages[step]);
  const done = $derived(step === stages.length - 1);

  let input = $state<HTMLInputElement>();
  let report = $state<MigrationReport | undefined>();
  let reportOpen = $state(false);
  let error = $state<MigrationReportError | 'read_failed' | undefined>();

  // Every opening starts at the first stage with no report, like the template.
  $effect(() => {
    if (!open) {
      return;
    }
    step = 0;
    error = undefined;
    report = undefined;
  });

  const back = () => {
    if (step === 0) {
      open = false;
    } else {
      step -= 1;
    }
  };
  const next = () => {
    if (done) {
      open = false;
      onDone?.();
    } else {
      step += 1;
    }
  };

  const openReport = async (event: Event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    // Reset so choosing the same file again (after fixing it) still fires `change`.
    if (input) {
      input.value = '';
    }
    if (!file) {
      return;
    }
    error = undefined;
    if (file.size > MIGRATION_REPORT_MAX_BYTES) {
      error = 'too-large';
      return;
    }
    let raw: string;
    try {
      raw = await file.text();
    } catch {
      error = 'read_failed';
      return;
    }
    const result = parseMigrationReport(raw);
    if (!result.ok) {
      error = result.error;
      return;
    }
    report = result.report;
    reportOpen = true;
  };
</script>

<Dialog title={$t('admin.frameleaf_migration_checklist_title')} closeLabel={$t('close')} wide bind:open>
  <div class="workflow">
    <ol class="stepper">
      {#each stages as item, index (item.id)}
        <li aria-current={step === index ? 'step' : undefined}>
          <span>{index + 1}</span>
          {$t(`admin.frameleaf_migration_stage_${item.id}` as Translations)}
        </li>
      {/each}
    </ol>
    <p>{$t('admin.frameleaf_migration_checklist_intro')}</p>
    <dl class="facts">
      {#each stage.facts as fact (fact)}
        <dt>{$t(`admin.frameleaf_migration_fact_${fact}` as Translations)}</dt>
        <dd>{$t(`admin.frameleaf_migration_fact_${fact}_value` as Translations)}</dd>
      {/each}
    </dl>
    <ol class="steps" aria-label={$t('admin.frameleaf_migration_steps_label')}>
      {#each stage.steps as id (id)}
        <li>
          <strong>{$t(stepTitle(id))}</strong>
          <p>{$t(stepDescription(id))}</p>
          <div class="command">
            <pre><code>{commands[id]}</code></pre>
            <Button
              variant="quiet"
              label={$t('admin.frameleaf_migration_copy_command', { values: { step: $t(stepTitle(id)) } })}
              onclick={() => void copyToClipboard(commands[id])}
            >
              {$t('copy_to_clipboard')}
            </Button>
          </div>
        </li>
      {/each}
    </ol>
    {#if done}
      <div class="report-entry">
        <Button onclick={() => input?.click()}>{$t('admin.frameleaf_migration_open_report')}</Button>
        <p>{$t('admin.frameleaf_migration_open_report_hint')}</p>
        <input
          bind:this={input}
          type="file"
          accept="application/json,.json"
          hidden
          data-testid="migration-report-input"
          onchange={openReport}
        />
      </div>
      {#if error}
        <p class="error" role="alert">{$t(errorMessage(error))}</p>
      {/if}
      <p class="notice">{$t('admin.frameleaf_migration_checklist_final')}</p>
    {/if}
    <p class="note">{$t('admin.frameleaf_migration_no_source_deletion')}</p>
    <div class="actions">
      <Button onclick={back}>{step === 0 ? $t('cancel') : $t('back')}</Button>
      <Button variant="primary" onclick={next}>{done ? $t('done') : $t('continue')}</Button>
    </div>
  </div>
</Dialog>

{#if report}
  <MigrationReportDialog {report} bind:open={reportOpen} />
{/if}

<style>
  .workflow {
    display: flex;
    flex-direction: column;
    gap: 1rem;
    margin-top: 1rem;
    font-variant-numeric: tabular-nums;
  }
  .workflow > p,
  .steps p,
  .report-entry p,
  .note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .stepper {
    list-style: none;
    display: flex;
    flex-wrap: wrap;
    gap: 1.25rem;
    padding: 0;
    margin: 0 0 0.625rem;
  }
  .stepper li {
    display: flex;
    gap: 0.5rem;
    align-items: center;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
  }
  .stepper li > span {
    display: grid;
    place-items: center;
    width: 1.375rem;
    height: 1.375rem;
    background: var(--fl-raised);
    border: 1px solid var(--fl-border);
    border-radius: 50%;
    font-size: var(--fl-font-micro);
  }
  .stepper li[aria-current] {
    color: var(--fl-text);
  }
  .stepper li[aria-current] > span {
    color: var(--fl-accent-text);
    background: var(--fl-accent);
    border-color: var(--fl-accent);
  }
  .facts {
    display: grid;
    grid-template-columns: 8.125rem 1fr;
    gap: 1rem;
    margin: 0.5rem 0;
    font-size: var(--fl-font-small);
  }
  .facts dt {
    color: var(--fl-muted);
  }
  .facts dd {
    margin: 0;
    line-height: 1.7;
  }
  @media (max-width: 40rem) {
    .facts {
      grid-template-columns: 1fr;
      gap: 0.25rem;
    }
    .facts dd {
      margin-bottom: 0.5rem;
    }
  }
  .steps {
    list-style: none;
    margin: 0;
    padding: 0;
    display: flex;
    flex-direction: column;
    gap: 0.875rem;
  }
  .steps li {
    display: flex;
    flex-direction: column;
    gap: 0.375rem;
  }
  .command {
    display: flex;
    align-items: flex-start;
    gap: 0.5rem;
    min-width: 0;
  }
  pre {
    flex: 1;
    min-width: 0;
    margin: 0;
    padding: 0.5rem 0.75rem;
    overflow-x: auto;
    background: var(--fl-canvas);
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-control);
    font-size: var(--fl-font-small);
  }
  .report-entry {
    display: flex;
    align-items: center;
    gap: 0.75rem;
    flex-wrap: wrap;
  }
  .error {
    margin: 0;
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
  .notice {
    margin: 0;
    padding: 0.625rem 0.75rem;
    border: 1px solid var(--fl-border);
    border-radius: var(--fl-radius-card);
    background: var(--fl-raised);
    font-size: var(--fl-font-small);
  }
  .actions {
    display: flex;
    justify-content: flex-end;
    gap: 0.5rem;
  }
</style>
