import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { pluginManager } from '$lib/managers/plugin-manager.svelte';

beforeEach(() => {
  vi.resetAllMocks();
  eventManager.emit('AuthLogout');
  sdkMock.getWorkflowDiscovery.mockResolvedValue({ triggers: [], templates: [] });
  sdkMock.getWorkflowTriggers.mockResolvedValue([]);
  sdkMock.searchPluginTemplates.mockResolvedValue([]);
});

it('loads modern discovery, including scheduled templates', async () => {
  sdkMock.searchPluginMethods.mockResolvedValue([]);
  sdkMock.getWorkflowDiscovery.mockResolvedValue({
    triggers: [{ trigger: 'Schedule', types: ['AssetV1'] }],
    templates: [{ key: 'sample#schedule', trigger: 'Schedule' }],
  } as never);
  await pluginManager.ready();
  expect(pluginManager.triggers).toEqual([{ trigger: 'Schedule', types: ['AssetV1'] }]);
  expect(pluginManager.templates).toEqual([{ key: 'sample#schedule', trigger: 'Schedule' }]);
  expect(sdkMock.getWorkflowTriggers).not.toHaveBeenCalled();
});

it.each([404, 405])('falls back to legacy discovery only for an unavailable endpoint (%s)', async (status) => {
  sdkMock.searchPluginMethods.mockResolvedValue([]);
  sdkMock.isHttpError.mockReturnValue(true);
  sdkMock.getWorkflowDiscovery.mockRejectedValue({ status });
  sdkMock.getWorkflowTriggers.mockResolvedValue([{ trigger: 'AssetCreate', types: ['AssetV1'] }] as never);
  await pluginManager.ready();
  expect(pluginManager.triggers).toEqual([{ trigger: 'AssetCreate', types: ['AssetV1'] }]);
  expect(sdkMock.searchPluginTemplates).toHaveBeenCalledOnce();
});

it.each([401, 403, 500])('preserves discovery errors instead of hiding them with fallback (%s)', async (status) => {
  sdkMock.searchPluginMethods.mockResolvedValue([]);
  sdkMock.isHttpError.mockReturnValue(true);
  sdkMock.getWorkflowDiscovery.mockRejectedValue({ status });
  await expect(pluginManager.ready()).rejects.toEqual({ status });
  expect(sdkMock.getWorkflowTriggers).not.toHaveBeenCalled();
});

it('preserves network errors instead of falling back to legacy discovery', async () => {
  sdkMock.searchPluginMethods.mockResolvedValue([]);
  sdkMock.isHttpError.mockReturnValue(false);
  sdkMock.getWorkflowDiscovery.mockRejectedValue(new Error('offline'));
  await expect(pluginManager.ready()).rejects.toThrow('offline');
  expect(sdkMock.getWorkflowTriggers).not.toHaveBeenCalled();
});

it('retries failed discovery and clears another account’s cached methods on logout', async () => {
  sdkMock.searchPluginMethods
    .mockRejectedValueOnce(new Error('offline'))
    .mockResolvedValueOnce([{ key: 'sample#method' } as never]);

  await expect(pluginManager.ready()).rejects.toThrow('offline');
  await pluginManager.ready();
  expect(pluginManager.methods).toHaveLength(1);

  eventManager.emit('AuthLogout');
  expect(pluginManager.methods).toEqual([]);
  expect(pluginManager.getMethod('sample#method')).toBeUndefined();
});

it('does not publish discovery data that arrives after logout', async () => {
  let finish!: (methods: never[]) => void;
  sdkMock.searchPluginMethods.mockReturnValue(new Promise((resolve) => (finish = resolve)));

  const pending = pluginManager.ready();
  eventManager.emit('AuthLogout');
  finish([{ key: 'sample#method' } as never]);
  await pending;

  expect(pluginManager.methods).toEqual([]);
  expect(pluginManager.getMethod('sample#method')).toBeUndefined();
});

it('retries discovery after a background sign-in load fails', async () => {
  sdkMock.searchPluginMethods.mockRejectedValueOnce(new Error('offline')).mockResolvedValueOnce([]);

  eventManager.emit('AuthUserLoaded', {} as never);
  await vi.waitFor(() => expect(sdkMock.searchPluginMethods).toHaveBeenCalledTimes(1));
  await vi.waitFor(() => expect(pluginManager.ready()).resolves.toBeUndefined());

  expect(sdkMock.searchPluginMethods).toHaveBeenCalledTimes(2);
});
