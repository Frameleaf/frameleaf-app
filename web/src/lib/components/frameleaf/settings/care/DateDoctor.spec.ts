import { DateFindingCause, type DateDoctorBatchDto, type DateDoctorFindingDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../../i18n/en.json';
import DateDoctor from './DateDoctor.svelte';

/** Library care › Dates that look wrong (FL-943): cards by what went wrong, the fix previewed, Undo for 30 days. */
const A = '11111111-1111-4111-8111-111111111111';
const B = '22222222-2222-4222-8222-222222222222';
const C = '33333333-3333-4333-8333-333333333333';

/** A Sony on UTC in the Rockies: every photo 7 hours later than it was taken. */
const drift = (assetId: string, current: string, proposed: string): DateDoctorFindingDto => ({
  assetId,
  cause: DateFindingCause.BurstDrift,
  confidence: 0.9,
  currentDate: current,
  currentZone: 'America/Edmonton',
  proposedDate: proposed,
  proposedZone: 'America/Edmonton',
});
const reset: DateDoctorFindingDto = {
  assetId: C,
  cause: DateFindingCause.EpochDate,
  confidence: 0.5,
  currentDate: '1970-01-01T00:00:00.000Z',
  currentZone: null,
  proposedDate: null,
  proposedZone: null,
};
const findings = (scanning = false) => ({
  total: 3,
  scanning,
  groups: [
    {
      groupKey: 'Sony A7 IV|2026-08-12',
      camera: 'Sony A7 IV',
      day: '2026-08-12',
      findings: [drift(A, '2026-08-12T22:40:00.000Z', '2026-08-12T15:40:00.000Z')],
    },
    {
      groupKey: 'Sony A7 IV|2026-08-14',
      camera: 'Sony A7 IV',
      day: '2026-08-14',
      findings: [drift(B, '2026-08-14T23:05:00.000Z', '2026-08-14T16:05:00.000Z')],
    },
    { groupKey: 'unknown|1970-01-01', camera: null, day: '1970-01-01', findings: [reset] },
  ],
});
const batch = (overrides: Partial<DateDoctorBatchDto> = {}): DateDoctorBatchDto => ({
  id: 'batch-1',
  cause: DateFindingCause.BurstDrift,
  count: 2,
  createdAt: new Date().toISOString(),
  expiresAt: new Date(Date.now() + 30 * 86_400_000).toISOString(),
  shiftMinutes: -420,
  timeZone: null,
  undoneAt: null,
  ...overrides,
});
const time = (date: string, local: string) => ({ date, zone: 'America/Edmonton', local });

const hero = () => within(screen.getByRole('region', { name: 'Date & Time Doctor' }));
const card = async (name: RegExp) => within(await screen.findByRole('article', { name }));

describe('Date & Time Doctor (FL-943)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getDateDoctorFindings.mockResolvedValue(findings());
    sdkMock.getDateFixBatches.mockResolvedValue([]);
    sdkMock.previewDateFix.mockImplementation(({ dateDoctorFixDto }) =>
      Promise.resolve({
        items: dateDoctorFixDto.assetIds.map((assetId) =>
          assetId === A
            ? {
                assetId,
                before: time('2026-08-12T22:40:00.000Z', '2026-08-12T16:40:00'),
                after: time('2026-08-12T15:40:00.000Z', '2026-08-12T09:40:00'),
              }
            : {
                assetId,
                before: time('2026-08-14T23:05:00.000Z', '2026-08-14T17:05:00'),
                after: time('2026-08-14T16:05:00.000Z', '2026-08-14T10:05:00'),
              },
        ),
      }),
    );
    sdkMock.applyDateFix.mockResolvedValue({ batch: batch(), skipped: [] });
    sdkMock.undoDateFix.mockResolvedValue(batch({ undoneAt: new Date().toISOString(), restored: 2 }));
    sdkMock.scanDateDoctor.mockResolvedValue(undefined as never);
    sdkMock.getBaseUrl.mockReturnValue('/api');
    sdkMock.getAssetThumbnailPath.mockImplementation((id: string) => `/assets/${id}/thumbnail`);
  });

  it("groups a camera's whole trip into one card, with its fix previewed before and after", async () => {
    render(DateDoctor);

    expect(
      await hero().findByRole('heading', { name: '3 photos may have the wrong date or time' }),
    ).toBeInTheDocument();
    // two days of the same camera and shift are one card, said in a sentence
    const clock = await card(/The clock on Sony A7 IV was 7 hours ahead on Aug 12\s*–\s*14, 2026/);
    expect(clock.getByText('2 photos')).toBeInTheDocument();
    expect(sdkMock.previewDateFix).toHaveBeenCalledWith({
      dateDoctorFixDto: { assetIds: [A, B], useProposal: true },
    });
    // the clock time where it was, then the time after the fix, with the zone's name on that day
    expect(await clock.findByText(/^Aug 12, 2026, 4:40\sPM MDT$/)).toBeInTheDocument();
    expect(clock.getByText(/^Aug 12, 2026, 9:40\sAM MDT$/)).toBeInTheDocument();
    expect(clock.getByRole('button', { name: 'Fix 2 photos' })).toBeInTheDocument();
  });

  it('points photos with nothing to go on at Library, and Not now puts a card off', async () => {
    render(DateDoctor);

    const resetCard = await card(/1 photo has a date a camera clock resets to/);
    expect(await resetCard.findByRole('link', { name: 'Show them in Library' })).toHaveAttribute('href', '/photos');
    expect(resetCard.queryByRole('button', { name: /Fix/ })).not.toBeInTheDocument();
    await fireEvent.click(resetCard.getByRole('button', { name: 'Not now' }));
    expect(screen.queryByRole('article', { name: /camera clock resets to/ })).not.toBeInTheDocument();
    // a card put off for now still counts: those dates still look wrong
    expect(hero().getByRole('heading', { name: '3 photos may have the wrong date or time' })).toBeInTheDocument();
  });

  it('applies a fix, says so, and lists it under Recent fixes with Undo', async () => {
    render(DateDoctor);
    const clock = await card(/The clock on Sony A7 IV/);
    sdkMock.getDateDoctorFindings.mockResolvedValue({ total: 1, scanning: false, groups: [findings().groups[2]] });
    sdkMock.getDateFixBatches.mockResolvedValue([batch()]);

    await fireEvent.click(await clock.findByRole('button', { name: 'Fix 2 photos' }));

    expect(sdkMock.applyDateFix).toHaveBeenCalledWith({
      dateDoctorFixDto: { assetIds: [A, B], useProposal: true },
    });
    expect(
      await screen.findByText(/2 photos were fixed\. You can undo it under Recent fixes for 30 days\./),
    ).toBeInTheDocument();
    expect(screen.queryByRole('article', { name: /The clock on Sony A7 IV/ })).not.toBeInTheDocument();

    const recent = within(screen.getByRole('list', { name: 'Recent fixes' }));
    sdkMock.getDateFixBatches.mockResolvedValue([batch({ undoneAt: new Date().toISOString() })]);
    await fireEvent.click(recent.getByRole('button', { name: 'Undo the fix of 2 photos' }));

    expect(sdkMock.undoDateFix).toHaveBeenCalledWith({ id: 'batch-1' });
    expect(await screen.findByText('2 photos are back at their old times.')).toBeInTheDocument();
    expect(await recent.findByText('Undone')).toBeInTheDocument();
  });

  it('says how many photos were left as they were', async () => {
    sdkMock.applyDateFix.mockResolvedValue({ batch: batch({ count: 1 }), skipped: [B] });
    render(DateDoctor);

    await fireEvent.click(await (await card(/The clock on Sony A7 IV/)).findByRole('button', { name: 'Fix 2 photos' }));

    expect(
      await screen.findByText(/^1 photo was fixed\. .* 1 photo was left as it was: it already had that time/),
    ).toBeInTheDocument();
  });

  it('says when the recent fixes cannot be read, and reads them again', async () => {
    sdkMock.getDateFixBatches.mockRejectedValue(new Error('offline'));
    render(DateDoctor);

    expect(await screen.findByText(en.frameleaf_date_doctor_recent_failed)).toBeInTheDocument();
    sdkMock.getDateFixBatches.mockResolvedValue([batch()]);
    await fireEvent.click(screen.getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('button', { name: 'Undo the fix of 2 photos' })).toBeInTheDocument();
  });

  it('asks for the PIN when a photo of the fix was Locked since, then undoes it (FL-930)', async () => {
    sdkMock.getDateFixBatches.mockResolvedValue([batch()]);
    sdkMock.isHttpError.mockReturnValueOnce(true);
    sdkMock.undoDateFix.mockRejectedValueOnce({
      status: 400,
      data: { message: 'Not found or no asset.update access', statusCode: 400 },
    });
    render(DateDoctor);

    await fireEvent.click(await screen.findByRole('button', { name: 'Undo the fix of 2 photos' }));

    expect(await screen.findByRole('dialog')).toBeInTheDocument();
    expect(screen.queryByText('2 photos are back at their old times.')).not.toBeInTheDocument();
  });

  it('says every date looks right when nothing was found', async () => {
    sdkMock.getDateDoctorFindings.mockResolvedValue({ total: 0, scanning: false, groups: [] });
    render(DateDoctor);

    expect(await hero().findByRole('heading', { name: 'Every date looks right' })).toBeInTheDocument();
    expect(screen.queryByRole('article')).not.toBeInTheDocument();
  });

  it('says a check is running, and reads the findings again once Check again is pressed', async () => {
    sdkMock.getDateDoctorFindings.mockResolvedValue({ total: 0, scanning: false, groups: [] });
    render(DateDoctor);
    sdkMock.getDateDoctorFindings.mockResolvedValue({ total: 0, scanning: true, groups: [] });

    await fireEvent.click(await hero().findByRole('button', { name: 'Check again' }));

    expect(sdkMock.scanDateDoctor).toHaveBeenCalled();
    expect(await hero().findByRole('heading', { name: 'Checking the dates in your photos…' })).toBeInTheDocument();
    expect(hero().queryByRole('button', { name: 'Check again' })).not.toBeInTheDocument();
  });

  it('says when the findings cannot be read, with Try again', async () => {
    sdkMock.getDateDoctorFindings.mockRejectedValue(new Error('offline'));
    render(DateDoctor);

    expect(await hero().findByRole('heading', { name: 'The dates couldn’t be checked' })).toBeInTheDocument();
    sdkMock.getDateDoctorFindings.mockResolvedValue(findings());
    await fireEvent.click(hero().getByRole('button', { name: 'Try again' }));
    await waitFor(() => expect(screen.getAllByRole('article')).toHaveLength(2));
  });
});
