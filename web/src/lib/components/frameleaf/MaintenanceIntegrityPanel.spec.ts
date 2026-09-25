import { IntegrityReport, ManualJobName } from '@immich/sdk';
import { fireEvent, render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, describe, expect, it, vi } from 'vitest';
import en from '../../../../../i18n/en.json';
import MaintenanceIntegrityPanel from './MaintenanceIntegrityPanel.svelte';

const handleRemoveAllIntegrityReportItems = vi.fn();

vi.mock('$lib/services/integrity.service', () => ({
  handleRemoveAllIntegrityReportItems: (...args: unknown[]) => handleRemoveAllIntegrityReportItems(...args),
}));

const jobNames = {
  [IntegrityReport.UntrackedFile]: ManualJobName.IntegrityUntrackedFiles,
  [IntegrityReport.MissingFile]: ManualJobName.IntegrityMissingFiles,
  [IntegrityReport.ChecksumMismatch]: ManualJobName.IntegrityChecksumMismatch,
};

const props = (activeJobs = new Set<ManualJobName>()) => ({
  reportTypes: [IntegrityReport.UntrackedFile, IntegrityReport.MissingFile, IntegrityReport.ChecksumMismatch],
  integrityReport: { untracked_file: 2, missing_file: 0, checksum_mismatch: 1 },
  jobNames,
  activeJobs,
  getReportTypeTranslation: (type: IntegrityReport) => `admin.maintenance_integrity_${type}` as never,
  getReportTypeDescriptionKey: (type: IntegrityReport) => `admin.maintenance_integrity_${type}_description` as never,
  onCheck: vi.fn(),
  onCheckAll: vi.fn(),
});

describe('MaintenanceIntegrityPanel (FL-81 CC-21/22)', () => {
  beforeAll(() => {
    addMessages('dev', en);
  });

  it('shows each check with its status and findings, and a reports list', async () => {
    const p = props();
    render(MaintenanceIntegrityPanel, p);

    const untracked = screen.getByRole('article', { name: 'Untracked Files' });
    expect(untracked).toHaveTextContent('Issues found');
    expect(untracked).toHaveTextContent('2 findings');
    expect(screen.getByRole('article', { name: 'Missing Files' })).toHaveTextContent('No issues');

    const reports = screen.getByRole('list', { name: 'Integrity reports' });
    expect(reports.querySelectorAll('[role="listitem"]')).toHaveLength(2);

    await fireEvent.click(screen.getByRole('button', { name: 'Run all checks' }));
    expect(p.onCheckAll).toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Delete Untracked Files report' }));
    expect(handleRemoveAllIntegrityReportItems).toHaveBeenCalledWith(IntegrityReport.UntrackedFile);
  });

  it('shows a running check', () => {
    render(MaintenanceIntegrityPanel, props(new Set([ManualJobName.IntegrityMissingFiles])));
    const missing = screen.getByRole('article', { name: 'Missing Files' });
    expect(missing).toHaveTextContent('Running');
    expect(screen.getByRole('button', { name: 'Running…' })).toBeDisabled();
  });

  it('reads "Last run …" or "No completed run recorded" per check, with its findings (Maintenance.jsx:466-469)', () => {
    render(MaintenanceIntegrityPanel, {
      ...props(),
      integrityReport: { untracked_file: 2, missing_file: 0, checksum_mismatch: 1 },
      runs: { untracked_file: '2026-09-20T10:15:00.000Z', missing_file: null, checksum_mismatch: null },
    });

    const untracked = screen.getByRole('article', { name: 'Untracked Files' });
    expect(untracked).toHaveTextContent(/Last run .*2026.* · 2 findings/);
    const missing = screen.getByRole('article', { name: 'Missing Files' });
    expect(missing).toHaveTextContent('No completed run recorded');
    expect(missing).not.toHaveTextContent('findings');
    expect(missing).toHaveTextContent('Not recorded');
    expect(missing).not.toHaveTextContent('No issues');
    // A check with findings from before runs were recorded still reads its findings.
    expect(screen.getByRole('article', { name: 'Checksum Mismatch' })).toHaveTextContent(
      'No completed run recorded · 1 finding',
    );
  });

  it('reads "0 findings" after a clean run', () => {
    render(MaintenanceIntegrityPanel, {
      ...props(),
      runs: { untracked_file: null, missing_file: '2026-09-20T10:15:00.000Z', checksum_mismatch: null },
    });

    const missing = screen.getByRole('article', { name: 'Missing Files' });
    expect(missing).toHaveTextContent(/Last run .* · 0 findings/);
    expect(missing).toHaveTextContent('No issues');
  });
});
