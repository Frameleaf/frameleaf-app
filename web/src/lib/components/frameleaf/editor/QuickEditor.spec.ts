import {
  AssetDevelopRevisionKind,
  AssetDevelopRevisionStatus,
  AssetTypeEnum,
  getAssetDevelop,
  getVideoEditVersions,
  previewAssetDevelop,
  saveAssetDevelop,
  type AssetDevelopRevisionResponseDto,
} from '@immich/sdk';
import { modalManager } from '@immich/ui';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { assetFactory } from '@test-data/factories/asset-factory';
import QuickEditor from './QuickEditor.svelte';

/**
 * QuickEditor (FL-113). The test i18n setup renders the literal key rather than its English
 * text, so assertions match on `frameleaf_editor_*` keys.
 */
vi.mock('@immich/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@immich/sdk')>('@immich/sdk');
  return {
    ...sdk,
    getAssetDevelop: vi.fn(),
    saveAssetDevelop: vi.fn(),
    previewAssetDevelop: vi.fn(),
    revertAssetDevelop: vi.fn(),
    renderAssetDevelopRevision: vi.fn(),
    cancelAssetDevelopRender: vi.fn(),
    getDevelopPresets: vi.fn().mockResolvedValue([]),
    getAssetDevelopExports: vi.fn().mockResolvedValue([]),
    getVideoEditVersions: vi.fn().mockResolvedValue([]),
  };
});

vi.mock('@immich/ui', async () => {
  const actual = await vi.importActual<typeof import('@immich/ui')>('@immich/ui');
  const { default: Icon } = await import('@test-data/components/MockIcon.svelte');
  return {
    ...actual,
    Icon,
    modalManager: { showDialog: vi.fn() },
    toastManager: { primary: vi.fn(), danger: vi.fn() },
  };
});

vi.mock('$lib/components/asset-viewer/editor/VideoEditorPanel.svelte', async () => {
  const { default: MockViewerControls } = await import('@test-data/components/MockViewerControls.svelte');
  return { default: MockViewerControls };
});

const revision = (overrides: Partial<AssetDevelopRevisionResponseDto> = {}): AssetDevelopRevisionResponseDto => ({
  id: 'rev-1',
  assetId: 'asset',
  revision: 1,
  label: null,
  status: AssetDevelopRevisionStatus.Rendered,
  progress: 100,
  error: null,
  recipe: { version: 1, contrast: 30 },
  rendererVersion: 'frameleaf-develop/1',
  kind: AssetDevelopRevisionKind.Recipe,
  sourceChecksum: null,
  renditionChecksum: null,
  exportId: null,
  fileName: null,
  software: null,
  attempts: 1,
  width: 100,
  height: 100,
  isCurrent: false,
  hasMaster: true,
  hasPreview: true,
  createdAt: '2026-09-22T10:00:00.000Z',
  updatedAt: '2026-09-22T10:00:00.000Z',
  renderedAt: '2026-09-22T10:00:00.000Z',
  ...overrides,
});

describe('QuickEditor', () => {
  const photo = assetFactory.build({
    type: AssetTypeEnum.Image,
    originalFileName: 'IMG_0001.jpg',
    width: 4000,
    height: 3000,
  });

  beforeEach(() => {
    vi.mocked(getAssetDevelop).mockResolvedValue({ assetId: photo.id, currentRevisionId: null, revisions: [] });
    vi.mocked(previewAssetDevelop).mockResolvedValue(new Blob(['jpeg']));
    vi.stubGlobal(
      'ResizeObserver',
      class {
        observe() {}
        disconnect() {}
      },
    );
    URL.createObjectURL = vi.fn(() => 'blob:preview');
    URL.revokeObjectURL = vi.fn();
  });

  afterEach(() => {
    vi.clearAllMocks();
  });

  it('opens a photo on Adjust with the four develop groups and a histogram', async () => {
    render(QuickEditor, { asset: photo, onClose: vi.fn() });

    expect(screen.getByRole('tab', { name: 'frameleaf_editor_tool_adjust' })).toHaveAttribute('aria-selected', 'true');
    expect(screen.getByRole('img', { name: 'frameleaf_editor_histogram_label' })).toBeInTheDocument();
    for (const group of ['light', 'color', 'effects', 'detail']) {
      expect(screen.getByRole('button', { name: `frameleaf_editor_group_${group}` })).toBeInTheDocument();
    }
    await waitFor(() => expect(getAssetDevelop).toHaveBeenCalledWith({ id: photo.id }));
    // Untouched recipe: nothing to render, so no preview round trip.
    expect(previewAssetDevelop).not.toHaveBeenCalled();
  });

  it('requests a server preview after an adjustment and says while it is rendering', async () => {
    vi.useFakeTimers({ shouldAdvanceTime: true });
    render(QuickEditor, { asset: photo, onClose: vi.fn() });
    const slider = screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' });

    await fireEvent.input(slider, { target: { value: '25' } });

    expect(screen.getByText('frameleaf_editor_preview_rendering')).toBeInTheDocument();
    await vi.advanceTimersByTimeAsync(400);
    await waitFor(() =>
      expect(previewAssetDevelop).toHaveBeenCalledWith(
        {
          id: photo.id,
          assetDevelopPreviewDto: { recipe: expect.objectContaining({ contrast: 25, version: 1 }), size: 1280 },
        },
        expect.anything(),
      ),
    );
    vi.useRealTimers();
  });

  it('saves the recipe as a new version and shows it in Versions', async () => {
    const saved = revision({
      assetId: photo.id,
      status: AssetDevelopRevisionStatus.Queued,
      progress: 0,
      hasMaster: false,
      hasPreview: false,
    });
    vi.mocked(saveAssetDevelop).mockResolvedValue(saved);
    vi.mocked(getAssetDevelop).mockResolvedValue({ assetId: photo.id, currentRevisionId: null, revisions: [saved] });
    render(QuickEditor, { asset: photo, onClose: vi.fn() });

    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_exposure' }), {
      target: { value: '0.5' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_save_version' }));

    await waitFor(() =>
      expect(saveAssetDevelop).toHaveBeenCalledWith({
        id: photo.id,
        assetDevelopSaveDto: { recipe: expect.objectContaining({ exposure: 0.5 }), render: true },
      }),
    );
    const sent = vi.mocked(saveAssetDevelop).mock.calls[0][0].assetDevelopSaveDto.recipe;
    expect('aspect' in sent).toBe(false);
    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_editor_tool_versions' }));
    expect(screen.getByText('frameleaf_editor_version_number')).toBeInTheDocument();
  });

  it('asks before discarding unsaved edits and closes without asking when clean', async () => {
    const onClose = vi.fn();
    vi.mocked(modalManager.showDialog).mockResolvedValue(false);
    render(QuickEditor, { asset: photo, onClose });

    await fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(modalManager.showDialog).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(false);
    onClose.mockClear();

    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }), {
      target: { value: '10' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    await waitFor(() => expect(modalManager.showDialog).toHaveBeenCalled());
    expect(onClose).not.toHaveBeenCalled();
  });

  it('opens a video on the production video editor inside the frame', () => {
    const video = assetFactory.build({ type: AssetTypeEnum.Video, originalFileName: 'MOV_0001.mp4' });
    render(QuickEditor, { asset: video, onClose: vi.fn() });

    expect(screen.getByRole('button', { name: 'Save video edits' })).toBeInTheDocument();
    expect(screen.queryByRole('tab', { name: 'frameleaf_editor_tool_adjust' })).not.toBeInTheDocument();
    expect(getAssetDevelop).not.toHaveBeenCalled();
  });

  it('opens the video Versions menu over the still-mounted video editor (FL-39)', async () => {
    const video = assetFactory.build({ type: AssetTypeEnum.Video, originalFileName: 'MOV_0001.mp4' });
    render(QuickEditor, { asset: video, onClose: vi.fn() });

    const versions = screen.getByRole('button', { name: 'frameleaf_editor_tool_versions' });
    expect(versions).toHaveAttribute('aria-haspopup', 'menu');
    await fireEvent.click(versions);

    expect(await screen.findByRole('menu', { name: 'editor_video_versions' })).toBeInTheDocument();
    // Looking at history never discards the open draft.
    expect(screen.getByRole('button', { name: 'Save video edits' })).toBeInTheDocument();
    await waitFor(() => expect(getVideoEditVersions).toHaveBeenCalledWith({ id: video.id }));
    // The draft is already the original, so there is nothing to revert.
    expect(screen.queryByRole('button', { name: 'frameleaf_editor_revert' })).not.toBeInTheDocument();
  });

  describe('selective photo tools (FL-64)', () => {
    it('adds a mask from the Masks tool, previews it on the server and saves it with the version', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.mocked(saveAssetDevelop).mockResolvedValue(revision({ status: AssetDevelopRevisionStatus.Queued }));
      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await waitFor(() => expect(getAssetDevelop).toHaveBeenCalled());

      await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_editor_tool_masks' }));
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_mask_add_radial' }));
      expect(screen.getByRole('radio', { name: /frameleaf_editor_mask_number/ })).toHaveAttribute(
        'aria-checked',
        'true',
      );
      await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_exposure' }), {
        target: { value: '0.5' },
      });
      await vi.advanceTimersByTimeAsync(400);
      await waitFor(() =>
        expect(previewAssetDevelop).toHaveBeenCalledWith(
          expect.objectContaining({
            assetDevelopPreviewDto: expect.objectContaining({
              recipe: expect.objectContaining({
                masks: [expect.objectContaining({ adjustments: expect.objectContaining({ exposure: 0.5 }) })],
              }),
            }),
          }),
          expect.anything(),
        ),
      );
      vi.useRealTimers();

      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_save_version' }));
      await waitFor(() => expect(saveAssetDevelop).toHaveBeenCalled());
      const sent = vi.mocked(saveAssetDevelop).mock.calls[0][0].assetDevelopSaveDto.recipe;
      expect(sent.masks).toEqual([expect.objectContaining({ kind: 'radial', x: 0.5, y: 0.5 })]);
    });

    it('turns masks with the frame so they stay on the same content', async () => {
      vi.mocked(saveAssetDevelop).mockResolvedValue(revision({ status: AssetDevelopRevisionStatus.Queued }));
      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await waitFor(() => expect(getAssetDevelop).toHaveBeenCalled());
      await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_editor_tool_masks' }));
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_mask_add_linear' }));
      await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_editor_tool_crop' }));
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_rotate_right' }));
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_save_version' }));
      await waitFor(() => expect(saveAssetDevelop).toHaveBeenCalled());
      const sent = vi.mocked(saveAssetDevelop).mock.calls[0][0].assetDevelopSaveDto.recipe;
      // A gradient from the top centre down to the middle now runs from the right edge inwards.
      expect(sent.rotation).toBe(90);
      expect(sent.masks?.[0]).toMatchObject({ x: 1, y: 0.5, endX: 0.5, endY: 0.5 });
    });

    it('offers your presets under Presets', async () => {
      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_editor_tool_presets' }));
      expect(screen.getByText('frameleaf_editor_your_presets')).toBeInTheDocument();
      expect(screen.getByRole('button', { name: 'frameleaf_editor_preset_save' })).toBeInTheDocument();
    });

    it('compares a rendered version with the original and shows where an imported one came from', async () => {
      const imported = revision({
        id: 'rev-2',
        revision: 2,
        kind: AssetDevelopRevisionKind.External,
        fileName: 'IMG_0001.tif',
        software: 'darktable 5',
        sourceChecksum: 'ab'.repeat(32),
        renditionChecksum: 'cd'.repeat(32),
        isCurrent: true,
      });
      vi.mocked(getAssetDevelop).mockResolvedValue({
        assetId: photo.id,
        currentRevisionId: imported.id,
        revisions: [imported, revision()],
      });
      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await waitFor(() => expect(getAssetDevelop).toHaveBeenCalled());
      await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_editor_tool_versions' }));

      expect(await screen.findByText(/frameleaf_editor_version_external · darktable 5/)).toBeInTheDocument();
      expect(screen.getAllByText('frameleaf_editor_version_lineage')).toHaveLength(1);
      // Only the recipe version offers its settings; both offer a comparison.
      expect(screen.getAllByRole('button', { name: 'frameleaf_editor_load_settings' })).toHaveLength(2);
      const compare = screen.getAllByRole('button', { name: 'frameleaf_editor_compare_with_original' });
      expect(compare).toHaveLength(2);

      await fireEvent.click(compare[0]);
      expect(compare[0]).toHaveAttribute('aria-pressed', 'true');
      const stage = screen.getByLabelText('frameleaf_editor_version_compare_stage');
      expect(stage.getHTML()).toContain('/develop/revisions/rev-2/file');
      expect(screen.getByText('frameleaf_editor_roundtrip_heading')).toBeInTheDocument();
    });
  });
});
