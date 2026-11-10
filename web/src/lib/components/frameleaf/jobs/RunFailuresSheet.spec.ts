import {
  JobRunFailureAction,
  JobRunFailureCause,
  QueueName,
  type JobRunFailureCauseDto,
  type JobRunFailuresResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import en from '$i18n/en.json';
import { durableRun } from '$lib/__mocks__/durable-runs.mock';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import RunFailuresSheet from '$lib/components/frameleaf/jobs/RunFailuresSheet.svelte';
import { commandCenterUrl } from '$lib/frameleaf/settings-areas';
import { Route } from '$lib/route';

vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'u1' }, params: {} } }));

const RUN_ID = '0195e2a0-0000-7000-8000-000000000001';
const group = (overrides: Partial<JobRunFailureCauseDto> = {}): JobRunFailureCauseDto => ({
  cause: JobRunFailureCause.Drive,
  count: 4,
  stopped: 0,
  repaired: 0,
  libraries: [],
  queues: [],
  message: null,
  samples: [],
  ...overrides,
});
const failures = (causes: JobRunFailureCauseDto[]): JobRunFailuresResponseDto => ({
  photos: causes.reduce((sum, { count, stopped }) => sum + count + stopped, 0),
  countsPhotos: true,
  causes,
});
const cause = (title: string) => within(screen.getByText(title, { selector: 'strong' }).closest('li')!);
const open = (props: Partial<{ onChanged: () => void; onClose: () => void }> = {}) =>
  render(RunFailuresSheet, {
    run: durableRun(),
    name: 'Reading photo details',
    onChanged: vi.fn(),
    onClose: vi.fn(),
    ...props,
  });

beforeAll(async () => {
  register('en', () => Promise.resolve(en));
  await init({ fallbackLocale: 'en', initialLocale: 'en' });
  await waitLocale();
  HTMLDialogElement.prototype.showModal ??= function (this: HTMLDialogElement) {
    this.open = true;
  };
  HTMLDialogElement.prototype.close ??= function (this: HTMLDialogElement) {
    this.open = false;
  };
});
beforeEach(() => {
  vi.clearAllMocks();
  sdkMock.getAssetThumbnailPath.mockImplementation((id: string) => `/assets/${id}/thumbnail`);
});

describe('review what failed (FL-1349)', () => {
  it('one action per cause, matched to the cause', async () => {
    sdkMock.getJobRunFailures.mockResolvedValue(
      failures([
        group({ cause: JobRunFailureCause.Drive, count: 7301, libraries: ['Archive'] }),
        group({ cause: JobRunFailureCause.Missing, count: 41 }),
        group({ cause: JobRunFailureCause.Damaged, count: 11, repaired: 8 }),
        group({ cause: JobRunFailureCause.Unsupported, count: 2 }),
        group({ cause: JobRunFailureCause.Other, count: 3 }),
      ]),
    );
    open();
    expect(await screen.findByText('What failed in Reading photo details')).toBeInTheDocument();
    expect(sdkMock.getJobRunFailures).toHaveBeenCalledWith({ id: RUN_ID });
    expect(screen.getByText(/^7,358 photos, 5 causes\. Each cause has one thing to do\./)).toBeInTheDocument();

    const actions = (title: string) =>
      cause(title)
        .queryAllByRole('button')
        .concat(cause(title).queryAllByRole('link'))
        .map((element) => element.textContent?.trim())
        .filter((label) => label !== 'Show photos' && label !== 'Technical details');
    expect(actions('A drive can’t be reached')).toEqual(['Try again now']);
    expect(cause('A drive can’t be reached').getByText(/external library “Archive”/)).toBeInTheDocument();
    expect(cause('A drive can’t be reached').getByText('7,301 photos')).toBeInTheDocument();
    expect(actions('Original missing')).toEqual(['Open in Library care']);
    expect(cause('Original missing').getByRole('link', { name: 'Open in Library care' })).toHaveAttribute(
      'href',
      commandCenterUrl('care', 'files'),
    );
    expect(actions('Damaged file')).toEqual(['Open in Library care']);
    expect(cause('Damaged file').getByText(/repaired 8 of these by itself/)).toBeInTheDocument();
    expect(actions('A kind of file Frameleaf can’t open')).toEqual(['Stop trying']);
    expect(actions('Couldn’t be finished this time')).toEqual(['Try again now']);
  });

  it('another account’s photo shows a lock, never a thumbnail request', async () => {
    sdkMock.getJobRunFailures.mockResolvedValue(
      failures([
        group({
          cause: JobRunFailureCause.Damaged,
          count: 11,
          samples: [
            { assetId: 'mine-1', fileName: 'scan-014.jpg', ownerName: 'Taylor', pictureAllowed: true },
            { assetId: 'theirs-1', fileName: 'IMG_3310.PNG', ownerName: 'Jamie', pictureAllowed: false },
          ],
        }),
      ]),
    );
    open();
    await fireEvent.click(await screen.findByRole('button', { name: 'Show photos' }));
    const images = [...document.querySelectorAll('img')];
    expect(images).toHaveLength(1);
    expect(images[0].getAttribute('src')).toContain('mine-1');
    expect(document.body.getHTML()).not.toContain('theirs-1');
    expect(screen.getByText('IMG_3310.PNG')).toBeInTheDocument();
    expect(screen.getByText('Only Jamie sees this photo and can undo or replace it.')).toBeInTheDocument();
    // The owner is said once: in the note, not again as a column.
    expect(screen.queryByText('Jamie')).not.toBeInTheDocument();
    expect(screen.getByText('Taylor')).toBeInTheDocument();
    // A damaged photo often has no thumbnail: the row falls back to the plain tile.
    await fireEvent.error(images[0]);
    expect(document.querySelectorAll('img')).toHaveLength(0);
    expect(screen.getByText('scan-014.jpg')).toBeInTheDocument();
    expect(screen.getByText('and 9 more')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Hide photos' })).toHaveAttribute('aria-expanded', 'true');
  });

  it('Stop trying sends {cause:"unsupported", action:"stop"} and says Stopped', async () => {
    const onChanged = vi.fn();
    sdkMock.getJobRunFailures.mockResolvedValue(failures([group({ cause: JobRunFailureCause.Unsupported, count: 2 })]));
    sdkMock.actOnJobRunFailures.mockResolvedValue({ count: 2 });
    open({ onChanged });
    await fireEvent.click(await screen.findByRole('button', { name: 'Stop trying' }));
    await waitFor(() =>
      expect(sdkMock.actOnJobRunFailures).toHaveBeenCalledWith({
        id: RUN_ID,
        jobRunFailureActionDto: { cause: JobRunFailureCause.Unsupported, action: JobRunFailureAction.Stop },
      }),
    );
    expect(
      await screen.findByText('Stopped. These 2 files are kept as they are and won’t be tried again.'),
    ).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: 'Stop trying' })).not.toBeInTheDocument();
    expect(onChanged).toHaveBeenCalledTimes(1);
    // The sheet reads again, so its totals and stopped lines are current.
    await waitFor(() => expect(sdkMock.getJobRunFailures).toHaveBeenCalledTimes(2));
  });
  it('says tasks when the work counts tasks', async () => {
    sdkMock.getJobRunFailures.mockResolvedValue({
      ...failures([
        group({ cause: JobRunFailureCause.Other, count: 3 }),
        group({ cause: JobRunFailureCause.Unsupported, count: 2 }),
      ]),
      countsPhotos: false,
    });
    sdkMock.actOnJobRunFailures.mockResolvedValueOnce({ count: 3 }).mockResolvedValueOnce({ count: 2 });
    open();
    await fireEvent.click(await screen.findByRole('button', { name: 'Try again now' }));
    expect(await screen.findByText('Trying 3 tasks again.')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Stop trying' }));
    expect(await screen.findByText('Stopped. These 2 tasks won’t be tried again.')).toBeInTheDocument();
    // Nothing in the sheet's own words says photos (the run's name is the caller's).
    expect(document.querySelector('.lead')?.textContent).not.toMatch(/photo/);
    expect(document.querySelector('.causes')?.textContent).not.toMatch(/photo/);
  });

  it('Try again now says how many photos go back', async () => {
    sdkMock.getJobRunFailures.mockResolvedValue(failures([group({ cause: JobRunFailureCause.Drive, count: 19 })]));
    sdkMock.actOnJobRunFailures.mockResolvedValue({ count: 19 });
    open();
    await fireEvent.click(await screen.findByRole('button', { name: 'Try again now' }));
    expect(await screen.findByText('Trying 19 photos again.')).toBeInTheDocument();
    expect(sdkMock.actOnJobRunFailures).toHaveBeenCalledWith({
      id: RUN_ID,
      jobRunFailureActionDto: { cause: JobRunFailureCause.Drive, action: JobRunFailureAction.Retry },
    });
  });

  it('Technical details links to the failed list', async () => {
    sdkMock.getJobRunFailures.mockResolvedValue(
      failures([
        group({
          cause: JobRunFailureCause.Damaged,
          count: 3,
          message: 'VipsJpeg: premature end of JPEG image',
          queues: [QueueName.ThumbnailGeneration],
        }),
      ]),
    );
    open();
    await screen.findByText('Damaged file', { selector: 'strong' });
    const details = cause('Damaged file');
    await fireEvent.click(details.getByText('Technical details'));
    expect(details.getByText('VipsJpeg: premature end of JPEG image')).toBeInTheDocument();
    expect(details.getByRole('link', { name: 'Open the full list, one row per photo' })).toHaveAttribute(
      'href',
      Route.viewQueue({ name: QueueName.ThumbnailGeneration, tab: 'failed' }),
    );
  });

  it('keeps up with a run that is still going, and keeps an expanded cause open', async () => {
    const sample = { assetId: 'mine-1', fileName: 'scan-014.jpg', ownerName: 'Taylor', pictureAllowed: true };
    sdkMock.getJobRunFailures.mockResolvedValueOnce(
      failures([group({ cause: JobRunFailureCause.Unsupported, count: 2, samples: [sample] })]),
    );
    const run = durableRun({ leftOver: 2, failureCauses: [{ cause: JobRunFailureCause.Unsupported, count: 2 }] });
    const { rerender } = render(RunFailuresSheet, { run, name: 'Thumbnails', onChanged: vi.fn(), onClose: vi.fn() });
    await fireEvent.click(await screen.findByRole('button', { name: 'Show photos' }));
    expect(screen.getByText('2 photos')).toBeInTheDocument();

    // Recent work's poll brings more left over: the sheet reads again, and what was open stays open.
    sdkMock.getJobRunFailures.mockResolvedValueOnce(
      failures([group({ cause: JobRunFailureCause.Unsupported, count: 9, samples: [sample] })]),
    );
    await rerender({
      run: { ...run, leftOver: 9, failureCauses: [{ cause: JobRunFailureCause.Unsupported, count: 9 }] },
    });
    expect(await screen.findByText('9 photos')).toBeInTheDocument();
    expect(sdkMock.getJobRunFailures).toHaveBeenCalledTimes(2);
    expect(screen.getByRole('button', { name: 'Hide photos' })).toHaveAttribute('aria-expanded', 'true');
    expect(screen.getByText('and 8 more')).toBeInTheDocument();

    // The same run read again unchanged reads nothing.
    await rerender({
      run: { ...run, leftOver: 9, failureCauses: [{ cause: JobRunFailureCause.Unsupported, count: 9 }] },
    });
    expect(sdkMock.getJobRunFailures).toHaveBeenCalledTimes(2);
  });

  it('says so when what failed cannot be loaded', async () => {
    sdkMock.getJobRunFailures.mockRejectedValue(new Error('offline'));
    open();
    expect(await screen.findByText('What failed couldn’t be loaded. Try again in a moment.')).toBeInTheDocument();
  });
});
