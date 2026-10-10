import {
  clearRender,
  markRenderReady,
  pendingRender,
  RENDER_READY_MS,
  setRenderProgress,
} from './pending-render.svelte';

describe('pending renders', () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => {
    clearRender('asset');
    vi.useRealTimers();
  });

  it('reports progress, then says the edit is ready for a moment', () => {
    expect(pendingRender('asset')).toBeUndefined();
    setRenderProgress('asset', null);
    expect(pendingRender('asset')).toEqual({ progress: null, ready: false });
    setRenderProgress('asset', 40);
    expect(pendingRender('asset')).toEqual({ progress: 40, ready: false });

    markRenderReady('asset');
    expect(pendingRender('asset')).toEqual({ progress: 100, ready: true });
    vi.advanceTimersByTime(RENDER_READY_MS);
    expect(pendingRender('asset')).toBeUndefined();
  });

  it('a new save for the same item cancels the earlier goodbye', () => {
    markRenderReady('asset');
    setRenderProgress('asset', 10);
    vi.advanceTimersByTime(RENDER_READY_MS * 2);
    expect(pendingRender('asset')).toEqual({ progress: 10, ready: false });
  });
});
