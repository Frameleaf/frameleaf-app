import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import MigrationSettingsSection from '$lib/components/frameleaf/settings/MigrationSettingsSection.svelte';
import { migrationCommands } from '$lib/frameleaf/migration-commands';
import { cleanMigrationReport, failedMigrationReport } from '@test-data/frameleaf/migration-report';
import en from '../../../../../../i18n/en.json';

/**
 * FL-75: Settings → Storage & originals → "Move or export your library" opens the template's
 * "Plan a library move" workflow (Source, Preflight, Review). It shows the command-line steps
 * and opens the audit report read-only. No request is made and no key is typed into the page.
 */

const admin = en.admin;

const openChecklist = async () => {
  render(MigrationSettingsSection);
  await fireEvent.click(screen.getByRole('button', { name: admin.frameleaf_migration_checklist_action }));
  return screen.getByRole('dialog', { name: admin.frameleaf_migration_checklist_title });
};
const code = (dialog: HTMLElement) => [...dialog.querySelectorAll(':scope pre code')].map((node) => node.textContent);
const next = (dialog: HTMLElement) => fireEvent.click(within(dialog).getByRole('button', { name: en.continue }));

const chooseReport = async (value: unknown) => {
  const input = screen.getByTestId('migration-report-input') as HTMLInputElement;
  const file = new File([typeof value === 'string' ? value : JSON.stringify(value)], 'library-move.sqlite.audit.json', {
    type: 'application/json',
  });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await fireEvent.change(input);
  // file.text() resolves on a later task.
  await new Promise((resolve) => setTimeout(resolve, 0));
};

const toReview = async () => {
  const dialog = await openChecklist();
  await next(dialog);
  await next(dialog);
  return dialog;
};

beforeEach(() => {
  addMessages('dev', en);
  vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MigrationSettingsSection', () => {
  it('walks Source, Preflight and Review with the exact commands for each stage', async () => {
    const dialog = await openChecklist();
    const current = () => dialog.querySelector('[aria-current="step"]')?.textContent?.trim();

    expect(current()).toContain(admin.frameleaf_migration_stage_source);
    expect(within(dialog).getByText(admin.frameleaf_migration_checklist_intro)).toBeInTheDocument();
    expect(code(dialog)).toEqual([migrationCommands.tool, migrationCommands.keys]);
    expect(within(dialog).getByRole('button', { name: en.cancel })).toBeInTheDocument();

    await next(dialog);
    expect(current()).toContain(admin.frameleaf_migration_stage_preflight);
    expect(code(dialog)).toEqual([migrationCommands.preflight, migrationCommands.dryRun]);
    expect(within(dialog).getByText(admin.frameleaf_migration_fact_rollback_value)).toBeInTheDocument();

    await next(dialog);
    expect(current()).toContain(admin.frameleaf_migration_stage_review);
    expect(code(dialog)).toEqual([migrationCommands.run, migrationCommands.retry, migrationCommands.verify]);
    expect(within(dialog).getByRole('button', { name: admin.frameleaf_migration_open_report })).toBeInTheDocument();

    await fireEvent.click(within(dialog).getByRole('button', { name: en.back }));
    expect(current()).toContain(admin.frameleaf_migration_stage_preflight);
  });

  it('Done closes the checklist with the template notice; nothing ran', async () => {
    const dialog = await toReview();
    await fireEvent.click(within(dialog).getByRole('button', { name: en.done }));

    expect(screen.queryByRole('dialog')).toBeNull();
    expect(screen.getByRole('status')).toHaveTextContent(admin.frameleaf_migration_checklist_final);
    expect(fetch).not.toHaveBeenCalled();
  });

  it('keeps API keys in the terminal, never in the page', async () => {
    const dialog = await toReview();

    expect(dialog.querySelector('input:not([type="file"]), textarea')).toBeNull();
    expect(migrationCommands.keys).toContain('read -rs IMMICH_FROM_KEY');
    for (const command of Object.values(migrationCommands)) {
      expect(command).not.toMatch(/--(from|to)-key/);
    }
  });

  it('opens a partially failed report read-only with its verdict and unresolved items', async () => {
    await toReview();
    await chooseReport(failedMigrationReport());

    const report = screen.getByRole('dialog', { name: admin.frameleaf_migration_report_title });
    expect(within(report).getAllByText(admin.frameleaf_migration_status_incomplete).length).toBeGreaterThan(0);
    expect(within(report).getByText('Lake morning.jpg')).toBeInTheDocument();
    expect(within(report).getByText('HTTP 404 Not Found')).toBeInTheDocument();
    expect(within(report).getByText('Trips / Banff')).toBeInTheDocument();
    const originals = within(report).getByRole('region', { name: admin.frameleaf_migration_section_originals });
    expect(within(originals).getByText(admin.frameleaf_migration_metric_transferred)).toBeInTheDocument();
    expect(within(originals).getByText(admin.frameleaf_migration_metric_verified)).toBeInTheDocument();

    await fireEvent.click(within(report).getByRole('button', { name: /Albums/ }));
    expect(within(report).queryByText('Lake morning.jpg')).toBeNull();
    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows a pass for a clean report', async () => {
    await toReview();
    await chooseReport(cleanMigrationReport());

    const report = screen.getByRole('dialog', { name: admin.frameleaf_migration_report_title });
    expect(within(report).getAllByText(admin.frameleaf_migration_status_pass).length).toBeGreaterThan(0);
  });

  it('refuses a report carrying a secret or a local path and opens nothing', async () => {
    await toReview();

    await chooseReport({ ...cleanMigrationReport(), from: 'https://user:pw@old.example.com/api' });
    expect(screen.getByRole('alert')).toHaveTextContent(admin.frameleaf_migration_report_error_secret);
    expect(screen.queryByRole('dialog', { name: admin.frameleaf_migration_report_title })).toBeNull();

    const withPath = failedMigrationReport();
    withPath.unresolved[0] = { ...withPath.unresolved[0], detail: 'ENOENT /mnt/photos/library/Lake morning.jpg' };
    await chooseReport(withPath);
    expect(screen.getByRole('alert')).toHaveTextContent(admin.frameleaf_migration_report_error_foreign_path);

    await chooseReport('not json');
    expect(screen.getByRole('alert')).toHaveTextContent(admin.frameleaf_migration_report_error_not_json);
  });
});
