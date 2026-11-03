import { StudioProjectAccess, StudioProjectShelf, StudioProjectSort, type StudioProjectDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { init, register, waitLocale } from 'svelte-i18n';
import { beforeAll, beforeEach, describe, expect, it, vi } from 'vitest';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import StudioProjectLibrary from './StudioProjectLibrary.svelte';

// Changing shelf rewrites the address; there is no router in a unit test to take it.
vi.mock('$app/navigation', async (original) => ({
  ...(await original<typeof import('$app/navigation')>()),
  goto: vi.fn().mockResolvedValue(undefined),
}));

const project = (thumbnailAssetId: string | null): StudioProjectDto => ({
  id: 'p-1',
  ownerId: 'me',
  name: 'Lake trip',
  spaceId: null,
  revision: 2,
  access: StudioProjectAccess.Owner,
  lease: {
    heldByYou: false,
    heldByAnother: false,
    expiresAt: null,
    leaseMs: 90_000,
    renewMs: 30_000,
    autosaveDebounceMs: 1500,
  },
  shelf: StudioProjectShelf.Active,
  archivedAt: null,
  deletedAt: null,
  purgeAfter: null,
  lastOpenedAt: null,
  thumbnailAssetId,
  duplicatedFromId: null,
  importedFromBundle: false,
  createdAt: '2026-09-27T10:00:00.000Z',
  updatedAt: '2026-09-27T10:00:00.000Z',
});

/** FL-195 follow-up: a Locked poster keeps its place but shows only to the unlocked session. */
describe('StudioProjectLibrary poster', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    sdkMock.searchStudioProjects.mockReset();
  });

  it('shows the placeholder while the server withholds the poster, and the poster after an unlock', async () => {
    sdkMock.searchStudioProjects.mockResolvedValue({ items: [project(null)], total: 1 });
    const { container } = render(StudioProjectLibrary);

    await waitFor(() => expect(container.querySelector(':scope .card')).not.toBeNull());
    expect(container.querySelector(':scope .poster img')).toBeNull();

    sdkMock.searchStudioProjects.mockResolvedValue({ items: [project('poster-asset')], total: 1 });
    eventManager.emit('SessionAccessChanged', { isElevated: true });

    await waitFor(() => expect(container.querySelector(':scope .poster img')).not.toBeNull());
    // One read per shelf visit: the first, and the one after the unlock.
    expect(sdkMock.searchStudioProjects).toHaveBeenCalledTimes(2);

    sdkMock.searchStudioProjects.mockResolvedValue({ items: [project(null)], total: 1 });
    eventManager.emit('SessionAccessChanged', { isElevated: false });

    await waitFor(() => expect(container.querySelector(':scope .poster img')).toBeNull());
  });
});

describe('StudioProjectLibrary states and cards', () => {
  beforeAll(async () => {
    await init({ fallbackLocale: 'en-US' });
    register('en-US', () => import('$i18n/en.json'));
    await waitLocale('en-US');
  });

  beforeEach(() => {
    sdkMock.searchStudioProjects.mockReset();
    sdkMock.deleteStudioProject.mockReset();
  });

  it('shows poster-shaped placeholders while the first shelf is read', () => {
    sdkMock.searchStudioProjects.mockReturnValue(new Promise(() => {}));
    const { container } = render(StudioProjectLibrary);
    expect(container.querySelectorAll(':scope .placeholder')).toHaveLength(6);
    expect(container.querySelector(':scope .card')).toBeNull();
    expect(screen.queryByText('Make your first film')).not.toBeInTheDocument();
  });

  it('says a failed read failed, with Try again, instead of calling the library empty', async () => {
    sdkMock.searchStudioProjects.mockRejectedValueOnce(new Error('offline'));
    render(StudioProjectLibrary);

    const alert = await screen.findByRole('alert');
    expect(alert).toHaveTextContent('Your projects did not load. They are safe. Try again.');
    expect(screen.queryByText('Make your first film')).not.toBeInTheDocument();

    sdkMock.searchStudioProjects.mockResolvedValue({ items: [project(null)], total: 1 });
    await fireEvent.click(within(alert).getByRole('button', { name: 'Try again' }));
    expect(await screen.findByRole('link', { name: 'Lake trip' })).toBeInTheDocument();
  });

  it('gives an empty Projects shelf a way forward', async () => {
    sdkMock.searchStudioProjects.mockResolvedValue({ items: [], total: 0 });
    render(StudioProjectLibrary);

    expect(await screen.findByRole('heading', { name: 'Make your first film' })).toBeInTheDocument();
    expect(screen.getByRole('link', { name: 'New project' })).toHaveAttribute('href', '/studio');
    expect(screen.getByRole('link', { name: 'Pick photos from your library' })).toBeInTheDocument();
    // UI review 2026-10-30 #18: "New project" once, in the empty state, and the page is just "Studio".
    expect(screen.queryByRole('button', { name: 'New project' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { level: 1, name: 'Studio' })).toBeInTheDocument();
  });

  it('offers New project in the header once there are projects (UI review 2026-10-30 #18)', async () => {
    sdkMock.searchStudioProjects.mockResolvedValue({ items: [project(null)], total: 1 });
    render(StudioProjectLibrary);

    expect(await screen.findByRole('link', { name: 'Lake trip' })).toBeInTheDocument();
    expect(screen.getAllByRole('button', { name: 'New project' })).toHaveLength(1);
    expect(screen.queryByRole('link', { name: 'New project' })).not.toBeInTheDocument();
  });

  it('opens a project from its card and keeps every other action in one menu, trash last', async () => {
    sdkMock.searchStudioProjects.mockResolvedValue({ items: [project(null)], total: 1 });
    sdkMock.deleteStudioProject.mockResolvedValue(undefined as never);
    const { container } = render(StudioProjectLibrary);

    const open = await screen.findByRole('link', { name: 'Lake trip' });
    expect(open).toHaveAttribute('href', '/studio?project=p-1');
    // No row of text buttons on the card: one menu holds them.
    expect(container.querySelectorAll(':scope .card button')).toHaveLength(1);

    await fireEvent.click(screen.getByRole('button', { name: 'Actions for Lake trip' }));
    const labels = screen.getAllByRole('menuitem').map((item) => item.textContent?.trim());
    expect(labels).toEqual(['Rename', 'Duplicate', 'Save as a file…', 'Archive', 'Move to trash']);

    await fireEvent.click(screen.getByRole('menuitem', { name: 'Move to trash' }));
    await waitFor(() => expect(sdkMock.deleteStudioProject).toHaveBeenCalledWith({ id: 'p-1' }));
  });

  it('orders and shelves with segmented controls, and reads again in the chosen order', async () => {
    sdkMock.searchStudioProjects.mockResolvedValue({ items: [project(null)], total: 1 });
    render(StudioProjectLibrary);
    await screen.findByRole('link', { name: 'Lake trip' });
    expect(screen.queryByRole('combobox')).not.toBeInTheDocument();

    const order = screen.getByRole('group', { name: 'Sort by' });
    expect(within(order).getByRole('button', { name: 'Recently changed' })).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.click(within(order).getByRole('button', { name: 'Name' }));
    await waitFor(() =>
      expect(sdkMock.searchStudioProjects).toHaveBeenLastCalledWith(
        expect.objectContaining({ sort: StudioProjectSort.Name }),
      ),
    );

    const shelves = screen.getByRole('group', { name: 'Project shelves' });
    await fireEvent.click(within(shelves).getByRole('button', { name: 'Trash' }));
    await waitFor(() =>
      expect(sdkMock.searchStudioProjects).toHaveBeenLastCalledWith(
        expect.objectContaining({ shelf: StudioProjectShelf.Trashed }),
      ),
    );
  });

  it('marks a poster with the key the opening screen shares, and only where there is a picture', async () => {
    sdkMock.searchStudioProjects.mockResolvedValue({
      items: [project('asset-1'), { ...project(null), id: 'p-2', name: 'Winter cut' }],
      total: 2,
    });
    const { container } = render(StudioProjectLibrary);
    await screen.findByRole('link', { name: 'Winter cut' });
    const marked = [...container.querySelectorAll<HTMLElement>(':scope [data-fl-shared]')];
    expect(marked.map((element) => element.dataset.flShared)).toEqual(['studio-project:p-1']);
  });

  it('offers the next page when the server holds more projects than are shown', async () => {
    sdkMock.searchStudioProjects.mockResolvedValueOnce({ items: [project(null)], total: 2 });
    render(StudioProjectLibrary);

    const more = await screen.findByRole('button', { name: 'Show more projects' });
    sdkMock.searchStudioProjects.mockResolvedValueOnce({
      items: [{ ...project(null), id: 'p-2', name: 'Winter cut' }],
      total: 2,
    });
    await fireEvent.click(more);

    expect(await screen.findByRole('link', { name: 'Winter cut' })).toBeInTheDocument();
    expect(sdkMock.searchStudioProjects).toHaveBeenLastCalledWith(expect.objectContaining({ skip: 1 }));
    expect(screen.queryByRole('button', { name: 'Show more projects' })).not.toBeInTheDocument();
  });

  it("follows only the newest file export, never an earlier project's job", async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      const winter = { ...project(null), id: 'p-2', name: 'Winter cut' };
      sdkMock.searchStudioProjects.mockResolvedValue({ items: [project(null), winter], total: 2 });
      const operation = (id: string) =>
        ({ id, kind: 'studio-bundle-export', status: 'queued', progress: null, attempt: 0, maxAttempts: 3 }) as never;
      sdkMock.exportStudioProjectBundle.mockImplementation(async ({ id }) => operation(id === 'p-1' ? 'op-1' : 'op-2'));
      let lakePolls = 0;
      sdkMock.getStudioBundleOperation.mockImplementation(async ({ id }) => {
        const lakeDone = id === 'op-1' && ++lakePolls > 1;
        return {
          operationId: id,
          kind: 'studio-bundle-export',
          status: lakeDone ? 'completed' : 'running',
          progress: null,
          attempt: 0,
          maxAttempts: 3,
          autoRetries: 0,
          retryAt: null,
          error: null,
          errorCode: null,
          projectId: id === 'op-1' ? 'p-1' : 'p-2',
          export: lakeDone ? { downloadable: true, fileName: 'lake-trip.zip', embedded: 0, referenced: 1 } : null,
          import: null,
        } as never;
      });
      render(StudioProjectLibrary);

      const exportFrom = async (name: string) => {
        await fireEvent.click(await screen.findByRole('button', { name: `Actions for ${name}` }));
        await fireEvent.click(screen.getByRole('menuitem', { name: 'Save as a file…' }));
        await fireEvent.click(await screen.findByRole('button', { name: 'Create file' }));
      };
      await exportFrom('Lake trip');
      await waitFor(() => expect(sdkMock.exportStudioProjectBundle).toHaveBeenCalledTimes(1));
      // The first poll of the Lake trip export answers "running"; its next one comes two seconds later.
      await vi.advanceTimersByTimeAsync(1500);
      await fireEvent.click(screen.getByRole('button', { name: 'Close' }));
      await exportFrom('Winter cut');
      await waitFor(() => expect(sdkMock.exportStudioProjectBundle).toHaveBeenCalledTimes(2));

      // The Lake trip export finishes while the Winter cut one is still being made.
      await vi.advanceTimersByTimeAsync(2000);
      await waitFor(() => expect(lakePolls).toBe(2));

      // The Lake trip file is not offered as the Winter cut export.
      expect(screen.queryByRole('button', { name: 'Download file' })).toBeNull();
    } finally {
      vi.useRealTimers();
    }
  });

  it('starts one file export however quickly Create file is pressed twice', async () => {
    sdkMock.searchStudioProjects.mockResolvedValue({ items: [project(null)], total: 1 });
    let answer!: (operation: never) => void;
    sdkMock.exportStudioProjectBundle.mockReset();
    sdkMock.exportStudioProjectBundle.mockReturnValue(new Promise((resolve) => (answer = resolve)) as never);
    render(StudioProjectLibrary);

    await fireEvent.click(await screen.findByRole('button', { name: 'Actions for Lake trip' }));
    await fireEvent.click(screen.getByRole('menuitem', { name: 'Save as a file…' }));
    const create = await screen.findByRole('button', { name: 'Create file' });
    await fireEvent.click(create);
    await fireEvent.click(create);

    expect(sdkMock.exportStudioProjectBundle).toHaveBeenCalledTimes(1);
    answer({ id: 'op-1', kind: 'studio-bundle-export', status: 'queued', progress: null, attempt: 0 } as never);
  });
});
