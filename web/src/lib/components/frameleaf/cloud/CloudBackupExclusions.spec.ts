import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import CloudBackupExclusions from '$lib/components/frameleaf/cloud/CloudBackupExclusions.svelte';
import en from '../../../../../../i18n/en.json';

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'me' } } }));

const counts = (patch: Record<string, number>) => ({ selection: 0, licence: 0, notCommitted: 0, unknown: 0, ...patch });

describe('Cloud Backup › What this backup doesn’t hold (FL-362)', () => {
  beforeAll(() => addMessages('dev', en));

  beforeEach(() => {
    vi.clearAllMocks();
  });

  it('labels a deliberate exclusion apart from licence and not-yet, per account', async () => {
    sdkMock.getCloudBackupManifestExclusions.mockResolvedValue({
      manifestKey: 'm/20261016T120000Z.json.gz',
      decisionKnown: true,
      totals: counts({ selection: 2196, licence: 40, notCommitted: 3 }),
      accounts: [
        { userId: 'me', name: 'Taylor', ...counts({ selection: 2196 }) },
        { userId: 'morgan', name: 'Morgan', ...counts({ licence: 40, notCommitted: 3 }) },
      ],
    } as never);
    render(CloudBackupExclusions, { manifestKey: 'm/20261016T120000Z.json.gz' });

    expect(await screen.findByText(en.frameleaf_backup_exclusion_selection)).toBeInTheDocument();
    expect(screen.getByText('2,196 items')).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_backup_exclusion_licence)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_backup_exclusion_not_committed)).toBeInTheDocument();
    expect(screen.getByText('Taylor (you)')).toBeInTheDocument();
    expect(sdkMock.getCloudBackupManifestExclusions).toHaveBeenCalledWith({
      cloudBackupExclusionsDto: { manifestKey: 'm/20261016T120000Z.json.gz' },
    });
  });

  it('says another account’s exclusions are its own choice', async () => {
    sdkMock.getCloudBackupManifestExclusions.mockResolvedValue({
      manifestKey: 'm/20261016T120000Z.json.gz',
      decisionKnown: true,
      totals: counts({ selection: 1 }),
      accounts: [{ userId: 'jamie', name: 'Jamie', ...counts({ selection: 1 }) }],
    } as never);
    render(CloudBackupExclusions, { manifestKey: 'm/20261016T120000Z.json.gz' });
    expect(await screen.findByText(en.frameleaf_backup_exclusion_selection_other)).toBeInTheDocument();
  });

  it('never claims a reason an older backup did not record', async () => {
    sdkMock.getCloudBackupManifestExclusions.mockResolvedValue({
      manifestKey: 'm/20261001T120000Z.json.gz',
      decisionKnown: false,
      totals: counts({ unknown: 5 }),
      accounts: [{ userId: 'jamie', name: 'Jamie', ...counts({ unknown: 5 }) }],
    } as never);
    render(CloudBackupExclusions, { manifestKey: 'm/20261001T120000Z.json.gz' });
    expect(await screen.findByText(en.frameleaf_backup_exclusion_older)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_backup_exclusion_unknown)).toBeInTheDocument();
    expect(screen.queryByText(en.frameleaf_backup_exclusion_selection_other)).toBeNull();
  });

  it('says so when every item has its original', async () => {
    sdkMock.getCloudBackupManifestExclusions.mockResolvedValue({
      manifestKey: 'm/20261016T120000Z.json.gz',
      decisionKnown: true,
      totals: counts({}),
      accounts: [],
    } as never);
    render(CloudBackupExclusions, { manifestKey: 'm/20261016T120000Z.json.gz' });
    expect(await screen.findByText(en.frameleaf_backup_exclusion_none)).toBeInTheDocument();
  });
});
