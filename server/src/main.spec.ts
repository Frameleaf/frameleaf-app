import { CommandFactory } from 'nest-commander';

vi.mock('src/app.module.js', () => ({ ImmichAdminModule: vi.fn() }));

// FL-294: `frameleaf-admin` is the command; `immich-admin` keeps working as its deprecated alias.
// Importing the entrypoint loads the whole application graph, which can take seconds under a busy suite.
it.each(['frameleaf-admin', 'immich-admin'])(
  'returns a failing admin exit status when a command rejects (%s)',
  { timeout: 30_000 },
  async (command) => {
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
      vi.resetModules();
      process.argv = ['node', 'main.js', command, 'fork-schema', 'start'];
      process.exitCode = undefined;
      // an old-name log level must not conflict with the quiet level the admin command sets
      vi.stubEnv('IMMICH_LOG_LEVEL', 'debug');
      await import('src/main.js');

      // Loading the admin module now happens asynchronously after the entrypoint import.
      await vi.waitFor(() => expect(process.exitCode).toBe(1), { timeout: 20_000 });
      expect(log).toHaveBeenCalledWith(error);
      expect(process.title).toBe('frameleaf_admin_cli');
      expect(process.env.FRAMELEAF_LOG_LEVEL).toBe('warn');
      expect(process.env.IMMICH_LOG_LEVEL).toBeUndefined();
    } finally {
      process.argv = argv;
      process.title = title;
      process.exitCode = exitCode;
      vi.unstubAllEnvs();
      delete process.env.FRAMELEAF_LOG_LEVEL;
      vi.restoreAllMocks();
    }
  },
);
