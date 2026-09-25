import type { AssetResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { flushSync } from 'svelte';
import { addMessages } from 'svelte-i18n';
import { SvelteSet } from 'svelte/reactivity';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import LargeFilesReview from '$lib/components/frameleaf/LargeFilesReview.svelte';
import en from '../../../../../i18n/en.json';

type Handler = (...args: never[]) => void;
/** The server events the review subscribed to, so a spec can deliver them. */
const socket = vi.hoisted(() => new Map<string, (...args: never[]) => void>());

vi.mock('$lib/managers/auth-manager.svelte', () => ({
  authManager: { user: { id: 'me', name: 'Taylor', isAdmin: false } },
}));
vi.mock('$lib/managers/feature-flags-manager.svelte', () => ({
  featureFlagsManager: { value: { trash: true } },
}));
vi.mock('$lib/stores/websocket', () => ({
  websocketEvents: {
    on: vi.fn((event: string, handler: Handler) => {
      socket.set(event, handler);
      return () => socket.delete(event);
    }),
  },
}));

const asset = (id: string, bytes: number) =>
  ({
    id,
    ownerId: 'me',
    originalFileName: `${id}.mov`,
    originalPath: `/library/${id}.mov`,
    originalMimeType: 'video/quicktime',
    thumbhash: null,
    exifInfo: { fileSizeInByte: bytes },
  }) as unknown as AssetResponseDto;

/** Largest first: big, mid, small. */
const library = () => [asset('small', 1_000_000), asset('big', 9_000_000), asset('mid', 5_000_000)];

const server = {
  trash: (ids: string[]) => socket.get('on_asset_trash')?.(ids as never),
  delete: (id: string) => socket.get('on_asset_delete')?.(id as never),
};

const setup = () => {
  const trashed = new SvelteSet<string>();
  const removed = new SvelteSet<string>();
  render(LargeFilesReview, { assets: library(), trashed, removed, onOpen: vi.fn() });
  return { trashed, removed };
};

/** Open the evidence view of one row. */
const inspect = async (name: string) => {
  const row = screen.getByText(name).closest('tr')!;
  await fireEvent.click(within(row).getByRole('button', { name: en.frameleaf_large_files_inspect }));
  return screen.findByRole('dialog', { name });
};

beforeEach(() => {
  vi.clearAllMocks();
  socket.clear();
  sdkMock.getPartners.mockResolvedValue([]);
  addMessages('dev', en);
});

describe('LargeFilesReview (FL-47): an item under review is removed elsewhere', () => {
  it('moves to the next largest item when the one being inspected is deleted', async () => {
    const { removed } = setup();
    await inspect('big.mov');

    server.delete('big');
    flushSync();

    expect(removed.has('big')).toBe(true);
    expect(screen.queryByRole('dialog', { name: 'big.mov' })).toBeNull();
    const dialog = await screen.findByRole('dialog', { name: 'mid.mov' });
    expect(within(dialog).getByText('/library/mid.mov')).toBeInTheDocument();
    expect(screen.queryByText('big.mov')).toBeNull();
  });

  it('moves to the next item when the one being inspected is trashed elsewhere', async () => {
    const { trashed } = setup();
    await inspect('mid.mov');

    server.trash(['mid']);
    flushSync();

    expect(trashed.has('mid')).toBe(true);
    expect(await screen.findByRole('dialog', { name: 'small.mov' })).toBeInTheDocument();
  });

  it('steps back to the previous item when the last one is removed', async () => {
    setup();
    await inspect('small.mov');

    server.delete('small');
    flushSync();

    expect(await screen.findByRole('dialog', { name: 'mid.mov' })).toBeInTheDocument();
  });

  it('closes the evidence view when nothing is left to review', async () => {
    setup();
    await inspect('big.mov');

    server.trash(['big', 'mid', 'small']);
    flushSync();

    await waitFor(() => expect(screen.queryByRole('dialog')).toBeNull());
    expect(screen.getByText(en.frameleaf_large_files_empty_title)).toBeInTheDocument();
  });

  it('stays on the item when All results still lists it, showing it is in the trash', async () => {
    setup();
    await fireEvent.change(screen.getByLabelText(en.frameleaf_large_files_show), { target: { value: 'all' } });
    const dialog = await inspect('big.mov');

    server.trash(['big']);
    flushSync();

    expect(screen.getByRole('dialog', { name: 'big.mov' })).toBe(dialog);
    expect(within(dialog).getByText(en.frameleaf_large_files_status_trashed)).toBeInTheDocument();
  });

  it('keeps reviewing when an unrelated item is removed', async () => {
    setup();
    await inspect('big.mov');

    server.delete('small');
    flushSync();

    expect(screen.getByRole('dialog', { name: 'big.mov' })).toBeInTheDocument();
  });

  it('drops a removed item from the selection', async () => {
    setup();
    await fireEvent.click(screen.getByLabelText('Select big.mov'));
    await fireEvent.click(screen.getByLabelText('Select mid.mov'));

    server.delete('big');
    flushSync();

    expect(screen.queryByLabelText('Select big.mov')).toBeNull();
    expect(screen.getByLabelText('Select mid.mov')).toBeChecked();
    expect(screen.getByRole('button', { name: en.frameleaf_large_files_move_selected })).toBeEnabled();
  });
});

describe('LargeFilesReview (FL-47): row detail and recent activity', () => {
  beforeEach(() => {
    sdkMock.getPartners.mockResolvedValue([]);
    sdkMock.reviewTrash.mockImplementation(({ trashReviewDto }) =>
      Promise.resolve({
        action: trashReviewDto.action,
        count: trashReviewDto.ids?.length ?? 0,
        bytes: 0,
        retainedOriginals: 0,
        retainedBytes: 0,
        names: [],
        token: 'token',
      }),
    );
    sdkMock.applyTrashReview.mockImplementation(({ trashApplyDto }) =>
      Promise.resolve({ count: trashApplyDto.ids?.length ?? 0 }),
    );
  });

  it("shows each original's type rather than its path (UT-15)", () => {
    setup();
    const row = screen.getByText('big.mov').closest('tr')!;
    expect(within(row).getByText('MOV')).toBeInTheDocument();
    expect(within(row).queryByText('/library/big.mov')).toBeNull();
  });

  it('lists the moves and undos of this visit under Recent utility activity (UT-11)', async () => {
    setup();
    expect(screen.queryByText(en.library_care_recent_activity)).toBeNull();

    await fireEvent.click(screen.getByLabelText('Select big.mov'));
    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_large_files_move_selected }));
    await fireEvent.click(await screen.findByRole('button', { name: 'Confirm 1 item' }));

    const history = (await screen.findByText(en.library_care_recent_activity)).closest('details')!;
    expect(within(history).getByText(`${en.frameleaf_large_files_activity_trash} · 1 item`)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: en.frameleaf_large_files_undo }));
    await waitFor(() =>
      expect(within(history).getByText(`${en.frameleaf_large_files_activity_restore} · 1 item`)).toBeInTheDocument(),
    );
    const entries = within(history).getAllByText(/ · 1 item$/);
    expect(entries.map((entry) => entry.textContent?.trim())).toEqual([
      `${en.frameleaf_large_files_activity_restore} · 1 item`,
      `${en.frameleaf_large_files_activity_trash} · 1 item`,
    ]);
  });
});
