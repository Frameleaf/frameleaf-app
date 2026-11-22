import {
  MediaAuthenticationMethod,
  MediaFeedSupport,
  MediaIndividualSupport,
  MediaProtocolVersion,
  MediaImportItemState,
  MediaImportState,
  type MediaCapabilitiesDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { creatorsStore } from '$lib/frameleaf/creators-store.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import CreatorsWorkspace from './CreatorsWorkspace.svelte';
import { creatorFixture, inspectionFixture } from './creators.fixture';

const app = vi.hoisted(() => ({ page: { url: new URL('http://localhost/pro?area=creators') } }));
vi.mock('$app/state', () => ({ page: app.page }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(() => Promise.resolve()) }));

const capabilities = (change: Partial<MediaCapabilitiesDto> = {}): MediaCapabilitiesDto => ({
  authentication: [MediaAuthenticationMethod.Credentials],
  available: true,
  creatorFeeds: MediaFeedSupport.PerUrl,
  galleryDlVersion: '1',
  individualMedia: MediaIndividualSupport.InstalledExtractors,
  qualifiedProviders: [],
  reason: null,
  version: MediaProtocolVersion.$1,
  ytDlpVersion: '1',
  ...change,
});

beforeEach(() => {
  addMessages('dev', en);
  app.page.url = new URL('http://localhost/pro?area=creators');
  creatorsStore.reset();
  authManager.setUser(userAdminFactory.build());
  authManager.setPreferences(preferencesFactory.build());
  sdkMock.isHttpError.mockImplementation((error) => (error as { status?: number } | null)?.status !== undefined);
  sdkMock.getMediaCapabilities.mockResolvedValue(capabilities());
  sdkMock.getMediaCreators.mockResolvedValue({ creators: [creatorFixture()] });
  sdkMock.getMediaConnections.mockResolvedValue({ connections: [] });
  sdkMock.getAllAlbums.mockResolvedValue([]);
  sdkMock.getNewMediaCreatorItems.mockResolvedValue({ items: [] });
  sdkMock.getMediaImports.mockResolvedValue({ imports: [] });
});

afterEach(() => {
  authManager.reset();
});

describe('CreatorsWorkspace', () => {
  it('lists every download on the Downloads page, with why a paused one stopped', async () => {
    const [file] = inspectionFixture().items;
    const paused = inspectionFixture({
      id: 'import-paused',
      albumId: 'album-1',
      state: MediaImportState.Paused,
      error: 'Media import could not continue; check access, destination and storage',
      items: [{ ...file, title: 'Sawmill clip' }],
    });
    const going = inspectionFixture({
      id: 'import-going',
      albumId: 'album-1',
      state: MediaImportState.Downloading,
      discovered: 2,
      saved: 1,
      items: [
        { ...file, id: 'a', title: 'Lake at first light', state: MediaImportItemState.Saved },
        { ...file, id: 'b', title: 'Trail sign in fog', state: MediaImportItemState.Discovered },
      ],
    });
    sdkMock.getMediaImports.mockResolvedValue({ imports: [paused, going] });
    sdkMock.retryMediaImport.mockResolvedValue({ ...paused, state: MediaImportState.Queued, error: null });
    app.page.url = new URL('http://localhost/pro?area=creators&view=downloads');
    render(CreatorsWorkspace);

    expect(await screen.findByRole('heading', { level: 1, name: 'Downloads' })).toBeInTheDocument();
    const row = (await screen.findByText('Sawmill clip')).closest('tr')!;
    expect(within(row).getByText('Paused')).toBeInTheDocument();
    expect(within(row).getByText(/check access, destination and storage/)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Waiting 1/ })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: /Needs you 1/ })).toBeInTheDocument();
    // the page is the whole list, so the tray is not drawn over it
    expect(screen.queryByRole('link', { name: 'See all downloads' })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Files in 2 items' }));
    expect(screen.getByText('Trail sign in fog')).toBeInTheDocument();

    await fireEvent.click(within(row).getByRole('button', { name: 'Retry' }));
    await waitFor(() =>
      expect(sdkMock.retryMediaImport).toHaveBeenCalledWith(expect.objectContaining({ id: 'import-paused' })),
    );
  });

  it('shows Home with everyone followed', async () => {
    render(CreatorsWorkspace);
    expect(await screen.findByRole('heading', { level: 1, name: 'Creators' })).toBeInTheDocument();
    expect(screen.getByRole('textbox', { name: 'Add from the web' })).toBeInTheDocument();
    expect(await screen.findByRole('link', { name: /Mara Ellis/ })).toHaveAttribute(
      'href',
      '/pro?area=creators&creator=creator-1',
    );
    expect(screen.getByRole('region', { name: 'Downloads' })).toBeInTheDocument();
  });

  it('says Creators is unavailable on an older Library', async () => {
    sdkMock.getMediaCapabilities.mockRejectedValue({ status: 404 });
    render(CreatorsWorkspace);
    expect(await screen.findByText('Media downloads are unavailable on this Library.')).toBeInTheDocument();
    expect(sdkMock.getMediaCreators).not.toHaveBeenCalled();
    expect(screen.queryByRole('textbox', { name: 'Add from the web' })).not.toBeInTheDocument();
    expect(screen.queryByRole('region', { name: 'Downloads' })).not.toBeInTheDocument();
  });

  it('says the same when the Library has no creators endpoints', async () => {
    sdkMock.getMediaCreators.mockRejectedValue({ status: 404 });
    render(CreatorsWorkspace);
    expect(await screen.findByText('Media downloads are unavailable on this Library.')).toBeInTheDocument();
    expect(screen.queryByRole('textbox', { name: 'Add from the web' })).not.toBeInTheDocument();
  });

  it('gives the Library’s reason when it cannot save from the web', async () => {
    sdkMock.getMediaCapabilities.mockResolvedValue(capabilities({ available: false, reason: 'yt-dlp is missing.' }));
    render(CreatorsWorkspace);
    expect(await screen.findByText('yt-dlp is missing.')).toBeInTheDocument();
    expect(sdkMock.getMediaCreators).not.toHaveBeenCalled();
  });

  it('offers to try again when the Library could not be asked', async () => {
    sdkMock.getMediaCapabilities.mockRejectedValue(new Error('offline'));
    render(CreatorsWorkspace);
    await waitFor(() => expect(screen.getByRole('alert')).toBeInTheDocument());
    expect(screen.getByRole('button', { name: /try again/i })).toBeInTheDocument();
  });
});
