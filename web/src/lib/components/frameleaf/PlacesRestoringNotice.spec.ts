import type { ServerConfigDto } from '@frameleaf/sdk';
import { render, screen } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import PlacesRestoringNotice from '$lib/components/frameleaf/PlacesRestoringNotice.svelte';
import en from '../../../../../i18n/en.json';

const config = vi.hoisted(() => ({ value: { placesRestoring: false } }));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({ serverConfigManager: config }));

/** The notice looks again every 30 seconds while the places are being put back. */
const PLACES_RESTORING_POLL_MS = 30_000;
const message = 'Putting place names and landmarks back. Some may be missing for a few minutes.';
const serverSays = (placesRestoring: boolean) =>
  sdkMock.getServerConfig.mockResolvedValue({ placesRestoring } as ServerConfigDto);

beforeAll(() => addMessages('dev', en));
beforeEach(() => {
  vi.clearAllMocks();
  vi.useFakeTimers();
});
afterEach(() => vi.useRealTimers());

/** FL-402: places look missing while the server puts them back after a restore, so the pages say why. */
describe('PlacesRestoringNotice', () => {
  it('says the places are being put back while the server reports it', async () => {
    config.value.placesRestoring = true;
    serverSays(true);

    render(PlacesRestoringNotice);

    expect(screen.getByRole('status')).toHaveTextContent(message);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByTestId('places-restoring-notice')).toBeInTheDocument();
  });

  it('goes away by itself once the places are back', async () => {
    config.value.placesRestoring = true;
    serverSays(true);
    render(PlacesRestoringNotice);
    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText(message)).toBeInTheDocument();

    serverSays(false);
    await vi.advanceTimersByTimeAsync(PLACES_RESTORING_POLL_MS);

    expect(screen.queryByText(message)).not.toBeInTheDocument();
    // with nothing left to explain, it stops asking
    const calls = sdkMock.getServerConfig.mock.calls.length;
    await vi.advanceTimersByTimeAsync(PLACES_RESTORING_POLL_MS * 3);
    expect(sdkMock.getServerConfig).toHaveBeenCalledTimes(calls);
  });

  it('shows up when the server starts putting places back after the app loaded', async () => {
    config.value.placesRestoring = false;
    serverSays(true);

    render(PlacesRestoringNotice);
    expect(screen.queryByText(message)).not.toBeInTheDocument();

    await vi.advanceTimersByTimeAsync(0);
    expect(screen.getByText(message)).toBeInTheDocument();
  });

  it('shows nothing when the places are in, or the server cannot be asked', async () => {
    config.value.placesRestoring = false;
    sdkMock.getServerConfig.mockRejectedValue(new Error('offline'));

    render(PlacesRestoringNotice, { layout: 'map' });
    await vi.advanceTimersByTimeAsync(0);

    expect(screen.queryByText(message)).not.toBeInTheDocument();
    expect(screen.queryByTestId('places-restoring-notice')).not.toBeInTheDocument();
  });
});
