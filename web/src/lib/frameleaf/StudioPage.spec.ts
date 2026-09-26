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

const baseProps = () => ({
  project,
  assets: [],
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
      // FL-42: what qualified render workers verified, for the export sheet (no credentials).
      'renderEvidence',
      // FL-96: the adapter's own chrome speaks the host's language; words only.
      'strings',
      'theme',
      // FL-91: the stored workspace layout, as data; saving it goes through services only.
      'workspace',
    ]);
    expect(Object.values(context.strings ?? {}).every((value) => typeof value === 'string')).toBe(true);
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
