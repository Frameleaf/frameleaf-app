import { sdkMock } from '$lib/__mocks__/sdk.mock';
import { eventManager } from '$lib/managers/event-manager.svelte';
import { pluginManager } from '$lib/managers/plugin-manager.svelte';

beforeEach(() => {
  vi.resetAllMocks();
  eventManager.emit('AuthLogout');
  sdkMock.getWorkflowTriggers.mockResolvedValue([]);
  sdkMock.searchPluginTemplates.mockResolvedValue([]);
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
