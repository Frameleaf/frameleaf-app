import { newPlugin } from '@extism/extism';
import { vitest } from 'vitest';
import { PluginRepository } from 'src/repositories/plugin.repository.js';

vi.mock('@extism/extism', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@extism/extism')>()),
  newPlugin: vi.fn(),
}));

describe(PluginRepository.name, () => {
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
    const { pool } = (
      sut as unknown as { pluginMap: Map<string, { pool: { drain(): Promise<void>; clear(): Promise<void> } }> }
    ).pluginMap.get('isolated')!;
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
