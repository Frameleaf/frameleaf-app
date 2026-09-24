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
    expect(screen.getByRole('article', { name: 'Missing Files' })).toHaveTextContent('Passed');

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
});
