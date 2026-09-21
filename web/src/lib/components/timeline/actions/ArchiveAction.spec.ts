import { AssetVisibility } from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { fireEvent, render, screen } from '@testing-library/svelte';
import TestWrapper from '$lib/components/TestWrapper.svelte';
import { assetMultiSelectManager } from '$lib/managers/asset-multi-select-manager.svelte';
import ArchiveOperationsModal from '$lib/modals/ArchiveOperationsModal.svelte';
import { archiveAssets } from '$lib/utils/asset-utils';
import ArchiveAction from './ArchiveAction.svelte';

vi.mock('$lib/managers/asset-multi-select-manager.svelte', () => ({
  assetMultiSelectManager: { getOwnedAssets: vi.fn(), clear: vi.fn() },
}));
vi.mock('$lib/utils/asset-utils', () => ({ archiveAssets: vi.fn() }));

beforeEach(() => vi.restoreAllMocks());

it('opens the real durable archive flow with a copied explicit selection', async () => {
  const assets = [{ id: 'selected', visibility: AssetVisibility.Timeline }];
  vi.mocked(assetMultiSelectManager.getOwnedAssets).mockReturnValue(assets as never);
  const show = vi.spyOn(modalManager, 'show').mockResolvedValue(undefined as never);
  render(TestWrapper, { component: ArchiveAction, componentProps: {} });
  await fireEvent.click(screen.getByRole('button', { name: 'to_archive' }));
  assets.push({ id: 'later', visibility: AssetVisibility.Timeline });
  expect(show).toHaveBeenCalledWith(ArchiveOperationsModal, { ids: ['selected'] });
  expect(archiveAssets).not.toHaveBeenCalled();
});

it('retains the existing unarchive action and callback', async () => {
  vi.mocked(assetMultiSelectManager.getOwnedAssets).mockReturnValue([
    { id: 'archived', visibility: AssetVisibility.Archive },
  ] as never);
  vi.mocked(archiveAssets).mockResolvedValue(['archived']);
  const onArchive = vi.fn();
  render(TestWrapper, { component: ArchiveAction, componentProps: { unarchive: true, onArchive } });
  await fireEvent.click(screen.getByRole('button', { name: 'unarchive' }));
  expect(onArchive).toHaveBeenCalledWith(['archived'], AssetVisibility.Timeline);
});
