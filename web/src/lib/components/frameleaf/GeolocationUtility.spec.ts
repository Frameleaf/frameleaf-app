import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import userEvent from '@testing-library/user-event';
import { addMessages } from 'svelte-i18n';
import en from '../../../../../i18n/en.json';
import { mapStub } from '../../../test-data/frameleaf/utility-map-stub';
import GeolocationUtility from './GeolocationUtility.svelte';

const state = vi.hoisted(() => ({ search: vi.fn(), info: vi.fn(), run: vi.fn() }));
vi.mock('@frameleaf/sdk', async (original) => ({
  ...(await original<typeof import('@frameleaf/sdk')>()),
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
    mapStub.calls = [];
    mapStub.inside = true;
    mapStub.center = { lng: 0, lat: 0 };
  });
  const setCoordinates = async (latitude: string, longitude: string) => {
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Latitude' }), { target: { value: latitude } });
    await fireEvent.input(screen.getByRole('spinbutton', { name: 'Longitude' }), { target: { value: longitude } });
  };
  const coordinates = () => [
    (screen.getByRole('spinbutton', { name: 'Latitude' }) as HTMLInputElement).valueAsNumber,
    (screen.getByRole('spinbutton', { name: 'Longitude' }) as HTMLInputElement).valueAsNumber,
  ];
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
    await userEvent.click(within(dialog).getByRole('button', { name: /Confirm/ }));
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
    await userEvent.click(within(dialog).getByRole('button', { name: /Confirm/ }));
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
    await userEvent.click(within(dialog).getByRole('button', { name: /Confirm/ }));

    await waitFor(() =>
      expect(state.run).toHaveBeenCalledExactlyOnceWith('change-location', ['one'], { clearLocation: true }),
    );
  });
  it('reviews each location change as owner · old → new with the fixed-set note (UT-10)', async () => {
    state.search.mockResolvedValue({
      assets: {
        items: [{ ...asset('one'), exifInfo: { latitude: 1.5, longitude: 2.5 } }, asset('two')],
        nextPage: null,
      },
    });
    render(GeolocationUtility);
    await userEvent.click(await screen.findByRole('checkbox', { name: 'one.jpg' }));
    await userEvent.click(screen.getByRole('checkbox', { name: 'two.jpg' }));
    await setCoordinates('10', '20');
    await userEvent.click(screen.getByRole('button', { name: 'Apply to 2 selected' }));
    const dialog = within(screen.getByRole('dialog', { name: 'Update locations' }));
    expect(dialog.getByText('one.jpg')).toBeInTheDocument();
    expect(dialog.getByText('Alex · 1.5, 2.5 → 10, 20')).toBeInTheDocument();
    expect(dialog.getByText('Alex · No location → 10, 20')).toBeInTheDocument();
    expect(
      dialog.getByText(
        'The selected items below are fixed for this operation. Changing a filter later will not add more items.',
      ),
    ).toBeInTheDocument();
    expect(dialog.getByText('Original files and ownership are retained.')).toBeInTheDocument();
    await userEvent.click(dialog.getByRole('button', { name: 'Confirm 2 items' }));
    await waitFor(() =>
      expect(state.run).toHaveBeenCalledExactlyOnceWith('change-location', ['one', 'two'], {
        latitude: 10,
        longitude: 20,
      }),
    );
  });
  it('uses a photo location from its card (UT-19)', async () => {
    state.search.mockResolvedValue({
      assets: {
        items: [{ ...asset('one'), exifInfo: { latitude: 51.5, longitude: -116.25 } }, asset('two')],
        nextPage: null,
      },
    });
    render(GeolocationUtility);
    const card = within((await screen.findByRole('img', { name: 'one.jpg' })).closest('article')!);
    await userEvent.click(card.getByRole('button', { name: 'Use this location' }));
    expect(coordinates()).toEqual([51.5, -116.25]);
    const other = within(screen.getByRole('img', { name: 'two.jpg' }).closest('article')!);
    expect(other.getByRole('button', { name: 'Use this location' })).toBeDisabled();
  });
  it('nudges the selected point with arrow keys on the focused map, farther with Shift (UT-18)', async () => {
    render(GeolocationUtility);
    await screen.findByRole('checkbox', { name: 'one.jpg' });
    await setCoordinates('10', '20');
    const map = screen.getByRole('group', { name: 'Choose a photo location on the coordinate map' });
    expect(map).toHaveAccessibleDescription(
      'Click the map or choose a photo marker. Arrow keys move the selected point; Shift moves farther.',
    );
    map.focus();
    await userEvent.keyboard('{ArrowUp}');
    expect(coordinates()).toEqual([10.001, 20]);
    await userEvent.keyboard('{Shift>}{ArrowRight}{/Shift}');
    expect(coordinates()).toEqual([10.001, 20.01]);
    await userEvent.keyboard('{ArrowDown}{ArrowLeft}');
    expect(coordinates()).toEqual([10, 20.009]);
  });
  it('moves the point with the direction buttons, starting from the map centre (UT-18)', async () => {
    mapStub.center = { lng: -116.18, lat: 51.36 };
    render(GeolocationUtility);
    await screen.findByRole('checkbox', { name: 'one.jpg' });
    await userEvent.click(screen.getByRole('button', { name: 'Move location north' }));
    expect(coordinates()).toEqual([51.361, -116.18]);
    await userEvent.click(screen.getByRole('button', { name: 'Move location east' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move location south' }));
    await userEvent.click(screen.getByRole('button', { name: 'Move location west' }));
    expect(coordinates()).toEqual([51.36, -116.18]);
  });
  it('zooms, centres on the selection and says when it is outside the view (UT-18)', async () => {
    render(GeolocationUtility);
    await screen.findByRole('checkbox', { name: 'one.jpg' });
    const center = screen.getByRole('button', { name: 'Center on selection' });
    expect(center).toBeDisabled();
    await userEvent.click(screen.getByRole('button', { name: 'Zoom in' }));
    await userEvent.click(screen.getByRole('button', { name: 'Zoom out' }));
    expect(mapStub.calls).toEqual(['zoomIn', 'zoomOut']);
    const hint = 'Selected location is outside this view. Center on it to see the marker.';
    mapStub.inside = false;
    await setCoordinates('10', '20');
    expect(await screen.findByText(hint)).toBeInTheDocument();
    await userEvent.click(center);
    expect(mapStub.calls).toContain('centerOn 20,10');
    mapStub.inside = true;
    mapStub.viewChanged();
    await waitFor(() => expect(screen.queryByText(hint)).not.toBeInTheDocument());
  });
});
