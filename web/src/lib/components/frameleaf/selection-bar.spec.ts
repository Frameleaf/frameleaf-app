import { AlbumKind, AlbumUserRole, getAllAlbums, type AlbumResponseDto } from '@immich/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import SelectionBar from '$lib/components/frameleaf/SelectionBar.svelte';
import type { BulkAsset } from '$lib/frameleaf/bulk-actions';
import { albumFactory } from '@test-data/factories/album-factory';
import { userAdminFactory } from '@test-data/factories/user-factory';

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  getAllAlbums: vi.fn(),
}));
vi.mock('$lib/managers/auth-manager.svelte', () => ({ authManager: { user: { id: 'me' } } }));

/**
 * The bar's contract with the library view: it never runs an action itself, it hands an action and a
 * payload to `onAction`, and it keeps the complete bulk set reachable by keyboard. Its one read is
 * the album list the Add to album picker loads for itself.
 */
describe('Frameleaf selection bar', () => {
  const onAction = vi.fn();
  const onClear = vi.fn();
  const onSelectAllMatching = vi.fn();

  const photo = (id: string, extra: Partial<BulkAsset> = {}): BulkAsset => ({ id, isVideo: false, ...extra });

  const mount = (props: Record<string, unknown> = {}) =>
    render(SelectionBar, {
      props: { count: 2, assets: [photo('a'), photo('b')], onAction, onClear, ...props },
    });

  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => vi.resetAllMocks());

  it('stays inert while nothing is selected', () => {
    mount({ count: 0, assets: [] });
    expect(screen.getByRole('region', { name: 'Selected items', hidden: true })).toHaveAttribute('inert');
  });

  it('announces the count and deselects', async () => {
    mount();
    expect(screen.getByText('2 selected')).toBeInTheDocument();
    const deselect = screen.getByRole('button', { name: 'Deselect all' });
    expect(deselect).toHaveTextContent('Deselect');
    await fireEvent.click(deselect);
    expect(onClear).toHaveBeenCalledOnce();
  });

  it('offers everything matching only when more matches than are selected', async () => {
    const { rerender } = render(SelectionBar, {
      props: { count: 2, assets: [photo('a'), photo('b')], total: 2, onAction, onClear, onSelectAllMatching },
    });
    // Anchored: "Deselect all" is always there and must not satisfy this.
    expect(screen.queryByRole('button', { name: /^Select all/i })).not.toBeInTheDocument();

    await rerender({ total: 4200 });
    await fireEvent.click(screen.getByRole('button', { name: 'Select all 4,200' }));
    expect(onSelectAllMatching).toHaveBeenCalledOnce();
  });

  it('dispatches a plain action without opening anything', async () => {
    mount();
    await fireEvent.click(screen.getByRole('button', { name: 'Favorite' }));
    expect(onAction).toHaveBeenCalledWith('favorite');
  });

  it('collects a payload before dispatching an action that needs one', async () => {
    mount();
    await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Change description' }));
    expect(onAction).not.toHaveBeenCalled();

    const description = screen.getByRole('textbox');
    await fireEvent.input(description, { target: { value: '  Lake day  ' } });
    await fireEvent.submit(description.closest('form')!);
    expect(onAction).toHaveBeenCalledWith('change-description', { description: 'Lake day' });
  });

  it('groups the rest of the bulk set in the More menu, including both sensitive actions', async () => {
    const { unmount } = mount();
    await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    for (const name of ['Stack', 'Tag', 'Change date', 'Archive', 'Mark Sensitive', 'Refresh metadata']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
    unmount();

    // As in the prototype's selection.mjs, Unmark Sensitive is offered only when a selected item is
    // marked, so a selection mixing a marked and an unmarked item offers both.
    mount({ assets: [photo('a'), photo('b', { isLocked: true })] });
    await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    for (const name of ['Mark Sensitive', 'Unmark Sensitive']) {
      expect(screen.getByRole('menuitem', { name })).toBeInTheDocument();
    }
  });

  it('offers no Unmark Sensitive when nothing selected is marked', async () => {
    mount();
    await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    expect(screen.getByRole('menuitem', { name: 'Mark Sensitive' })).toBeInTheDocument();
    expect(screen.queryByRole('menuitem', { name: 'Unmark Sensitive' })).not.toBeInTheDocument();
  });

  it('carries the stack ids Unstack needs, which only the bar knows', async () => {
    render(SelectionBar, {
      props: {
        count: 2,
        assets: [photo('a', { stackId: 'stack-1' }), photo('b', { stackId: 'stack-1' })],
        onAction,
        onClear,
      },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'More actions' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Unstack' }));
    expect(onAction).toHaveBeenCalledWith('unstack', { stackIds: ['stack-1'] });
  });

  it('loads its own album list for Add to album, so any view can offer it with nothing passed in', async () => {
    const me = userAdminFactory.build({ id: 'me' });
    const album = (overrides: Partial<AlbumResponseDto>): AlbumResponseDto =>
      albumFactory.build({
        kind: AlbumKind.Album,
        parentId: null,
        albumUsers: [{ user: me, role: AlbumUserRole.Owner }],
        ...overrides,
      });
    vi.mocked(getAllAlbums).mockResolvedValue([
      album({ id: 'trips', albumName: 'Trips', kind: AlbumKind.Collection }),
      album({ id: 'iceland', albumName: 'Iceland', parentId: 'trips' }),
      album({ id: 'household', albumName: 'Household', kind: AlbumKind.Space }),
    ]);

    mount();
    await fireEvent.click(screen.getByRole('button', { name: 'Add to album' }));

    const dialog = screen.getByRole('dialog');
    await waitFor(() => expect(within(dialog).getByRole('radio', { name: /Iceland/ })).toBeInTheDocument());
    expect(getAllAlbums).toHaveBeenCalledOnce();
    expect(within(dialog).getByText('Trips')).toBeInTheDocument();
    expect(within(dialog).queryByRole('radio', { name: /Trips/ })).not.toBeInTheDocument();
    expect(within(dialog).getByRole('radio', { name: /Household/ })).toBeInTheDocument();

    await fireEvent.click(within(dialog).getByRole('radio', { name: /Iceland/ }));
    await fireEvent.submit(
      within(dialog)
        .getByRole('radio', { name: /Iceland/ })
        .closest('form')!,
    );
    expect(onAction).toHaveBeenCalledWith('add-to-album', { albumId: 'iceland' });
  });

  it('confirms a permanent delete and never a reversible one', async () => {
    mount({ context: { trash: true } });
    await fireEvent.click(screen.getByRole('button', { name: 'Delete permanently' }));
    expect(onAction).not.toHaveBeenCalled();

    const confirm = screen.getByRole('dialog');
    expect(within(confirm).getByText(/cannot be undone/i)).toBeInTheDocument();
    // The confirm sits in the dialog's actions footer and joins its form through `form=`.
    const submit = within(confirm).getByRole<HTMLButtonElement>('button', { name: 'Delete permanently' });
    expect(submit.form).not.toBeNull();
    await fireEvent.submit(submit.form!);
    expect(onAction).toHaveBeenCalledWith('delete-permanently', undefined);

    vi.resetAllMocks();
    mount();
    await fireEvent.click(screen.getByRole('button', { name: 'Delete' }));
    expect(onAction).toHaveBeenCalledWith('delete');
  });

  it('reports a running operation and offers to cancel it', async () => {
    const onCancelOperation = vi.fn();
    mount({
      operations: [
        {
          requestId: 'request-1',
          action: 'archive',
          scope: { version: 1, scope: { kind: 'library' } },
          status: 'running',
          submittedTotal: 4200,
          processed: 500,
          total: 4200,
          succeeded: 0,
          failed: 0,
          skipped: 0,
          failures: [],
          truncated: false,
          startedAt: 0,
        },
      ],
      onCancelOperation,
    });
    expect(screen.getByText('500 of 4,200 done')).toBeInTheDocument();
    await fireEvent.click(screen.getByRole('button', { name: 'Cancel' }));
    expect(onCancelOperation).toHaveBeenCalledWith('request-1');
  });

  it('lists the items a finished operation could not change', () => {
    mount({
      operations: [
        {
          requestId: 'request-2',
          action: 'archive',
          scope: { version: 1, scope: { kind: 'album' } },
          status: 'completed',
          submittedTotal: 3,
          processed: 3,
          total: 3,
          succeeded: 2,
          failed: 1,
          skipped: 0,
          failures: [{ id: 'asset-9', reasonKey: 'frameleaf_bulk_reason_no_permission' }],
          truncated: false,
          startedAt: 0,
        },
      ],
    });
    expect(screen.getByText('1 item did not change')).toBeInTheDocument();
    expect(screen.getByText('asset-9')).toBeInTheDocument();
    expect(screen.getByText('You cannot change this one')).toBeInTheDocument();
  });
});
