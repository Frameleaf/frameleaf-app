import {
  AlbumKind,
  AlbumUserRole,
  type AlbumResponseDto,
  type SharedLinkResponseDto,
  type SharedSpaceActivityResponseDto,
} from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { get } from 'svelte/store';
import { goto, replaceState } from '$app/navigation';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { SlideshowState, slideshowStore } from '$lib/stores/slideshow.store';
import { openFileUploadDialog } from '$lib/utils/file-uploader';
import { albumFactory } from '@test-data/factories/album-factory';
import { assetFactory } from '@test-data/factories/asset-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';
import SharedSpaceDetail from './SharedSpaceDetail.svelte';

const app = vi.hoisted(() => ({ page: { url: new URL('http://localhost/sharing/space-1'), state: {} } }));
vi.mock('$app/state', () => ({ page: app.page }));
vi.mock('$app/navigation', () => ({ goto: vi.fn(), replaceState: vi.fn() }));
vi.mock('$lib/utils/file-uploader', () => ({ openFileUploadDialog: vi.fn(() => Promise.resolve([])) }));

let signedInId = 'me';
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    get user() {
      return { id: signedInId, name: 'Me', email: 'me@example.com', isAdmin: false };
    },
    params: {},
    preferences: { download: { archiveSize: 0, includeEmbeddedVideos: false } },
  },
}));

// The panels and the viewer have their own specs; here only the header is under test.
vi.mock('./SharedSpaceTimeline.svelte', async () => ({
  default: (await import('$lib/../test-data/frameleaf/EmptyStub.svelte')).default,
}));
vi.mock('./SharedSpaceNewSince.svelte', async () => ({
  default: (await import('$lib/../test-data/frameleaf/EmptyStub.svelte')).default,
}));
vi.mock('./SharedSpaceAddMatching.svelte', async () => ({
  default: (await import('$lib/../test-data/frameleaf/EmptyStub.svelte')).default,
}));
vi.mock('./SharedSpaceMap.svelte', async () => ({
  default: (await import('$lib/../test-data/frameleaf/EmptyStub.svelte')).default,
}));
vi.mock('./SharedSpaceActivity.svelte', async () => ({
  default: (await import('$lib/../test-data/frameleaf/EmptyStub.svelte')).default,
}));
vi.mock('./SharedSpaceMembers.svelte', async () => ({
  default: (await import('$lib/../test-data/frameleaf/EmptyStub.svelte')).default,
}));
vi.mock('./ResultsAssetViewer.svelte', async () => ({
  default: (await import('$lib/../test-data/frameleaf/EmptyStub.svelte')).default,
}));

const me = userAdminFactory.build({ id: 'me', name: 'Me' });
const jamie = userAdminFactory.build({ id: 'jamie', name: 'Jamie' });

const spaceAs = (role: AlbumUserRole): AlbumResponseDto =>
  albumFactory.build({
    id: 'space-1',
    albumName: 'Family',
    description: 'Everyone’s photos',
    kind: AlbumKind.Space,
    assetCount: 12,
    albumUsers:
      role === AlbumUserRole.Owner
        ? [
            { user: me, role: AlbumUserRole.Owner },
            { user: jamie, role: AlbumUserRole.Editor },
          ]
        : [
            { user: jamie, role: AlbumUserRole.Owner },
            { user: me, role },
          ],
  });

const activity = (unreadCount: number): SharedSpaceActivityResponseDto => ({
  events: [],
  hasMore: false,
  lastVisitedAt: null,
  unreadCount,
});

const renderSpace = (space: AlbumResponseDto, extra: Record<string, unknown> = {}) =>
  render(SharedSpaceDetail, { props: { space, members: [], onRefresh: vi.fn(), ...extra } });

const panel = () => document.querySelector<HTMLElement>('.panel')?.dataset.panel;

describe('SharedSpaceDetail header (FL-83 AL-42)', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    vi.clearAllMocks();
    signedInId = 'me';
    app.page.url = new URL('http://localhost/sharing/space-1');
    sdkMock.getAllSharedLinks.mockResolvedValue([]);
    sdkMock.getAlbumIconCatalogue.mockResolvedValue({ version: '7.4.47', names: [], suggested: [] });
    sdkMock.searchAssets.mockResolvedValue({
      assets: { items: [assetFactory.build({ id: 'a1' })], nextPage: null, total: 1, count: 1, facets: [] },
    } as never);
    slideshowStore.slideshowState.set(SlideshowState.None);
  });

  it('shows the Shared spaces breadcrumb and the Shared space badge', () => {
    renderSpace(spaceAs(AlbumUserRole.Owner));

    const crumbs = within(screen.getByRole('navigation', { name: 'Breadcrumb' }));
    expect(crumbs.getByRole('link', { name: 'Shared spaces' })).toHaveAttribute('href', '/sharing');
    expect(crumbs.getByText('Family')).toHaveAttribute('aria-current', 'page');
    expect(screen.getByText('shared space', { selector: '.badge-pill' })).toBeInTheDocument();
  });

  it('edits the title and description in place, and offers the icon, for an owner or editor', async () => {
    sdkMock.updateAlbumInfo.mockResolvedValue({ ...spaceAs(AlbumUserRole.Owner), albumName: 'Family & friends' });
    const onRefresh = vi.fn();
    renderSpace(spaceAs(AlbumUserRole.Owner), { onRefresh });

    expect(screen.getByRole('button', { name: 'Change icon' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Edit description' })).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'Edit title' }));
    const field = screen.getByRole('textbox', { name: 'Edit title' });
    await fireEvent.input(field, { target: { value: 'Family & friends' } });
    await fireEvent.keyDown(field, { key: 'Enter' });

    await waitFor(() =>
      expect(sdkMock.updateAlbumInfo).toHaveBeenCalledWith({
        id: 'space-1',
        updateAlbumDto: { albumName: 'Family & friends' },
      }),
    );
    await waitFor(() => expect(onRefresh).toHaveBeenCalled());
  });

  it('keeps a viewer’s header read-only', () => {
    renderSpace(spaceAs(AlbumUserRole.Viewer));

    expect(screen.queryByRole('button', { name: 'Change icon' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Edit title' })).toBeNull();
    expect(screen.queryByRole('button', { name: 'Add photos' })).toBeNull();
    expect(screen.getByRole('heading', { level: 1, name: 'Family' })).toBeInTheDocument();
    const toolbar = within(screen.getByRole('toolbar'));
    expect(toolbar.getByRole('button', { name: 'Members' })).toBeInTheDocument();
    expect(toolbar.queryByRole('button', { name: 'Share' })).toBeNull();
  });

  it('shows who it is shared with and opens the Members panel to manage them', async () => {
    renderSpace(spaceAs(AlbumUserRole.Owner));

    await fireEvent.click(screen.getByRole('button', { name: 'Shared with 1 person. Manage members' }));
    expect(panel()).toBe('members');
    expect(replaceState).toHaveBeenCalled();

    await fireEvent.click(screen.getByRole('button', { name: 'Map' }));
    expect(panel()).toBe('places');
    await fireEvent.click(screen.getByRole('button', { name: 'Share' }));
    expect(panel()).toBe('members');
  });

  it('adds photos from the library or by uploading', async () => {
    renderSpace(spaceAs(AlbumUserRole.Owner));

    await fireEvent.click(screen.getByRole('button', { name: 'Add photos' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Upload from computer' }));
    expect(openFileUploadDialog).toHaveBeenCalledWith({ albumId: 'space-1' });

    await fireEvent.click(screen.getByRole('button', { name: 'Add photos' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Select from library' }));
    expect(goto).toHaveBeenCalledWith('/photos');
  });

  it('creates the first link, and lists them once there are some', async () => {
    const first = renderSpace(spaceAs(AlbumUserRole.Owner));
    await fireEvent.click(await screen.findByRole('button', { name: 'Create link' }));
    expect(await screen.findByRole('dialog', { name: 'Create shared link' })).toBeInTheDocument();
    expect(sdkMock.getAllSharedLinks).toHaveBeenCalledWith({ albumId: 'space-1' });
    first.unmount();

    sdkMock.getAllSharedLinks.mockResolvedValue([{ id: 'l1' }, { id: 'l2' }] as SharedLinkResponseDto[]);
    renderSpace(spaceAs(AlbumUserRole.Owner));
    await fireEvent.click(await screen.findByRole('button', { name: 'Links, 2' }));
    expect(goto).toHaveBeenCalledWith('/shared-links');
  });

  it('offers links to the owner only', async () => {
    renderSpace(spaceAs(AlbumUserRole.Editor));
    await waitFor(() => expect(screen.getByRole('button', { name: 'Map' })).toBeInTheDocument());
    expect(screen.queryByRole('button', { name: /^(Create link|Links, \d+)$/ })).toBeNull();
    expect(sdkMock.getAllSharedLinks).not.toHaveBeenCalled();
  });

  it('opens the Activity panel from a button that says how many entries are new', async () => {
    renderSpace(spaceAs(AlbumUserRole.Owner), { activity: activity(3) });

    await fireEvent.click(screen.getByRole('button', { name: 'Activity, 3 entries' }));
    expect(panel()).toBe('activity');
  });

  it('starts the slideshow in the space’s own viewer', async () => {
    renderSpace(spaceAs(AlbumUserRole.Owner));

    await fireEvent.click(screen.getByRole('button', { name: 'Slideshow' }));

    await waitFor(() => expect(goto).toHaveBeenCalledWith(expect.stringContaining('/sharing/space-1/photos/a1')));
    await waitFor(() => expect(get(slideshowStore.slideshowState)).toBe(SlideshowState.PlaySlideshow));
  });
});
