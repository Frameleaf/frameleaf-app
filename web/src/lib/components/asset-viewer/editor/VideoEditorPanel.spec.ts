import { AssetEditAction, AssetTypeEnum, editAsset, getAssetEdits, removeAssetEdits } from '@immich/sdk';
import '@testing-library/jest-dom';
import { act, fireEvent, waitFor } from '@testing-library/svelte';
import { renderWithTooltips } from '$tests/helpers';
import { assetFactory } from '@test-data/factories/asset-factory';
import VideoEditorPanel from './VideoEditorPanel.svelte';

vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    editAsset: vi.fn(),
    getAssetEdits: vi.fn(),
    removeAssetEdits: vi.fn(),
  };
});

vi.mock('$lib/managers/event-manager.svelte', () => ({
  eventManager: {
    emit: vi.fn(),
    on: vi.fn(),
  },
}));

vi.mock('$lib/stores/websocket', () => ({
  websocketEvents: { on: vi.fn().mockReturnValue(() => {}) },
}));

const rect = (width: number, height: number): DOMRect => ({
  x: 0,
  y: 0,
  top: 0,
  left: 0,
  right: width,
  bottom: height,
  width,
  height,
  toJSON: () => ({}),
});

describe('VideoEditorPanel component', () => {
  const asset = assetFactory.build({
    type: AssetTypeEnum.Video,
    originalPath: '/upload/video.mp4',
    originalFileName: 'video.mp4',
    width: 1920,
    height: 1080,
    duration: 10_000,
  });

  beforeEach(() => {
    vi.mocked(getAssetEdits).mockResolvedValue({
      assetId: asset.id,
      edits: [],
      originalVideo: { width: 1920, height: 1080, durationMs: 10_000 },
    });
    vi.mocked(editAsset).mockResolvedValue({ assetId: asset.id, edits: [] });
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('loads a chosen version recipe into the draft and publishes it only on Save version (FL-39)', async () => {
    const onDraftChange = vi.fn();
    const onClose = vi.fn();
    const onReady = vi.fn();
    const view = renderWithTooltips(VideoEditorPanel, { asset, onClose, onDraftChange, onReady });
    await waitFor(() => expect(onReady).toHaveBeenCalledOnce());
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith('[]'));
    const recipe = [{ action: 'rotate', parameters: { angle: 90 } }];
    await act(() => onReady.mock.calls[0][0].applyRecipe(recipe));
    await waitFor(() => expect(onDraftChange).toHaveBeenLastCalledWith(JSON.stringify(recipe)));
    expect(editAsset).not.toHaveBeenCalled();
    await fireEvent.click(view.getByRole('button', { name: 'editor_video_save_version' }));
    await waitFor(() =>
      expect(editAsset).toHaveBeenCalledWith({ id: asset.id, assetEditsCreateDto: { edits: recipe } }),
    );
  });

  it('does not save the original over an unedited original', async () => {
    const onClose = vi.fn();
    const view = renderWithTooltips(VideoEditorPanel, { asset: { ...asset, isEdited: false }, onClose });
    const save = await view.findByRole('button', { name: 'editor_video_save_version' });
    await waitFor(() => expect(save).toBeEnabled());
    await fireEvent.click(save);
    expect(onClose).toHaveBeenCalledOnce();
    expect(removeAssetEdits).not.toHaveBeenCalled();
    expect(editAsset).not.toHaveBeenCalled();
  });

  it('shows the focused video editor tools', async () => {
    const { findByRole } = renderWithTooltips(VideoEditorPanel, { asset, onClose: vi.fn() });

    expect(await findByRole('button', { name: 'editor_video_auto' })).toBeInTheDocument();
    expect(await findByRole('button', { name: 'crop' })).toBeInTheDocument();
    expect(await findByRole('button', { name: 'filters' })).toBeInTheDocument();
    expect(await findByRole('button', { name: 'editor_video_trim' })).toBeInTheDocument();
  });

  it('queues a version and closes without waiting for an unrelated render event', async () => {
    const onClose = vi.fn();
    const { findByRole, getByRole, queryByText } = renderWithTooltips(VideoEditorPanel, { asset, onClose });

    await fireEvent.click(await findByRole('button', { name: 'crop' }));
    expect(queryByText('Crop values')).not.toBeInTheDocument();

    await fireEvent.click(getByRole('button', { name: /9:16/ }));
    await fireEvent.click(getByRole('button', { name: 'editor_video_save_version' }));

    await waitFor(() =>
      expect(editAsset).toHaveBeenCalledWith({
        id: asset.id,
        assetEditsCreateDto: {
          edits: [
            {
              action: 'crop',
              parameters: { x: 656, y: 0, width: 608, height: 1080 },
            },
          ],
        },
      }),
    );
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(true));
  });

  it('composes trim and crop against the original after a shorter cropped version', async () => {
    const current = { ...asset, duration: 5000, width: 640, height: 360, isEdited: true };
    vi.mocked(getAssetEdits).mockResolvedValue({
      assetId: asset.id,
      originalVideo: { width: 1920, height: 1080, durationMs: 30_000 },
      edits: [
        { id: 'crop', action: AssetEditAction.Crop, parameters: { x: 0, y: 0, width: 640, height: 360 } },
        { id: 'trim', action: AssetEditAction.Trim, parameters: { startMs: 0, endMs: 5000 } },
      ],
    });
    const view = renderWithTooltips(VideoEditorPanel, { asset: current, onClose: vi.fn() });
    await fireEvent.click(await view.findByRole('button', { name: 'editor_video_trim' }));
    const end = await view.findByLabelText('editor_video_trim_end');
    vi.spyOn(end, 'getBoundingClientRect').mockReturnValue(rect(300, 44));
    await fireEvent.pointerDown(end, { clientX: 250, clientY: 22 });
    await fireEvent.click(view.getByRole('button', { name: 'crop' }));
    await fireEvent.click(view.getByRole('button', { name: /9:16/ }));
    await fireEvent.click(view.getByRole('button', { name: 'editor_video_save_version' }));
    await waitFor(() =>
      expect(editAsset).toHaveBeenCalledWith({
        id: asset.id,
        assetEditsCreateDto: {
          edits: [
            { action: 'crop', parameters: { x: 656, y: 0, width: 608, height: 1080 } },
            { action: 'trim', parameters: { startMs: 0, endMs: 25_000 } },
          ],
        },
      }),
    );
  });

  it.each(['missing', 'failed'])('blocks saving if original metadata is %s', async (failure) => {
    if (failure === 'missing') {
      vi.mocked(getAssetEdits).mockResolvedValue({ assetId: asset.id, edits: [] });
    } else {
      vi.mocked(getAssetEdits).mockRejectedValueOnce(new Error('unavailable'));
    }
    const view = renderWithTooltips(VideoEditorPanel, { asset, onClose: vi.fn() });
    expect(await view.findByRole('alert')).toHaveTextContent('editor_video_original_metadata_error');
    expect(view.getByRole('button', { name: 'editor_video_save_version' })).toBeDisabled();
    await fireEvent.keyDown(document, { key: 'Enter' });
    expect(editAsset).not.toHaveBeenCalled();
  });

  it('uses trim handles instead of time inputs', async () => {
    const { findByRole, getByLabelText, getByRole } = renderWithTooltips(VideoEditorPanel, { asset, onClose: vi.fn() });

    await fireEvent.click(await findByRole('button', { name: 'editor_video_trim' }));
    const endHandle = getByLabelText('editor_video_trim_end');
    vi.spyOn(endHandle, 'getBoundingClientRect').mockReturnValue(rect(200, 44));

    await fireEvent.pointerDown(endHandle, { clientX: 100, clientY: 22 });
    await fireEvent.click(getByRole('button', { name: 'editor_video_save_version' }));

    await waitFor(() =>
      expect(editAsset).toHaveBeenCalledWith({
        id: asset.id,
        assetEditsCreateDto: {
          edits: [{ action: 'trim', parameters: { startMs: 0, endMs: 5000 } }],
        },
      }),
    );
  });

  it('drags text overlays to normalized positions', async () => {
    const { container, findByRole, getByLabelText, getByRole } = renderWithTooltips(VideoEditorPanel, {
      asset,
      onClose: vi.fn(),
    });

    await fireEvent.click(await findByRole('button', { name: 'editor_video_text' }));
    await fireEvent.input(getByRole('textbox'), { target: { value: 'Hello' } });

    const preview = container.querySelector('.text-preview') as HTMLElement;
    vi.spyOn(preview, 'getBoundingClientRect').mockReturnValue(rect(200, 100));

    await fireEvent.pointerDown(getByLabelText('editor_video_move_text'), { clientX: 160, clientY: 25 });
    await fireEvent.click(getByRole('button', { name: 'editor_video_save_version' }));

    await waitFor(() =>
      expect(editAsset).toHaveBeenCalledWith({
        id: asset.id,
        assetEditsCreateDto: {
          edits: [
            {
              action: 'textOverlay',
              parameters: {
                text: 'Hello',
                x: 0.8,
                y: 0.25,
                startMs: 0,
                endMs: 10_000,
                size: 0.06,
                color: '#ffffff',
              },
            },
          ],
        },
      }),
    );
  });
});
