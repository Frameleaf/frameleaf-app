import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import Duplicates from '$lib/components/frameleaf/settings/care/Duplicates.svelte';
import { alikeChoiceOf } from '$lib/components/frameleaf/settings/care/duplicates';
import { unusedFilesAccess } from '$lib/frameleaf/unused-files.svelte';
import en from '../../../../../../../i18n/en.json';

const draft = vi.hoisted(() => ({ store: undefined as unknown }));

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$app/state', () => ({
  page: { url: new URL('http://localhost/user-settings?area=care&section=duplicates') },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { configFile: false } },
}));
vi.mock('$lib/frameleaf/system-config-draft.svelte', async (original) => ({
  ...(await original<object>()),
  getSystemConfigDraft: () => draft.store,
  requireSystemConfigDraft: () => draft.store,
}));

const config = (overrides: { enabled?: boolean; review?: boolean; maxDistance?: number; clip?: boolean } = {}) => ({
  machineLearning: {
    enabled: true,
    clip: { enabled: overrides.clip ?? true },
    duplicateDetection: {
      enabled: overrides.enabled ?? true,
      maxDistance: overrides.maxDistance ?? 0.01,
      preferOriginalFormat: true,
      enhancedVideo: { enabled: true, frameCount: 4, minMatchingFrames: 2, maxDistance: 0.01 },
    },
  },
  libraryCare: { duplicateReview: overrides.review ?? true },
});

const makeDraft = (overrides: Parameters<typeof config>[0] = {}) => {
  const live = $state(config(overrides));
  const store = { baseline: config(overrides), draft: live, saveKeys: vi.fn().mockResolvedValue(true) };
  draft.store = store;
  return store;
};

const summary = (duplicates: number) => ({ queues: { duplicates } }) as never;

/** FL-416: where the identical-files check stands. */
const status = (overrides: Record<string, unknown> = {}) =>
  ({
    status: 'completed',
    stage: 'done',
    trigger: 'manual',
    startedAt: '2026-10-23T03:00:00.000Z',
    finishedAt: '2026-10-23T03:40:00.000Z',
    totalOriginals: 48_210,
    counts: {
      scanned: 48_210,
      upgraded: 0,
      registered: 0,
      linked: 4,
      photosMerged: 8,
      filesMovedToUnused: 214,
      bytesMovedToUnused: 3_200_000_000,
      orphansFound: 0,
      orphanDuplicates: 0,
      photosRecovered: 0,
      damaged: 0,
      problems: 0,
    },
    recovered: [],
    problems: [],
    ...overrides,
  }) as never;
const report = { summary: { savedBytes: 3_200_000_000, duplicateReferences: 1140 } } as never;
const hero = () => within(screen.getByRole('region', { name: en.frameleaf_dupes_status }));

describe('Library care › Duplicates (FL-366)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    unusedFilesAccess.reset();
    sdkMock.getSummary.mockResolvedValue(summary(0));
    sdkMock.getIdenticalFilesStatus.mockResolvedValue(status());
    sdkMock.getAnalyticsReport.mockResolvedValue(report);
    sdkMock.getAllLibraries.mockResolvedValue([]);
  });

  it('answers first: look-alike groups waiting, exact copies stored once', async () => {
    makeDraft();
    sdkMock.getSummary.mockResolvedValue(summary(38));
    render(Duplicates);

    expect(await hero().findByText(/38 groups of look-alike photos are waiting/)).toBeInTheDocument();
    expect(hero().getByRole('heading', { name: en.frameleaf_dupes_hero_once })).toBeInTheDocument();
    expect(hero().getByText('38 groups to review')).toBeInTheDocument();
    expect(hero().getByText(en.frameleaf_dupes_exact_stored_once)).toBeInTheDocument();
    await fireEvent.click(hero().getByRole('button', { name: en.frameleaf_dupes_review }));
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('duplicates'));
  });

  it('says what identical files save, when they were checked and what waits in Unused files (FL-416)', async () => {
    makeDraft();
    render(Duplicates);

    expect(await hero().findByText('3.2 GB saved')).toBeInTheDocument();
    const block = within(screen.getByRole('region', { name: en.frameleaf_dupes_once_title }));
    expect(block.getByText('1,140 files are stored once')).toBeInTheDocument();
    expect(block.getByText('All 48,210 files, read from the drive')).toBeInTheDocument();
    expect(block.getByText('214 files · 3.2 GB')).toBeInTheDocument();
    expect(block.getByText(en.frameleaf_dupes_problems_none)).toBeInTheDocument();
    expect(
      block.getByText('12 merges in the last check. Each one is listed in Duplicates review, where you can undo it.'),
    ).toBeInTheDocument();
  });

  it('says storing identical files once as a promise, with no switch', () => {
    makeDraft();
    render(Duplicates);

    expect(screen.getByText(en.frameleaf_dupes_pledge)).toBeInTheDocument();
    expect(screen.getAllByRole('switch').map((item) => item.getAttribute('aria-label'))).not.toContain(
      en.frameleaf_dupes_pledge,
    );
  });

  it('checks again on request and says so (FL-416)', async () => {
    sdkMock.checkIdenticalFiles.mockResolvedValue(status({ status: 'running', stage: 'scan', finishedAt: null }));
    makeDraft();
    render(Duplicates);

    const block = within(await screen.findByRole('region', { name: en.frameleaf_dupes_once_title }));
    await fireEvent.click(block.getByRole('button', { name: en.frameleaf_dupes_check_again }));
    expect(sdkMock.checkIdenticalFiles).toHaveBeenCalled();
    expect(await screen.findByText(en.frameleaf_dupes_check_started)).toBeInTheDocument();
    expect(await block.findByRole('button', { name: en.frameleaf_dupes_checking })).toBeDisabled();
    expect(block.getByText(en.frameleaf_dupes_checking_now)).toBeInTheDocument();
  });

  it('lists the three kinds of files the check skipped, and warns (FL-416)', async () => {
    sdkMock.getIdenticalFilesStatus.mockResolvedValue(
      status({
        problems: [
          { kind: 'unreadable', assetId: 'a', path: 'library/morgan/2024/IMG_3302.HEIC', detail: null },
          { kind: 'changed', assetId: 'b', path: null, detail: null },
          { kind: 'changed', assetId: 'c', path: null, detail: null },
          // look-alikes to check before merging are Duplicate review's, not a problem here
          { kind: 'check-before-merging', assetId: 'd', path: null, detail: 'edits' },
        ],
      }),
    );
    sdkMock.getAllLibraries.mockResolvedValue([{ id: 'lib', name: 'Lake cabin drive', deletedAt: null }] as never);
    makeDraft();
    render(Duplicates);

    expect(await hero().findByRole('heading', { name: '3 files could not be checked' })).toBeInTheDocument();
    const block = within(screen.getByRole('region', { name: en.frameleaf_dupes_once_title }));
    expect(block.getByText(en.frameleaf_dupes_problems_some)).toBeInTheDocument();
    expect(block.getByText('IMG_3302.HEIC')).toBeInTheDocument();
    expect(block.getByText(en.frameleaf_dupes_problem_unreadable)).toBeInTheDocument();
    expect(block.getByText('2 files changed while they were read')).toBeInTheDocument();
    expect(block.getByText(en.frameleaf_dupes_problem_changed)).toBeInTheDocument();
    expect(await block.findByText('Files in “Lake cabin drive”')).toBeInTheDocument();
    expect(block.getByText(en.frameleaf_dupes_problem_external)).toBeInTheDocument();
    await fireEvent.click(block.getByRole('button', { name: en.frameleaf_dupes_problem_file_checks }));
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('integrity-checks'));
  });

  it('opens Unused files only for the server owner (FL-416)', async () => {
    makeDraft();
    const { unmount } = render(Duplicates);
    const block = within(await screen.findByRole('region', { name: en.frameleaf_dupes_once_title }));
    expect(block.queryByRole('button', { name: en.frameleaf_unused_title })).toBeNull();
    expect(block.getByText(en.frameleaf_dupes_extra_copies_help_owner)).toBeInTheDocument();
    unmount();

    unusedFilesAccess.totals = { files: 277, bytes: 4_500_000_000 };
    render(Duplicates);
    const owner = within(await screen.findByRole('region', { name: en.frameleaf_dupes_once_title }));
    await fireEvent.click(owner.getByRole('button', { name: en.frameleaf_unused_title }));
    expect(goto).toHaveBeenCalledWith(expect.stringContaining('section=unused-files'));
  });

  it('shows the look-alike switch on only while both settings are on, and writes both', async () => {
    const store = makeDraft({ review: false });
    render(Duplicates);

    const find = screen.getByRole('switch', { name: en.frameleaf_dupes_find });
    expect(find).not.toBeChecked();
    await fireEvent.click(find);
    expect(store.draft.machineLearning.duplicateDetection.enabled).toBe(true);
    expect(store.draft.libraryCare.duplicateReview).toBe(true);

    await fireEvent.click(screen.getByRole('switch', { name: en.frameleaf_dupes_find }));
    expect(store.draft.machineLearning.duplicateDetection.enabled).toBe(false);
    expect(store.draft.libraryCare.duplicateReview).toBe(false);
  });

  it('writes the photo distance from the three choices and warns before saving', async () => {
    const store = makeDraft();
    render(Duplicates);

    expect(screen.queryByText(en.frameleaf_dupes_recompare_title)).toBeNull();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_dupes_how_alike_close }));
    expect(store.draft.machineLearning.duplicateDetection.maxDistance).toBe(0.004);
    expect(screen.getByText(en.frameleaf_dupes_recompare_title)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_dupes_undo }));
    expect(store.draft.machineLearning.duplicateDetection.maxDistance).toBe(0.01);
  });

  it('says about how many groups each choice makes, and how long comparing again takes (FL-520)', async () => {
    sdkMock.getDuplicateEstimate.mockResolvedValue({
      comparable: 48_210,
      groups: 38,
      sampled: 200,
      seconds: 2400,
      choices: [
        { maxDistance: 0.004, groups: 12 },
        { maxDistance: 0.01, groups: 38 },
        { maxDistance: 0.03, groups: 140 },
      ],
    });
    const store = makeDraft();
    render(Duplicates);

    expect(await screen.findByText(/About 38 groups in your library/)).toBeInTheDocument();
    expect(sdkMock.getDuplicateEstimate).toHaveBeenCalledWith({ maxDistances: [0.004, 0.01, 0.03] });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_dupes_how_alike_loose }));
    expect(screen.getByText(/About 140 groups in your library/)).toBeInTheDocument();
    expect(screen.getByText('Saving this compares all 48,210 photos again, about 40 minutes')).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_dupes_recompare_now }));
    expect(store.saveKeys).toHaveBeenCalledWith(['machineLearning', 'libraryCare']);
    expect(sdkMock.recompareDuplicates).toHaveBeenCalledWith({ duplicateRecompareDto: { when: 'now' } });
    expect(await screen.findByText('Saved. Comparing has started and takes about 40 minutes.')).toBeInTheDocument();
  });

  it('leaves comparing again for tonight, and does nothing when the save fails (FL-520)', async () => {
    const store = makeDraft();
    render(Duplicates);

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_dupes_how_alike_close }));
    store.saveKeys.mockResolvedValueOnce(false);
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_dupes_recompare_tonight }));
    expect(sdkMock.recompareDuplicates).not.toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_dupes_recompare_tonight }));
    expect(sdkMock.recompareDuplicates).toHaveBeenCalledWith({ duplicateRecompareDto: { when: 'tonight' } });
  });

  it('says extra copies on the drive that are not stored once yet (FL-520)', async () => {
    sdkMock.getIdenticalFilesExtraCopies.mockResolvedValue({ files: 214, contents: 97, bytes: 3_200_000_000 });
    makeDraft();
    render(Duplicates);

    expect(await screen.findByText(/214 extra files of 97 photos and videos take/)).toBeInTheDocument();
  });

  it('shows a number that matches no choice as Custom', () => {
    makeDraft({ maxDistance: 0.02 });
    render(Duplicates);

    expect(screen.getByRole('button', { name: en.frameleaf_dupes_how_alike_custom })).toHaveAttribute(
      'aria-pressed',
      'true',
    );
    expect(alikeChoiceOf(0.03)).toBe('loose');
  });

  it('says look-alikes need Visual search when it is off', () => {
    makeDraft({ clip: false });
    render(Duplicates);

    expect(screen.getByText(en.frameleaf_dupes_visual_search_off_title)).toBeInTheDocument();
  });
});
