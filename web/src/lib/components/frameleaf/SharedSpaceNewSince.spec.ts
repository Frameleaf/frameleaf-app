import { markSharedSpaceVisited, AlbumKind, type SharedSpaceNewResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { albumFactory } from '@test-data/factories/album-factory';
import en from '../../../../../i18n/en.json';
import SharedSpaceNewSince from './SharedSpaceNewSince.svelte';

vi.mock('$lib/utils');
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  markSharedSpaceVisited: vi.fn(),
}));

const space = albumFactory.build({ id: 'space-1', albumName: 'Family Space', kind: AlbumKind.Space });

const info = (overrides: Partial<SharedSpaceNewResponseDto> = {}): SharedSpaceNewResponseDto => ({
  assetCount: 3,
  assetIds: ['a', 'b', 'c'],
  lastVisitedAt: '2026-09-20T00:00:00.000Z',
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('SharedSpaceNewSince', () => {
  it('says nothing when nothing is new', () => {
    render(SharedSpaceNewSince, {
      space,
      info: info({ assetCount: 0, assetIds: [] }),
      showing: false,
      onToggle: vi.fn(),
      onMarked: vi.fn(),
    });

    expect(screen.queryByRole('button', { name: en.frameleaf_spaces_new_mark_seen })).toBeNull();
  });

  it('counts since the last visit, or what others added when there was none', () => {
    const { unmount } = render(SharedSpaceNewSince, {
      space,
      info: info(),
      showing: false,
      onToggle: vi.fn(),
      onMarked: vi.fn(),
    });
    expect(screen.getByText(/3 new items since your last visit/)).toBeInTheDocument();
    unmount();

    render(SharedSpaceNewSince, {
      space,
      info: info({ lastVisitedAt: null }),
      showing: false,
      onToggle: vi.fn(),
      onMarked: vi.fn(),
    });
    expect(screen.getByText(/3 items added by other members/)).toBeInTheDocument();
  });

  it('narrows the timeline on request without marking anything seen', async () => {
    const onToggle = vi.fn();
    render(SharedSpaceNewSince, { space, info: info(), showing: false, onToggle, onMarked: vi.fn() });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_new_show }));

    expect(onToggle).toHaveBeenCalledWith(true);
    expect(markSharedSpaceVisited).not.toHaveBeenCalled();
  });

  it('marks the space seen only when asked, and hands back the server answer', async () => {
    const after = info({ assetCount: 0, assetIds: [] });
    vi.mocked(markSharedSpaceVisited).mockResolvedValue(after);
    const onToggle = vi.fn();
    const onMarked = vi.fn();
    render(SharedSpaceNewSince, { space, info: info(), showing: true, onToggle, onMarked });

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_new_mark_seen }));

    await waitFor(() => expect(markSharedSpaceVisited).toHaveBeenCalledWith({ id: 'space-1' }));
    await waitFor(() => expect(onMarked).toHaveBeenCalledWith(after));
    expect(onToggle).toHaveBeenCalledWith(false);
  });

  it('says when it is showing fewer items than it counted', () => {
    render(SharedSpaceNewSince, {
      space,
      info: info({ assetCount: 900, assetIds: ['a', 'b'] }),
      showing: true,
      onToggle: vi.fn(),
      onMarked: vi.fn(),
    });

    expect(screen.getByText(/Showing the 2 most recent/)).toBeInTheDocument();
  });
});
