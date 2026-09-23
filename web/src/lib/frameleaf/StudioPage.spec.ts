import { render, screen, waitFor } from '@testing-library/svelte';
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

const capable = { gpuWorker: true, renderWorker: true, restorationWorker: true, transcriptionWorker: true };

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
    const serialised = JSON.stringify(context);
    expect(serialised).not.toMatch(/token|apiKey|Authorization|baseUrl/i);
    expect(Object.keys(context).sort()).toEqual([
      'assets',
      'auth',
      'capabilities',
      'handoffAssetIds',
      'online',
      // FL-96: the preview reaches the engine as data. There is still no transport here.
      'preview',
      'project',
      'theme',
    ]);
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
          revisionDigest: 'rev-a',
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
      previewView({ phase: 'unavailable', messageKey: 'frameleaf_studio_preview_unavailable', errorCode: 'worker_lost' }),
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
          revisionDigest: 'rev-a',
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

    await expect(loadStudioEngine()).resolves.toMatchObject({ status: 'absent', reason: 'load-failed', detail: 'chunk 404' });
  });

  it('refuses to register two engines in one page', () => {
    registerStudioEngine(async () => ({ engineRevision: pinnedFreecutRevision, features: [], mount: vi.fn() }));

    expect(() => registerStudioEngine(async () => ({ engineRevision: pinnedFreecutRevision, features: [], mount: vi.fn() }))).toThrow(
      TypeError,
    );
  });
});
