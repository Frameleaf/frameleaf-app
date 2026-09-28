import { CommandFactory } from 'nest-commander';

vi.mock('src/app.module.js', () => ({ ImmichAdminModule: vi.fn() }));

// importing the entrypoint loads the whole application graph, which can take seconds under a busy suite
it('returns a failing admin exit status when a command rejects', { timeout: 30_000 }, async () => {
  const argv = process.argv;
  const title = process.title;
  const exitCode = process.exitCode;
  const error = new Error('backfill enqueue failed');
  const log = vi.spyOn(console, 'error').mockImplementation(() => {});
  vi.spyOn(CommandFactory, 'run').mockImplementation(async (_module, options) => {
    if (options && typeof options === 'object' && 'serviceErrorHandler' in options) {
      await options.serviceErrorHandler?.(error);
    }
  });

  try {
    process.argv = ['node', 'main.js', 'immich-admin', 'fork-schema', 'start'];
    process.exitCode = undefined;
    vi.stubEnv('IMMICH_LOG_LEVEL', 'warn');
    await import('src/main.js');

    // Loading the admin module now happens asynchronously after the entrypoint import.
    await vi.waitFor(() => expect(process.exitCode).toBe(1), { timeout: 20_000 });
    expect(log).toHaveBeenCalledWith(error);
  } finally {
    process.argv = argv;
    process.title = title;
    process.exitCode = exitCode;
    vi.unstubAllEnvs();
    vi.restoreAllMocks();
  }
});
