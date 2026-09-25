import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import GeolocationUtility from './GeolocationUtility.svelte';

const state = vi.hoisted(() => ({ search: vi.fn(), info: vi.fn(), run: vi.fn() }));
vi.mock('@immich/sdk', async (original) => ({
  ...(await original<typeof import('@immich/sdk')>()),
  searchAssets: state.search,
  getAssetInfo: state.info,
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'owner', name: 'Alex' }, params: {} },
}));
vi.mock('$lib/frameleaf/bulk-controller.svelte', () => ({
  BulkController: class {
    busy = false;
    run = state.run;
  },
}));
vi.mock('$lib/frameleaf/durable-bulk-tracker.svelte', () => ({ durableBulkTracker: { stateOf: () => undefined } }));
vi.mock('$lib/components/shared-components/map/Map.svelte', async () => ({
  default: (await import('../../../test-data/frameleaf/UtilityMapStub.svelte')).default,
}));
const asset = (id: string, ownerId = 'owner') => ({ id, ownerId, originalFileName: `${id}.jpg`, exifInfo: {} });

describe('location utility', () => {
  beforeAll(async () => {
    addMessages('dev', en);
    // The utility loads the map lazily. Resolve that module once here so the first render does not
    // race the query timeout while a cold runner compiles the map stub.
    await import('$lib/components/shared-components/map/Map.svelte');
  });
  beforeEach(() => {
    state.search.mockReset().mockResolvedValue({
      assets: { items: [asset('one'), asset('two'), asset('partner', 'other')], nextPage: null },
    });
    state.info
      .mockReset()
      .mockImplementation(({ id }) => Promise.resolve({ ...asset(id), exifInfo: { latitude: 10, longitude: 20 } }));
    state.run.mockReset().mockResolvedValue({ succeeded: ['one'], failed: [{ id: 'two', error: 'offline' }] });
  });
  it('limits changes to owned media and rejects incomplete or out-of-range coordinates', async () => {
    render(GeolocationUtility);
    const one = await screen.findByRole('checkbox', { name: 'one.jpg' });
    expect(screen.getByRole('checkbox', { name: 'partner.jpg' })).toBeDisabled();
    await userEvent.click(one);
    const apply = screen.getByRole('button', { name: /Apply to/ });
    expect(apply).toBeDisabled();
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Latitude' }), { target: { value: '91' } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Longitude' }), { target: { value: '20' } });
    expect(apply).toBeDisabled();
    expect(state.run).not.toHaveBeenCalled();
  });
  it('applies only visible selections and keeps the reviewed scope frozen when the search changes', async () => {
    state.search.mockResolvedValue({
      assets: {
        items: ['one', 'two'].map((id) => ({ ...asset(id), exifInfo: { latitude: 10, longitude: 20 } })),
        nextPage: null,
      },
    });
    render(GeolocationUtility);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'one.jpg' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'two.jpg' }));
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Latitude' }), { target: { value: '10' } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Longitude' }), { target: { value: '20' } });
    const search = screen.getByRole('searchbox', { name: 'Find items' });
    await userEvent.type(search, 'one');
    expect(await screen.findByLabelText('Map markers')).toHaveTextContent(/^one$/);
    await userEvent.click(screen.getByRole('button', { name: 'Apply to 1 selected' }));
    const dialog = screen.getByRole('dialog');
    await fireEvent.input(search, { target: { value: 'two' } });
    await userEvent.click(within(dialog).getByRole('button', { name: /Apply/ }));
    await waitFor(() =>
      expect(state.run).toHaveBeenCalledExactlyOnceWith('change-location', ['one'], { latitude: 10, longitude: 20 }),
    );
    expect(screen.getByRole('checkbox', { name: 'two.jpg' })).toBeChecked();
  });
  it('freezes reviewed IDs and coordinates and keeps unsuccessful items selected', async () => {
    render(GeolocationUtility);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'one.jpg' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'two.jpg' }));
    const latitude = screen.getByRole('spinbutton', { name: 'Latitude' });
    await fireEvent.input(latitude, { target: { value: '10' } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Longitude' }), { target: { value: '20' } });
    await userEvent.click(screen.getByRole('button', { name: /Apply to/ }));
    const dialog = screen.getByRole('dialog');
    await fireEvent.input(latitude, { target: { value: '30' } });
    await userEvent.click(within(dialog).getByRole('button', { name: /Apply/ }));
    await waitFor(() =>
      expect(state.run).toHaveBeenCalledWith('change-location', ['one', 'two'], { latitude: 10, longitude: 20 }),
    );
    await waitFor(() => expect(screen.getByRole('checkbox', { name: 'one.jpg' })).not.toBeChecked());
    expect(screen.getByRole('checkbox', { name: 'two.jpg' })).toBeChecked();
    expect(state.info).toHaveBeenCalledTimes(1);
  });
  it('removes the location of the selected located items after a review (FL-51)', async () => {
    state.search.mockResolvedValue({
      assets: {
        items: [{ ...asset('one'), exifInfo: { latitude: 10, longitude: 20 } }, asset('two')],
        nextPage: null,
      },
    });
    state.run.mockResolvedValue({ succeeded: ['one'], failed: [] });
    render(GeolocationUtility);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'one.jpg' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'two.jpg' }));

    // only the selected item that has a location can lose it
    await userEvent.click(screen.getByRole('button', { name: 'Remove location from 1 selected' }));
    const dialog = screen.getByRole('dialog', { name: 'Remove location' });
    await userEvent.click(within(dialog).getByRole('button', { name: /Apply/ }));

    await waitFor(() =>
      expect(state.run).toHaveBeenCalledExactlyOnceWith('change-location', ['one'], { clearLocation: true }),
    );
  });
});
