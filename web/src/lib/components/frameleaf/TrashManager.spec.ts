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
import { flushSync } from 'svelte';
import { addMessages } from 'svelte-i18n';
import TrashManager from '$lib/components/frameleaf/TrashManager.svelte';
import { sessionAccess } from '$lib/frameleaf/session-access.svelte';
import en from '../../../../../i18n/en.json';

type Handler = (...args: never[]) => void;
/** What the page subscribed to, so a spec can deliver app and server events to it. */
const bus = vi.hoisted(() => ({
  app: new Set<Record<string, (...args: never[]) => void>>(),
  socket: new Map<string, (...args: never[]) => void>(),
}));

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
  eventManager: {
    emit: vi.fn(),
    on: vi.fn((handlers: Record<string, Handler>) => {
      bus.app.add(handlers);
      return () => bus.app.delete(handlers);
    }),
  },
}));
vi.mock('$lib/stores/websocket', () => ({
  websocketEvents: {
    on: vi.fn((event: string, handler: Handler) => {
      bus.socket.set(event, handler);
      return () => bus.socket.delete(event);
    }),
  },
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

/**
 * Deliver a server event the way `$lib/stores/websocket` does: trash and permanent deletion reach
 * pages as the app's `AssetsDelete` event, restore as the socket event itself.
 */
const server = {
  trash: (ids: string[]) => {
    for (const handlers of bus.app) {
      handlers.AssetsDelete?.(ids as never);
    }
  },
  delete: (id: string) => {
    for (const handlers of bus.app) {
      handlers.AssetsDelete?.([id] as never);
    }
  },
  restore: (ids: string[]) => bus.socket.get('on_asset_restore')?.(ids as never),
};

/** The debounced reload after lifecycle events waits 600 ms. */
const reload = { timeout: 2000 };

beforeEach(() => {
  vi.clearAllMocks();
  bus.app.clear();
  bus.socket.clear();
  sessionAccess.isElevated = false;
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

  describe('when the trash changes elsewhere', () => {
    it('reloads when something is trashed, keeping the selection', async () => {
      serve([item('lake'), item('camp')]);
      render(TrashManager);
      await fireEvent.click(await screen.findByLabelText('Select lake.jpg'));

      serve([item('fresh'), item('lake'), item('camp')]);
      server.trash(['fresh']);

      expect(await screen.findByText('fresh.jpg', {}, reload)).toBeInTheDocument();
      expect(getTrashItems).toHaveBeenCalledTimes(2);
      expect(screen.getByRole('button', { name: 'Restore selected (1)' })).toBeEnabled();
      expect(screen.getByLabelText('Select lake.jpg')).toBeChecked();
    });

    it('drops a restored item and its selection at once, then reloads', async () => {
      serve([item('lake'), item('camp')]);
      render(TrashManager);
      await fireEvent.click(await screen.findByLabelText('Select lake.jpg'));
      await fireEvent.click(screen.getByLabelText('Select camp.jpg'));
      expect(screen.getByRole('button', { name: 'Restore selected (2)' })).toBeInTheDocument();

      serve([item('camp')]);
      server.restore(['lake']);
      flushSync();

      expect(screen.queryByText('lake.jpg')).toBeNull();
      expect(screen.getByRole('button', { name: 'Restore selected (1)' })).toBeInTheDocument();
      expect(screen.getByLabelText('Select camp.jpg')).toBeChecked();
      await waitFor(() => expect(getTrashItems).toHaveBeenCalledTimes(2), reload);
    });

    it('drops a permanently deleted item and clears its selection, then reloads', async () => {
      serve([item('lake'), item('camp')]);
      render(TrashManager);
      await fireEvent.click(await screen.findByLabelText('Select lake.jpg'));

      serve([item('camp')]);
      server.delete('lake');
      flushSync();

      expect(screen.queryByText('lake.jpg')).toBeNull();
      expect(screen.getByRole('button', { name: 'Delete selected (0)' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: en.frameleaf_trash_clear_selection })).toBeNull();
      await waitFor(() => expect(getTrashItems).toHaveBeenCalledTimes(2), reload);
      expect(screen.getByText('camp.jpg')).toBeInTheDocument();
    });

    it('prunes a selected item the reload no longer lists', async () => {
      serve([item('lake'), item('camp')]);
      render(TrashManager);
      await fireEvent.click(await screen.findByLabelText('Select lake.jpg'));

      // another device emptied part of the trash; only the event for an unrelated item arrived
      serve([item('camp')]);
      server.trash(['elsewhere']);

      await waitFor(() => expect(screen.queryByText('lake.jpg')).toBeNull(), reload);
      expect(screen.getByRole('button', { name: 'Restore selected (0)' })).toBeDisabled();
      expect(screen.queryByRole('button', { name: en.frameleaf_trash_clear_selection })).toBeNull();
    });
  });

  describe('when the session is locked or unlocked', () => {
    it('hides Locked media at once on lock, clears the selection and reloads', async () => {
      sessionAccess.isElevated = true;
      serve([item('lake'), item('vault', { isLocked: true })]);
      render(TrashManager);
      await fireEvent.click(await screen.findByLabelText('Select vault.jpg'));

      // the reload after the lock has not answered yet
      let answer: (value: Awaited<ReturnType<typeof getTrashItems>>) => void = () => {};
      vi.mocked(getTrashItems).mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
      sessionAccess.isElevated = false;
      flushSync();

      expect(screen.queryByText('vault.jpg')).toBeNull();
      expect(screen.getByText('lake.jpg')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'Restore selected (0)' })).toBeDisabled();
      expect(getTrashItems).toHaveBeenCalledTimes(2);

      answer({ items: [item('lake')], total: 1, nextPage: null });
      await waitFor(() => expect(screen.getByText(/1 matching item/)).toBeInTheDocument());
      expect(screen.queryByText('vault.jpg')).toBeNull();
    });

    it('reloads on unlock to show what the session may now see, starting a fresh selection', async () => {
      serve([item('lake')]);
      render(TrashManager);
      await fireEvent.click(await screen.findByLabelText('Select lake.jpg'));

      serve([item('lake'), item('vault', { isLocked: true })]);
      sessionAccess.isElevated = true;
      flushSync();

      expect(await screen.findByText('vault.jpg')).toBeInTheDocument();
      expect(getTrashItems).toHaveBeenCalledTimes(2);
      expect(screen.getByLabelText('Select lake.jpg')).not.toBeChecked();
      expect(screen.getByRole('button', { name: 'Restore selected (0)' })).toBeDisabled();
    });
  });
});
