import {
  AlbumUserRole,
  createSharedSpaceComment,
  deleteSharedSpaceComment,
  getSharedSpaceComments,
  getSharedSpaceMembers,
  type SharedSpaceCommentResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import { userAdminFactory } from '@test-data/factories/user-factory';
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
  parentId: null,
  replyCount: 0,
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

  describe('threaded replies', () => {
    const thread = () => [
      comment({ id: 'root', user: ada, comment: 'Where was this?', replyCount: 2 }),
      comment({ id: 'r-1', user: bo, comment: 'At the lake', parentId: 'root', createdAt: '2026-09-20T11:00:00.000Z' }),
      comment({ id: 'r-2', user: ada, comment: 'Of course', parentId: 'root', createdAt: '2026-09-20T12:00:00.000Z' }),
    ];

    it('folds replies under their comment until "View replies" is pressed', async () => {
      vi.mocked(getSharedSpaceComments).mockResolvedValue({ comments: thread() });

      render(SpaceMediaComments, { spaceId: 'space-1', assetId: 'asset-1' });
      await screen.findByText('Where was this?');

      expect(screen.queryByText('At the lake')).toBeNull();
      const toggle = screen.getByRole('button', { name: 'View 2 replies' });
      expect(toggle).toHaveAttribute('aria-expanded', 'false');

      await fireEvent.click(toggle);

      expect(await screen.findByText('At the lake')).toBeInTheDocument();
      expect(screen.getByText('Of course')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: en.frameleaf_spaces_comments_hide_replies })).toHaveAttribute(
        'aria-expanded',
        'true',
      );
    });

    it('replies to a reply in the same thread, starting with a mention of the person answered', async () => {
      vi.mocked(getSharedSpaceComments).mockResolvedValue({ comments: thread() });
      vi.mocked(createSharedSpaceComment).mockResolvedValue(
        comment({ id: 'r-3', user: ada, comment: `@{${boId}} thanks`, parentId: 'root', mentions: [bo] }),
      );

      render(SpaceMediaComments, { spaceId: 'space-1', assetId: 'asset-1' });
      await fireEvent.click(await screen.findByRole('button', { name: 'View 2 replies' }));
      await fireEvent.click(await screen.findByRole('button', { name: 'Reply to Bo' }));

      const box = await screen.findByRole('textbox', { name: en.frameleaf_spaces_comments_reply_placeholder });
      expect(box).toHaveValue(`@{${boId}} `);

      await fireEvent.input(box, { target: { value: `@{${boId}} thanks` } });
      await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_spaces_comments_reply_send }));

      await waitFor(() =>
        expect(createSharedSpaceComment).toHaveBeenCalledWith({
          id: 'space-1',
          sharedSpaceCommentCreateDto: { assetId: 'asset-1', comment: `@{${boId}} thanks`, parentId: 'r-1' },
        }),
      );
      expect(await screen.findByText('thanks', { exact: false })).toBeInTheDocument();
    });

    it('starts a reply to a top-level comment empty', async () => {
      vi.mocked(getSharedSpaceComments).mockResolvedValue({ comments: [comment({ id: 'root', user: bo })] });

      render(SpaceMediaComments, { spaceId: 'space-1', assetId: 'asset-1' });
      await fireEvent.click(await screen.findByRole('button', { name: 'Reply to Bo' }));

      expect(await screen.findByRole('textbox', { name: en.frameleaf_spaces_comments_reply_placeholder })).toHaveValue(
        '',
      );
    });

    it('asks the conversation about the space itself when no item is given', async () => {
      vi.mocked(getSharedSpaceComments).mockResolvedValue({ comments: [] });

      render(SpaceMediaComments, { spaceId: 'space-1' });

      await waitFor(() => expect(getSharedSpaceComments).toHaveBeenCalledWith({ id: 'space-1', assetId: undefined }));
      expect(await screen.findByText(en.frameleaf_spaces_comments_empty_space)).toBeInTheDocument();
    });

    it('offers no reply and no composer when comments are turned off, but keeps the thread readable', async () => {
      vi.mocked(getSharedSpaceComments).mockResolvedValue({ comments: [comment({ id: 'root', user: bo })] });

      render(SpaceMediaComments, { spaceId: 'space-1', assetId: 'asset-1', canComment: false });
      await screen.findByText('Hello');

      expect(screen.queryByRole('button', { name: 'Reply to Bo' })).toBeNull();
      expect(screen.getByRole('textbox', { name: en.comments_are_disabled })).toBeDisabled();
    });
  });

  describe('as the album view of a space', () => {
    it('offers the space’s own like beside the conversation', async () => {
      vi.mocked(getSharedSpaceComments).mockResolvedValue({ comments: [] });
      const onToggle = vi.fn();

      render(SpaceMediaComments, { spaceId: 'space-1', likes: { count: 0, liked: false, onToggle } });
      await screen.findByText(en.frameleaf_spaces_comments_empty_space);

      const like = screen.getByRole('button', { name: en.frameleaf_album_activity_like });
      expect(like).toHaveAttribute('aria-pressed', 'false');
      await fireEvent.click(like);
      expect(onToggle).toHaveBeenCalledTimes(1);
    });

    it('closes on Escape instead of letting the page go back', async () => {
      vi.mocked(getSharedSpaceComments).mockResolvedValue({ comments: [] });
      const onClose = vi.fn();

      render(SpaceMediaComments, { spaceId: 'space-1', onClose });
      const box = await screen.findByRole('textbox', { name: en.frameleaf_spaces_comments_placeholder });
      await fireEvent.keyDown(box, { key: 'Escape' });

      expect(onClose).toHaveBeenCalledTimes(1);
    });
  });
});
