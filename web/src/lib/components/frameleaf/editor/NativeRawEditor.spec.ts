import { AssetTypeEnum, type AssetDevelopRevisionResponseDto } from '@frameleaf/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { assetFactory } from '@test-data/factories/asset-factory';
import NativeRawEditor from './NativeRawEditor.svelte';

vi.mock('$lib/frameleaf/develop-api', () => ({
  PREVIEW_DEBOUNCE_MS: 0,
  developFileUrl: () => '/file',
  followDevelop: () => () => {},
  requestDevelopPreview: () => Promise.resolve(undefined),
}));

const asset = assetFactory.build({ type: AssetTypeEnum.Image, id: 'raw-1', originalFileName: 'IMG_1.CR3' });

describe('NativeRawEditor Save version', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    sdkMock.getAssetDevelop.mockResolvedValue({ assetId: asset.id, currentRevisionId: null, revisions: [] });
    sdkMock.getDevelopPresets.mockResolvedValue([]);
  });

  it('saves one version for a double press while the first save is on its way', async () => {
    let finish: (value: AssetDevelopRevisionResponseDto) => void = () => {};
    sdkMock.saveAssetDevelop.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    render(NativeRawEditor, { asset, onClose: vi.fn(), onLegacy: vi.fn() });

    const save = screen.getByRole('button', { name: 'frameleaf_editor_save_version' });
    await waitFor(() => expect(save).toBeEnabled());
    await fireEvent.click(save);
    await fireEvent.click(save);
    await fireEvent.keyDown(document.body, { key: 's', ctrlKey: true });

    expect(sdkMock.saveAssetDevelop).toHaveBeenCalledTimes(1);
    finish({ id: 'rev-1', revision: 1, status: 'queued', recipe: {} } as never);
  });
});
