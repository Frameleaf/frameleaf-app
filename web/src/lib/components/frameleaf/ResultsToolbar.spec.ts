import { render, screen, waitFor } from '@testing-library/svelte';
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
