import { IntegrityReport } from '@frameleaf/sdk';
import {
  handleRemoveAllIntegrityReportItems,
  handleRemoveIntegrityReportItem,
  integrityActionKey,
} from '$lib/services/integrity.service';

const confirmFrameleaf = vi.fn();
vi.mock('$lib/frameleaf/confirm', () => ({ confirmFrameleaf: (...args: unknown[]) => confirmFrameleaf(...args) }));
// the keys themselves, so the test reads which wording each check gets
vi.mock('$lib/utils/i18n', () => ({
  getFormatter: () => (key: string, options?: { values?: Record<string, unknown> }) =>
    options?.values ? `${key} ${JSON.stringify(options.values)}` : key,
}));

describe('integrity actions', () => {
  beforeEach(() => {
    confirmFrameleaf.mockReset();
    // declined, so nothing is deleted or queued
    confirmFrameleaf.mockResolvedValue(false);
  });

  it('names what happens to untracked files: they are deleted from disk', async () => {
    await handleRemoveAllIntegrityReportItems(IntegrityReport.UntrackedFile, 12);
    expect(confirmFrameleaf).toHaveBeenCalledWith({
      title: 'admin.frameleaf_maintenance_report_act_untracked_title {"count":12}',
      prompt: 'admin.frameleaf_maintenance_report_delete_untracked',
      confirmText: 'admin.frameleaf_maintenance_report_act_untracked',
      danger: true,
    });
  });

  it('names what happens to photos whose files are missing: they go to Trash, with the unplugged-drive warning', async () => {
    await handleRemoveAllIntegrityReportItems(IntegrityReport.MissingFile, 48_210);
    expect(confirmFrameleaf).toHaveBeenCalledWith({
      title: 'admin.frameleaf_maintenance_report_act_trash_title {"count":48210}',
      prompt: 'admin.frameleaf_maintenance_report_act_missing',
      confirmText: 'admin.frameleaf_maintenance_report_act_trash',
      danger: true,
    });
  });

  it('asks about every finding when only part of the list is loaded', async () => {
    await handleRemoveAllIntegrityReportItems(IntegrityReport.ChecksumMismatch);
    expect(confirmFrameleaf).toHaveBeenCalledWith(
      expect.objectContaining({
        title: 'admin.frameleaf_maintenance_report_act_trash_title {"count":0}',
        prompt: 'admin.frameleaf_maintenance_report_act_checksum',
      }),
    );
  });

  it('names the action on one finding the same way', async () => {
    await handleRemoveIntegrityReportItem('finding-1', IntegrityReport.UntrackedFile);
    expect(confirmFrameleaf).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'admin.frameleaf_maintenance_finding_act_untracked_title',
        confirmText: 'admin.frameleaf_maintenance_finding_act_untracked',
      }),
    );
    await handleRemoveIntegrityReportItem('finding-2', IntegrityReport.MissingFile);
    expect(confirmFrameleaf).toHaveBeenLastCalledWith(
      expect.objectContaining({
        title: 'admin.frameleaf_maintenance_finding_act_trash_title',
        confirmText: 'admin.frameleaf_maintenance_finding_act_trash',
      }),
    );
  });

  it('never offers an action that only clears a list', () => {
    expect(integrityActionKey(IntegrityReport.UntrackedFile)).toBe('admin.frameleaf_maintenance_report_act_untracked');
    expect(integrityActionKey(IntegrityReport.MissingFile)).toBe('admin.frameleaf_maintenance_report_act_trash');
    expect(integrityActionKey(IntegrityReport.ChecksumMismatch)).toBe('admin.frameleaf_maintenance_report_act_trash');
  });
});
