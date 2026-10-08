import { toastManager } from '@frameleaf/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { emptyDiscoveryQuery } from '$lib/components/discovery/query';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { savedSearchesStore } from '$lib/stores/saved-searches.svelte';
import RailSavedSearches from './RailSavedSearches.svelte';

const state = vi.hoisted(() => ({ url: new URL('http://localhost/photos') }));
vi.mock('$app/state', () => ({
  get page() {
    return state;
  },
}));

const JAMIE = '00000000-0000-4000-8000-000000000001';
const lisbon = { name: 'Lisbon', query: { ...emptyDiscoveryQuery(), filter: { city: { eq: 'Lisbon' } } } };
const jamie = { name: 'Jamie', query: { ...emptyDiscoveryQuery(), filter: { personIds: { all: [JAMIE] } } } };

describe('RailSavedSearches', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.resetAllMocks();
  });

  it('lists the saved searches as rail links and deletes one', async () => {
    sdkMock.getMyPreferences.mockResolvedValue({ savedSearches: [lisbon, jamie], revision: 'r1' } as never);
    sdkMock.updateMyPreferences.mockResolvedValue({ savedSearches: [jamie], revision: 'r2' } as never);
    render(RailSavedSearches);
    const link = await screen.findByRole('link', { name: 'Lisbon' });
    expect(link.getAttribute('href')).toMatch(/^\/search\?dq=/);
    await fireEvent.click(screen.getByRole('button', { name: 'Delete saved search Lisbon' }));
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Lisbon' })).not.toBeInTheDocument());
    expect(sdkMock.updateMyPreferences).toHaveBeenCalledWith({
      userPreferencesUpdateDto: { savedSearches: [jamie], expectedRevision: 'r1' },
    });
  });

  it('offers Undo after a delete, and Undo saves the search back', async () => {
    const show = vi.spyOn(toastManager, 'show').mockImplementation(() => ({}) as never);
    sdkMock.getMyPreferences.mockResolvedValue({ savedSearches: [lisbon, jamie], revision: 'r1' } as never);
    sdkMock.updateMyPreferences.mockResolvedValueOnce({ savedSearches: [jamie], revision: 'r2' } as never);
    // The store is shared: read the account's list afresh for this test.
    await savedSearchesStore.load(true);
    render(RailSavedSearches);
    await screen.findByRole('link', { name: 'Lisbon' });

    await fireEvent.click(screen.getByRole('button', { name: 'Delete saved search Lisbon' }));
    await waitFor(() => expect(show).toHaveBeenCalledOnce());
    const toast = show.mock.calls[0][0] as { description: string; button: { label: string; onclick: () => void } };
    expect(toast.description).toBe('Deleted “Lisbon”');
    expect(toast.button.label).toBe('Undo');

    sdkMock.updateMyPreferences.mockResolvedValueOnce({ savedSearches: [jamie, lisbon], revision: 'r3' } as never);
    toast.button.onclick();
    expect(await screen.findByRole('link', { name: 'Lisbon' })).toBeInTheDocument();
    const saved = sdkMock.updateMyPreferences.mock.lastCall![0].userPreferencesUpdateDto;
    expect(saved.expectedRevision).toBe('r2');
    expect((saved.savedSearches ?? []).map((search) => search.name).sort()).toEqual(['Jamie', 'Lisbon']);
  });

  it('says so, and offers no Undo, when the delete did not go through', async () => {
    const show = vi.spyOn(toastManager, 'show').mockImplementation(() => ({}) as never);
    const warning = vi.spyOn(toastManager, 'warning').mockImplementation(() => ({}) as never);
    sdkMock.getMyPreferences.mockResolvedValue({ savedSearches: [lisbon], revision: 'r1' } as never);
    sdkMock.updateMyPreferences.mockRejectedValue(new Error('stale'));
    // The store is shared: read the account's list afresh for this test.
    await savedSearchesStore.load(true);
    render(RailSavedSearches);
    await screen.findByRole('link', { name: 'Lisbon' });

    await fireEvent.click(screen.getByRole('button', { name: 'Delete saved search Lisbon' }));
    await waitFor(() => expect(warning).toHaveBeenCalledWith('Couldn’t delete that saved search. Try again.'));
    expect(show).not.toHaveBeenCalled();
    expect(screen.getByRole('link', { name: 'Lisbon' })).toBeInTheDocument();
  });

  it('labels the list, so a saved search is not taken for an album', async () => {
    sdkMock.getMyPreferences.mockResolvedValue({ savedSearches: [lisbon], revision: 'r1' } as never);
    // The store is shared: read the account's list afresh for this test.
    await savedSearchesStore.load(true);
    render(RailSavedSearches);
    await screen.findByRole('link', { name: 'Lisbon' });
    expect(screen.getByText('Saved searches')).toBeInTheDocument();
  });

  it('reloads on a lock, so a search naming something Locked is not listed while locked', async () => {
    sdkMock.getMyPreferences.mockResolvedValue({ savedSearches: [lisbon, jamie], revision: 'r1' } as never);
    await savedSearchesStore.load(true);
    render(RailSavedSearches);
    await screen.findByRole('link', { name: 'Jamie' });
    // A locked session's preferences leave out the search naming the Locked person
    sdkMock.getMyPreferences.mockResolvedValue({ savedSearches: [lisbon], revision: 'r3' } as never);
    eventManager.emit('SessionLocked');
    await waitFor(() => expect(screen.queryByRole('link', { name: 'Jamie' })).not.toBeInTheDocument());
    expect(screen.getByRole('link', { name: 'Lisbon' })).toBeInTheDocument();
  });
});
