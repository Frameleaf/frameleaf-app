import { IntegrityReport } from '@frameleaf/sdk';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import {
  handleClearIntegrityReports,
  handleDismissIntegrityReport,
  handleRemoveAllIntegrityReportItems,
  handleRemoveIntegrityReportItem,
  integrityActionKey,
} from '$lib/services/integrity.service';

const confirmFrameleaf = vi.fn();
const toastSuccess = vi.fn();
vi.mock('@frameleaf/ui', async (original) => ({
  ...(await original<object>()),
  toastManager: { success: (...args: unknown[]) => toastSuccess(...args) },
}));
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

  it('names the destructive action for what it does, never as clearing a list', () => {
    expect(integrityActionKey(IntegrityReport.UntrackedFile)).toBe('admin.frameleaf_maintenance_report_act_untracked');
    expect(integrityActionKey(IntegrityReport.MissingFile)).toBe('admin.frameleaf_maintenance_report_act_trash');
    expect(integrityActionKey(IntegrityReport.ChecksumMismatch)).toBe('admin.frameleaf_maintenance_report_act_trash');
  });

  it('"Clear this list" forgets one check\'s findings without asking, and says nothing was deleted', async () => {
    sdkMock.clearIntegrityReports.mockResolvedValue({ cleared: 14 });
    const emit = vi.spyOn(eventManager, 'emit');

    expect(await handleClearIntegrityReports(IntegrityReport.UntrackedFile)).toBe(14);

    expect(confirmFrameleaf).not.toHaveBeenCalled();
    expect(sdkMock.clearIntegrityReports).toHaveBeenCalledWith({ $type: IntegrityReport.UntrackedFile });
    expect(sdkMock.createJob).not.toHaveBeenCalled();
    expect(sdkMock.deleteIntegrityReport).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('IntegrityReportDeleted', { type: IntegrityReport.UntrackedFile });
    expect(toastSuccess).toHaveBeenCalledWith('frameleaf_care_list_cleared {"count":14}');
  });

  it('"Remove from list" forgets one finding and leaves its file alone', async () => {
    sdkMock.dismissIntegrityReport.mockResolvedValue(undefined as never);
    const emit = vi.spyOn(eventManager, 'emit');

    expect(await handleDismissIntegrityReport('finding-1')).toBe(true);

    expect(confirmFrameleaf).not.toHaveBeenCalled();
    expect(sdkMock.dismissIntegrityReport).toHaveBeenCalledWith({ id: 'finding-1' });
    expect(sdkMock.deleteIntegrityReport).not.toHaveBeenCalled();
    expect(emit).toHaveBeenCalledWith('IntegrityReportDeleted', { id: 'finding-1' });
    expect(toastSuccess).toHaveBeenCalledWith('frameleaf_care_list_removed');
  });
});
