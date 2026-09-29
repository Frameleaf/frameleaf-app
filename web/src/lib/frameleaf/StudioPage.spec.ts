import { DecodeRefusal, StudioProjectImportKind, StudioRestoredVersionUnavailable } from '@immich/sdk';
import { fireEvent, render, screen, waitFor } from '@testing-library/svelte';
import { afterEach, describe, expect, it, vi } from 'vitest';
import StudioHost from '$lib/components/frameleaf/StudioHost.svelte';
import {
  clearStudioEngine,
  loadStudioEngine,
  pinnedFreecutRevision,
  registerStudioEngine,
} from '$lib/frameleaf/studio/engine-loader';
import {
  emptyStudioCapabilities,
  type StudioEngineInstance,
  type StudioEngineModule,
  type StudioHostContext,
  type StudioHostServices,
  type StudioProjectHandle,
} from '$lib/frameleaf/studio/host-contract';
import { idleStudioPreviewView, type StudioPreviewView } from '$lib/frameleaf/studio/preview';
import { offStudioStreamView, type StudioStreamView } from '$lib/frameleaf/studio/preview-stream';
import { toStudioProjectImport } from '$lib/frameleaf/studio/project-imports';
import { rational } from '$lib/frameleaf/studio/rational-time';

/**
 * The Studio route's own contract (FL-88, source anchor `web/src/lib/frameleaf/StudioPage.spec.ts`).
 *
 * The vendored engine is not in this checkout, so these tests exercise the boundary rather
 * than the editor: the honest unavailable state, what the host does and does not hand
 * across, and that the engine is disposed on every path that must not leave it running.
 */

const project: StudioProjectHandle = {
  id: 'draft',
  name: 'Summer in the Rockies',
  revision: 0,
  graph: null,
  hasLease: true,
};

const services = (): StudioHostServices => ({
  submitCommands: vi.fn().mockResolvedValue([]),
  reloadProject: vi.fn().mockResolvedValue(project),
  resolveAsset: vi.fn(),
  notify: vi.fn(),
  navigate: vi.fn(),
  setDirty: vi.fn(),
  reportFatal: vi.fn(),
});

const capable = {
  ...emptyStudioCapabilities(),
  gpuWorker: true,
  renderWorker: true,
  restorationWorker: true,
  transcriptionWorker: true,
};

const auth = { userId: 'user-1', name: 'Taylor', avatarUrl: null, locale: 'en' };

/** A file kept with the project, mapped exactly as the route maps the server's answer. */
const keptImport = toStudioProjectImport(project.id, {
  id: '4b0f4b2e-5d3a-4c55-9e0e-6b9f4c7d8e01',
  kind: StudioProjectImportKind.Audio,
  contentType: 'audio/webm',
  fileName: 'Voiceover 1.webm',
  sizeBytes: 1024,
  checksum: 'a'.repeat(64),
  externalReferences: null,
  createdAt: '2026-09-29T00:00:00.000Z',
});

const baseProps = () => ({
  project,
  assets: [],
  projectImports: [keptImport],
  handoffAssetIds: [],
  auth,
  capabilities: capable,
  services: services(),
  onBack: vi.fn(),
});

const stubEngine = (overrides: Partial<StudioEngineModule> = {}) => {
  const dispose = vi.fn();
  const update = vi.fn();
  const contexts: StudioHostContext[] = [];
  const instance: StudioEngineInstance = { update, dispose };

  const module: StudioEngineModule = {
    engineRevision: pinnedFreecutRevision,
    features: [],
    mount: vi.fn(async (_target: HTMLElement, context: StudioHostContext) => {
      contexts.push(context);
      return instance;
    }),
    ...overrides,
  };

  return { module, dispose, update, contexts, load: async () => ({ status: 'available' as const, module }) };
};

afterEach(() => {
  clearStudioEngine();
});

describe('Studio header (September 24 prototype, Studio.jsx:2584-2647)', () => {
  it('renames the project from the header, and puts the stored name back when refused', async () => {
    const onRename = vi.fn().mockResolvedValueOnce(false).mockResolvedValueOnce(true);
    render(StudioHost, { ...baseProps(), onRename, loadEngine: loadStudioEngine });

    const field = screen.getByRole('textbox', { name: 'frameleaf_studio_project_name' });
    expect(field).toHaveValue('Summer in the Rockies');
    await fireEvent.focus(field);
    await fireEvent.input(field, { target: { value: 'Lake trip' } });
    await fireEvent.keyDown(field, { key: 'Enter' });
    await fireEvent.blur(field);
    await waitFor(() => expect(onRename).toHaveBeenCalledWith('Lake trip'));
    await waitFor(() => expect(field).toHaveValue('Summer in the Rockies'));

    await fireEvent.focus(field);
    await fireEvent.input(field, { target: { value: 'Draft cut' } });
    await fireEvent.keyDown(field, { key: 'Escape' });
    await fireEvent.blur(field);
    expect(field).toHaveValue('Summer in the Rockies');
    expect(onRename).toHaveBeenCalledTimes(1);
  });

  it('shows the name as a title when it cannot be renamed', () => {
    render(StudioHost, { ...baseProps(), loadEngine: loadStudioEngine });
    expect(screen.queryByRole('textbox', { name: 'frameleaf_studio_project_name' })).not.toBeInTheDocument();
    expect(screen.getByRole('heading', { name: 'Summer in the Rockies' })).toBeInTheDocument();
  });

  it('offers Export only when the route wires it, and says how many jobs are queued', async () => {
    const onExport = vi.fn();
    const onOpenActivity = vi.fn();
    render(StudioHost, { ...baseProps(), onExport, onOpenActivity, queuedJobs: 2, loadEngine: loadStudioEngine });

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_studio_export_action' }));
    expect(onExport).toHaveBeenCalled();
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_studio_queued_open_activity' }));
    expect(onOpenActivity).toHaveBeenCalled();
  });

  it('offers Basic and Advanced only while the engine runs, and hands the choice to it', async () => {
    const engine = stubEngine();
    render(StudioHost, { ...baseProps(), loadEngine: engine.load });
    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(1));

    const advanced = await screen.findByRole('radio', { name: 'frameleaf_studio_mode_advanced' });
    expect(screen.getByRole('radio', { name: 'frameleaf_studio_mode_basic' })).toHaveAttribute('aria-checked', 'true');
    await fireEvent.click(advanced);
    expect(advanced).toHaveAttribute('aria-checked', 'true');
    await waitFor(() => expect(engine.update).toHaveBeenLastCalledWith(expect.objectContaining({ mode: 'advanced' })));
  });

  it('hands the stored workspace layout to the engine and keeps saves on the host (FL-91)', async () => {
    const engine = stubEngine();
    const layout = { panels: { bin: { open: true } } };
    const saveWorkspace = vi.fn().mockResolvedValue({ status: 'saved', savedAt: '2026-09-25T10:00:00.000Z' });
    const props = { ...baseProps(), services: { ...services(), saveWorkspace }, loadEngine: engine.load };
    render(StudioHost, {
      ...props,
      workspace: { state: 'ready', layout, savedAt: '2026-09-25T09:00:00.000Z' },
    });
    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(1));
    expect(engine.contexts[0].workspace).toEqual({ state: 'ready', layout, savedAt: '2026-09-25T09:00:00.000Z' });
    const handed = vi.mocked(engine.module.mount).mock.calls[0][2];
    await expect(handed.saveWorkspace?.({ zoom: 2 })).resolves.toEqual({
      status: 'saved',
      savedAt: '2026-09-25T10:00:00.000Z',
    });
  });

  it('goes back to the quick editor that opened Studio, starting the engine at its playhead (FL-113)', async () => {
    const engine = stubEngine();
    const onBackToEditor = vi.fn();
    render(StudioHost, {
      ...baseProps(),
      onBackToEditor,
      handoffPlayhead: { num: 25, den: 2 },
      loadEngine: engine.load,
    });
    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(1));
    expect(engine.contexts[0].handoffPlayhead).toEqual({ num: 25, den: 2 });

    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_studio_back_to_quick_edit' }));
    expect(onBackToEditor).toHaveBeenCalled();
  });

  it('offers no way back to a quick editor when Studio was not opened from one', () => {
    render(StudioHost, { ...baseProps(), loadEngine: loadStudioEngine });
    expect(screen.queryByRole('button', { name: 'frameleaf_studio_back_to_quick_edit' })).not.toBeInTheDocument();
  });

  it('has no mode switch without an engine', () => {
    render(StudioHost, { ...baseProps(), loadEngine: loadStudioEngine });
    expect(screen.queryByRole('radiogroup', { name: 'frameleaf_studio_mode_label' })).not.toBeInTheDocument();
  });
});

describe('Studio route, engine absent', () => {
  it('says the editor is not part of this build instead of showing an empty editor', async () => {
    render(StudioHost, { ...baseProps(), loadEngine: loadStudioEngine });

    await waitFor(() => {
      expect(screen.getByTestId('studio-state')).toHaveAttribute('data-phase', 'unavailable');
    });
    expect(screen.getByText('frameleaf_studio_engine_absent_body')).toBeInTheDocument();
    // And the way back out is offered both in the chrome and in the state itself.
    expect(screen.getAllByRole('button', { name: 'frameleaf_studio_back_to_library' })).toHaveLength(2);
  });

  it('names the missing workers when the deployment has none', async () => {
    render(StudioHost, { ...baseProps(), capabilities: emptyStudioCapabilities(), loadEngine: loadStudioEngine });

    await waitFor(() => {
      expect(screen.getByTestId('studio-state')).toHaveAttribute('data-phase', 'unavailable');
    });
    expect(screen.getByText('frameleaf_studio_capability_gpu_worker')).toBeInTheDocument();
    expect(screen.getByText('frameleaf_studio_capability_render_worker')).toBeInTheDocument();
  });

  it('keeps the shell chrome working with no engine at all', () => {
    render(StudioHost, { ...baseProps(), loadEngine: loadStudioEngine });

    expect(screen.getByRole('heading', { name: 'Summer in the Rockies' })).toBeInTheDocument();
    expect(screen.getByText('frameleaf_studio_editing_as')).toBeInTheDocument();
  });

  it('reports handoff items this session could not read rather than dropping them silently', () => {
    render(StudioHost, { ...baseProps(), droppedAssetCount: 2, loadEngine: loadStudioEngine });

    expect(screen.getByText('frameleaf_studio_handoff_dropped')).toBeInTheDocument();
  });

  it('names a restored version the project can no longer use, instead of swapping in the original (FL-115)', () => {
    render(StudioHost, {
      ...baseProps(),
      unavailableRestorations: [
        { name: 'summit.mp4 (restored)', reason: StudioRestoredVersionUnavailable.Discarded },
        { name: 'lake.mp4 (restored)', reason: StudioRestoredVersionUnavailable.Expired },
      ],
      loadEngine: loadStudioEngine,
    });
    const banner = screen.getByTestId('studio-restored-unavailable');
    expect(banner).toHaveTextContent('frameleaf_studio_restored_unavailable_discarded');
    expect(banner).toHaveTextContent('frameleaf_studio_restored_unavailable_expired');
  });

  it('shows no restored-version notice when every version can be used', () => {
    render(StudioHost, { ...baseProps(), loadEngine: loadStudioEngine });
    expect(screen.queryByTestId('studio-restored-unavailable')).not.toBeInTheDocument();
  });

  it('says which placed videos the server cannot decode, once per reason (FL-101)', () => {
    render(StudioHost, {
      ...baseProps(),
      loadEngine: loadStudioEngine,
      unsupportedSources: [
        { assetId: 'a', refusal: DecodeRefusal.DolbyVisionEnhancementLayer, reason: 'profile 7' },
        { assetId: 'b', refusal: DecodeRefusal.DolbyVisionEnhancementLayer, reason: 'profile 7' },
        { assetId: 'c', refusal: DecodeRefusal.UnsupportedBitDepth, reason: '16 bits' },
      ],
    });

    const banner = screen.getByTestId('studio-unsupported-sources');
    expect(banner).toHaveAttribute('role', 'status');
    expect(banner).toHaveTextContent('frameleaf_studio_sources_unsupported');
    expect(banner.textContent?.match(/frameleaf_video_editor_decode_dolby_vision_enhancement_layer/g)).toHaveLength(1);
    expect(banner).toHaveTextContent('frameleaf_video_editor_decode_bit_depth');
  });

  it('shows no decode notice when every placed video can be decoded', () => {
    render(StudioHost, { ...baseProps(), loadEngine: loadStudioEngine, unsupportedSources: [] });

    expect(screen.queryByTestId('studio-unsupported-sources')).not.toBeInTheDocument();
  });

  it('offers the Restore tab only when the route wires it, and opens it as a drawer (FL-115)', async () => {
    const { unmount } = render(StudioHost, { ...baseProps(), loadEngine: loadStudioEngine });
    expect(screen.queryByRole('button', { name: 'frameleaf_studio_restore_title' })).not.toBeInTheDocument();
    unmount();

    render(StudioHost, { ...baseProps(), onUseRestoration: vi.fn(), loadEngine: loadStudioEngine });
    await fireEvent.click(screen.getByRole('button', { name: 'frameleaf_studio_restore_title' }));
    const panel = screen.getByTestId('studio-restore-panel');
    // this project has no library photo or video yet, so there is nothing to restore
    expect(panel).toHaveTextContent('frameleaf_studio_restore_no_sources');
  });

  it('opens the Restore tab when a command sends a Frameleaf Cloud job there to confirm (FL-162)', () => {
    render(StudioHost, {
      ...baseProps(),
      onUseRestoration: vi.fn(),
      restoreRequest: { assetId: null, focus: 'smooth-motion' as const, nonce: 1 },
      loadEngine: loadStudioEngine,
    });
    expect(screen.getByTestId('studio-restore-panel')).toBeInTheDocument();
  });

  it('withdraws the Restore tab once the session loses the project', () => {
    render(StudioHost, { ...baseProps(), onUseRestoration: vi.fn(), accessLost: true, loadEngine: loadStudioEngine });
    expect(screen.queryByRole('button', { name: 'frameleaf_studio_restore_title' })).not.toBeInTheDocument();
  });

  it('offers no Activity link while there is no Activity route to open', () => {
    render(StudioHost, { ...baseProps(), queuedJobs: 3, loadEngine: loadStudioEngine });

    expect(screen.queryByText('frameleaf_studio_queued_open_activity')).not.toBeInTheDocument();
  });

  it('links the bundle jobs this session queued to Activity (FL-91)', () => {
    const onOpenActivity = vi.fn();
    render(StudioHost, { ...baseProps(), queuedJobs: 1, onOpenActivity, loadEngine: loadStudioEngine });

    expect(screen.getByText('frameleaf_studio_queued_open_activity')).toBeInTheDocument();
  });

  it('offers the bundle export only when the route passes it, and opens its dialog (FL-91)', async () => {
    const exportButton = () => screen.queryByRole('button', { name: /frameleaf_studio_bundle_export_action/ });
    const { unmount } = render(StudioHost, { ...baseProps(), loadEngine: loadStudioEngine });
    expect(exportButton()).not.toBeInTheDocument();
    unmount();

    const onExportBundle = vi.fn();
    render(StudioHost, { ...baseProps(), onExportBundle, loadEngine: loadStudioEngine });
    await fireEvent.click(exportButton()!);

    expect(onExportBundle).toHaveBeenCalledTimes(1);
  });

  it('withdraws the bundle export once the session loses the project', () => {
    render(StudioHost, { ...baseProps(), onExportBundle: vi.fn(), accessLost: true, loadEngine: loadStudioEngine });

    expect(screen.queryByRole('button', { name: /frameleaf_studio_bundle_export_action/ })).not.toBeInTheDocument();
  });
});

describe('Studio route, engine present', () => {
  it('mounts into the stage and hands across no credentials of any kind', async () => {
    const engine = stubEngine();

    render(StudioHost, { ...baseProps(), loadEngine: engine.load });

    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(1));

    const [target, context, passedServices] = vi.mocked(engine.module.mount).mock.calls[0];
    expect(target).toBe(screen.getByTestId('studio-stage'));
    expect(screen.queryByTestId('studio-state')).not.toBeInTheDocument();

    // The whole point of the boundary: data and callbacks, never a way to call the API.
    // `theme.tokens` is the design-token map (colours, radii), not a credential, so that one key
    // is set aside; every other key and value is still searched.
    const serialised = JSON.stringify({ ...context, theme: { ...context.theme, tokens: undefined } });
    expect(serialised).not.toMatch(/token|apiKey|Authorization|baseUrl/i);
    expect(Object.keys(context.theme).sort()).toEqual(['theme', 'tokens']);
    expect(JSON.stringify(Object.values(context.theme.tokens))).not.toMatch(/token|apiKey|Authorization|baseUrl/i);
    expect(Object.keys(context).sort()).toEqual([
      'assets',
      'auth',
      'capabilities',
      // FL-88: undecided edits held by the host; the engine keeps what it shows.
      'draftHeld',
      'handoffAssetIds',
      // FL-113: where the quick editor's playhead was, as exact seconds.
      'handoffPlayhead',
      // Basic or Advanced from the header (Studio.jsx:2626-2633).
      'mode',
      'online',
      // FL-96: the preview reaches the engine as data. There is still no transport here.
      'preview',
      'project',
      // FL-103 / FL-105: files kept with the project, as data; each url is a plain same-origin path
      // the owner's session cookie authorizes, with no key, slug or token (checked below).
      'projectImports',
      // FL-42: what qualified render workers verified, for the export sheet (no credentials).
      'renderEvidence',
      // FL-96: whether the host shows the server preview itself; a boolean, never the stream.
      'serverPreviewOpen',
      // FL-96: the adapter's own chrome speaks the host's language; words only.
      'strings',
      'theme',
      // FL-91: the stored workspace layout, as data; saving it goes through services only.
      'workspace',
    ]);
    expect(Object.values(context.strings ?? {}).every((value) => typeof value === 'string')).toBe(true);
    expect(context.projectImports).toHaveLength(1);
    for (const item of context.projectImports ?? []) {
      expect(item.url).not.toMatch(/token|apiKey|key=|slug=|Authorization|baseUrl/i);
      const url = new URL(item.url, location.origin);
      expect(url.origin).toBe(location.origin);
      expect(url.search).toBe('');
      expect(url.pathname).toMatch(/\/studio\/projects\/[\w-]+\/imports\/[\da-f-]+\/file$/);
    }
    expect(Object.keys(passedServices).sort()).toEqual([
      'navigate',
      'notify',
      'reloadProject',
      'reportFatal',
      'resolveAsset',
      'setDirty',
      'submitCommands',
    ]);
  });

  it('updates a running engine instead of remounting it when the context changes', async () => {
    const engine = stubEngine();
    const { rerender } = render(StudioHost, { ...baseProps(), loadEngine: engine.load });

    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(1));
    await rerender({ ...baseProps(), loadEngine: engine.load, assets: [], queuedJobs: 1 });

    await waitFor(() => expect(engine.update).toHaveBeenCalled());
    expect(engine.module.mount).toHaveBeenCalledTimes(1);
    expect(engine.dispose).not.toHaveBeenCalled();
  });

  it('disposes the engine the moment the session loses access, and says so', async () => {
    const engine = stubEngine();
    const props = { ...baseProps(), loadEngine: engine.load };
    const { rerender } = render(StudioHost, props);

    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(1));
    await rerender({ ...props, accessLost: true });

    await waitFor(() => expect(engine.dispose).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('studio-state')).toHaveAttribute('data-phase', 'forbidden');
    expect(screen.getByText('frameleaf_studio_forbidden_body')).toBeInTheDocument();
  });

  it('disposes the engine when the route unmounts', async () => {
    const engine = stubEngine();
    const { unmount } = render(StudioHost, { ...baseProps(), loadEngine: engine.load });

    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(1));
    unmount();

    await waitFor(() => expect(engine.dispose).toHaveBeenCalledTimes(1));
  });

  it('shows the error state and shuts the engine down when mounting throws', async () => {
    const failing = {
      engineRevision: pinnedFreecutRevision,
      features: [],
      mount: vi.fn().mockRejectedValue(new Error('WebGPU device lost')),
    } satisfies StudioEngineModule;

    render(StudioHost, {
      ...baseProps(),
      loadEngine: async () => ({ status: 'available' as const, module: failing }),
    });

    await waitFor(() => {
      expect(screen.getByTestId('studio-state')).toHaveAttribute('data-phase', 'error');
    });
    expect(screen.getByText('frameleaf_studio_error_body')).toBeInTheDocument();
  });
});

describe('Studio server preview panel (FL-96)', () => {
  const frame = {
    previewId: 'preview-1',
    revision: 3,
    time: rational(1, 1),
    quality: 'standard' as const,
    objectUrl: 'blob:exact',
    framePts: null,
    framePtsTimebase: null,
    toneMapped: false,
  };
  const ready: StudioPreviewView = { ...idleStudioPreviewView(), phase: 'ready', frame };
  const streamView = (overrides: Partial<StudioStreamView> = {}): StudioStreamView => ({
    ...offStudioStreamView(),
    ...overrides,
  });

  const mountedWith = async (props: Record<string, unknown>) => {
    const engine = stubEngine();
    render(StudioHost, { ...baseProps(), loadEngine: engine.load, ...props });
    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(1));
    return engine;
  };

  it('offers the panel when a render worker is live, and tells the engine when it is open', async () => {
    const engine = await mountedWith({});
    expect(vi.mocked(engine.module.mount).mock.calls[0][1].serverPreviewOpen).toBe(false);

    await fireEvent.click(screen.getByTestId('studio-server-preview-show'));
    expect(screen.getByTestId('studio-server-preview')).toBeInTheDocument();
    await waitFor(() =>
      expect(engine.update).toHaveBeenCalledWith(expect.objectContaining({ serverPreviewOpen: true })),
    );
  });

  it('shows the exact frame while paused and hides the stream picture', async () => {
    await mountedWith({ serverPreviewOpen: true, preview: ready, stream: streamView({ phase: 'paused' }) });
    expect(screen.getByTestId('studio-exact-frame')).toHaveAttribute('src', 'blob:exact');
    expect(screen.getByTestId('studio-stream-video')).toHaveAttribute('data-live', 'false');
    expect(screen.queryByTestId('studio-server-preview-status')).not.toBeInTheDocument();
  });

  it('shows the stream, not the exact frame, once the current seek is live', async () => {
    await mountedWith({
      serverPreviewOpen: true,
      preview: ready,
      stream: streamView({ phase: 'playing', live: true }),
    });
    expect(screen.getByTestId('studio-stream-video')).toHaveAttribute('data-live', 'true');
    expect(screen.queryByTestId('studio-exact-frame')).not.toBeInTheDocument();
  });

  it('says why playback stopped when the stream is revoked, and keeps no picture of it', async () => {
    await mountedWith({
      serverPreviewOpen: true,
      stream: streamView({ phase: 'unavailable', reason: 'revoked' }),
    });
    expect(screen.getByTestId('studio-server-preview-status')).toHaveTextContent('frameleaf_studio_stream_revoked');
    expect((screen.getByTestId('studio-stream-video') as HTMLVideoElement).srcObject ?? null).toBeNull();
  });

  it('falls back to exact frames with a plain reason when this browser cannot play from the server', async () => {
    await mountedWith({
      serverPreviewOpen: true,
      preview: ready,
      stream: streamView({ phase: 'unavailable', reason: 'unsupported' }),
    });
    expect(screen.getByTestId('studio-exact-frame')).toBeInTheDocument();
    expect(screen.getByTestId('studio-server-preview-status')).toHaveTextContent('frameleaf_studio_stream_unsupported');
  });
});

describe('Studio preview area', () => {
  const previewView = (overrides: Partial<StudioPreviewView> = {}): StudioPreviewView => ({
    ...idleStudioPreviewView(),
    ...overrides,
  });

  const mounted = async (preview: StudioPreviewView) => {
    const engine = stubEngine();
    render(StudioHost, { ...baseProps(), loadEngine: engine.load, preview });
    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(1));
    return engine;
  };

  it('says nothing while the frame on screen is the current one', async () => {
    await mounted(previewView({ phase: 'ready', messageKey: null }));

    expect(screen.queryByTestId('studio-preview-state')).not.toBeInTheDocument();
  });

  it('says the frame is being rendered', async () => {
    await mounted(previewView({ phase: 'rendering', messageKey: 'frameleaf_studio_preview_rendering' }));

    expect(screen.getByTestId('studio-preview-state')).toHaveAttribute('data-preview-phase', 'rendering');
    expect(screen.getByText('frameleaf_studio_preview_rendering')).toBeInTheDocument();
  });

  it('says a frame is out of date rather than leaving it looking current', async () => {
    await mounted(
      previewView({
        phase: 'stale',
        messageKey: 'frameleaf_studio_preview_stale',
        staleFrame: {
          previewId: 'preview-1',
          revision: 1,
          time: rational(1001, 30_000),
          quality: 'standard',
          objectUrl: 'blob:a',
          framePts: null,
          framePtsTimebase: null,
          toneMapped: false,
        },
      }),
    );

    expect(screen.getByTestId('studio-preview-state')).toHaveAttribute('data-preview-phase', 'stale');
    expect(screen.getByText('frameleaf_studio_preview_stale')).toBeInTheDocument();
    expect(screen.getByText('frameleaf_studio_preview_showing_previous')).toBeInTheDocument();
  });

  it('says a frame could not be rendered instead of showing an empty monitor', async () => {
    await mounted(
      previewView({
        phase: 'unavailable',
        messageKey: 'frameleaf_studio_preview_unavailable',
        errorCode: 'worker_lost',
      }),
    );

    expect(screen.getByTestId('studio-preview-state')).toHaveAttribute('data-preview-phase', 'unavailable');
    expect(screen.getByText('frameleaf_studio_preview_unavailable')).toBeInTheDocument();
    // The stable code is diagnostics, never the message a person reads.
    expect(screen.queryByText('worker_lost')).not.toBeInTheDocument();
  });

  it('labels a tone-mapped frame so it is never mistaken for the colour reference', async () => {
    await mounted(
      previewView({
        phase: 'ready',
        frame: {
          previewId: 'preview-1',
          revision: 1,
          time: rational(1001, 30_000),
          quality: 'standard',
          objectUrl: 'blob:a',
          framePts: '3003',
          framePtsTimebase: '1/90000',
          toneMapped: true,
        },
      }),
    );

    expect(screen.getByText('frameleaf_studio_preview_tone_mapped')).toBeInTheDocument();
  });
});

describe('Studio engine resolution', () => {
  it('reports the engine as not built when nothing registered one', async () => {
    await expect(loadStudioEngine()).resolves.toMatchObject({
      status: 'absent',
      reason: 'not-built',
      messageKey: 'frameleaf_studio_engine_absent_body',
    });
  });

  it('accepts only the pinned Freecut revision', async () => {
    registerStudioEngine(async () => ({ engineRevision: 'deadbeef', features: [], mount: vi.fn() }));

    await expect(loadStudioEngine()).resolves.toMatchObject({
      status: 'absent',
      reason: 'revision-mismatch',
      detail: expect.stringContaining(pinnedFreecutRevision),
    });
  });

  it('reports a failed load rather than throwing into the route', async () => {
    registerStudioEngine(async () => {
      throw new Error('chunk 404');
    });

    await expect(loadStudioEngine()).resolves.toMatchObject({
      status: 'absent',
      reason: 'load-failed',
      detail: 'chunk 404',
    });
  });

  it('refuses to register two engines in one page', () => {
    registerStudioEngine(async () => ({ engineRevision: pinnedFreecutRevision, features: [], mount: vi.fn() }));

    expect(() =>
      registerStudioEngine(async () => ({ engineRevision: pinnedFreecutRevision, features: [], mount: vi.fn() })),
    ).toThrow(TypeError);
  });
});

describe('Studio route, capabilities that arrive after the probe', () => {
  it('mounts the engine when the probe answers, with no user action', async () => {
    const engine = stubEngine();
    const { rerender } = render(StudioHost, { ...baseProps(), capabilities: null, loadEngine: engine.load });

    // Before the probe answers nothing is judged missing and nothing is mounted.
    expect(screen.getByTestId('studio-state')).toHaveAttribute('data-phase', 'loading');
    expect(screen.queryByText('frameleaf_studio_capability_render_worker')).not.toBeInTheDocument();
    expect(engine.module.mount).not.toHaveBeenCalled();

    await rerender({ ...baseProps(), capabilities: capable, loadEngine: engine.load });

    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('studio-state')).not.toBeInTheDocument());
    expect(screen.queryByRole('button', { name: 'frameleaf_studio_retry' })).not.toBeInTheDocument();
  });

  it('leaves the unavailable state and mounts once the required workers come online', async () => {
    const engine = stubEngine();
    const { rerender } = render(StudioHost, {
      ...baseProps(),
      capabilities: emptyStudioCapabilities(),
      loadEngine: engine.load,
    });

    await waitFor(() => {
      expect(screen.getByTestId('studio-state')).toHaveAttribute('data-phase', 'unavailable');
    });
    expect(engine.module.mount).not.toHaveBeenCalled();

    await rerender({ ...baseProps(), capabilities: capable, loadEngine: engine.load });

    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(1));
    await waitFor(() => expect(screen.queryByTestId('studio-state')).not.toBeInTheDocument());
  });

  it('tears the engine down and mounts exactly one new one when the workers flap', async () => {
    const engine = stubEngine();
    const { rerender } = render(StudioHost, { ...baseProps(), loadEngine: engine.load });
    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(1));

    // Missing and met again before the old engine's teardown can settle.
    await rerender({ ...baseProps(), capabilities: emptyStudioCapabilities(), loadEngine: engine.load });
    await rerender({ ...baseProps(), capabilities: { ...capable }, loadEngine: engine.load });

    await waitFor(() => expect(engine.module.mount).toHaveBeenCalledTimes(2));
    expect(engine.dispose).toHaveBeenCalledTimes(1);
    await waitFor(() => expect(screen.queryByTestId('studio-state')).not.toBeInTheDocument());

    // Nothing else starts afterwards.
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(engine.module.mount).toHaveBeenCalledTimes(2);
    expect(engine.dispose).toHaveBeenCalledTimes(1);
  });

  it('hands the engine a context change made while it was still starting', async () => {
    let finishMount: (instance: StudioEngineInstance) => void = () => {};
    const instance: StudioEngineInstance = { update: vi.fn(), dispose: vi.fn() };
    const module: StudioEngineModule = {
      engineRevision: pinnedFreecutRevision,
      features: [],
      mount: vi.fn(() => new Promise<StudioEngineInstance>((resolve) => (finishMount = resolve))),
    };
    const load = async () => ({ status: 'available' as const, module });
    const { rerender } = render(StudioHost, { ...baseProps(), loadEngine: load });
    await waitFor(() => expect(module.mount).toHaveBeenCalledTimes(1));

    // The engine reports it has no WebCodecs while mounting, so the route opens the server preview.
    await rerender({ ...baseProps(), serverPreviewOpen: true, loadEngine: load });
    finishMount(instance);

    await waitFor(() =>
      expect(instance.update).toHaveBeenLastCalledWith(expect.objectContaining({ serverPreviewOpen: true })),
    );
  });

  it('abandons a mount still starting when the workers go missing', async () => {
    let finishMount: (instance: StudioEngineInstance) => void = () => {};
    const instance: StudioEngineInstance = { update: vi.fn(), dispose: vi.fn() };
    const module: StudioEngineModule = {
      engineRevision: pinnedFreecutRevision,
      features: [],
      mount: vi.fn(() => new Promise<StudioEngineInstance>((resolve) => (finishMount = resolve))),
    };
    const load = async () => ({ status: 'available' as const, module });
    const { rerender } = render(StudioHost, { ...baseProps(), loadEngine: load });
    await waitFor(() => expect(module.mount).toHaveBeenCalledTimes(1));

    await rerender({ ...baseProps(), capabilities: emptyStudioCapabilities(), loadEngine: load });
    finishMount(instance);

    await waitFor(() => expect(instance.dispose).toHaveBeenCalledTimes(1));
    expect(screen.getByTestId('studio-state')).toHaveAttribute('data-phase', 'unavailable');
  });
});
