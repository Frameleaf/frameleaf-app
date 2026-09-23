import {
  applyTrashReview,
  AssetTypeEnum,
  getTrashItems,
  getTrashSummary,
  reviewTrash,
  TrashReviewAction,
  type TrashItemResponseDto,
} from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { addMessages } from 'svelte-i18n';
import TrashManager from '$lib/components/frameleaf/TrashManager.svelte';
import en from '../../../../../i18n/en.json';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getTrashItems: vi.fn(),
  getTrashSummary: vi.fn(),
  reviewTrash: vi.fn(),
  applyTrashReview: vi.fn(),
}));
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));
vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'me', name: 'Taylor', isAdmin: false } },
}));
vi.mock('$lib/managers/event-manager.svelte', () => ({
  eventManager: { emit: vi.fn(), on: vi.fn(() => () => {}) },
}));
vi.mock('$lib/stores/websocket', () => ({
  websocketEvents: { on: vi.fn(() => () => {}) },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { trash: true } },
}));
vi.mock('$lib/managers/server-config-manager.svelte', () => ({
  serverConfigManager: { value: { trashDays: 30 } },
}));

const item = (id: string, overrides: Partial<TrashItemResponseDto> = {}): TrashItemResponseDto => ({
  id,
  originalFileName: `${id}.jpg`,
  type: AssetTypeEnum.Image,
  fileSizeInByte: 2048,
  trashedAt: new Date().toISOString(),
  isLocked: false,
  isOffline: false,
  ...overrides,
});

const serve = (rows: TrashItemResponseDto[]) => {
  vi.mocked(getTrashSummary).mockResolvedValue({
    count: rows.length,
    offline: rows.filter((row) => row.isOffline).length,
    bytes: rows.length * 2048,
    pendingDeletion: 0,
  });
  vi.mocked(getTrashItems).mockResolvedValue({ items: rows, total: rows.length, nextPage: null });
};

const httpError = (status: number) => Object.assign(new Error('refused'), { status });

beforeEach(() => {
  vi.clearAllMocks();
  addMessages('dev', en);
});

describe('TrashManager (FL-47)', () => {
  it("lists the server's trash with its retention window", async () => {
    serve([item('lake'), item('camp', { type: AssetTypeEnum.Video })]);

    render(TrashManager);

    expect(await screen.findByText('lake.jpg')).toBeInTheDocument();
    expect(screen.getByText('camp.jpg')).toBeInTheDocument();
    expect(screen.getByText('30 days')).toBeInTheDocument();
    expect(screen.getByText(/2 matching items/)).toBeInTheDocument();
  });

  it('shows the empty trash', async () => {
    serve([]);

    render(TrashManager);

    expect(await screen.findByText(en.frameleaf_trash_empty_title)).toBeInTheDocument();
  });

  it('permanently deletes only the reviewed items, after the typed confirmation', async () => {
    serve([item('lake'), item('camp')]);
    vi.mocked(reviewTrash).mockResolvedValue({
      action: TrashReviewAction.Delete,
      count: 1,
      bytes: 2048,
      retainedOriginals: 0,
      retainedBytes: 0,
      names: ['lake.jpg'],
      token: 'reviewed-token',
    });
    vi.mocked(applyTrashReview).mockResolvedValue({ count: 1 });

    render(TrashManager);
    await fireEvent.click(await screen.findByLabelText('Select lake.jpg'));
    await fireEvent.click(screen.getByRole('button', { name: 'Delete selected (1)' }));

    await waitFor(() =>
      expect(reviewTrash).toHaveBeenCalledWith({ trashReviewDto: { action: TrashReviewAction.Delete, ids: ['lake'] } }),
    );
    const confirm = await screen.findByRole('button', { name: 'Permanently delete 1 item' });
    expect(confirm).toBeDisabled();

    await fireEvent.input(screen.getByLabelText(en.frameleaf_trash_review_confirm_label), {
      target: { value: 'DELETE 1' },
    });
    await fireEvent.click(confirm);

    await waitFor(() =>
      expect(applyTrashReview).toHaveBeenCalledWith({
        trashApplyDto: { action: TrashReviewAction.Delete, ids: ['lake'], token: 'reviewed-token' },
      }),
    );
  });

  it('says so when the trash changed after the review, and changes nothing', async () => {
    serve([item('lake')]);
    vi.mocked(reviewTrash).mockResolvedValue({
      action: TrashReviewAction.Empty,
      count: 1,
      bytes: 2048,
      retainedOriginals: 0,
      retainedBytes: 0,
      names: ['lake.jpg'],
      token: 'stale-token',
    });
    vi.mocked(applyTrashReview).mockRejectedValue(httpError(409));

    render(TrashManager);
    await screen.findByText('lake.jpg');
    await fireEvent.click(screen.getByRole('button', { name: 'Empty your trash (1)' }));
    await fireEvent.input(await screen.findByLabelText(en.frameleaf_trash_review_confirm_label), {
      target: { value: 'DELETE 1' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'Permanently delete 1 item' }));

    expect(await screen.findByText(en.frameleaf_trash_error_changed)).toBeInTheDocument();
    expect(reviewTrash).toHaveBeenCalledWith({ trashReviewDto: { action: TrashReviewAction.Empty } });
  });

  it('restores one item through its review', async () => {
    serve([item('lake')]);
    vi.mocked(reviewTrash).mockResolvedValue({
      action: TrashReviewAction.Restore,
      count: 1,
      bytes: 2048,
      retainedOriginals: 0,
      retainedBytes: 0,
      names: ['lake.jpg'],
      token: 'restore-token',
    });
    vi.mocked(applyTrashReview).mockResolvedValue({ count: 1 });

    render(TrashManager);
    await screen.findByText('lake.jpg');
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_trash_restore }));

    await waitFor(() =>
      expect(applyTrashReview).toHaveBeenCalledWith({
        trashApplyDto: { action: TrashReviewAction.Restore, ids: ['lake'], token: 'restore-token' },
      }),
    );
  });

  it('lists a missing external original without offering to change it', async () => {
    serve([item('lake'), item('gone', { isOffline: true })]);

    render(TrashManager);

    expect(await screen.findByText('gone.jpg')).toBeInTheDocument();
    expect(screen.queryByLabelText('Select gone.jpg')).toBeNull();
    expect(screen.getByText(en.frameleaf_trash_offline)).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'Empty your trash (1)' })).toBeInTheDocument();
  });
});
