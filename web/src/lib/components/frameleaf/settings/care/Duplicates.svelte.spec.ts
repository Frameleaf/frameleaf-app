import { fireEvent, render, screen, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { goto } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import Duplicates from '$lib/components/frameleaf/settings/care/Duplicates.svelte';
import { alikeChoiceOf } from '$lib/components/frameleaf/settings/care/duplicates';
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
const hero = () => within(screen.getByRole('region', { name: en.frameleaf_dupes_status }));

describe('Library care › Duplicates (FL-366)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getSummary.mockResolvedValue(summary(0));
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

  it('says identical files are stored once automatically, with nothing to merge by hand (FL-413)', async () => {
    makeDraft();
    render(Duplicates);

    expect(await hero().findByText(en.frameleaf_dupes_exact_automatic)).toBeInTheDocument();
    expect(screen.queryByRole('button', { name: en.frameleaf_dupes_show_me })).toBeNull();
    expect(screen.queryByRole('button', { name: en.frameleaf_dupes_look_again })).toBeNull();
  });

  it('says storing identical files once as a promise, with no switch', () => {
    makeDraft();
    render(Duplicates);

    expect(screen.getByText(en.frameleaf_dupes_promise_once)).toBeInTheDocument();
    expect(screen.getByText(en.frameleaf_dupes_promise_in_use)).toBeInTheDocument();
    expect(screen.getAllByRole('switch').map((item) => item.getAttribute('aria-label'))).not.toContain(
      en.frameleaf_dupes_promise_once,
    );
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

  it('counts extra copies already on the drive and can store them once (FL-520)', async () => {
    sdkMock.getIdenticalFilesExtraCopies.mockResolvedValue({ files: 214, contents: 97, bytes: 3_200_000_000 });
    makeDraft();
    render(Duplicates);

    expect(await screen.findByText(/214 extra copies of 97 photos and videos, taking/)).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_dupes_extra_store }));
    expect(sdkMock.checkIdenticalFiles).toHaveBeenCalled();
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
