import { TidyUpDecision, type TidyUpItemDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../../i18n/en.json';
import TidyUpReview from './TidyUpReview.svelte';

/** Tidy up › Review (FL-1470): everything goes to the Archive unless set to Keep; the large view decides one by one. */
const item = (assetId: string, kind = 'memes'): TidyUpItemDto => ({ assetId, kinds: [kind], automatic: false });
const MEMES = ['m1', 'm2', 'm3'].map((id) => item(id));

const status = {
  kinds: [
    {
      kind: 'memes',
      enabled: true,
      strictness: 'balanced',
      automatic: false,
      visual: true,
      available: true,
      waiting: 3,
      albumId: 'album',
    },
  ],
  waiting: 3,
  tidiedAway: 1,
  collectionId: 'collection',
};

describe('Tidy up review (FL-1470)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getTidyUp.mockResolvedValue(status);
    sdkMock.getTidyUpSuggestions.mockResolvedValue({ total: 3, items: MEMES, nextPage: null });
    sdkMock.getTidiedAway.mockResolvedValue({ total: 1, items: [item('t1')], nextPage: null });
    sdkMock.decideTidyUp.mockResolvedValue({ updated: 1, skipped: 0 });
    sdkMock.getAssetInfo.mockResolvedValue({
      originalFileName: 'IMG-20260412-WA0007.jpg',
      localDateTime: '2026-04-12T10:00:00',
    } as never);
    sdkMock.getBaseUrl.mockReturnValue('/api');
  });

  it('archives everything not kept, and keeps the kept ones for good', async () => {
    render(TidyUpReview);

    const choices = await screen.findAllByRole('button', { name: 'Archive' });
    expect(choices).toHaveLength(3);
    await fireEvent.click(choices[1]);
    const archive = screen.getByRole('button', { name: 'Archive 2 photos' });
    expect(screen.getByText('1 kept', { exact: false })).toBeInTheDocument();

    await fireEvent.click(archive);

    await waitFor(() =>
      expect(sdkMock.decideTidyUp).toHaveBeenCalledWith({
        tidyUpDecisionDto: { assetIds: ['m1', 'm3'], decision: TidyUpDecision.Archive },
      }),
    );
    expect(sdkMock.decideTidyUp).toHaveBeenCalledWith({
      tidyUpDecisionDto: { assetIds: ['m2'], decision: TidyUpDecision.Keep },
    });
    expect(await screen.findByText('2 photos moved to the Archive')).toBeInTheDocument();

    const undo = screen.getByRole('button', { name: 'Undo' });
    await waitFor(() => expect(undo).toBeEnabled());
    await fireEvent.click(undo);
    await waitFor(() =>
      expect(sdkMock.decideTidyUp).toHaveBeenCalledWith({
        tidyUpDecisionDto: { assetIds: ['m1', 'm3'], decision: TidyUpDecision.Undo },
      }),
    );
  });

  it('the large view keeps with K and moves on, and closes with Escape', async () => {
    render(TidyUpReview);

    const tiles = await screen.findAllByRole('button', { name: 'Open in the large view' });
    await fireEvent.click(tiles[0]);
    const viewer = within(await screen.findByRole('dialog', { name: 'Large view' }));
    expect(viewer.getByText('1 of 3')).toBeInTheDocument();
    expect(viewer.getByText('Looks like a meme')).toBeInTheDocument();
    expect(await viewer.findByText(/IMG-20260412-WA0007\.jpg/)).toBeInTheDocument();

    await fireEvent.keyDown(globalThis, { key: 'k' });
    expect(viewer.getByText('2 of 3')).toBeInTheDocument();
    await fireEvent.keyDown(globalThis, { key: 'Escape' });
    expect(screen.queryByRole('dialog', { name: 'Large view' })).not.toBeInTheDocument();

    // the first meme is now set to Keep
    expect(screen.getAllByRole('button', { name: 'Keep' })).toHaveLength(1);
    expect(screen.getByRole('button', { name: 'Archive 2 photos' })).toBeInTheDocument();
  });

  it('Tidied away puts a photo back on the timeline', async () => {
    render(TidyUpReview);

    await fireEvent.click(await screen.findByRole('button', { name: /^Tidied away ·/ }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Put back' }));

    await waitFor(() =>
      expect(sdkMock.decideTidyUp).toHaveBeenCalledWith({
        tidyUpDecisionDto: { assetIds: ['t1'], decision: TidyUpDecision.Keep },
      }),
    );
    await waitFor(() => expect(screen.queryByRole('button', { name: 'Put back' })).not.toBeInTheDocument());
  });
});
