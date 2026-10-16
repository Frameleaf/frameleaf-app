import { render, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { authManager } from '$lib/managers/auth-manager.svelte';
import LibraryFilterPanel from './LibraryFilterPanel.svelte';

vi.mock('$lib/components/frameleaf/FilterPanel.svelte', async () => ({
  default: (await import('@test-data/frameleaf/EmptyStub.svelte')).default,
}));

/**
 * ACCOUNT-P3: Search › "Include archived items" belongs to the search palette and the results page.
 * The library's Filter panel counts what its page shows, the timeline, whatever the preference says.
 */
describe('LibraryFilterPanel counts', () => {
  afterEach(() => authManager.reset());

  it('keep the timeline default with Include archived items on', async () => {
    authManager.setUser({ id: 'user-1' } as never);
    authManager.setPreferences({
      search: { includeArchived: true },
      privacy: { suppression: { personIds: [], tagIds: [], petIds: [] } },
    } as never);
    sdkMock.searchFacets.mockResolvedValue({ total: 0, facets: [] });
    const query = emptyDiscoveryQuery();
    render(LibraryFilterPanel, { query, countQuery: query, onChange: vi.fn(), onClose: vi.fn() });

    await waitFor(() => expect(sdkMock.searchFacets).toHaveBeenCalled(), { timeout: 2000 });
    expect(sdkMock.searchFacets.mock.calls.at(-1)![0].searchFacetsDto.filter?.visibility).toEqual({
      eq: 'timeline',
    });
  });
});
