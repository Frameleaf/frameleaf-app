import {
  AssetEditAction,
  AssetTypeEnum,
  DecodeRefusal,
  TextOverlayPosition,
  editAsset,
  getAssetEdits,
  removeAssetEdits,
} from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { goto } from '$app/navigation';
import { readEditorContinuity } from '$lib/frameleaf/editor-continuity';
import { clearPrivateBrowserState } from '$lib/frameleaf/private-browser-state';
import type { VideoDraft } from '$lib/frameleaf/video-edit';
import VideoEditorCloseHost from '@test-data/components/VideoEditorCloseHost.svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import VideoQuickEditor from './VideoQuickEditor.svelte';

/**
 * The video quick editor (FL-113, VE-1 … VE-12), ported from `Editor.jsx`. The test i18n setup
 * renders the literal key, so assertions match on keys.
 */
vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

vi.mock('@frameleaf/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@frameleaf/sdk')>('@frameleaf/sdk');
  return {
    ...sdk,
    getAssetEdits: vi.fn(),
    getAssetEditKeyframes: vi.fn().mockResolvedValue({ keyframesMs: [0, 2000, 4000] }),
    editAsset: vi.fn(),
    removeAssetEdits: vi.fn(),
    getVideoEditVersions: vi.fn().mockResolvedValue([]),
    getAssetRestorations: vi.fn().mockResolvedValue([]),
    getAssetRestorationOptions: vi.fn().mockResolvedValue({ destinations: [], modes: [] }),
  };
});

vi.mock('@frameleaf/ui', async () => {
  const actual = await vi.importActual<typeof import('@frameleaf/ui')>('@frameleaf/ui');
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
  afterEach(() => vi.restoreAllMocks());

  beforeEach(() => {
    vi.clearAllMocks();
    sessionStorage.clear();
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

  it('restores an unsaved video draft after reload', async () => {
    vi.mocked(getAssetEdits).mockResolvedValue({ assetId: 'asset', edits: [], originalVideo } as never);
    const asset = video();
    const first = render(VideoQuickEditor, { asset, onClose: vi.fn() });
    await waitFor(() => expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_audio' }));
    await fireEvent.click(screen.getByRole('switch', { name: 'frameleaf_video_editor_mute' }));
    await waitFor(() => expect(readEditorContinuity<VideoDraft>(asset.id)?.draft.edit.volume).toBe(0));
    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_video_editor_playhead' }), {
      target: { value: '6' },
    });
    await waitFor(() => expect(readEditorContinuity(asset.id)?.playhead).toEqual({ num: 6, den: 1 }));
    first.unmount();

    render(VideoQuickEditor, { asset, onClose: vi.fn() });
    await waitFor(() => expect(readEditorContinuity(asset.id)?.kind).toBe('video'));
    expect(readEditorContinuity(asset.id)?.playhead).toEqual({ num: 6, den: 1 });
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_audio' }));
    expect(screen.getByRole('switch', { name: 'frameleaf_video_editor_mute' })).toHaveAttribute('aria-checked', 'true');
  });

  it('keeps a playing video draft at its latest timeupdate when the page reloads', async () => {
    // The media stage renders only after layout supplies its dimensions.
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    vi.spyOn(HTMLMediaElement.prototype, 'play').mockResolvedValue(undefined);
    const asset = video();
    vi.mocked(getAssetEdits).mockResolvedValue({ assetId: asset.id, edits: [], originalVideo } as never);
    const first = render(VideoQuickEditor, { asset, onClose: vi.fn() });
    await waitFor(() => expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_audio' }));
    await fireEvent.click(screen.getByRole('switch', { name: 'frameleaf_video_editor_mute' }));
    await waitFor(() => expect(readEditorContinuity(asset.id)?.kind).toBe('video'));

    const media = first.container.querySelector('video')!;
    await fireEvent.loadedMetadata(media);
    await fireEvent.click(screen.getByRole('button', { name: 'play' }));
    media.currentTime = 7;
    await fireEvent.timeUpdate(media);
    await fireEvent.click(screen.getByRole('button', { name: 'pause' }));
    await waitFor(() => expect(readEditorContinuity(asset.id)?.playhead).toEqual({ num: 7, den: 1 }));
    await fireEvent.click(screen.getByRole('button', { name: 'play' }));
    media.currentTime = 9;
    await fireEvent.timeUpdate(media);
    dispatchEvent(new Event('pagehide'));
    expect(readEditorContinuity(asset.id)?.playhead).toEqual({ num: 9, den: 1 });
    first.unmount();

    render(VideoQuickEditor, { asset, onClose: vi.fn() });
    await waitFor(() => expect(readEditorContinuity(asset.id)?.playhead).toEqual({ num: 9, den: 1 }));
    await waitFor(() =>
      expect(screen.getByRole('slider', { name: 'frameleaf_video_editor_playhead' })).toHaveValue('9'),
    );
  });

  it('keeps a restored playhead when the reloaded video reports 0 before its metadata loads', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    const asset = video();
    vi.mocked(getAssetEdits).mockResolvedValue({ assetId: asset.id, edits: [], originalVideo } as never);
    const first = render(VideoQuickEditor, { asset, onClose: vi.fn() });
    await waitFor(() => expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_audio' }));
    await fireEvent.click(screen.getByRole('switch', { name: 'frameleaf_video_editor_mute' }));
    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_video_editor_playhead' }), {
      target: { value: '6' },
    });
    await waitFor(() => expect(readEditorContinuity(asset.id)?.playhead).toEqual({ num: 6, den: 1 }));
    first.unmount();

    const second = render(VideoQuickEditor, { asset, onClose: vi.fn() });
    const slider = () => screen.getByRole('slider', { name: 'frameleaf_video_editor_playhead' });
    await waitFor(() => expect(slider()).toHaveValue('6'));
    const media = second.container.querySelector('video')!;
    // The fresh load reports position 0 before metadata arrives; that must not replace the draft.
    await fireEvent.loadStart(media);
    media.currentTime = 0;
    await fireEvent.timeUpdate(media);
    expect(slider()).toHaveValue('6');
    expect(readEditorContinuity(asset.id)?.playhead).toEqual({ num: 6, den: 1 });

    await fireEvent.loadedMetadata(media);
    expect(media.currentTime).toBe(6);
    await fireEvent.timeUpdate(media);
    expect(slider()).toHaveValue('6');
    expect(readEditorContinuity(asset.id)?.playhead).toEqual({ num: 6, den: 1 });
  });

  it('restores a draft playhead when the clip cannot play and only its still preview shows', async () => {
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue(new DOMRect(0, 0, 800, 600));
    const asset = video();
    vi.mocked(getAssetEdits).mockResolvedValue({ assetId: asset.id, edits: [], originalVideo } as never);
    const first = render(VideoQuickEditor, { asset, onClose: vi.fn() });
    await waitFor(() => expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_audio' }));
    await fireEvent.click(screen.getByRole('switch', { name: 'frameleaf_video_editor_mute' }));
    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_video_editor_playhead' }), {
      target: { value: '6' },
    });
    await waitFor(() => expect(readEditorContinuity(asset.id)?.playhead).toEqual({ num: 6, den: 1 }));
    first.unmount();

    // Playback fails while the clip's metadata is still loading, so the element is gone by the time
    // the draft's playhead is ready to restore.
    let loadEdits!: () => void;
    vi.mocked(getAssetEdits).mockReturnValue(
      new Promise((resolve) => {
        loadEdits = () => resolve({ assetId: asset.id, edits: [], originalVideo } as never);
      }),
    );
    const second = render(VideoQuickEditor, { asset, onClose: vi.fn() });
    const media = await waitFor(() => second.container.querySelector('video')!);
    await fireEvent.error(media);
    await waitFor(() => expect(second.container.querySelector('video')).toBeNull());
    loadEdits();
    await waitFor(() =>
      expect(screen.getByRole('slider', { name: 'frameleaf_video_editor_playhead' })).toHaveValue('6'),
    );
    expect(readEditorContinuity(asset.id)?.playhead).toEqual({ num: 6, den: 1 });
  });

  it('does not recreate a cleared private draft on pagehide or editor teardown', async () => {
    const asset = video();
    vi.mocked(getAssetEdits).mockResolvedValue({ assetId: asset.id, edits: [], originalVideo } as never);
    const first = render(VideoQuickEditor, { asset, onClose: vi.fn() });
    await waitFor(() => expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_text' }));
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_video_editor_add_text' }));
    await waitFor(() => expect(readEditorContinuity(asset.id)?.kind).toBe('video'));

    clearPrivateBrowserState();
    expect(readEditorContinuity(asset.id)).toBeNull();
    dispatchEvent(new Event('pagehide'));
    first.unmount();
    expect(readEditorContinuity(asset.id)).toBeNull();
  });

  it('keeps video redo history after undo returns to the opening edit', async () => {
    const asset = video();
    vi.mocked(getAssetEdits).mockResolvedValue({ assetId: asset.id, edits: [], originalVideo } as never);
    const first = render(VideoQuickEditor, { asset, onClose: vi.fn() });
    await waitFor(() => expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_audio' }));
    await fireEvent.click(screen.getByRole('switch', { name: 'frameleaf_video_editor_mute' }));
    await fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    await waitFor(() => expect(readEditorContinuity<VideoDraft>(asset.id)?.draft.redo.length).toBe(1));
    first.unmount();

    render(VideoQuickEditor, { asset, onClose: vi.fn() });
    await waitFor(() => expect(screen.getByRole('button', { name: 'frameleaf_editor_redo' })).not.toBeDisabled());
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_redo' }));
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_audio' }));
    expect(screen.getByRole('switch', { name: 'frameleaf_video_editor_mute' })).toHaveAttribute('aria-checked', 'true');
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
    expect(readEditorContinuity(asset.id)).toBeNull();
  });

  it('shows where a fast trim really cuts once the keyframes are known', async () => {
    await opened();
    await fireEvent.change(screen.getByLabelText('frameleaf_video_editor_in_seconds'), { target: { value: '3' } });
    await fireEvent.click(screen.getByRole('radio', { name: 'frameleaf_video_editor_trim_fast' }));
    expect(await screen.findByText(/frameleaf_video_editor_trim_fast_actual/)).toBeInTheDocument();
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

  it.each(['cancel', 'save', 'empty-original-save'] as const)(
    'does not rewrite a cleared draft during batched parent teardown after %s',
    async (action) => {
      const asset = video();
      vi.mocked(getAssetEdits).mockResolvedValue({
        assetId: asset.id,
        edits: [],
        originalVideo,
      } as never);
      const writes = vi.spyOn(sessionStorage, 'setItem');
      const removals = vi.spyOn(sessionStorage, 'removeItem');
      const onClose = vi.fn();
      render(VideoEditorCloseHost, { asset, onClose });
      await waitFor(() => expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeEnabled());
      await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_speed' }));
      await fireEvent.click(screen.getByRole('radio', { name: '2×' }));
      await waitFor(() => expect(readEditorContinuity<VideoDraft>(asset.id)?.draft.edit.speed).toBe(2));
      if (action === 'empty-original-save') {
        await fireEvent.click(screen.getByRole('radio', { name: '1×' }));
        await waitFor(() => expect(readEditorContinuity<VideoDraft>(asset.id)?.draft.undo.length).toBeGreaterThan(0));
      }
      writes.mockClear();
      removals.mockClear();
      await fireEvent.click(
        screen.getByRole('button', { name: action === 'cancel' ? 'cancel' : 'frameleaf_editor_save_version' }),
      );
      await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
      const key = `frameleaf.editor.continuity.${asset.id}`;
      expect(removals.mock.calls.filter(([removed]) => removed === key)).toHaveLength(1);
      expect(writes.mock.calls.filter(([written]) => written === key)).toEqual([]);
      expect(readEditorContinuity(asset.id)).toBeNull();
      expect(onClose).toHaveBeenCalledWith(action === 'save');
      expect(editAsset).toHaveBeenCalledTimes(action === 'save' ? 1 : 0);
      expect(removeAssetEdits).not.toHaveBeenCalled();
    },
  );

  it('preserves the intentional Studio draft through batched parent teardown', async () => {
    const asset = video();
    vi.mocked(getAssetEdits).mockResolvedValue({ assetId: asset.id, edits: [], originalVideo } as never);
    render(VideoEditorCloseHost, { asset, onClose: vi.fn() });
    await waitFor(() => expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeEnabled());
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_speed' }));
    await fireEvent.click(screen.getByRole('radio', { name: '0.5×' }));
    // With an unsaved edit, More names what Studio will open on.
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_more_actions' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'frameleaf_editor_studio_without_edits' }));
    await waitFor(() => expect(screen.queryByRole('dialog')).not.toBeInTheDocument());
    expect(readEditorContinuity<VideoDraft>(asset.id)?.draft.edit.speed).toBe(0.5);
    expect(editAsset).not.toHaveBeenCalled();
    expect(goto).toHaveBeenCalledWith(`/studio?assets=${asset.id}&from=${asset.id}&at=0%2F1`);
  });

  it('discards an unsaved edit on Cancel and says so', async () => {
    const { asset, onClose } = await opened();
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_audio' }));
    await fireEvent.click(screen.getByRole('switch', { name: 'frameleaf_video_editor_mute' }));
    await fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(toastManager.primary).toHaveBeenCalledWith('frameleaf_editor_edits_discarded');
    expect(onClose).toHaveBeenCalledWith(false);
    expect(editAsset).not.toHaveBeenCalled();
    expect(readEditorContinuity(asset.id)).toBeNull();
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

  it('keeps the clip on the stage with the compare hint when restoring from Enhance (FL-83 E-9)', async () => {
    await opened();
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_enhance' }));
    // Restoration is the prototype's "Restore video" section at the end of the Enhance panel.
    const panel = screen.getByRole('tabpanel');
    expect(within(panel).getByRole('heading', { level: 3, name: 'frameleaf_video_editor_restore_video' })).toBeTruthy();
    expect(within(panel).getByRole('switch', { name: 'frameleaf_video_editor_stabilize' })).toBeTruthy();
    expect(screen.getByText('frameleaf_restoration_compare_empty')).toHaveClass('ed-restore-hint');
  });

  it('says the clip cannot be edited when its original cannot be read', async () => {
    vi.mocked(getAssetEdits).mockRejectedValue(new Error('nope'));
    render(VideoQuickEditor, { asset: video(), onClose: vi.fn() });
    expect(await screen.findByText('frameleaf_video_editor_load_error')).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeDisabled();
  });
});

describe('HDR and Dolby Vision clips (FL-113)', () => {
  const openWith = async (policy: 'tone-map' | 'unsupported', decodeRefusal?: DecodeRefusal) => {
    vi.mocked(getAssetEdits).mockResolvedValue({
      assetId: 'asset',
      edits: [],
      originalVideo: { ...originalVideo, colorPolicy: policy as never, colorReason: 'server reason', decodeRefusal },
    });
    render(VideoQuickEditor, { asset: video(), onClose: vi.fn() });
    await waitFor(() => expect(screen.getByTestId('video-color-policy')).toHaveAttribute('data-policy', policy));
  };

  it('says an HDR clip is edited in standard range while the HDR original is kept, and still saves', async () => {
    await openWith('tone-map');
    expect(screen.getByTestId('video-color-policy')).toHaveTextContent('frameleaf_video_editor_color_tone_map');
    expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeEnabled();
  });

  it('explains why a Dolby Vision profile 5 clip cannot be saved, and does not offer to', async () => {
    await openWith('unsupported');
    expect(screen.getByTestId('video-color-policy')).toHaveTextContent('frameleaf_video_editor_color_unsupported');
    expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeDisabled();
    expect(editAsset).not.toHaveBeenCalled();
  });

  it.each([
    [DecodeRefusal.DolbyVisionEnhancementLayer, 'frameleaf_video_editor_decode_dolby_vision_enhancement_layer'],
    [DecodeRefusal.UnsupportedBitDepth, 'frameleaf_video_editor_decode_bit_depth'],
    [DecodeRefusal.UnknownPixelFormat, 'frameleaf_video_editor_decode_pixel_format'],
  ])(
    'says why a %s clip cannot be edited before editing starts, and does not offer to save (FL-101)',
    async (refusal, key) => {
      await openWith('unsupported', refusal);
      const note = screen.getByTestId('video-color-policy');
      expect(note).toHaveTextContent(key);
      expect(note).toHaveAttribute('data-refusal', refusal);
      const save = screen.getByRole('button', { name: 'frameleaf_editor_save_version' });
      expect(save).toBeDisabled();
      expect(save).toHaveAttribute('title', key);
      expect(editAsset).not.toHaveBeenCalled();
    },
  );
});
