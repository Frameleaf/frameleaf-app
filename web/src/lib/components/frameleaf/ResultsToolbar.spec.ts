import { ImageEnrichmentFilter } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { createRawSnippet } from 'svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { LibrarySessionStore } from '$lib/frameleaf/library-session.svelte';
import { eventManager } from '$lib/managers/event-manager.svelte';
import ResultsToolbar from './ResultsToolbar.svelte';

vi.mock('$lib/components/assets/thumbnail/ImageThumbnail.svelte', async () => {
  const { default: TestImage } = await import('$lib/../test-data/frameleaf/TestImage.svelte');
  return { default: TestImage };
});

const person = (id: string, isHidden = false) =>
  ({ id, name: 'Jamie', isHidden, updatedAt: '2026-09-25T00:00:00.000Z', thumbnailPath: '/t.jpg' }) as never;

/** LIB-11: a pet chip names the pet it narrows by. */
describe('ResultsToolbar pet chip', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });
  beforeEach(() => vi.resetAllMocks());

  it('reads "Pet: Max" for the one pet the filter names', async () => {
    sdkMock.getPet.mockResolvedValue({ id: 'max', name: 'Max', isHidden: false } as never);
    const session = new LibrarySessionStore({ storage: null });
    session.setQuery({ ...emptyDiscoveryQuery(), filter: { petIds: { any: ['max'] } } });
    render(ResultsToolbar, { session });
    await waitFor(() => expect(screen.getByTestId('frameleaf-filter-chips')).toHaveTextContent('Pet: Max'));
  });
});

/** FL-29: a people chip shows the person's real face, and never after access narrows. */
describe('ResultsToolbar people chip', () => {
  const withPerson = (id: string) => {
    const session = new LibrarySessionStore({ storage: null });
    session.setQuery({ ...emptyDiscoveryQuery(), filter: { personIds: { any: [id] } } });
    return session;
  };
  const chipImages = () => screen.getByTestId('frameleaf-filter-chips').querySelectorAll('img');

  beforeEach(() => vi.resetAllMocks());

  it('draws the face of the one person the filter names', async () => {
    sdkMock.getPerson.mockResolvedValue(person('p1'));
    render(ResultsToolbar, { session: withPerson('p1') });
    await waitFor(() => expect(chipImages()).toHaveLength(1));
    expect(sdkMock.getPerson).toHaveBeenCalledWith({ id: 'p1' });
  });

  it('draws no face for a hidden person or one the session may not read', async () => {
    sdkMock.getPerson.mockResolvedValue(person('p2', true));
    const first = render(ResultsToolbar, { session: withPerson('p2') });
    await waitFor(() => expect(sdkMock.getPerson).toHaveBeenCalled());
    expect(chipImages()).toHaveLength(0);
    first.unmount();

    sdkMock.getPerson.mockRejectedValue(new Error('403'));
    render(ResultsToolbar, { session: withPerson('p3') });
    await waitFor(() => expect(sdkMock.getPerson).toHaveBeenCalledTimes(2));
    expect(chipImages()).toHaveLength(0);
  });

  it('drops the face at once when the session locks', async () => {
    sdkMock.getPerson.mockResolvedValue(person('p4'));
    render(ResultsToolbar, { session: withPerson('p4') });
    await waitFor(() => expect(chipImages()).toHaveLength(1));
    eventManager.emit('SessionLocked');
    await waitFor(() => expect(chipImages()).toHaveLength(0));
  });
});

/** LIB-09: a chip reads like the filter panel choice that made it, never the stored value. */
describe('ResultsToolbar chip wording', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  const chipText = (filter: Record<string, unknown>, imageEnrichment?: ImageEnrichmentFilter) => {
    const session = new LibrarySessionStore({ storage: null });
    session.setQuery({ ...emptyDiscoveryQuery(), filter, ...(imageEnrichment && { imageEnrichment }) } as never);
    const { unmount } = render(ResultsToolbar, { session });
    const text = [...screen.getByTestId('frameleaf-filter-chips').querySelectorAll(':scope .fl-chip-list > *')].map(
      (chip) => chip.textContent?.replaceAll(/\s+/g, ' ').trim(),
    );
    unmount();
    return text;
  };

  it.each([
    [{ type: { eq: 'IMAGE' } }, 'Media type: Photos'],
    [{ type: { eq: 'VIDEO' } }, 'Media type: Videos'],
    [{ rating: { gte: 4 } }, 'Star rating: 4 stars or more'],
    [{ rating: { gte: 1 } }, 'Star rating: 1 star or more'],
    [{ rating: { eq: 4 } }, 'Star rating: Exactly 4 stars'],
    [{ rating: { eq: 0 } }, 'Star rating: Exactly 0 stars'],
    [{ rating: { eq: null } }, 'Star rating: Not rated'],
    [{ rating: { eq: -1 } }, 'Star rating: Rejected'],
    [{ visibility: { eq: 'archive' } }, 'Visibility: Archived'],
    [{ hasAlbums: { eq: false } }, 'Not in any album'],
    [{ hasTags: { eq: false } }, 'Untagged'],
    [{ hasPeople: { eq: true } }, 'Has people'],
    [{ hasPeople: { eq: false } }, 'Has people: No'],
    [{ localDateTime: { gte: '2026-01-01', lte: '2026-03-31' } }, 'Capture date: Jan 1, 2026 – Mar 31, 2026'],
    [{ localDateTime: { gte: '2026-01-01' } }, 'Capture date: From Jan 1, 2026'],
    [{ city: { eq: 'Banff' } }, 'City: Banff'],
    [{ make: { eq: 'Canon' } }, 'Camera brand: Canon'],
  ])('%j reads %s', (filter, expected) => {
    expect(chipText(filter)).toEqual([expected]);
  });

  it('draws a chip for the Text & descriptions and Sensitivity review choices', () => {
    expect(chipText({}, ImageEnrichmentFilter.MissingImageDescription)).toEqual(['Description: No description']);
    expect(chipText({}, ImageEnrichmentFilter.NsfwReview)).toEqual(['Review status: Needs review']);
  });
});

/** FL-1398: a library page's View menu holds how the library looks, with or without the info panel. */
describe('ResultsToolbar View menu', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  it('opens the full menu, keeps it open through a chevron page, and gives View the focus back on Escape', async () => {
    sdkMock.getPartners.mockResolvedValue([]);
    render(ResultsToolbar, {
      session: new LibrarySessionStore({ storage: null }),
      viewMenu: { layout: 'browse', grid: true, scrubber: false, stacks: true, libraryRoot: true, marks: true },
    });

    const view = screen.getByRole('button', { name: /View/ });
    await fireEvent.click(view);
    expect(view).toHaveAttribute('aria-expanded', 'true');
    const menu = screen.getByRole('group', { name: 'View options' });
    // no information panel here, so the first control is the Size preset
    await waitFor(() => expect(within(menu).getByRole('button', { name: 'Small' })).toHaveFocus());
    expect(within(menu).getByRole('switch', { name: 'Crop photos to fit' })).toBeChecked();

    await fireEvent.click(within(menu).getByRole('button', { name: /Also show/ }));
    expect(within(menu).getByText('Locked items never show here.')).toBeInTheDocument();
    expect(view).toHaveAttribute('aria-expanded', 'true');

    await fireEvent.keyDown(menu, { key: 'Escape' });
    expect(view).toHaveAttribute('aria-expanded', 'false');
    expect(view).toHaveFocus();
  });
});

/** FL-1391 B1: a wide photo area has the layout tabs at the start of the row, and the count is read, not shown. */
describe('ResultsToolbar start', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  const tabs = createRawSnippet(() => ({ render: () => '<span data-testid="tabs">Timeline</span>' }));
  const session = () => new LibrarySessionStore({ storage: null });

  it("draws the host's tabs first and keeps the count for screen readers only", () => {
    render(ResultsToolbar, { session: session(), count: 86, start: tabs, countElsewhere: true });
    const row = screen.getByTestId('frameleaf-results-toolbar').querySelector('.fl-toolbar-row')!;
    expect(row.firstElementChild).toContainElement(screen.getByTestId('tabs'));
    const count = screen.getByTestId('frameleaf-result-count');
    expect(count).toHaveTextContent('86 items');
    expect(count).toHaveAttribute('aria-live', 'polite');
    expect(count).toHaveClass('fl-sr');
  });

  it('shows the count where the tabs have a row of their own, or no floating bar shows it', () => {
    const narrow = render(ResultsToolbar, { session: session(), count: 86 });
    expect(screen.getByTestId('frameleaf-result-count')).not.toHaveClass('fl-sr');
    narrow.unmount();
    render(ResultsToolbar, { session: session(), count: 86, start: tabs });
    expect(screen.getByTestId('frameleaf-result-count')).not.toHaveClass('fl-sr');
  });
});
