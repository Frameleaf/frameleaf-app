import { AssetVisibility, restoreAssets, updateAsset, updateAssets, type AssetResponseDto } from '@immich/sdk';
import { modalManager, toastManager } from '@immich/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { AssetAction } from '$lib/constants';
import { handleError } from '$lib/utils/handle-error';
import { toTimelineAsset } from '$lib/utils/timeline-util';
import { assetFactory } from '@test-data/factories/asset-factory';
import ArchiveAction from './ArchiveAction.svelte';
import RestoreAction from './RestoreAction.svelte';
import SetVisibilityAction from './SetVisibilityAction.svelte';

const updateAssetsRequest = vi.hoisted(() => vi.fn<(request: Parameters<typeof updateAssets>[0]) => Promise<void>>());

const deferred = <T>() => {
  let resolve!: (value: T) => void;
  const promise = new Promise<T>((done) => (resolve = done));
  return { promise, resolve };
};

vi.mock('@immich/sdk', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@immich/sdk')>()),
  updateAsset: vi.fn(),
  updateAssets: updateAssetsRequest,
  restoreAssets: vi.fn(),
}));
vi.mock('$lib/utils/handle-error', () => ({ handleError: vi.fn() }));

beforeEach(() => {
  vi.restoreAllMocks();
  vi.mocked(updateAsset).mockReset();
  updateAssetsRequest.mockReset();
  vi.mocked(restoreAssets).mockReset();
  vi.mocked(handleError).mockClear();
  vi.spyOn(toastManager, 'primary').mockImplementation(() => {});
});

it.each([false, true])('archive completion retains the invoked asset (archived=%s)', async (isArchived) => {
  const first = assetFactory.build({ isArchived });
  const next = assetFactory.build({ isArchived: !isArchived });
  const request = deferred<AssetResponseDto>();
  vi.mocked(updateAsset).mockReturnValueOnce(request.promise);
  const onAction = vi.fn();
  const preAction = vi.fn();
  const { rerender } = render(ArchiveAction, { asset: first, onAction, preAction });
  await fireEvent.click(screen.getByRole('menuitem'));
  await rerender({ asset: next, onAction, preAction });
  request.resolve({
    ...first,
    isArchived: !isArchived,
    visibility: isArchived ? AssetVisibility.Timeline : AssetVisibility.Archive,
  });
  await waitFor(() =>
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: isArchived ? AssetAction.UNARCHIVE : AssetAction.ARCHIVE,
        asset: expect.objectContaining({ id: first.id }),
      }),
    ),
  );
  expect(updateAsset).toHaveBeenLastCalledWith(expect.objectContaining({ id: first.id }));
  expect(next.isArchived).toBe(!isArchived);
});

it('does not publish an archive completion when the request fails', async () => {
  vi.mocked(updateAsset).mockRejectedValueOnce(new Error('denied'));
  const onAction = vi.fn();
  render(ArchiveAction, { asset: assetFactory.build({ isArchived: false }), onAction, preAction: vi.fn() });
  await fireEvent.click(screen.getByRole('menuitem'));
  await waitFor(() => expect(handleError).toHaveBeenCalled());
  expect(onAction).not.toHaveBeenCalled();
});

it('restore completion mutates and emits the invoked asset, not its replacement', async () => {
  const first = assetFactory.build({ isTrashed: true });
  const next = assetFactory.build({ isTrashed: true });
  const request = deferred<Awaited<ReturnType<typeof restoreAssets>>>();
  vi.mocked(restoreAssets).mockReturnValueOnce(request.promise);
  const onAction = vi.fn();
  const { rerender } = render(RestoreAction, { asset: first, onAction });
  await fireEvent.click(screen.getByRole('menuitem'));
  await rerender({ asset: next, onAction });
  request.resolve({ count: 0 });
  await waitFor(() =>
    expect(onAction).toHaveBeenCalledWith(
      expect.objectContaining({
        type: AssetAction.RESTORE,
        asset: expect.objectContaining({ id: first.id, isTrashed: false }),
      }),
    ),
  );
  expect(next.isTrashed).toBe(true);
  expect(restoreAssets).toHaveBeenLastCalledWith({ bulkIdsDto: { ids: [first.id] } });
});

it.each([false, true])('visibility confirmation retains its asset and direction (confirmed=%s)', async (confirmed) => {
  const first = toTimelineAsset(assetFactory.build({ visibility: AssetVisibility.Timeline }));
  const next = toTimelineAsset(assetFactory.build({ visibility: AssetVisibility.Locked }));
  const last = toTimelineAsset(assetFactory.build());
  const confirmation = deferred<boolean>();
  const request = deferred<void>();
  vi.spyOn(modalManager, 'showDialog').mockReturnValueOnce(confirmation.promise);
  updateAssetsRequest.mockReturnValueOnce(request.promise);
  const onAction = vi.fn();
  const preAction = vi.fn();
  const { rerender } = render(SetVisibilityAction, { asset: first, onAction, preAction });
  await fireEvent.click(screen.getByRole('menuitem'));
  await rerender({ asset: next, onAction, preAction });
  confirmation.resolve(confirmed);
  if (!confirmed) {
    await confirmation.promise;
    expect(updateAssets).not.toHaveBeenCalled();
    expect(preAction).not.toHaveBeenCalled();
    expect(onAction).not.toHaveBeenCalled();
    return;
  }
  await waitFor(() =>
    expect(updateAssets).toHaveBeenCalledWith({
      assetBulkUpdateDto: {
        ids: [first.id],
        visibility: AssetVisibility.Locked,
      },
    }),
  );
  await rerender({ asset: last, onAction, preAction });
  request.resolve();
  await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: AssetAction.SET_VISIBILITY_LOCKED, asset: first }));
  expect(preAction).toHaveBeenCalledWith({ type: AssetAction.SET_VISIBILITY_LOCKED, asset: first });
});

it('visibility direction follows a replacement asset before invocation', async () => {
  const props = { onAction: vi.fn(), preAction: vi.fn() };
  const { rerender } = render(SetVisibilityAction, {
    ...props,
    asset: toTimelineAsset(assetFactory.build({ visibility: AssetVisibility.Timeline })),
  });
  await rerender({ ...props, asset: toTimelineAsset(assetFactory.build({ visibility: AssetVisibility.Locked })) });
  expect(screen.getByRole('menuitem').textContent).toContain('move_off_locked_folder');
});

it('awaits archive navigation before starting a mutation that removes the current asset', async () => {
  const first = assetFactory.build({ isArchived: false });
  const navigation = deferred<void>();
  const preAction = vi.fn(() => navigation.promise);
  vi.mocked(updateAsset).mockResolvedValueOnce({ ...first, isArchived: true, visibility: AssetVisibility.Archive });
  const onAction = vi.fn();
  render(ArchiveAction, { asset: first, preAction, onAction });
  await fireEvent.click(screen.getByRole('menuitem'));
  await waitFor(() => expect(preAction).toHaveBeenCalled());
  expect(updateAsset).not.toHaveBeenCalled();
  navigation.resolve();
  await waitFor(() => expect(onAction).toHaveBeenCalled());
  expect(updateAsset).toHaveBeenCalledWith(expect.objectContaining({ id: first.id }));
});

it('awaits visibility navigation before starting its confirmed mutation', async () => {
  const first = toTimelineAsset(assetFactory.build({ visibility: AssetVisibility.Timeline }));
  const navigation = deferred<void>();
  const preAction = vi.fn(() => navigation.promise);
  vi.spyOn(modalManager, 'showDialog').mockResolvedValueOnce(true);
  updateAssetsRequest.mockResolvedValueOnce(undefined);
  const onAction = vi.fn();
  render(SetVisibilityAction, { asset: first, preAction, onAction });
  await fireEvent.click(screen.getByRole('menuitem'));
  await waitFor(() => expect(preAction).toHaveBeenCalled());
  expect(updateAssets).not.toHaveBeenCalled();
  navigation.resolve();
  await waitFor(() => expect(onAction).toHaveBeenCalledWith({ type: AssetAction.SET_VISIBILITY_LOCKED, asset: first }));
});

it('reports rejected archive navigation without mutating or publishing completion', async () => {
  const error = new Error('navigation rejected');
  const onAction = vi.fn();
  render(ArchiveAction, {
    asset: assetFactory.build({ isArchived: false }),
    preAction: vi.fn().mockRejectedValueOnce(error),
    onAction,
  });
  await fireEvent.click(screen.getByRole('menuitem'));
  await waitFor(() => expect(handleError).toHaveBeenCalledWith(error, expect.any(String)));
  expect(updateAsset).not.toHaveBeenCalled();
  expect(onAction).not.toHaveBeenCalled();
});
