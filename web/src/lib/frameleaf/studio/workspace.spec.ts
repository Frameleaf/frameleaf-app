import { loadStudioWorkspace, saveStudioWorkspaceLayout } from '$lib/frameleaf/studio/workspace';

const httpError = (status: number) => Object.assign(new Error(`HTTP ${status}`), { status });

describe('Studio workspace layout (FL-91)', () => {
  it('hands the engine the stored layout byte for byte', async () => {
    const layout = { panels: { bin: { open: true, width: 312 } }, zoom: 1.5 };
    const view = await loadStudioWorkspace({
      get: () => Promise.resolve({ layout, engineRevision: 'rev-1', savedAt: '2026-09-25T10:00:00.000Z' }),
      save: vi.fn(),
    });
    expect(view).toEqual({ state: 'ready', layout, savedAt: '2026-09-25T10:00:00.000Z' });
  });

  it('treats an account with no stored layout as ready with no layout', async () => {
    const view = await loadStudioWorkspace({
      get: () => Promise.resolve({ layout: null, engineRevision: null, savedAt: null }),
      save: vi.fn(),
    });
    expect(view).toEqual({ state: 'ready', layout: null, savedAt: null });
  });

  it('says the layout is unavailable when it cannot be read, rather than failing the editor', async () => {
    const view = await loadStudioWorkspace({ get: () => Promise.reject(httpError(503)), save: vi.fn() });
    expect(view).toEqual({ state: 'unavailable', reason: 'storage-unavailable' });
  });

  it('saves the layout with the pinned engine revision', async () => {
    const save = vi
      .fn()
      .mockResolvedValue({ layout: {}, engineRevision: 'rev-1', savedAt: '2026-09-25T10:01:00.000Z' });
    const result = await saveStudioWorkspaceLayout({ zoom: 2 }, 'rev-1', { get: vi.fn(), save });
    expect(save).toHaveBeenCalledWith({ zoom: 2 }, 'rev-1');
    expect(result).toEqual({ status: 'saved', savedAt: '2026-09-25T10:01:00.000Z' });
  });

  it('answers unavailable, never a fake save, when the server cannot store it', async () => {
    const save = vi.fn().mockRejectedValue(httpError(503));
    await expect(saveStudioWorkspaceLayout({ zoom: 2 }, 'rev-1', { get: vi.fn(), save })).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('answers unavailable when the network is gone', async () => {
    const save = vi.fn().mockRejectedValue(new TypeError('Failed to fetch'));
    await expect(saveStudioWorkspaceLayout({ zoom: 2 }, 'rev-1', { get: vi.fn(), save })).resolves.toEqual({
      status: 'unavailable',
    });
  });

  it('rejects a refused payload so the engine does not assume it was kept', async () => {
    const save = vi.fn().mockRejectedValue(httpError(400));
    await expect(saveStudioWorkspaceLayout({ zoom: 2 }, 'rev-1', { get: vi.fn(), save })).rejects.toThrow('HTTP 400');
  });

  it('refuses a layout that is not a JSON object before calling the server', async () => {
    const save = vi.fn();
    await expect(saveStudioWorkspaceLayout(['a'], 'rev-1', { get: vi.fn(), save })).rejects.toThrow(TypeError);
    await expect(saveStudioWorkspaceLayout(null, 'rev-1', { get: vi.fn(), save })).rejects.toThrow(TypeError);
    expect(save).not.toHaveBeenCalled();
  });
});
