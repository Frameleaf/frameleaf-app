import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { userAdminFactory } from '@test-data/factories/user-factory';
import {
  AlbumUserRole,
  createSharedSpaceComment,
  deleteSharedSpaceComment,
  getSharedSpaceComments,
  getSharedSpaceMembers,
  type SharedSpaceCommentResponseDto,
} from '@immich/sdk';
import en from '../../../../../i18n/en.json';
import SpaceMediaComments from './SpaceMediaComments.svelte';

const adaId = '11111111-1111-4111-8111-111111111111';
const boId = '22222222-2222-4222-8222-222222222222';

vi.mock('$lib/utils');
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: {
    get user() {
      return { id: adaId, name: 'Ada', email: 'ada@example.com', isAdmin: false };
    },
    params: {},
  },
}));
vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getSharedSpaceComments: vi.fn(),
  getSharedSpaceMembers: vi.fn(),
  createSharedSpaceComment: vi.fn(),
  updateSharedSpaceComment: vi.fn(),
  deleteSharedSpaceComment: vi.fn(),
}));

const ada = userAdminFactory.build({ id: adaId, name: 'Ada', email: 'ada@example.com' });
const bo = userAdminFactory.build({ id: boId, name: 'Bo', email: 'bo@example.com' });

const comment = (overrides: Partial<SharedSpaceCommentResponseDto> = {}): SharedSpaceCommentResponseDto => ({
  id: 'c-1',
  createdAt: '2026-09-20T10:00:00.000Z',
  updatedAt: '2026-09-20T10:00:00.000Z',
  user: bo,
  assetId: 'asset-1',
  comment: 'Hello',
  mentions: [],
  canEdit: false,
  canDelete: false,
  ...overrides,
});

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
  vi.mocked(getSharedSpaceMembers).mockResolvedValue({
    members: [
      { user: ada, role: AlbumUserRole.Owner, pending: false },
      { user: bo, role: AlbumUserRole.Editor, pending: false },
    ],
  });
});

describe('SpaceMediaComments', () => {
  it('asks for the comments on this item and renders a mention as a name', async () => {
    vi.mocked(getSharedSpaceComments).mockResolvedValue({
      comments: [comment({ comment: `Nice one @{${adaId}}`, mentions: [ada] })],
    });

    render(SpaceMediaComments, { spaceId: 'space-1', assetId: 'asset-1' });

    await waitFor(() => expect(getSharedSpaceComments).toHaveBeenCalledWith({ id: 'space-1', assetId: 'asset-1' }));
    expect(await screen.findByText('@Ada')).toBeInTheDocument();
    expect(screen.queryByText(adaId, { exact: false })).toBeNull();
  });

  it('offers edit and delete only when the server says the member may', async () => {
    vi.mocked(getSharedSpaceComments).mockResolvedValue({
      comments: [
        comment({ id: 'mine', user: ada, comment: 'Mine', canEdit: true, canDelete: true }),
        comment({ id: 'theirs', user: bo, comment: 'Theirs', canEdit: false, canDelete: true }),
        comment({ id: 'untouchable', user: bo, comment: 'Untouchable' }),
      ],
    });

    render(SpaceMediaComments, { spaceId: 'space-1', assetId: 'asset-1' });

    await screen.findByText('Untouchable');
    expect(screen.getAllByRole('button', { name: en.frameleaf_spaces_comments_edit })).toHaveLength(1);
    expect(screen.getAllByRole('button', { name: en.frameleaf_spaces_comments_delete })).toHaveLength(2);
  });

  it('posts a comment on this item and shows it', async () => {
    vi.mocked(getSharedSpaceComments).mockResolvedValue({ comments: [] });
    vi.mocked(createSharedSpaceComment).mockResolvedValue(comment({ id: 'new', user: ada, comment: 'Posted' }));

    render(SpaceMediaComments, { spaceId: 'space-1', assetId: 'asset-1' });
    await screen.findByText(en.frameleaf_spaces_comments_empty);

    const box = screen.getByRole('textbox', { name: en.frameleaf_spaces_comments_placeholder });
    await fireEvent.input(box, { target: { value: 'Posted' } });
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_comments_send }));

    await waitFor(() =>
      expect(createSharedSpaceComment).toHaveBeenCalledWith({
        id: 'space-1',
        sharedSpaceCommentCreateDto: { assetId: 'asset-1', comment: 'Posted' },
      }),
    );
    expect(await screen.findByText('Posted')).toBeInTheDocument();
  });

  it('removes a comment through the space endpoint', async () => {
    vi.mocked(getSharedSpaceComments).mockResolvedValue({
      comments: [comment({ id: 'gone', user: bo, comment: 'Gone soon', canDelete: true })],
    });
    vi.mocked(deleteSharedSpaceComment).mockResolvedValue(undefined as never);

    render(SpaceMediaComments, { spaceId: 'space-1', assetId: 'asset-1' });
    await screen.findByText('Gone soon');

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_comments_delete }));

    await waitFor(() => expect(deleteSharedSpaceComment).toHaveBeenCalledWith({ id: 'space-1', commentId: 'gone' }));
    await waitFor(() => expect(screen.queryByText('Gone soon')).toBeNull());
  });
});
