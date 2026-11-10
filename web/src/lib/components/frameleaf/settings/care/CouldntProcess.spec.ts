import { ProcessingFailureStep, type ProcessingFailureResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../../i18n/en.json';
import CouldntProcess from './CouldntProcess.svelte';

/** Library care › Couldn't process (FL-862): the list in words, Try again, Download original and Keep as is. */
const auth = vi.hoisted(() => ({ user: { id: 'taylor', isAdmin: false } }));
const utils = vi.hoisted(() => ({ downloadUrl: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    ...auth,
    get user() {
      return auth.user;
    },
    params: {},
  },
}));
vi.mock('$lib/utils', async (original) => ({ ...(await original<object>()), downloadUrl: utils.downloadUrl }));

const failure = (overrides: Partial<ProcessingFailureResponseDto> = {}): ProcessingFailureResponseDto => ({
  assetId: '11111111-1111-4111-8111-111111111111',
  step: ProcessingFailureStep.AssetEncodeVideo,
  cause: 'unreadable',
  attempts: 3,
  lastFailedAt: '2026-11-08T08:00:00.000Z',
  quarantinedAt: '2026-11-08T08:00:00.000Z',
  ownerId: 'taylor',
  ownerName: 'Taylor',
  fileName: 'VID_20260813_0912.MOV',
  ...overrides,
});
const panorama = failure({
  assetId: '22222222-2222-4222-8222-222222222222',
  step: ProcessingFailureStep.AssetGenerateThumbnails,
  cause: 'too-large',
  attempts: 1,
  quarantinedAt: null,
  fileName: 'PANO_0042.JPG',
});
const morgans = failure({
  assetId: '33333333-3333-4333-8333-333333333333',
  step: ProcessingFailureStep.AssetGenerateThumbnails,
  cause: 'unsupported',
  attempts: 1,
  quarantinedAt: null,
  ownerId: 'morgan',
  ownerName: 'Morgan',
  fileName: 'DSC09912.ARW',
});

const hero = () => within(screen.getByRole('region', { name: en.frameleaf_cc_section_couldnt_process }));
const fileRow = (name: string) =>
  within(
    screen
      .getAllByText(name, { exact: false })
      .map((element) => element.closest('li'))
      .find(Boolean)!,
  );

describe("Couldn't process (FL-862)", () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getProcessingFailures.mockReset();
    auth.user = { id: 'taylor', isAdmin: false };
    sdkMock.getProcessingFailures.mockResolvedValue([failure(), panorama]);
    sdkMock.retryProcessingFailures.mockResolvedValue(undefined as never);
    sdkMock.dismissProcessingFailures.mockResolvedValue(undefined as never);
    sdkMock.getBaseUrl.mockReturnValue('/api');
    sdkMock.getAssetOriginalPath.mockImplementation((id: string) => `/assets/${id}/original`);
    sdkMock.getAssetThumbnailPath.mockImplementation((id: string) => `/assets/${id}/thumbnail`);
  });

  it("shows a member's own files in words, with what was set aside", async () => {
    render(CouldntProcess);

    expect(await hero().findByRole('heading', { name: '2 files couldn’t be processed' })).toBeInTheDocument();
    expect(hero().getByText(/1 was set aside after 3 tries/)).toBeInTheDocument();
    expect(screen.getByText('Couldn’t read this video')).toBeInTheDocument();
    expect(screen.getByText('This photo is too big to work with')).toBeInTheDocument();
    expect(
      fileRow('VID_20260813_0912.MOV').getByText(
        'Frameleaf tried to make a copy that plays everywhere. The original is untouched.',
      ),
    ).toBeInTheDocument();
    expect(fileRow('VID_20260813_0912.MOV').getByText(en.frameleaf_processing_failure_set_aside)).toBeInTheDocument();
    expect(fileRow('PANO_0042.JPG').queryByText(en.frameleaf_processing_failure_set_aside)).not.toBeInTheDocument();
    // a member's own list: no owner names, no filter, no server log link
    expect(screen.queryByText(/Taylor/)).not.toBeInTheDocument();
    expect(screen.queryByRole('combobox', { name: 'Whose' })).not.toBeInTheDocument();
    expect(screen.queryByRole('link', { name: en.frameleaf_processing_failure_logs })).not.toBeInTheDocument();
    expect(sdkMock.getProcessingFailures).toHaveBeenCalledWith({ skip: 0, take: 200 });
  });

  it('shows a file once, and tries every step of it again, saying it is being tried until it works', async () => {
    sdkMock.getProcessingFailures.mockResolvedValueOnce([
      failure(),
      failure({ step: ProcessingFailureStep.AssetGenerateThumbnails, attempts: 1, quarantinedAt: null }),
    ]);
    render(CouldntProcess);
    const name = 'VID_20260813_0912.MOV';
    await hero().findByRole('heading', { name: /couldn’t be processed/ });
    expect(screen.getAllByRole('button', { name: en.frameleaf_processing_failure_try_again })).toHaveLength(1);

    // the server starts each step afresh: no tries counted until it works or fails again
    sdkMock.getProcessingFailures.mockResolvedValue([
      failure({ attempts: 0, quarantinedAt: null }),
      failure({ step: ProcessingFailureStep.AssetGenerateThumbnails, attempts: 0, quarantinedAt: null }),
    ]);
    await fireEvent.click(fileRow(name).getByRole('button', { name: en.frameleaf_processing_failure_try_again }));

    expect(sdkMock.retryProcessingFailures).toHaveBeenCalledWith({
      processingFailureActionDto: {
        items: [
          { assetId: failure().assetId, step: ProcessingFailureStep.AssetEncodeVideo },
          { assetId: failure().assetId, step: ProcessingFailureStep.AssetGenerateThumbnails },
        ],
      },
    });
    expect(await fileRow(name).findByText(en.frameleaf_processing_failure_trying)).toBeInTheDocument();
    expect(fileRow(name).getByRole('button', { name: en.frameleaf_processing_failure_try_again })).toBeDisabled();
    expect(screen.getByText(`Trying ${name} again now.`)).toBeInTheDocument();
  });

  it('drops a read that answers after a newer one', async () => {
    render(CouldntProcess);
    await hero().findByRole('heading', { name: /couldn’t be processed/ });

    let answerStale: (rows: ProcessingFailureResponseDto[]) => void = () => {};
    sdkMock.getProcessingFailures.mockImplementationOnce(
      () => new Promise((resolve) => (answerStale = resolve)) as never,
    );
    sdkMock.getProcessingFailures.mockResolvedValue([
      failure({ attempts: 0, quarantinedAt: null }),
      { ...panorama, attempts: 0 },
    ]);
    await fireEvent.click(
      fileRow('VID_20260813_0912.MOV').getByRole('button', { name: en.frameleaf_processing_failure_try_again }),
    );
    await fireEvent.click(
      fileRow('PANO_0042.JPG').getByRole('button', { name: en.frameleaf_processing_failure_try_again }),
    );
    expect(await fileRow('PANO_0042.JPG').findByText(en.frameleaf_processing_failure_trying)).toBeInTheDocument();

    // the first read answers last, with the rows as they were before Try again
    answerStale([failure(), panorama]);
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(fileRow('VID_20260813_0912.MOV').getByText(en.frameleaf_processing_failure_trying)).toBeInTheDocument();
    expect(fileRow('PANO_0042.JPG').getByText(en.frameleaf_processing_failure_trying)).toBeInTheDocument();
  });

  it('downloads the original of a set-aside file, and keeps a file as it is', async () => {
    render(CouldntProcess);
    const name = 'VID_20260813_0912.MOV';
    await hero().findByRole('heading', { name: /couldn’t be processed/ });

    await fireEvent.click(fileRow(name).getByRole('button', { name: en.frameleaf_processing_failure_download }));
    expect(utils.downloadUrl).toHaveBeenCalledWith(
      expect.stringContaining(`/assets/${failure().assetId}/original`),
      name,
    );

    await fireEvent.click(fileRow(name).getByRole('button', { name: en.frameleaf_processing_failure_keep }));
    expect(sdkMock.dismissProcessingFailures).toHaveBeenCalledWith({
      processingFailureActionDto: {
        items: [{ assetId: failure().assetId, step: ProcessingFailureStep.AssetEncodeVideo }],
      },
    });
    await waitFor(() =>
      expect(screen.getAllByRole('button', { name: en.frameleaf_processing_failure_keep })).toHaveLength(1),
    );
    expect(screen.getByText(`${name} is kept as it is and won’t be listed again.`)).toBeInTheDocument();
  });

  it("shows an administrator the household with whose each file is, without another account's picture or download", async () => {
    auth.user = { id: 'taylor', isAdmin: true };
    sdkMock.getProcessingFailures.mockResolvedValue([failure(), morgans]);
    render(CouldntProcess);

    expect(await screen.findByText(/DSC09912\.ARW · Morgan/)).toBeInTheDocument();
    const theirs = fileRow('DSC09912.ARW');
    expect(theirs.queryByRole('img')).not.toBeInTheDocument();
    expect(theirs.queryByRole('button', { name: en.frameleaf_processing_failure_download })).not.toBeInTheDocument();
    expect(theirs.getByRole('button', { name: en.frameleaf_processing_failure_keep })).toBeInTheDocument();
    expect(theirs.getByRole('link', { name: en.frameleaf_processing_failure_logs })).toHaveAttribute(
      'href',
      expect.stringContaining(`section=logs&q=${morgans.assetId}`),
    );

    await fireEvent.change(screen.getByRole('combobox', { name: 'Whose' }), { target: { value: 'morgan' } });
    expect(screen.queryByText(/VID_20260813_0912\.MOV/)).not.toBeInTheDocument();
    expect(hero().getByRole('heading', { name: '1 file couldn’t be processed' })).toBeInTheDocument();
  });

  it('says when nothing is waiting', async () => {
    sdkMock.getProcessingFailures.mockResolvedValue([]);
    render(CouldntProcess);
    expect(await hero().findByRole('heading', { name: en.frameleaf_processing_failure_hero_none })).toBeInTheDocument();
  });

  it('says when the list cannot be read, and reads it again', async () => {
    sdkMock.getProcessingFailures.mockRejectedValueOnce(new Error('offline'));
    render(CouldntProcess);
    expect(
      await screen.findByRole('heading', { name: en.frameleaf_processing_failure_load_failed }),
    ).toBeInTheDocument();
    // the hero is drawn afresh for each state, so it is looked up again each time
    await fireEvent.click(hero().getByRole('button', { name: en.frameleaf_processing_failure_try_load }));
    expect(await screen.findByRole('heading', { name: '2 files couldn’t be processed' })).toBeInTheDocument();
  });
});
