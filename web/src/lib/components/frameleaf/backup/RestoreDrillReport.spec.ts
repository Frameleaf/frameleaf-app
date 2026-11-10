import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RestoreDrillReport from '$lib/components/frameleaf/backup/RestoreDrillReport.svelte';
import en from '../../../../../../i18n/en.json';

describe('RestoreDrillReport (FL-900)', () => {
  beforeAll(() => addMessages('dev', en));

  it('shows what was checked, the failed step, what was not reached, and the signing key', async () => {
    sdkMock.getCloudBackupDrill.mockResolvedValue({
      id: 'd1',
      target: 'byo-s3',
      trigger: 'manual',
      startedAt: '2026-11-08T03:40:00.000Z',
      finishedAt: '2026-11-08T03:41:00.000Z',
      result: 'failed',
      failedStep: 'rebuild',
      backupFrom: '2026-11-08T02:00:00.000Z',
      library: { items: 3, photos: 2, videos: 1, albums: 0 },
      restored: null,
      sampleSize: 3,
      checked: 0,
      matched: 0,
      mismatches: [],
      durationSeconds: 61,
      keyFingerprint: 'AbCdEfGh12',
      signed: true,
    } as never);
    render(RestoreDrillReport, { id: 'd1' });

    expect(await screen.findByRole('heading', { name: /^Failed · / })).toBeInTheDocument();
    expect(screen.getByText('The library data in the backup couldn’t be rebuilt.')).toBeInTheDocument();
    expect(screen.getAllByText('Not reached').length).toBeGreaterThanOrEqual(2);
    expect(screen.getByText('2 photos and 1 video')).toBeInTheDocument();
    expect(screen.getByText('1 minute 1 second')).toBeInTheDocument();
    expect(screen.getByText('AbCd EfGh 12')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Download report/ })).toBeEnabled();
    expect(screen.getByRole('button', { name: /Print/ })).toBeInTheDocument();
  });
});
