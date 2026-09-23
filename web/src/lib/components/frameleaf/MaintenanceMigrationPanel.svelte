<script lang="ts" module>
  /**
   * The exact operator commands, shared with the guide in
   * `docs/docs/administration/server-migration.md`. They are code, so they are not
   * translated; `node packages/cli/dist/index.js` is the command-line tool built from source.
   */
  const cli = 'node packages/cli/dist/index.js migrate';
  const ledger = '--ledger ./library-move.sqlite';
  export const migrationCommands = {
    tool: ['pnpm install --frozen-lockfile', 'pnpm --filter @immich/sdk build', 'pnpm --filter @immich/cli build'].join(
      '\n',
    ),
    keys: [
      'export IMMICH_FROM_URL=https://old-server.example/api',
      'export IMMICH_TO_URL=https://new-server.example/api',
      'read -rs IMMICH_FROM_KEY && export IMMICH_FROM_KEY',
      'read -rs IMMICH_TO_KEY && export IMMICH_TO_KEY',
    ].join('\n'),
    preflight: `${cli} --preflight ${ledger}`,
    dryRun: `${cli} --dry-run ${ledger}`,
    run: `${cli} ${ledger} --serve`,
    retry: `${cli} ${ledger} --retry-failed`,
    verify: `${cli} --verify ${ledger}`,
  } as const;
</script>

<script lang="ts">
  /**
   * Server migration in the Maintenance area (FL-75). The migration is the resumable
   * command-line tool, never a browser action: this panel shows the exact commands and opens
   * the audit report the tool writes, read-only and in this browser only. It has no API
   * call, keeps nothing in storage and has no input for API keys.
   */
  import Button from '$lib/components/frameleaf/Button.svelte';
  import MigrationReportDialog from '$lib/components/frameleaf/MigrationReportDialog.svelte';
  import Pane from '$lib/components/frameleaf/Pane.svelte';
  import {
    MIGRATION_REPORT_MAX_BYTES,
    parseMigrationReport,
    type MigrationReport,
    type MigrationReportError,
  } from '$lib/frameleaf/migration-report';
  import { copyToClipboard } from '$lib/utils';
  import type { Translations } from 'svelte-i18n';
  import { t } from 'svelte-i18n';

  type StepId = 'tool' | 'keys' | 'preflight' | 'dry_run' | 'run' | 'retry' | 'verify';
  const steps: Array<{ id: StepId; command: string }> = [
    { id: 'tool', command: migrationCommands.tool },
    { id: 'keys', command: migrationCommands.keys },
    { id: 'preflight', command: migrationCommands.preflight },
    { id: 'dry_run', command: migrationCommands.dryRun },
    { id: 'run', command: migrationCommands.run },
    { id: 'retry', command: migrationCommands.retry },
    { id: 'verify', command: migrationCommands.verify },
  ];
  const stepTitle = (id: StepId) => `admin.frameleaf_migration_step_${id}_title` as Translations;
  const stepDescription = (id: StepId) => `admin.frameleaf_migration_step_${id}_description` as Translations;
  const errorMessage = (error: MigrationReportError | 'read_failed') =>
    `admin.frameleaf_migration_report_error_${error.replaceAll('-', '_')}` as Translations;

  let input: HTMLInputElement;
  let report = $state<MigrationReport | undefined>();
  let reportOpen = $state(false);
  let error = $state<MigrationReportError | 'read_failed' | undefined>();

  const openReport = async (event: Event) => {
    const file = (event.currentTarget as HTMLInputElement).files?.[0];
    // Reset so choosing the same file again (after fixing it) still fires `change`.
    input.value = '';
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

<Pane label={$t('admin.frameleaf_migration_title')}>
  <div class="head">
    <h2>{$t('admin.frameleaf_migration_title')}</h2>
    <p>{$t('admin.frameleaf_migration_description')}</p>
  </div>
  <ol class="steps" aria-label={$t('admin.frameleaf_migration_steps_label')}>
    {#each steps as step (step.id)}
      <li>
        <div class="step-copy">
          <strong>{$t(stepTitle(step.id))}</strong>
          <p>{$t(stepDescription(step.id))}</p>
        </div>
        <div class="command">
          <pre><code>{step.command}</code></pre>
          <Button
            variant="quiet"
            label={$t('admin.frameleaf_migration_copy_command', { values: { step: $t(stepTitle(step.id)) } })}
            onclick={() => void copyToClipboard(step.command)}
          >
            {$t('copy_to_clipboard')}
          </Button>
        </div>
      </li>
    {/each}
  </ol>
  <div class="report-entry">
    <Button variant="primary" onclick={() => input.click()}>{$t('admin.frameleaf_migration_open_report')}</Button>
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
  <p class="note">{$t('admin.frameleaf_migration_no_source_deletion')}</p>
</Pane>

{#if report}
  <MigrationReportDialog {report} bind:open={reportOpen} />
{/if}

<style>
  .head h2 {
    font-size: var(--fl-font-size);
    margin: 0 0 0.25rem;
  }
  .head p,
  .step-copy p,
  .report-entry p,
  .note {
    margin: 0;
    color: var(--fl-muted);
    font-size: var(--fl-font-small);
    max-width: 44rem;
  }
  .steps {
    list-style: decimal;
    margin: 1rem 0 0;
    padding-inline-start: 1.25rem;
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
    margin-top: 1.25rem;
  }
  .error {
    margin: 0.75rem 0 0;
    color: var(--fl-danger);
    font-size: var(--fl-font-small);
  }
  .note {
    margin-top: 0.75rem;
  }
</style>
