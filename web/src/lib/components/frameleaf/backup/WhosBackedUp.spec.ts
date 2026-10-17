import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import WhosBackedUp from '$lib/components/frameleaf/backup/WhosBackedUp.svelte';
import en from '../../../../../../i18n/en.json';

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'me' } } }));

const account = (patch: Record<string, unknown>) => ({
  userId: 'someone',
  name: 'Someone',
  email: 'someone@example.test',
  totalOriginals: 3400,
  selectedOriginals: 3400,
  licenceEligible: true,
  includedOriginals: 3400,
  ...patch,
});

describe('Backup › Who’s backed up (FL-362)', () => {
  beforeAll(() => addMessages('dev', en));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('shows each account’s numbers, and never what anyone chose', async () => {
    sdkMock.getCloudBackupCoverage.mockResolvedValue({
      runId: 'run-1',
      inventoryAt: new Date().toISOString(),
      state: 'published',
      accounts: [
        account({ userId: 'me', name: 'Taylor', includedOriginals: 1204, selectedOriginals: 1204 }),
        account({ userId: 'jamie', name: 'Jamie' }),
        account({ userId: 'morgan', name: 'Morgan', licenceEligible: false, includedOriginals: 0 }),
        account({ userId: 'casey', name: 'Casey', includedOriginals: null }),
      ],
    } as never);
    render(WhosBackedUp);

    expect(await screen.findByRole('heading', { name: en.frameleaf_backup_who_title })).toBeInTheDocument();
    expect(await screen.findByText('1,204 of 3,400 photos')).toBeInTheDocument();
    expect(screen.getByText('Taylor (you)')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_backup_who_everything)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_backup_who_no_licence)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_backup_who_unknown)).toBeInTheDocument();
    expect(screen.getByRole('link', { name: en.frameleaf_backup_who_change_mine })).toHaveAttribute(
      'href',
      '/user-settings?area=backup&section=cloud-backup-choice',
    );
    expect(document.body.textContent).not.toMatch(/album|favorite|folder|tag/i);
  });

  it('says when the numbers have not reached Frameleaf Cloud', async () => {
    sdkMock.getCloudBackupCoverage.mockResolvedValue({
      runId: 'run-1',
      inventoryAt: new Date().toISOString(),
      state: 'pending',
      accounts: [account({})],
    } as never);
    render(WhosBackedUp);
    expect(await screen.findByText(/Not reported to Frameleaf Cloud yet/)).toBeInTheDocument();
  });

  it('says nothing has been counted before the first backup', async () => {
    sdkMock.getCloudBackupCoverage.mockResolvedValue({
      runId: null,
      inventoryAt: null,
      state: 'unknown',
      accounts: [],
    } as never);
    render(WhosBackedUp);
    expect(await screen.findByText(en.frameleaf_backup_who_none)).toBeInTheDocument();
  });
});
