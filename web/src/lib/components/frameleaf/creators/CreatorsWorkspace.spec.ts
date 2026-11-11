import {
  MediaAuthenticationMethod,
  MediaFeedSupport,
  MediaIndividualSupport,
  MediaProtocolVersion,
  type MediaCapabilitiesDto,
} from '@frameleaf/sdk';
import { render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import en from '$i18n/en.json';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { creatorsStore } from '$lib/frameleaf/creators-store.svelte';
import { authManager } from '$lib/managers/auth-manager.svelte';
import { preferencesFactory } from '@test-data/factories/preferences-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import CreatorsWorkspace from './CreatorsWorkspace.svelte';
import { creatorFixture } from './creators.fixture';

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
