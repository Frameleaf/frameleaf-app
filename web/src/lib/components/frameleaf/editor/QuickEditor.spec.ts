import {
  AssetDevelopRevisionKind,
  AssetDevelopRevisionStatus,
  AssetTypeEnum,
  cancelAssetDevelopRender,
  getAssetDevelop,
  getAssetEdits,
  getVideoEditVersions,
  previewAssetDevelop,
  renderAssetDevelopRevision,
  saveAssetDevelop,
  type AssetDevelopRevisionResponseDto,
} from '@frameleaf/sdk';
import { toastManager } from '@frameleaf/ui';
import { fireEvent, render, screen, waitFor, within } from '@testing-library/svelte';
import { goto } from '$app/navigation';
import { continuityBase, readEditorContinuity, saveEditorContinuity } from '$lib/frameleaf/editor-continuity';
import { openingRecipe, type EditorDraft } from '$lib/frameleaf/editor-draft';
import { clearPrivateBrowserState } from '$lib/frameleaf/private-browser-state';
import { assetFactory } from '@test-data/factories/asset-factory';
import QuickEditor from './QuickEditor.svelte';

vi.mock('$app/navigation', () => ({ goto: vi.fn() }));

/**
 * QuickEditor (FL-113). The test i18n setup renders the literal key rather than its English
 * text, so assertions match on `frameleaf_editor_*` keys.
 */
vi.mock('@frameleaf/sdk', async () => {
  const sdk = await vi.importActual<typeof import('@frameleaf/sdk')>('@frameleaf/sdk');
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
    getAssetEdits: vi.fn().mockResolvedValue({
      assetId: 'asset',
      edits: [],
      originalVideo: { width: 1920, height: 1080, durationMs: 24_000 },
    }),
  };
});

vi.mock('@frameleaf/ui', async () => {
  const actual = await vi.importActual<typeof import('@frameleaf/ui')>('@frameleaf/ui');
  const { default: Icon } = await import('@test-data/components/MockIcon.svelte');
  return {
    ...actual,
    Icon,
    modalManager: { showDialog: vi.fn() },
    toastManager: { primary: vi.fn(), danger: vi.fn() },
  };
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
    sessionStorage.clear();
    vi.mocked(saveAssetDevelop).mockReset();
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
    vi.restoreAllMocks();
    vi.clearAllMocks();
  });

  /** The editor loads the asset's develop state on mount and only then adopts it as the draft. */
  const ready = async () => {
    await waitFor(() => expect(getAssetDevelop).toHaveBeenCalled());
    await new Promise((resolve) => setTimeout(resolve, 0));
  };

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
    render(QuickEditor, { asset: photo, onClose: vi.fn() });
    await ready();
    vi.useFakeTimers({ shouldAdvanceTime: true });
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

  it('uses HDR-preserving server previews and holds the last result while adjusting', async () => {
    const measure = vi
      .spyOn(HTMLElement.prototype, 'getBoundingClientRect')
      .mockReturnValue(new DOMRect(0, 0, 800, 600));
    const hdr = {
      ...photo,
      imageEncoding: { dynamicRange: 'hdr' as const, gainMap: 'ultra-hdr', reconstructionAvailable: true },
    };
    const view = render(QuickEditor, { asset: hdr, onClose: vi.fn() });
    await ready();
    await waitFor(() =>
      expect(previewAssetDevelop).toHaveBeenCalledWith(
        {
          id: photo.id,
          assetDevelopPreviewDto: {
            recipe: expect.objectContaining({ version: 3, hdr: expect.objectContaining({ intent: 'preserve' }) }),
            size: 1280,
            dynamicRange: 'auto',
          },
        },
        expect.anything(),
      ),
    );
    await waitFor(() => expect(view.container.querySelector('img[src="blob:preview"]')).toBeInTheDocument());
    vi.mocked(previewAssetDevelop).mockImplementation(() => new Promise(() => {}));
    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }), {
      target: { value: '25' },
    });
    expect(view.container.querySelector('img[src="blob:preview"]')).toHaveStyle('filter: none');
    expect(screen.getByRole('img', { name: 'frameleaf_editor_histogram_hdr' })).toBeInTheDocument();
    view.unmount();
    measure.mockRestore();
  });

  const sdkError = async (status: number, code?: string) => {
    const sdk = await vi.importActual<typeof import('@frameleaf/sdk')>('@frameleaf/sdk');
    try {
      await sdk.saveAssetDevelop(
        { id: photo.id, assetDevelopSaveDto: { recipe: { version: 1 }, render: true } },
        {
          fetch: async () =>
            Response.json(
              { message: 'Refused', code },
              {
                status,
                headers: { 'Content-Type': 'application/json' },
              },
            ),
        },
      );
      throw new Error('Expected an SDK HTTP error');
    } catch (error) {
      expect(sdk.isHttpError(error)).toBe(true);
      return error;
    }
  };

  it('saves an opaque recipe only after the exact unsupported-render refusal, without queueing or replacing the preview', async () => {
    const source = revision({ assetId: photo.id, recipe: { version: 2, future: { fill: ['ordered', 7] } } });
    vi.mocked(getAssetDevelop).mockResolvedValue({
      assetId: photo.id,
      currentRevisionId: source.id,
      revisions: [source],
    });
    vi.mocked(saveAssetDevelop)
      .mockRejectedValueOnce(await sdkError(400, 'develop_renderer_unsupported'))
      .mockResolvedValueOnce(
        revision({ status: AssetDevelopRevisionStatus.Saved, hasPreview: false, hasMaster: false }),
      );
    const onClose = vi.fn();
    vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
      x: 0,
      y: 0,
      left: 0,
      top: 0,
      right: 600,
      bottom: 400,
      width: 600,
      height: 400,
      toJSON: () => ({}),
    });
    render(QuickEditor, { asset: photo, onClose });
    await ready();
    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }), {
      target: { value: '25' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'undo' }));
    await fireEvent.keyDown(screen.getByRole('dialog'), { key: 'z', ctrlKey: true, shiftKey: true });
    const preview = document.querySelector('.ed-stage img')?.getAttribute('src');
    expect(preview).toBeTruthy();
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_save_version' }));
    await waitFor(() => expect(saveAssetDevelop).toHaveBeenCalledTimes(2));
    const [first, second] = vi.mocked(saveAssetDevelop).mock.calls.map(([args]) => args);
    expect(first.assetDevelopSaveDto).toMatchObject({
      sourceRevisionId: source.id,
      replaceRecipe: true,
      recipe: { version: 2, future: { fill: ['ordered', 7] }, contrast: 25 },
      render: true,
    });
    expect(second).toEqual({ ...first, assetDevelopSaveDto: { ...first.assetDevelopSaveDto, render: false } });
    expect(toastManager.primary).toHaveBeenCalledWith('frameleaf_editor_version_saved_newer_renderer');
    expect(toastManager.primary).not.toHaveBeenCalledWith('frameleaf_editor_version_queued');
    expect(document.querySelector('.ed-stage img')?.getAttribute('src')).toBe(preview);
    expect(onClose).toHaveBeenCalledWith(false);
  });

  it.each([
    [400, undefined],
    [403, 'develop_renderer_unsupported'],
    [404, 'develop_renderer_unsupported'],
    [409, 'develop_renderer_unsupported'],
    [500, 'develop_renderer_unsupported'],
  ] as const)('does not retry a different Save refusal (%s, %s)', async (status, code) => {
    vi.mocked(saveAssetDevelop).mockRejectedValueOnce(await sdkError(status, code));
    const onClose = vi.fn();
    render(QuickEditor, { asset: photo, onClose });
    await ready();
    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }), {
      target: { value: '25' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_save_version' }));
    await waitFor(() => expect(toastManager.danger).toHaveBeenCalled());
    expect(saveAssetDevelop).toHaveBeenCalledTimes(1);
    expect(onClose).not.toHaveBeenCalled();
  });

  it('deliberately resets an opaque draft to Original and resumes the normal render save', async () => {
    const source = revision({ assetId: photo.id, recipe: { version: 2, future: { fill: ['opaque'] } } });
    vi.mocked(getAssetDevelop).mockResolvedValue({
      assetId: photo.id,
      currentRevisionId: source.id,
      revisions: [source],
    });
    vi.mocked(saveAssetDevelop).mockResolvedValueOnce(revision({ status: AssetDevelopRevisionStatus.Queued }));
    render(QuickEditor, { asset: photo, onClose: vi.fn() });
    await ready();
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_revert' }));
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_save_version' }));
    await waitFor(() => expect(saveAssetDevelop).toHaveBeenCalledTimes(1));
    const sent = vi.mocked(saveAssetDevelop).mock.calls[0][0].assetDevelopSaveDto;
    expect(sent).toMatchObject({ recipe: { version: 1 }, render: true, replaceRecipe: true });
    expect(sent.recipe).not.toHaveProperty('future');
    expect(sent).not.toHaveProperty('sourceRevisionId');
    expect(toastManager.primary).toHaveBeenCalledWith('frameleaf_editor_version_queued');
  });

  it('does not retry a Save transport failure', async () => {
    vi.mocked(saveAssetDevelop).mockRejectedValueOnce(new TypeError('Failed to fetch'));
    render(QuickEditor, { asset: photo, onClose: vi.fn() });
    await ready();
    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }), {
      target: { value: '25' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_save_version' }));
    await waitFor(() => expect(toastManager.danger).toHaveBeenCalled());
    expect(saveAssetDevelop).toHaveBeenCalledTimes(1);
  });

  it('saves the recipe as a new version, announces it and closes the editor', async () => {
    const saved = revision({
      assetId: photo.id,
      status: AssetDevelopRevisionStatus.Queued,
      progress: 0,
      hasMaster: false,
      hasPreview: false,
    });
    vi.mocked(saveAssetDevelop).mockResolvedValue(saved);
    vi.mocked(getAssetDevelop).mockResolvedValue({ assetId: photo.id, currentRevisionId: null, revisions: [saved] });
    const onClose = vi.fn();
    render(QuickEditor, { asset: photo, onClose });
    await ready();

    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }), {
      target: { value: '25' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_save_version' }));

    await waitFor(() =>
      expect(saveAssetDevelop).toHaveBeenCalledWith({
        id: photo.id,
        assetDevelopSaveDto: { recipe: expect.objectContaining({ contrast: 25 }), render: true, replaceRecipe: true },
      }),
    );
    const sent = vi.mocked(saveAssetDevelop).mock.calls[0][0].assetDevelopSaveDto.recipe;
    expect('aspect' in sent).toBe(false);
    await waitFor(() => expect(onClose).toHaveBeenCalledWith(false));
    expect(toastManager.primary).toHaveBeenCalledWith('frameleaf_editor_version_queued');
    expect(readEditorContinuity(photo.id)).toBeNull();
  });

  it('refreshes the viewer only after a rendered revision becomes current', async () => {
    const saved = revision({ assetId: photo.id, status: AssetDevelopRevisionStatus.Queued, isCurrent: false });
    const rendered = revision({ assetId: photo.id, status: AssetDevelopRevisionStatus.Rendered, isCurrent: true });
    vi.mocked(saveAssetDevelop).mockResolvedValue(saved);
    vi.mocked(getAssetDevelop)
      .mockResolvedValueOnce({ assetId: photo.id, currentRevisionId: null, revisions: [] })
      .mockResolvedValueOnce({ assetId: photo.id, currentRevisionId: null, revisions: [rendered] })
      .mockResolvedValue({ assetId: photo.id, currentRevisionId: rendered.id, revisions: [rendered] });
    const onClose = vi.fn();
    const onRendered = vi.fn();
    render(QuickEditor, { asset: photo, onClose, onRendered });
    await ready();

    vi.useFakeTimers({ shouldAdvanceTime: true });
    try {
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_save_version' }));
      await waitFor(() => expect(onClose).toHaveBeenCalledWith(false));
      await waitFor(() => expect(getAssetDevelop).toHaveBeenCalledTimes(2));
      expect(onRendered).not.toHaveBeenCalled();

      await vi.advanceTimersByTimeAsync(1200);
      await waitFor(() => expect(onRendered).toHaveBeenCalledExactlyOnceWith(photo.id));
    } finally {
      vi.useRealTimers();
    }
  });

  it('discards unsaved edits at once with a toast, and closes quietly when clean', async () => {
    const onClose = vi.fn();
    render(QuickEditor, { asset: photo, onClose });

    await fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(toastManager.primary).not.toHaveBeenCalled();
    expect(onClose).toHaveBeenCalledWith(false);
    onClose.mockClear();

    await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }), {
      target: { value: '10' },
    });
    await fireEvent.click(screen.getByRole('button', { name: 'cancel' }));
    expect(toastManager.primary).toHaveBeenCalledWith('frameleaf_editor_edits_discarded');
    expect(onClose).toHaveBeenCalledWith(false);
    expect(readEditorContinuity(photo.id)).toBeNull();
  });

  describe('hold to compare (September 24 design)', () => {
    const stageImage = () => screen.getByAltText(photo.originalFileName);
    beforeEach(() => {
      vi.spyOn(HTMLElement.prototype, 'getBoundingClientRect').mockReturnValue({
        width: 800,
        height: 600,
        top: 0,
        left: 0,
        right: 800,
        bottom: 600,
        x: 0,
        y: 0,
        toJSON: () => ({}),
      });
    });
    afterEach(() => vi.restoreAllMocks());

    it('holds the untouched original on backslash, geometry included, and releases on key up', async () => {
      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await ready();
      await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_editor_tool_crop' }));
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_rotate_right' }));
      expect(stageImage().getAttribute('style')).toContain('rotate(90deg)');

      const dialog = screen.getByRole('dialog');
      await fireEvent.keyDown(dialog, { key: '\\', code: 'Backslash' });
      expect(document.querySelector('.ed-badge.ed-original')).toHaveTextContent('frameleaf_editor_version_original');
      expect(stageImage().getAttribute('style')).toContain('rotate(0deg)');
      expect(screen.getByRole('button', { name: 'frameleaf_editor_hold_before' })).toHaveAttribute(
        'aria-pressed',
        'true',
      );

      // A release counts even with a modifier held, so the original never sticks.
      await fireEvent.keyUp(dialog, { key: '\\', code: 'Backslash', metaKey: true });
      expect(stageImage().getAttribute('style')).toContain('rotate(90deg)');
    });

    it('compares while an adjustment slider has focus, and releases when the window loses focus', async () => {
      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await ready();
      const slider = screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' });
      await fireEvent.keyDown(slider, { key: 'y', code: 'KeyY' });
      const hold = screen.getByRole('button', { name: 'frameleaf_editor_hold_before' });
      expect(hold).toHaveAttribute('aria-pressed', 'true');

      await fireEvent.blur(globalThis as unknown as Window);
      expect(hold).toHaveAttribute('aria-pressed', 'false');

      await fireEvent.keyDown(slider, { key: 'y', code: 'KeyY', metaKey: true });
      expect(hold).toHaveAttribute('aria-pressed', 'false');
    });

    it('keeps the edited framing in split view', async () => {
      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await ready();
      await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_editor_tool_crop' }));
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_rotate_right' }));
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_split_view' }));
      await fireEvent.keyDown(screen.getByRole('dialog'), { key: '\\', code: 'Backslash' });
      expect(stageImage().getAttribute('style')).toContain('rotate(90deg)');
      expect(document.querySelector('.ed-badge.ed-original')).toBeNull();
    });
  });

  it('puts Versions in a top-bar menu that loads a saved recipe', async () => {
    vi.mocked(getAssetDevelop).mockResolvedValue({
      assetId: photo.id,
      currentRevisionId: null,
      revisions: [revision({ label: 'Warm' })],
    });
    render(QuickEditor, { asset: photo, onClose: vi.fn() });
    await ready();
    expect(screen.queryByRole('tab', { name: 'frameleaf_editor_tool_versions' })).not.toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_tool_versions' }));
    const original = await screen.findByRole('menuitemradio', { name: /frameleaf_editor_version_original/ });
    expect(original).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(screen.getByRole('menuitemradio', { name: /Warm/ }));

    const contrast = screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }) as HTMLInputElement;
    expect(contrast.value).toBe('30');
  });

  const manageVersions = async () => {
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_tool_versions' }));
    await fireEvent.click(await screen.findByRole('menuitem', { name: 'frameleaf_editor_manage_versions' }));
  };

  it('cancels a version that is still rendering on the server', async () => {
    const rendering = revision({ status: AssetDevelopRevisionStatus.Rendering, progress: 40, hasMaster: false });
    vi.mocked(getAssetDevelop).mockResolvedValue({
      assetId: photo.id,
      currentRevisionId: null,
      revisions: [rendering],
    });
    vi.mocked(cancelAssetDevelopRender).mockResolvedValue({
      ...rendering,
      status: AssetDevelopRevisionStatus.Cancelled,
    });
    render(QuickEditor, { asset: photo, onClose: vi.fn() });
    await ready();
    await manageVersions();

    // The top bar and the version's own row both offer it; this is the row's.
    const cancel = await screen.findAllByRole('button', { name: 'frameleaf_editor_cancel_render' });
    expect(cancel).toHaveLength(2);
    const cancelled = { ...rendering, status: AssetDevelopRevisionStatus.Cancelled };
    vi.mocked(getAssetDevelop).mockResolvedValue({
      assetId: photo.id,
      currentRevisionId: null,
      revisions: [cancelled],
    });
    await fireEvent.click(cancel[1]);

    expect(cancelAssetDevelopRender).toHaveBeenCalledWith({ id: photo.id, revisionId: 'rev-1' });
    expect(renderAssetDevelopRevision).not.toHaveBeenCalled();
    expect(await screen.findByRole('button', { name: 'frameleaf_editor_render' })).toBeInTheDocument();
  });

  it('renders a failed version again on the server', async () => {
    const failed = revision({ status: AssetDevelopRevisionStatus.Failed, error: 'out of memory', hasMaster: false });
    vi.mocked(getAssetDevelop).mockResolvedValue({ assetId: photo.id, currentRevisionId: null, revisions: [failed] });
    vi.mocked(renderAssetDevelopRevision).mockResolvedValue({
      ...failed,
      status: AssetDevelopRevisionStatus.Queued,
      error: null,
    });
    render(QuickEditor, { asset: photo, onClose: vi.fn() });
    await ready();
    await manageVersions();

    expect(await screen.findByText('out of memory')).toBeInTheDocument();
    const queued = { ...failed, status: AssetDevelopRevisionStatus.Queued, error: null };
    vi.mocked(getAssetDevelop).mockResolvedValue({ assetId: photo.id, currentRevisionId: null, revisions: [queued] });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_render' }));

    expect(renderAssetDevelopRevision).toHaveBeenCalledWith({ id: photo.id, revisionId: 'rev-1' });
    expect(cancelAssetDevelopRender).not.toHaveBeenCalled();
    expect(await screen.findAllByRole('button', { name: 'frameleaf_editor_cancel_render' })).toHaveLength(2);
  });

  it('offers the phone More actions menu and names the people in the photo', async () => {
    const withPeople = assetFactory.build({
      ...photo,
      people: [{ id: 'p1', name: 'Anna' } as never, { id: 'p2', name: '' } as never],
    });
    render(QuickEditor, { asset: withPeople, onClose: vi.fn() });
    await ready();
    expect(screen.getByText(/frameleaf_editor_with_people/)).toBeInTheDocument();

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_more_actions' }));
    const items = await screen.findAllByRole('menuitem');
    expect(items.map((item) => item.textContent?.trim())).toEqual([
      'frameleaf_editor_copy_settings',
      'frameleaf_editor_paste_settings',
      'frameleaf_editor_revert_draft',
      'frameleaf_editor_open_in_studio',
    ]);
    expect(items[1]).toHaveAttribute('aria-disabled', 'true');
  });

  it('offers Open in Studio in the top bar', () => {
    render(QuickEditor, { asset: photo, onClose: vi.fn() });
    expect(screen.getByRole('button', { name: 'frameleaf_editor_open_in_studio' })).toBeInTheDocument();
  });

  describe('continuity with Studio (FL-113)', () => {
    afterEach(() => sessionStorage.clear());

    it('carries the unsaved draft to Studio instead of discarding it, and says where it came from', async () => {
      const onClose = vi.fn();
      render(QuickEditor, { asset: photo, onClose });
      await ready();
      await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }), {
        target: { value: '40' },
      });

      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_open_in_studio' }));

      expect(toastManager.primary).not.toHaveBeenCalledWith('frameleaf_editor_edits_discarded');
      expect(onClose).toHaveBeenCalled();
      expect(goto).toHaveBeenCalledWith(`/studio?assets=${photo.id}&from=${photo.id}`);
      const carried = readEditorContinuity<{ recipe: { contrast: number }; undo: unknown[] }>(photo.id);
      expect(carried).toMatchObject({ kind: 'photo', tool: 'adjust' });
      expect(carried?.draft.recipe.contrast).toBe(40);
      expect(carried?.draft.undo.length).toBeGreaterThan(0);
    });

    it('opens on the draft left before Studio, with its undo history', async () => {
      const develop = { assetId: photo.id, currentRevisionId: null, revisions: [] };
      const start = openingRecipe(develop);
      saveEditorContinuity({
        assetId: photo.id,
        kind: 'photo',
        draft: { recipe: { ...start, contrast: 25 }, undo: [start], redo: [] },
        base: continuityBase({ ownerId: photo.ownerId, edit: start }),
        tool: 'adjust',
        playhead: { num: 0, den: 1 },
      });

      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await ready();

      await waitFor(() =>
        expect(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' })).toHaveValue('25'),
      );
      expect(toastManager.primary).toHaveBeenCalledWith('frameleaf_editor_continuity_resumed');
      expect(screen.getByRole('button', { name: 'undo' })).not.toBeDisabled();
      expect(readEditorContinuity(photo.id)?.draft).toBeDefined();
    });

    it('restores an unsaved photo draft and undo history after reload without opening Studio', async () => {
      const first = render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await ready();
      await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }), {
        target: { value: '40' },
      });
      await waitFor(() => expect(readEditorContinuity<EditorDraft>(photo.id)?.draft.recipe.contrast).toBe(40));
      first.unmount();

      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await waitFor(() =>
        expect(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' })).toHaveValue('40'),
      );
      expect(screen.getByRole('button', { name: 'undo' })).not.toBeDisabled();
    });

    it('keeps photo redo history after undo returns to the opening recipe', async () => {
      const first = render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await ready();
      await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }), {
        target: { value: '40' },
      });
      await fireEvent.click(screen.getByRole('button', { name: 'undo' }));
      await waitFor(() => expect(readEditorContinuity<EditorDraft>(photo.id)?.draft.redo.length).toBe(1));
      first.unmount();

      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await ready();
      const redo = screen.getByRole('button', { name: 'frameleaf_editor_redo' });
      expect(redo).not.toBeDisabled();
      await fireEvent.click(redo);
      expect(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' })).toHaveValue('40');
    });

    it('does not rewrite a cleared photo draft from a late editor update', async () => {
      const first = render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await ready();
      await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }), {
        target: { value: '40' },
      });
      await waitFor(() => expect(readEditorContinuity(photo.id)?.kind).toBe('photo'));

      clearPrivateBrowserState();
      await fireEvent.input(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' }), {
        target: { value: '50' },
      });
      first.unmount();
      expect(readEditorContinuity(photo.id)).toBeNull();
    });

    it('does not replay a draft over a version saved in the meantime', async () => {
      saveEditorContinuity({
        assetId: photo.id,
        kind: 'photo',
        draft: { recipe: { contrast: 25 }, undo: [], redo: [] },
        base: continuityBase({ something: 'older' }),
        tool: 'adjust',
        playhead: { num: 0, den: 1 },
      });

      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await ready();

      expect(toastManager.primary).toHaveBeenCalledWith('frameleaf_editor_continuity_stale');
      expect(screen.getByRole('slider', { name: 'frameleaf_editor_param_contrast' })).toHaveValue('0');
    });

    it('carries a clip’s draft and playhead, and Studio starts at the same instant', async () => {
      const video = assetFactory.build({ type: AssetTypeEnum.Video, originalFileName: 'MOV_0001.mp4' });
      render(QuickEditor, { asset: video, onClose: vi.fn() });
      await waitFor(() => expect(getAssetEdits).toHaveBeenCalledWith({ id: video.id }));
      await new Promise((resolve) => setTimeout(resolve, 0));

      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_open_in_studio' }));

      expect(goto).toHaveBeenCalledWith(`/studio?assets=${video.id}&from=${video.id}&at=0%2F1`);
    });
  });

  it('opens a video on the video quick editor in the same frame (VE-1)', async () => {
    const video = assetFactory.build({ type: AssetTypeEnum.Video, originalFileName: 'MOV_0001.mp4' });
    render(QuickEditor, { asset: video, onClose: vi.fn() });

    expect(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_trim' })).toHaveAttribute(
      'aria-selected',
      'true',
    );
    await waitFor(() => expect(getAssetEdits).toHaveBeenCalledWith({ id: video.id }));
    expect(getAssetDevelop).not.toHaveBeenCalled();
    // The photo Masks entry is not offered for a clip.
    expect(screen.queryByRole('button', { name: /frameleaf_editor_tool_masks/ })).not.toBeInTheDocument();
  });

  it('opens the video Versions menu without discarding the open draft (FL-39)', async () => {
    const video = assetFactory.build({ type: AssetTypeEnum.Video, originalFileName: 'MOV_0001.mp4' });
    render(QuickEditor, { asset: video, onClose: vi.fn() });

    const versions = screen.getByRole('button', { name: 'frameleaf_editor_tool_versions' });
    expect(versions).toHaveAttribute('aria-haspopup', 'menu');
    await fireEvent.click(versions);

    expect(await screen.findByRole('menu', { name: 'editor_video_versions' })).toBeInTheDocument();
    expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeInTheDocument();
    await waitFor(() => expect(getVideoEditVersions).toHaveBeenCalledWith({ id: video.id }));
  });

  it(String.raw`hands the dialog keys to the video editor: undo with ⌘Z, compare with \ (VE-12)`, async () => {
    const video = assetFactory.build({ type: AssetTypeEnum.Video, originalFileName: 'MOV_0001.mp4' });
    render(QuickEditor, { asset: video, onClose: vi.fn() });
    await waitFor(() => expect(screen.getByRole('button', { name: 'frameleaf_editor_save_version' })).toBeEnabled());

    await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_video_editor_tool_audio' }));
    const mute = screen.getByRole('switch', { name: 'frameleaf_video_editor_mute' });
    await fireEvent.click(mute);
    expect(mute).toHaveAttribute('aria-checked', 'true');

    const dialog = screen.getByRole('dialog');
    await fireEvent.keyDown(dialog, { key: 'z', metaKey: true });
    expect(mute).toHaveAttribute('aria-checked', 'false');
    await fireEvent.keyDown(dialog, { key: 'z', metaKey: true, shiftKey: true });
    expect(mute).toHaveAttribute('aria-checked', 'true');

    const compare = screen.getByRole('button', { name: 'frameleaf_editor_hold_before' });
    await fireEvent.keyDown(dialog, { key: '\\' });
    expect(compare).toHaveAttribute('aria-pressed', 'true');
    await fireEvent.keyUp(dialog, { key: '\\' });
    expect(compare).toHaveAttribute('aria-pressed', 'false');
  });

  describe('the prototype tool rail (FL-83 E-9)', () => {
    it('offers Adjust, Crop, Enhance and Presets, with restoration under Enhance', async () => {
      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await waitFor(() => expect(getAssetDevelop).toHaveBeenCalled());

      expect(screen.getAllByRole('tab').map((tab) => tab.dataset.tool)).toEqual([
        'adjust',
        'crop',
        'enhance',
        'presets',
      ]);
      await fireEvent.click(screen.getByRole('tab', { name: 'frameleaf_editor_tool_enhance' }));
      const panel = screen.getByRole('tabpanel', { name: 'frameleaf_editor_tool_enhance' });
      expect(within(panel).getByTestId('restoration-panel')).toBeInTheDocument();
      expect(within(panel).getByRole('heading', { level: 2, name: 'frameleaf_editor_tool_enhance' })).toBeTruthy();
    });

    it('opens Masks from the Adjust panel, keeps Adjust selected and returns to it', async () => {
      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await waitFor(() => expect(getAssetDevelop).toHaveBeenCalled());

      await fireEvent.click(screen.getByRole('button', { name: /frameleaf_editor_tool_masks/ }));
      expect(screen.getByRole('tabpanel', { name: 'frameleaf_editor_tool_masks' })).toBeInTheDocument();
      expect(screen.getByRole('tab', { name: 'frameleaf_editor_tool_adjust' })).toHaveAttribute(
        'aria-selected',
        'true',
      );
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_mask_add_radial' }));

      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_masks_back' }));
      expect(screen.getByRole('tabpanel', { name: 'frameleaf_editor_tool_adjust' })).toBeInTheDocument();
      // The entry counts the masks the photo has.
      expect(screen.getByRole('button', { name: /frameleaf_editor_tool_masks/ })).toHaveTextContent('1');
    });
  });

  describe('selective photo tools (FL-64)', () => {
    it('adds a mask from the Masks tool, previews it on the server and saves it with the version', async () => {
      vi.useFakeTimers({ shouldAdvanceTime: true });
      vi.mocked(saveAssetDevelop).mockResolvedValue(revision({ status: AssetDevelopRevisionStatus.Queued }));
      render(QuickEditor, { asset: photo, onClose: vi.fn() });
      await waitFor(() => expect(getAssetDevelop).toHaveBeenCalled());

      await fireEvent.click(screen.getByRole('button', { name: /frameleaf_editor_tool_masks/ }));
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
      await fireEvent.click(screen.getByRole('button', { name: /frameleaf_editor_tool_masks/ }));
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
      await ready();
      await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_editor_tool_versions' }));
      await fireEvent.click(await screen.findByRole('menuitem', { name: 'frameleaf_editor_manage_versions' }));

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
