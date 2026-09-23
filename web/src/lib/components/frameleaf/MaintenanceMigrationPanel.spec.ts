import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import MaintenanceMigrationPanel, {
  migrationCommands,
} from '$lib/components/frameleaf/MaintenanceMigrationPanel.svelte';
import { cleanMigrationReport, failedMigrationReport } from '@test-data/frameleaf/migration-report';
import en from '../../../../../i18n/en.json';

/**
 * FL-75: the Maintenance area surfaces the command-line migration and opens its audit
 * report read-only. No request is made and no key is ever typed into the page.
 */

const admin = en.admin;

const chooseReport = async (value: unknown, name = 'library-move.sqlite.audit.json') => {
  const input = screen.getByTestId('migration-report-input') as HTMLInputElement;
  const file = new File([typeof value === 'string' ? value : JSON.stringify(value)], name, {
    type: 'application/json',
  });
  Object.defineProperty(input, 'files', { value: [file], configurable: true });
  await fireEvent.change(input);
  // file.text() resolves on a later task.
  await new Promise((resolve) => setTimeout(resolve, 0));
};

beforeEach(() => {
  addMessages('dev', en);
  vi.spyOn(globalThis, 'fetch');
});

afterEach(() => {
  vi.restoreAllMocks();
});

describe('MaintenanceMigrationPanel', () => {
  it('shows the exact preflight, dry-run, resume, retry and verify commands', () => {
    render(MaintenanceMigrationPanel);

    for (const command of [
      migrationCommands.preflight,
      migrationCommands.dryRun,
      migrationCommands.run,
      migrationCommands.retry,
      migrationCommands.verify,
    ]) {
      expect(screen.getByText(command)).toBeInTheDocument();
    }
    expect(migrationCommands.preflight).toContain('--preflight');
    expect(migrationCommands.dryRun).toContain('--dry-run');
    expect(migrationCommands.retry).toContain('--retry-failed');
    expect(migrationCommands.verify).toContain('--verify');
    // The resume command is the run command itself, with the same ledger.
    expect(migrationCommands.run).toContain('--ledger ./library-move.sqlite');
  });

  it('keeps API keys in the terminal, never in the page', () => {
    const { container } = render(MaintenanceMigrationPanel);

    expect(container.querySelector('input:not([type="file"]), textarea')).toBeNull();
    expect(migrationCommands.keys).toContain('read -rs IMMICH_FROM_KEY');
    expect(migrationCommands.keys).toContain('read -rs IMMICH_TO_KEY');
    for (const command of Object.values(migrationCommands)) {
      expect(command).not.toMatch(/--(from|to)-key/);
    }
  });

  it('opens a partially failed report read-only with its verdict and unresolved items', async () => {
    render(MaintenanceMigrationPanel);
    await chooseReport(failedMigrationReport());

    const dialog = screen.getByRole('dialog', { name: admin.frameleaf_migration_report_title });
    expect(within(dialog).getAllByText(admin.frameleaf_migration_status_incomplete).length).toBeGreaterThan(0);
    expect(within(dialog).getByText('Lake morning.jpg')).toBeInTheDocument();
    expect(within(dialog).getByText('HTTP 404 Not Found')).toBeInTheDocument();
    expect(within(dialog).getByText('Trips / Banff')).toBeInTheDocument();
    expect(within(dialog).getByText(admin.frameleaf_migration_reason_not_linked)).toBeInTheDocument();
    expect(within(dialog).getByText(/owner@old\.example\.com on the source/)).toBeInTheDocument();

    // Transferred and verified are shown separately.
    const originals = within(dialog).getByRole('region', { name: admin.frameleaf_migration_section_originals });
    expect(within(originals).getByText(admin.frameleaf_migration_metric_transferred)).toBeInTheDocument();
    expect(within(originals).getByText(admin.frameleaf_migration_metric_verified)).toBeInTheDocument();

    // Filtering to albums hides the original.
    await fireEvent.click(within(dialog).getByRole('button', { name: /Albums/ }));
    expect(within(dialog).queryByText('Lake morning.jpg')).toBeNull();
    expect(within(dialog).getByText('Trips / Banff')).toBeInTheDocument();

    expect(fetch).not.toHaveBeenCalled();
  });

  it('shows a pass for a clean report', async () => {
    render(MaintenanceMigrationPanel);
    await chooseReport(cleanMigrationReport());

    const dialog = screen.getByRole('dialog', { name: admin.frameleaf_migration_report_title });
    expect(within(dialog).getAllByText(admin.frameleaf_migration_status_pass).length).toBeGreaterThan(0);
    expect(within(dialog).getByText(admin.frameleaf_migration_unresolved_none)).toBeInTheDocument();
  });

  it('refuses a report carrying a secret or a local path and opens nothing', async () => {
    render(MaintenanceMigrationPanel);

    await chooseReport({ ...cleanMigrationReport(), from: 'https://user:pw@old.example.com/api' });
    expect(screen.getByRole('alert')).toHaveTextContent(admin.frameleaf_migration_report_error_secret);
    expect(screen.queryByRole('dialog')).toBeNull();

    const withPath = failedMigrationReport();
    withPath.unresolved[0] = { ...withPath.unresolved[0], detail: 'ENOENT /mnt/photos/library/Lake morning.jpg' };
    await chooseReport(withPath);
    expect(screen.getByRole('alert')).toHaveTextContent(admin.frameleaf_migration_report_error_foreign_path);
    expect(screen.queryByRole('dialog')).toBeNull();

    await chooseReport('not json');
    expect(screen.getByRole('alert')).toHaveTextContent(admin.frameleaf_migration_report_error_not_json);
  });
});
