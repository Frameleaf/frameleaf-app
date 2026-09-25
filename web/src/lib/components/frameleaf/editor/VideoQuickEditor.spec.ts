import {
  AssetEditAction,
  AssetTypeEnum,
  TextOverlayPosition,
  editAsset,
  getAssetEdits,
  removeAssetEdits,
} from '@immich/sdk';
import { toastManager } from '@immich/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import VideoQuickEditor from './VideoQuickEditor.svelte';

/**
 * The video quick editor (FL-113, VE-1 … VE-12), ported from `Editor.jsx`. The test i18n setup
 * renders the literal key, so assertions match on keys.
 */
vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    getAssetEdits: vi.fn(),
    editAsset: vi.fn(),
    removeAssetEdits: vi.fn(),
    getVideoEditVersions: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@immich/ui', async () => {
  const actual = await vi.importActual<typeof import('@immich/ui')>('@immich/ui');
  const { default: Icon } = await import('@test-data/components/MockIcon.svelte');
  return {
    ...actual,
    Icon,
    modalManager: { showDialog: vi.fn(), show: vi.fn() },
    toastManager: { primary: vi.fn(), danger: vi.fn() },
  };
});

const originalVideo = { width: 1920, height: 1080, durationMs: 24_000 };
const video = () =>
  assetFactory.build({ type: AssetTypeEnum.Video, originalFileName: 'MOV_0001.mp4', isEdited: false });

const opened = async (edits: Array<{ action: AssetEditAction; parameters: object }> = []) => {
  vi.mocked(getAssetEdits).mockResolvedValue({
    assetId: 'asset',
    edits: edits.map((edit, index) => ({ ...edit, id: `edit-${index}` })) as never,
    originalVideo,
  });
  const onClose = vi.fn();
  const asset = video();
  render(VideoQuickEditor, { asset, onClose });
  await waitFor(() => expect(getAssetEdits).toHaveBeenCalledWith({ id: asset.id }));
  await waitFor(() => expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeEnabled());
  return { asset, onClose };
};

describe('VideoQuickEditor', () => {
  beforeEach(() => {
    vi.clearAllMocks();
    vi.mocked(editAsset).mockResolvedValue({ assetId: 'asset', edits: [] } as never);
    vi.mocked(removeAssetEdits).mockResolvedValue(undefined as never);
  });

  it('opens on Trim with the prototype tools in order, plus Restore', async () => {
    await opened();
    const tabs = screen.getAllByRole('tab').map((tab) => tab.getAttribute('title'));
    expect(tabs).toEqual([
      'frameleaf_video_editor_tool_trim',
      'frameleaf_video_editor_tool_speed',
      'frameleaf_editor_tool_adjust',
      'frameleaf_editor_tool_crop',
      'frameleaf_video_editor_tool_audio',
      'frameleaf_video_editor_tool_text',
      'frameleaf_video_editor_tool_enhance',
      'frameleaf_editor_tool_presets',
      'frameleaf_editor_tool_restore',
    ]);
    expect(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_trim' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    // Trim, the transport and the filmstrip are there from the start.
    expect(screen.getByRole('slider', { name: 'frameleaf_video_editor_trim_in' })).toBeInTheDocument();
    expect(screen.getByRole('slider', { name: 'frameleaf_video_editor_playhead' })).toBeInTheDocument();
    expect(screen.getByRole('radio', { name: 'frameleaf_video_editor_trim_fast' })).toBeInTheDocument();
  });

  it('saves a fast trim, a whole-clip speed and muted audio as one version', async () => {
    const { asset, onClose } = await opened();

    await fireEvent.change(screen.getByLabelText('frameleaf_video_editor_in_seconds'), { target: { value: '2' } });
    await fireEvent.click(screen.getByRole('radio', { name: 'frameleaf_video_editor_trim_fast' }));
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_speed' }));
    await fireEvent.click(screen.getByRole('radio', { name: '2×' }));
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_audio' }));
    await fireEvent.click(screen.getByRole('switch', { name: 'frameleaf_video_editor_mute' }));
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_save_version' }));

    await waitFor(() =>
      expect(editAsset).toHaveBeenCalledWith({
        id: asset.id,
        assetEditsCreateDto: {
          edits: [
            { action: AssetEditAction.Trim, parameters: { startMs: 2000, endMs: 24_000, mode: 'fast' } },
            { action: AssetEditAction.Speed, parameters: { rate: 2 } },
            { action: AssetEditAction.Audio, parameters: { muted: true } },
          ],
        },
      }),
    );
    expect(onClose).toHaveBeenCalledWith(true);
    expect(toastManager.primary).toHaveBeenCalledWith('frameleaf_video_editor_saved');
  });

  it('adds a text overlay on the grid and saves it anchored, with its shadow', async () => {
    const { asset } = await opened();
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_text' }));
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_video_editor_add_text' }));
    await fireEvent.click(screen.getByRole('radio', { name: 'frameleaf_video_editor_position_top_left' }));
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_save_version' }));

    await waitFor(() => expect(editAsset).toHaveBeenCalled());
    const [[{ id, assetEditsCreateDto }]] = vi.mocked(editAsset).mock.calls;
    expect(id).toBe(asset.id);
    expect(assetEditsCreateDto.edits).toEqual([
      {
        action: AssetEditAction.TextOverlay,
        parameters: expect.objectContaining({
          text: 'frameleaf_video_editor_text_default',
          position: TextOverlayPosition.TopLeft,
          shadow: true,
          startMs: 0,
          endMs: 4000,
        }),
      },
    ]);
  });

  it('turns Enhance on without pretending to analyse, and says when it applies', async () => {
    await opened();
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_enhance' }));
    const stabilize = screen.getByRole('switch', { name: 'frameleaf_video_editor_stabilize' });
    await fireEvent.click(stabilize);
    expect(stabilize).toHaveAttribute('aria-checked', 'true');
    expect(screen.getByText('frameleaf_video_editor_enhance_on_save')).toHaveAttribute('role', 'status');
  });

  it('reopens a saved recipe and keeps adjustments from the earlier editor until Adjust changes', async () => {
    await opened([
      { action: AssetEditAction.Adjust, parameters: { brightness: 10 } },
      { action: AssetEditAction.Speed, parameters: { rate: 0.5 } },
    ]);
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_speed' }));
    expect(screen.getByRole('radio', { name: '0.5×' })).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_editor_tool_adjust' }));
    expect(screen.getByRole('note')).toHaveTextContent('frameleaf_video_editor_legacy_adjustments');
  });

  it('discards an unsaved edit on Cancel and says so', async () => {
    const { onClose } = await opened();
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_audio' }));
    await fireEvent.click(screen.getByRole('switch', { name: 'frameleaf_video_editor_mute' }));
    await fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(toastManager.primary).toHaveBeenCalledWith('frameleaf_editor_edits_discarded');
    expect(onClose).toHaveBeenCalledWith(false);
    expect(editAsset).not.toHaveBeenCalled();
  });

  it('undoes and redoes from the top bar', async () => {
    await opened();
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_audio' }));
    const mute = screen.getByRole('switch', { name: 'frameleaf_video_editor_mute' });
    await fireEvent.click(mute);
    expect(mute).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    expect(mute).toHaveAttribute('aria-checked', 'false');
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_redo' }));
    expect(mute).toHaveAttribute('aria-checked', 'true');
  });

  it('says the clip cannot be edited when its original cannot be read', async () => {
    vi.mocked(getAssetEdits).mockRejectedValue(new Error('nope'));
    render(VideoQuickEditor, { asset: video(), onClose: vi.fn() });
    expect(await screen.findByText('frameleaf_video_editor_load_error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeDisabled();
  });
});
