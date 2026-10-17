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

  it('sends the current version it opened on and reloads, keeping the draft, when another device moved it (FL-431)', async () => {
    const opened = { id: 'rev-opened', revision: 1, status: 'rendered', isCurrent: true, recipe: {} } as never;
    sdkMock.getAssetDevelop
      .mockResolvedValueOnce({ assetId: asset.id, currentRevisionId: 'rev-opened', revisions: [opened] })
      .mockResolvedValue({ assetId: asset.id, currentRevisionId: 'rev-elsewhere', revisions: [] });
    // Every SDK function is mocked here, so the HTTP-error guard is told what an HTTP error is.
    sdkMock.isHttpError.mockImplementation((error) => typeof (error as { status?: unknown }).status === 'number');
    sdkMock.saveAssetDevelop.mockRejectedValueOnce(
      Object.assign(new Error('Conflict'), {
        status: 409,
        data: { code: 'develop_current_revision_changed', currentRevisionId: 'rev-elsewhere' },
      }),
    );
    const onClose = vi.fn();
    render(NativeRawEditor, { asset, onClose, onLegacy: vi.fn() });

    const save = screen.getByRole('button', { name: 'frameleaf_editor_save_version' });
    await waitFor(() => expect(save).toBeEnabled());
    await fireEvent.click(save);
    await screen.findByText('frameleaf_editor_version_conflict');
    expect(sdkMock.saveAssetDevelop.mock.calls[0][0].assetDevelopSaveDto).toMatchObject({
      expectedCurrentRevisionId: 'rev-opened',
    });
    await waitFor(() => expect(sdkMock.getAssetDevelop).toHaveBeenCalledTimes(2));
    expect(onClose).not.toHaveBeenCalled();

    sdkMock.saveAssetDevelop.mockResolvedValueOnce({ id: 'rev-3', revision: 3, status: 'queued', recipe: {} } as never);
    await fireEvent.click(save);
    await waitFor(() => expect(sdkMock.saveAssetDevelop).toHaveBeenCalledTimes(2));
    expect(sdkMock.saveAssetDevelop.mock.calls[1][0].assetDevelopSaveDto).toMatchObject({
      expectedCurrentRevisionId: 'rev-elsewhere',
    });
  });
});
