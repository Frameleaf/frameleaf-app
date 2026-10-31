const fixture = vi.hoisted(() => ({
  create: vi.fn(),
  stop: undefined as (() => void) | undefined,
  ipc: undefined as boolean | undefined,
  disconnect: undefined as (() => void) | undefined,
  attach: vi.fn(),
}));

vi.mock('@nestjs/core', () => ({ NestFactory: { createApplicationContext: fixture.create } }));
vi.mock('src/edge/edge.module.js', () => ({ EdgeModule: class {} }));
vi.mock('src/utils/misc.js', () => ({ isStartUpError: () => false }));
vi.mock('src/utils/locked-key-ipc.js', () => ({ attachLockedKeyIpc: fixture.attach }));
vi.mock('src/utils/shutdown.js', () => ({
  onStopRequest: (stop: () => void, { ipc }: { ipc: boolean }) => {
    fixture.stop = stop;
    fixture.ipc = ipc;
  },
}));

describe('edge worker native shutdown', () => {
  const title = process.title;
  const app = { close: vi.fn(), enableShutdownHooks: vi.fn() };
  const settled = () => new Promise((resolve) => setImmediate(resolve));
  beforeEach(() => {
    vi.resetModules();
    fixture.stop = undefined;
    fixture.ipc = undefined;
    fixture.disconnect = undefined;
    app.close.mockReset().mockResolvedValue(undefined);
    app.enableShutdownHooks.mockReset();
    fixture.create.mockReset().mockResolvedValue(app);
    vi.stubEnv('FRAMELEAF_NATIVE_OWNER', '1');
    vi.spyOn(process, 'exit').mockImplementation(() => undefined as never);
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const on = process.on.bind(process);
    vi.spyOn(process, 'on').mockImplementation(((event: string, listener: () => void) => {
      if (event === 'disconnect') {
        fixture.disconnect = listener;
        return process;
      }
      return on(event, listener);
    }) as typeof process.on);
  });
  afterEach(() => {
    vi.restoreAllMocks();
    vi.unstubAllEnvs();
    process.title = title;
  });

  it('installs native ownership before the application finishes starting', async () => {
    const context = Promise.withResolvers<typeof app>();
    fixture.create.mockReturnValue(context.promise);
    await import('src/workers/edge.js');
    expect(fixture.ipc).toBe(true);
    fixture.stop!();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
    expect(app.close).not.toHaveBeenCalled();
    // A mocked exit returns; let the pending bootstrap settle before restoring process hooks.
    context.resolve(app);
    await settled();
  });

  it.each([false, true])('joins native application cleanup and preserves failure=%s', async (failed) => {
    if (failed) app.close.mockRejectedValue(new Error('synthetic cleanup failure'));
    await import('src/workers/edge.js');
    fixture.stop!();
    await settled();
    expect(app.close).toHaveBeenCalledOnce();
    expect(app.enableShutdownHooks).not.toHaveBeenCalled();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(failed ? 1 : 0);
  });

  it('listens for Locked keys before the application starts', async () => {
    const context = Promise.withResolvers<typeof app>();
    fixture.create.mockReturnValue(context.promise);
    fixture.attach.mockClear();
    await import('src/workers/edge.js');
    expect(fixture.attach).toHaveBeenCalledOnce();
    context.resolve(app);
    await settled();
  });

  it('keeps container signal hooks and owner-disconnect cleanup', async () => {
    vi.stubEnv('FRAMELEAF_NATIVE_OWNER', '0');
    await import('src/workers/edge.js');
    expect(fixture.stop).toBeUndefined();
    expect(app.enableShutdownHooks).toHaveBeenCalledWith(['SIGTERM', 'SIGINT']);
    fixture.disconnect!();
    await settled();
    expect(app.close).toHaveBeenCalledOnce();
    expect(process.exit).toHaveBeenCalledExactlyOnceWith(0);
  });
});
