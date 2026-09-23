import { describe, expect, it } from 'vitest';
import { emptyStudioCapabilities } from './host-contract';
import {
  initialStudioHostState,
  reduceStudioHost,
  shouldDisposeEngine,
  studioCapabilityLabelKey,
  studioHostBlocksNavigation,
  studioHostCanRetry,
  studioHostHeadingKey,
  type StudioHostEvent,
  type StudioHostState,
} from './host-state';

const capable = {
  ...emptyStudioCapabilities(),
  gpuWorker: true,
  renderWorker: true,
  restorationWorker: true,
  transcriptionWorker: true,
};

const run = (...events: StudioHostEvent[]): StudioHostState => {
  let state = initialStudioHostState();
  for (const event of events) {
    state = reduceStudioHost(state, event);
  }
  return state;
};

describe('studio host state', () => {
  it('starts loading and reaches ready once the engine mounts', () => {
    const state = run(
      { type: 'connectivity', online: true },
      { type: 'capabilities', capabilities: capable },
      { type: 'engine-mounted' },
    );

    expect(state.phase).toBe('ready');
    expect(state.mounted).toBe(true);
    expect(studioHostHeadingKey(state)).toBeNull();
  });

  it('names the missing workers rather than only saying it is unavailable', () => {
    const state = run({ type: 'capabilities', capabilities: emptyStudioCapabilities() });

    expect(state.phase).toBe('unavailable');
    expect(state.missingCapabilities).toEqual(['gpuWorker', 'renderWorker']);
    expect(state.messageKey).toBe('frameleaf_studio_unavailable_body');
    expect(studioCapabilityLabelKey('gpuWorker')).toBe('frameleaf_studio_capability_gpu_worker');
  });

  it('does not blame a missing capability when the capability probe could not be trusted', () => {
    const state = run(
      { type: 'connectivity', online: false },
      { type: 'capabilities', capabilities: emptyStudioCapabilities() },
    );

    expect(state.phase).toBe('offline');
    expect(state.messageKey).toBe('frameleaf_studio_offline_body');
  });

  it('does not blame the build for an engine that could not be fetched while offline', () => {
    const state = run(
      { type: 'connectivity', online: false },
      { type: 'engine-absent', reason: 'load-failed', messageKey: 'frameleaf_studio_engine_failed_body' },
    );

    expect(state.phase).toBe('offline');
    expect(state.engineAbsence).toBe('load-failed');
  });

  it('reports an absent engine honestly when the connection is fine', () => {
    const state = run(
      { type: 'connectivity', online: true },
      { type: 'capabilities', capabilities: capable },
      { type: 'engine-absent', reason: 'not-built', messageKey: 'frameleaf_studio_engine_absent_body' },
    );

    expect(state.phase).toBe('unavailable');
    expect(state.messageKey).toBe('frameleaf_studio_engine_absent_body');
    expect(state.mounted).toBe(false);
  });

  it('refuses a substituted engine build', () => {
    const state = run({
      type: 'engine-absent',
      reason: 'revision-mismatch',
      messageKey: 'frameleaf_studio_engine_mismatch_body',
      detail: 'expected abc, got def',
    });

    expect(state.phase).toBe('unavailable');
    expect(state.detail).toBe('expected abc, got def');
  });

  it('puts access loss above every other reason and keeps it there', () => {
    const state = run(
      { type: 'capabilities', capabilities: capable },
      { type: 'engine-mounted' },
      { type: 'dirty', dirty: true },
      { type: 'access-lost' },
      // Nothing that arrives afterwards may talk the host out of it.
      { type: 'connectivity', online: true },
      { type: 'engine-mounted' },
    );

    expect(state.phase).toBe('forbidden');
    expect(state.mounted).toBe(false);
    // The draft went with the engine, so the guard must not trap the person on the route.
    expect(state.dirty).toBe(false);
    expect(studioHostBlocksNavigation(state)).toBe(false);
  });

  it('disposes the engine in every state it must not run in', () => {
    expect(shouldDisposeEngine('forbidden')).toBe(true);
    expect(shouldDisposeEngine('unavailable')).toBe(true);
    expect(shouldDisposeEngine('error')).toBe(true);
    expect(shouldDisposeEngine('ready')).toBe(false);
    expect(shouldDisposeEngine('loading')).toBe(false);
    // Offline keeps the engine up: the work in it is the thing worth preserving.
    expect(shouldDisposeEngine('offline')).toBe(false);
  });

  it('returns to ready when the connection comes back to a mounted engine', () => {
    const state = run(
      { type: 'capabilities', capabilities: capable },
      { type: 'engine-mounted' },
      { type: 'connectivity', online: false },
      { type: 'connectivity', online: true },
    );

    expect(state.phase).toBe('ready');
  });

  it('only arms the navigation guard while a running engine holds a draft', () => {
    const mounted = run(
      { type: 'capabilities', capabilities: capable },
      { type: 'engine-mounted' },
      { type: 'dirty', dirty: true },
    );
    expect(studioHostBlocksNavigation(mounted)).toBe(true);

    const notMounted = run({ type: 'dirty', dirty: true });
    expect(studioHostBlocksNavigation(notMounted)).toBe(false);

    const disposed = reduceStudioHost(mounted, { type: 'engine-disposed' });
    expect(studioHostBlocksNavigation(disposed)).toBe(false);
  });

  it('offers a retry only where retrying can change the answer', () => {
    expect(studioHostCanRetry(run({ type: 'connectivity', online: false }))).toBe(true);
    expect(studioHostCanRetry(run({ type: 'fatal' }))).toBe(true);
    expect(studioHostCanRetry(run({ type: 'capabilities', capabilities: emptyStudioCapabilities() }))).toBe(true);
    expect(studioHostCanRetry(run({ type: 'access-lost' }))).toBe(false);
    expect(studioHostCanRetry(initialStudioHostState())).toBe(false);
  });

  it('clears everything on retry, including a forbidden state a fresh mount may recover from', () => {
    const state = run({ type: 'access-lost' }, { type: 'retry' });

    expect(state).toEqual(initialStudioHostState());
  });

  it('shuts the engine down on a fatal error and records the detail out of the message', () => {
    const state = run(
      { type: 'capabilities', capabilities: capable },
      { type: 'engine-mounted' },
      { type: 'fatal', detail: 'WebGPU device lost' },
    );

    expect(state.phase).toBe('error');
    expect(state.mounted).toBe(false);
    expect(state.messageKey).toBe('frameleaf_studio_error_body');
    expect(state.detail).toBe('WebGPU device lost');
  });
});
