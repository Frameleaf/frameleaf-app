import { newPlugin } from '@extism/extism';
import { vitest } from 'vitest';
import { PLUGIN_CALL_TIMEOUT_MS, PluginRepository } from 'src/repositories/plugin.repository.js';

vi.mock('@extism/extism', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@extism/extism')>()),
  newPlugin: vi.fn(),
}));

describe(PluginRepository.name, () => {
  it('releases the initialization wait when plugin creation fails without leaving a polling timer', async () => {
    vi.useFakeTimers();
    const error = new Error('synthetic invalid wasm');
    vi.mocked(newPlugin).mockRejectedValue(error);
    const sut = new PluginRepository({} as never, { setContext: vi.fn() } as never);
    try {
      await expect(
        sut.load({ key: 'invalid', label: 'invalid', wasmBytes: Buffer.from('invalid') }, {}),
      ).rejects.toMatchObject({ message: 'Unable to instantiate plugin: invalid', cause: error });
      expect(vi.getTimerCount()).toBe(0);
    } finally {
      vi.clearAllTimers();
      vi.useRealTimers();
    }
  });

  it('loads without polling readiness and remains callable through the real pool', async () => {
    vi.useFakeTimers();
    const schedule = vi.spyOn(globalThis, 'setTimeout');
    const plugin = { close: vi.fn(), call: vi.fn().mockResolvedValue({ json: () => ({ ok: true }) }) };
    vi.mocked(newPlugin).mockResolvedValue(plugin as never);
    const sut = new PluginRepository({} as never, { setContext: vi.fn() } as never);
    try {
      const loading = sut.load({ key: 'ready', label: 'ready', wasmBytes: Buffer.from('fixture') }, {});
      await vi.advanceTimersByTimeAsync(100);
      await loading;
      expect(await sut.callMethod({ pluginKey: 'ready', methodName: 'inspect' }, {})).toEqual({ ok: true });
      expect(schedule).not.toHaveBeenCalled();
    } finally {
      const item = (
        sut as unknown as { pluginMap: Map<string, { pool: import('generic-pool').Pool<never> }> }
      ).pluginMap.get('ready');
      if (item) {
        await item.pool.drain();
        await item.pool.clear();
      }
      schedule.mockRestore();
      vi.clearAllTimers();
      vi.useRealTimers();
    }
    expect(plugin.close).toHaveBeenCalledOnce();
  });

  it.each([false, true])('loads WASI plugins without host filesystem mounts (worker=%s)', async (runInWorker) => {
    vi.mocked(newPlugin).mockResolvedValue({ close: vi.fn() } as never);
    const sut = new PluginRepository({} as never, { setContext: vi.fn() } as never);
    const functions = { byteInput: vi.fn() };
    await sut.load(
      { key: 'isolated', label: 'isolated', wasmBytes: Buffer.from('fixture') },
      { runInWorker, functions },
    );
    expect(newPlugin).toHaveBeenCalledWith(
      { wasm: [{ data: expect.any(Uint8Array) }] },
      expect.objectContaining({ allowedPaths: {}, runInWorker, functions: { 'extism:host/user': functions } }),
    );
    // a worker plugin's calls are timed out (a hung call would hold every workflow); Extism refuses a
    // timeout for an in-thread plugin, so none is passed there
    const options = vi.mocked(newPlugin).mock.calls.at(-1)![1] as { timeoutMs?: number };
    expect(options.timeoutMs).toBe(runInWorker ? PLUGIN_CALL_TIMEOUT_MS : undefined);
    expect(runInWorker || !('timeoutMs' in options)).toBe(true);
    const { pool } = (
      sut as unknown as { pluginMap: Map<string, { pool: { drain(): Promise<void>; clear(): Promise<void> } }> }
    ).pluginMap.get('isolated')!;
    await pool.drain();
    await pool.clear();
  });

  it('passes a caller-chosen timeout to a worker plugin', async () => {
    vi.mocked(newPlugin).mockResolvedValue({ close: vi.fn() } as never);
    const sut = new PluginRepository({} as never, { setContext: vi.fn() } as never);
    await sut.load(
      { key: 'timed', label: 'timed', wasmBytes: Buffer.from('fixture') },
      { runInWorker: true, timeoutMs: 5000 },
    );
    expect(newPlugin).toHaveBeenLastCalledWith(expect.anything(), expect.objectContaining({ timeoutMs: 5000 }));
    const { pool } = (
      sut as unknown as { pluginMap: Map<string, { pool: { drain(): Promise<void>; clear(): Promise<void> } }> }
    ).pluginMap.get('timed')!;
    await pool.drain();
    await pool.clear();
  });

  it.each(['plugin-id', 'plugin-id/worker'])(
    'passes host context through the %s Extism boundary',
    async (pluginKey) => {
      const plugin = {
        call: vitest.fn().mockResolvedValue({ json: () => ({ ok: true }) }),
      };
      const pool = {
        acquire: vitest.fn().mockResolvedValue(plugin),
        release: vitest.fn(),
      };
      const logger = { setContext: vitest.fn() };
      const sut = new PluginRepository({} as never, logger as never);
      (sut as unknown as { pluginMap: Map<string, unknown> }).pluginMap.set(pluginKey, { label: pluginKey, pool });
      const context = { allowedHosts: ['hooks.example.test'] };

      await (sut.callMethod as unknown as (...args: unknown[]) => Promise<unknown>)(
        { pluginKey, methodName: 'webhook' },
        { event: 'asset.create' },
        context,
      );

      expect(plugin.call).toHaveBeenCalledWith('webhook', JSON.stringify({ event: 'asset.create' }), context);
      expect(pool.release).toHaveBeenCalledWith(plugin);
    },
  );
});
