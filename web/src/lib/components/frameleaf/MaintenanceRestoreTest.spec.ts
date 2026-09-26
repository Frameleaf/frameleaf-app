import { getBackupRestoreVerification, recordBackupRestoreVerification } from '@immich/sdk';
import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import MaintenanceRestoreTest from '$lib/components/frameleaf/MaintenanceRestoreTest.svelte';
import en from '../../../../../i18n/en.json';

vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  getBackupRestoreVerification: vi.fn(),
  recordBackupRestoreVerification: vi.fn(),
}));

const never = {
  metadataVerifiedAt: null,
  originalsVerifiedAt: null,
  verifiedBy: null,
  overdue: true,
  dueAt: null,
  intervalDays: 90,
};

beforeAll(() => {
  addMessages('dev', en);
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => vi.clearAllMocks());

describe('MaintenanceRestoreTest (FL-71 CC-9)', () => {
  it('shows what has been proved and records a restore test of the parts that restored', async () => {
    vi.mocked(getBackupRestoreVerification).mockResolvedValue(never);
    vi.mocked(recordBackupRestoreVerification).mockResolvedValue({
      ...never,
      originalsVerifiedAt: '2026-09-24T10:00:00.000Z',
      verifiedBy: { id: 'admin', name: 'Ada' },
    });
    render(MaintenanceRestoreTest);

    const card = await screen.findByRole('region', { name: 'Recovery readiness' });
    expect(await within(card).findByText('Due now')).toBeInTheDocument();
    expect(within(card).getAllByText('Not recorded')).toHaveLength(2);

    await fireEvent.click(within(card).getByRole('button', { name: 'Record a restore test' }));
    const dialog = screen.getByRole('dialog', { name: 'Record a restore test' });
    const save = within(dialog).getByRole('button', { name: 'Record restore test' });
    expect(save).toBeDisabled();
    await fireEvent.click(
      within(dialog).getByRole('checkbox', { name: 'Original files restored and their checksums were verified' }),
    );
    await fireEvent.click(save);

    expect(recordBackupRestoreVerification).toHaveBeenCalledWith({
      backupRestoreVerificationRecordDto: { metadata: false, originals: true },
    });
    expect(await within(card).findByText('Last recorded by Ada.')).toBeInTheDocument();
  });
});
