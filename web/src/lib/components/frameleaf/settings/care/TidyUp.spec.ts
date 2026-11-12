import type { TidyUpKindStatusDto, TidyUpStatusDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import en from '../../../../../../../i18n/en.json';
import TidyUp from './TidyUp.svelte';

/** Library care › Tidy up (FL-1470): kinds of clutter suggested for the Archive; Archive automatically is off. */
const kind = (id: string, overrides: Partial<TidyUpKindStatusDto> = {}): TidyUpKindStatusDto => ({
  kind: id,
  enabled: false,
  strictness: 'balanced',
  automatic: false,
  visual: !['screenshots', 'chat', 'accidental'].includes(id),
  available: true,
  waiting: 0,
  albumId: null,
  ...overrides,
});
const KINDS = ['memes', 'documents', 'screenshots', 'shop', 'chat', 'slides', 'notes', 'accidental'];
const status = (
  overrides: Partial<TidyUpStatusDto> = {},
  kinds: Record<string, Partial<TidyUpKindStatusDto>> = {},
) => ({
  kinds: KINDS.map((id) => kind(id, kinds[id])),
  waiting: 0,
  tidiedAway: 0,
  collectionId: null,
  ...overrides,
});

describe('Tidy up (FL-1470)', () => {
  beforeAll(() => addMessages('dev', en));
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getTidyUpSuggestions.mockResolvedValue({ total: 0, items: [], nextPage: null });
    sdkMock.updateTidyUpKind.mockResolvedValue(kind('memes', { enabled: true }));
    sdkMock.getBaseUrl.mockReturnValue('/api');
  });

  it('starts with nothing on and every kind offered', async () => {
    sdkMock.getTidyUp.mockResolvedValue(status());
    render(TidyUp);

    expect(await screen.findByRole('heading', { name: 'Choose what to tidy' })).toBeInTheDocument();
    for (const name of ['Memes', 'Receipts & documents', 'Screenshots', 'Accidental shots']) {
      expect(screen.getByRole('switch', { name: `Look for ${name}` })).toHaveAttribute('aria-checked', 'false');
    }
    expect(screen.getByText('Photos you gave stars')).toBeInTheDocument();
  });

  it('turning a kind on asks the server to look, and says nothing moves yet', async () => {
    sdkMock.getTidyUp.mockResolvedValue(status());
    render(TidyUp);

    await fireEvent.click(await screen.findByRole('switch', { name: 'Look for Memes' }));

    await waitFor(() =>
      expect(sdkMock.updateTidyUpKind).toHaveBeenCalledWith({ kind: 'memes', tidyUpKindUpdateDto: { enabled: true } }),
    );
    expect(await screen.findByText(/Nothing moves until you review/)).toBeInTheDocument();
  });

  it('shows what is waiting and leads to the review', async () => {
    sdkMock.getTidyUp.mockResolvedValue(status({ waiting: 38 }, { memes: { enabled: true, waiting: 38 } }));
    sdkMock.getTidyUpSuggestions.mockResolvedValue({
      total: 38,
      items: [{ assetId: 'a', kinds: ['memes'], automatic: false }],
      nextPage: 2,
    });
    render(TidyUp);

    const hero = within(await screen.findByRole('region', { name: 'Tidy up' }));
    expect(await hero.findByRole('heading', { name: '38 photos could go to the Archive' })).toBeInTheDocument();
    expect(hero.getByRole('button', { name: 'Review' })).toBeInTheDocument();
    expect(screen.getByText('38 to review')).toBeInTheDocument();
  });

  it('Archive automatically is off until it is turned on in Options, and says what waits', async () => {
    sdkMock.getTidyUp.mockResolvedValue(status({ waiting: 38 }, { memes: { enabled: true, waiting: 38 } }));
    render(TidyUp);

    await fireEvent.click(await screen.findByRole('button', { name: 'Memes options' }));
    const automatic = await screen.findByRole('switch', { name: 'Archive automatically' });
    expect(automatic).toHaveAttribute('aria-checked', 'false');
    expect(screen.getByText(/Nothing moves until you press Archive/)).toBeInTheDocument();

    await fireEvent.click(automatic);
    expect(await screen.findByText('The 38 already found still wait for you')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Save' }));

    await waitFor(() =>
      expect(sdkMock.updateTidyUpKind).toHaveBeenCalledWith({
        kind: 'memes',
        tidyUpKindUpdateDto: { enabled: undefined, strictness: undefined, automatic: true },
      }),
    );
  });

  it('says which kinds need Visual search when it is off', async () => {
    sdkMock.getTidyUp.mockResolvedValue(
      status(
        {},
        Object.fromEntries(['memes', 'documents', 'shop', 'slides', 'notes'].map((id) => [id, { available: false }])),
      ),
    );
    render(TidyUp);

    expect(await screen.findByText('Visual search is off')).toBeInTheDocument();
    expect(screen.getAllByText('Needs Visual search')).toHaveLength(5);
  });
});
