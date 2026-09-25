import { AssetVisibility, type AssetResponseDto } from '@immich/sdk';
import '@testing-library/jest-dom';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import DeleteAction from './DeleteAction.svelte';

vi.mock(import('$lib/managers/feature-flags-manager.svelte'), () => {
  // eslint-disable-next-line @typescript-eslint/no-explicit-any
  return { featureFlagsManager: { init: vi.fn(), loadFeatureFlags: vi.fn(), value: { trash: true } } as any };
});

let asset: AssetResponseDto;

describe('DeleteAction component', () => {
  describe('given an asset which is not trashed yet', () => {
    beforeEach(() => {
      asset = assetFactory.build({ isTrashed: false });
    });

    it('displays a button to move the asset to the trash bin', () => {
      const { getByLabelText, queryByTitle } = renderWithTooltips(DeleteAction, {
        asset,
        onAction: vi.fn(),
        preAction: vi.fn(),
      });
      expect(getByLabelText('frameleaf_viewer_move_to_trash')).toBeInTheDocument();
      expect(queryByTitle('frameleaf_viewer_delete_permanently')).toBeNull();
    });
  });

  describe('but if the asset is already trashed', () => {
    beforeEach(() => {
      asset = assetFactory.build({ isTrashed: true, visibility: AssetVisibility.Timeline });
    });

    it('displays Restore and Delete permanently in place of Move to trash (V-4)', () => {
      const { getByLabelText, queryByLabelText } = renderWithTooltips(DeleteAction, {
        asset,
        onAction: vi.fn(),
        preAction: vi.fn(),
      });
      expect(getByLabelText('restore')).toBeInTheDocument();
      expect(getByLabelText('frameleaf_viewer_delete_permanently')).toBeInTheDocument();
      expect(queryByLabelText('frameleaf_viewer_move_to_trash')).toBeNull();
    });

    it('never offers Restore for a Locked item', () => {
      const { queryByLabelText } = renderWithTooltips(DeleteAction, {
        asset: { ...asset, visibility: AssetVisibility.Locked },
        onAction: vi.fn(),
        preAction: vi.fn(),
      });
      expect(queryByLabelText('restore')).toBeNull();
    });
  });
});
