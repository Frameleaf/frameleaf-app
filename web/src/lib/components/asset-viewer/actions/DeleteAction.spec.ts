import { AssetVisibility, type AssetResponseDto } from '@immich/sdk';
import '@testing-library/jest-dom';
import { fireEvent } from '@testing-library/svelte';
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

  describe('the delete keys', () => {
    beforeEach(() => {
      asset = assetFactory.build({ isTrashed: false });
    });
    afterEach(() => {
      document.body.replaceChildren();
    });

    const renderAction = () => {
      const preAction = vi.fn(() => Promise.reject(new Error('stop before the request')));
      renderWithTooltips(DeleteAction, { asset, onAction: vi.fn(), preAction });
      return preAction;
    };

    it('moves the item to the trash on Backspace from the viewer itself', async () => {
      const preAction = renderAction();
      await fireEvent.keyDown(document.body, { key: 'Backspace' });
      expect(preAction).toHaveBeenCalledTimes(1);
    });

    it('leaves Backspace to a focused control', async () => {
      const preAction = renderAction();
      const button = document.createElement('button');
      document.body.append(button);
      await fireEvent.keyDown(button, { key: 'Backspace' });
      expect(preAction).not.toHaveBeenCalled();
    });

    it('does nothing while a dialog is open over the viewer', async () => {
      const preAction = renderAction();
      const dialog = document.createElement('dialog');
      dialog.setAttribute('open', '');
      document.body.append(dialog);
      await fireEvent.keyDown(document.body, { key: 'Backspace' });
      await fireEvent.keyDown(document.body, { key: 'Delete' });
      expect(preAction).not.toHaveBeenCalled();
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
