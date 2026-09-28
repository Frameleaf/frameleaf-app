import { describe, expect, it } from 'vitest';
import { emptyStudioCapabilities } from './host-contract';
import {
  initialStudioHostState,
  reduceStudioHost,
  shouldDisposeEngine,
  studioCapabilityLabelKey,
  studioHostAbandonsMount,
  studioHostBlocksNavigation,
  studioHostCanMount,
  studioHostCanRetry,
  studioHostHeadingKey,
  studioHostNeedsMount,
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

/** Replays events and counts the transitions that would start a mount or abandon one. */
const trace = (start: StudioHostState, ...events: StudioHostEvent[]) => {
  let state = start;
  let mounts = 0;
  let abandons = 0;
  for (const event of events) {
    const next = reduceStudioHost(state, event);
    mounts += studioHostNeedsMount(state, next) ? 1 : 0;
    abandons += studioHostAbandonsMount(state, next) ? 1 : 0;
    state = next;
  }
  return { state, mounts, abandons };
};

describe('studio host state, capabilities that arrive after the probe', () => {
  it('judges nothing before the probe has answered', () => {
    const initial = initialStudioHostState();
    expect(initial.phase).toBe('loading');
    expect(initial.capabilities).toBeNull();
    expect(initial.missingCapabilities).toEqual([]);
    expect(initial.unavailableReason).toBeNull();
    // Nothing is mounted until the probe answers, either.
    expect(studioHostCanMount(initial)).toBe(false);

    const unanswered = reduceStudioHost(initial, { type: 'capabilities', capabilities: null });
    expect(unanswered).toBe(initial);
  });

  it('mounts once when the probe answers with the required workers', () => {
    const { state, mounts } = trace(
      initialStudioHostState(),
      { type: 'capabilities', capabilities: null },
      { type: 'capabilities', capabilities: capable },
      // The same answer again (a re-render) must not start a second mount.
      { type: 'capabilities', capabilities: { ...capable } },
    );

    expect(state.phase).toBe('loading');
    expect(mounts).toBe(1);
  });

  it('goes from missing to met back to loading and mounts, with no retry', () => {
    const { state, mounts } = trace(
      initialStudioHostState(),
      { type: 'capabilities', capabilities: emptyStudioCapabilities() },
      { type: 'capabilities', capabilities: capable },
    );

    expect(state.phase).toBe('loading');
    expect(state.unavailableReason).toBeNull();
    expect(state.missingCapabilities).toEqual([]);
    expect(state.messageKey).toBeNull();
    expect(mounts).toBe(1);

    const ready = reduceStudioHost(state, { type: 'engine-mounted' });
    expect(ready.phase).toBe('ready');
  });

  it('records why it is unavailable', () => {
    const missing = run({ type: 'capabilities', capabilities: emptyStudioCapabilities() });
    expect(missing.unavailableReason).toBe('capabilities');

    const absent = run(
      { type: 'capabilities', capabilities: capable },
      { type: 'engine-absent', reason: 'not-built', messageKey: 'frameleaf_studio_engine_absent_body' },
    );
    expect(absent.unavailableReason).toBe('engine-absent');
  });

  it('keeps an absent engine unavailable when the capabilities change', () => {
    const { state, mounts } = trace(
      initialStudioHostState(),
      { type: 'capabilities', capabilities: capable },
      { type: 'engine-absent', reason: 'not-built', messageKey: 'frameleaf_studio_engine_absent_body' },
      { type: 'capabilities', capabilities: emptyStudioCapabilities() },
      { type: 'capabilities', capabilities: capable },
    );

    expect(state.phase).toBe('unavailable');
    expect(state.unavailableReason).toBe('engine-absent');
    expect(state.messageKey).toBe('frameleaf_studio_engine_absent_body');
    // One mount for the probe's first answer; the absent engine is never tried again unasked.
    expect(mounts).toBe(1);
  });

  it('keeps a fatal error as it is when the capabilities are met again', () => {
    const state = run(
      { type: 'capabilities', capabilities: capable },
      { type: 'engine-mounted' },
      { type: 'fatal', detail: 'boom' },
      { type: 'capabilities', capabilities: { ...capable } },
    );

    expect(state.phase).toBe('error');
  });

  it('handles capabilities that flap: one teardown, one remount per recovery', () => {
    const mounted = run({ type: 'capabilities', capabilities: capable }, { type: 'engine-mounted' });

    const { state, mounts, abandons } = trace(
      mounted,
      { type: 'capabilities', capabilities: emptyStudioCapabilities() },
      { type: 'capabilities', capabilities: emptyStudioCapabilities() },
      { type: 'capabilities', capabilities: capable },
      // The old engine's teardown lands after the recovery; it must not undo it.
      { type: 'engine-disposed' },
      { type: 'capabilities', capabilities: capable },
    );

    expect(abandons).toBe(1);
    expect(mounts).toBe(1);
    expect(state.phase).toBe('loading');
    expect(state.mounted).toBe(false);

    const again = trace(
      reduceStudioHost(state, { type: 'engine-mounted' }),
      { type: 'capabilities', capabilities: emptyStudioCapabilities() },
      { type: 'capabilities', capabilities: capable },
    );
    expect(again.abandons).toBe(1);
    expect(again.mounts).toBe(1);
  });

  it('abandons a mount that lands while the workers are missing', () => {
    const { state, abandons } = trace(
      reduceStudioHost(initialStudioHostState(), { type: 'capabilities', capabilities: capable }),
      { type: 'capabilities', capabilities: emptyStudioCapabilities() },
    );

    expect(state.phase).toBe('unavailable');
    expect(abandons).toBe(1);
  });

  it('returns to the capability state, not loading, when the connection comes back', () => {
    const { state, mounts } = trace(
      initialStudioHostState(),
      { type: 'connectivity', online: false },
      { type: 'capabilities', capabilities: emptyStudioCapabilities() },
      { type: 'connectivity', online: true },
    );

    expect(state.phase).toBe('unavailable');
    expect(state.unavailableReason).toBe('capabilities');
    expect(mounts).toBe(0);
  });

  it('mounts when the connection comes back to a deployment that has the workers', () => {
    const { state, mounts } = trace(
      initialStudioHostState(),
      { type: 'connectivity', online: false },
      { type: 'capabilities', capabilities: capable },
      { type: 'connectivity', online: true },
    );

    expect(state.phase).toBe('loading');
    expect(mounts).toBe(1);
  });

  it('stays unavailable on retry while the probe still says the workers are missing', () => {
    const { state, mounts } = trace(
      initialStudioHostState(),
      { type: 'capabilities', capabilities: emptyStudioCapabilities() },
      { type: 'retry' },
    );

    expect(state.phase).toBe('unavailable');
    expect(state.unavailableReason).toBe('capabilities');
    expect(mounts).toBe(0);
  });

  it('mounts once on retry after an absent engine', () => {
    const { state, mounts } = trace(
      reduceStudioHost(initialStudioHostState(), { type: 'capabilities', capabilities: capable }),
      { type: 'engine-absent', reason: 'load-failed', messageKey: 'frameleaf_studio_engine_failed_body' },
      { type: 'retry' },
    );

    expect(state.phase).toBe('loading');
    expect(state.unavailableReason).toBeNull();
    expect(mounts).toBe(1);
  });
});
