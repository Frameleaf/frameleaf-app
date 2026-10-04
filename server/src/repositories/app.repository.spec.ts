import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';
import { ExitCode } from 'src/enum.js';
import { AppRepository } from 'src/repositories/app.repository.js';
import { RESTART_BUDGET } from 'src/utils/shutdown.js';

const mocks = vitest.hoisted(() => ({
  transport: { attach: vitest.fn(), discoverWorkers: vitest.fn(), close: vitest.fn() },
  server: {
    timeout: vitest.fn(),
    emitWithAck: vitest.fn(),
    serverSideEmitWithAck: vitest.fn(),
    sockets: { adapter: { close: vitest.fn() } },
  },
}));
vitest.mock('src/middleware/websocket.adapter.js', () => ({
  PostgresSocketTransport: vitest.fn(function () {
    return mocks.transport;
  }),
}));
vitest.mock('socket.io', () => ({
  Server: vitest.fn(function () {
    return mocks.server;
  }),
}));
vitest.mock('src/repositories/config.repository.js', () => ({
  ConfigRepository: vitest.fn(function () {
    return { getEnv: () => ({ shutdown: { graceMs: 2000, deadlineMs: 4000, workerDeadlineMs: 3000 } }) };
  }),
}));

describe(AppRepository.name, () => {
  beforeEach(() => {
    vitest.resetAllMocks();
    mocks.transport.attach.mockResolvedValue(undefined);
    mocks.transport.discoverWorkers.mockResolvedValue(2);
    mocks.transport.close.mockResolvedValue(undefined);
    mocks.server.timeout.mockReturnValue(mocks.server);
    mocks.server.emitWithAck.mockResolvedValue([]);
    mocks.server.serverSideEmitWithAck.mockResolvedValue(['ok', 'ok']);
  });

  it('waits for discovered workers and their restart acknowledgements', async () => {
    let finish!: (responses: string[]) => void;
    mocks.server.serverSideEmitWithAck.mockImplementation(() => new Promise((resolve) => (finish = resolve)));
    const restart = new AppRepository().sendOneShotAppRestart({ isMaintenanceMode: false });
    await vitest.waitFor(() => expect(finish).toBeDefined());
    expect(mocks.transport.attach).toHaveBeenCalledWith(mocks.server, false);
    expect(mocks.server.timeout).toHaveBeenCalledWith(5000);
    expect(mocks.server.emitWithAck).toHaveBeenCalledWith('AppRestartV1', { isMaintenanceMode: false });
    expect(mocks.transport.close).not.toHaveBeenCalled();
    finish(['ok', 'ok']);
    await restart;
    expect(mocks.transport.close).toHaveBeenCalledOnce();
  });

  it.each([{ responses: ['ok'] }, { responses: ['ok', 'not-ok'] }])(
    'rejects missing or non-ok responses: $responses',
    async ({ responses }) => {
      mocks.server.serverSideEmitWithAck.mockResolvedValue(responses);
      await expect(new AppRepository().sendOneShotAppRestart({ isMaintenanceMode: true })).rejects.toThrow("non-'ok'");
      expect(mocks.transport.close).toHaveBeenCalledOnce();
    },
  );

  it.each(['attach', 'discoverWorkers', 'emitWithAck', 'serverSideEmitWithAck'] as const)(
    'closes resources after %s fails',
    async (step) => {
      const mock = step === 'attach' || step === 'discoverWorkers' ? mocks.transport[step] : mocks.server[step];
      mock.mockRejectedValue(new Error('transport unavailable'));
      await expect(new AppRepository().sendOneShotAppRestart({ isMaintenanceMode: true })).rejects.toThrow(
        'transport unavailable',
      );
      expect(mocks.transport.close).toHaveBeenCalledOnce();
    },
  );

  describe('stop (FL-291)', () => {
    let exit: ReturnType<typeof vitest.spyOn>;

    beforeEach(() => {
      vitest.useFakeTimers();
      exit = vitest.spyOn(process, 'exit').mockImplementation((() => {}) as never);
    });

    afterEach(() => {
      exit.mockRestore();
      vitest.useRealTimers();
    });

    it('closes the application gracefully, then exits with the code asked for', async () => {
      const sut = new AppRepository();
      let finish!: () => void;
      const close = vitest.fn(() => new Promise<void>((resolve) => (finish = resolve)));
      sut.setCloseFn(close);

      sut.stop(0);
      expect(close).toHaveBeenCalledOnce();
      await vitest.advanceTimersByTimeAsync(2500);
      expect(exit).not.toHaveBeenCalled();

      finish();
      await vitest.advanceTimersByTimeAsync(0);
      expect(exit).toHaveBeenCalledWith(0);
    });

    it('exits at the configured worker deadline (FRAMELEAF_SHUTDOWN_*) when closing hangs', async () => {
      const sut = new AppRepository();
      sut.setCloseFn(() => new Promise<void>(() => {}));

      sut.stop(0);
      await vitest.advanceTimersByTimeAsync(3000 - 1);
      expect(exit).not.toHaveBeenCalled();
      await vitest.advanceTimersByTimeAsync(1);

      expect(exit).toHaveBeenCalledWith(0);
    });

    it('still exits when closing fails', async () => {
      const sut = new AppRepository();
      const log = vitest.spyOn(console, 'error').mockImplementation(() => {});
      sut.setCloseFn(() => Promise.reject(new Error('database away')));

      sut.stop(0);
      await vitest.advanceTimersByTimeAsync(0);

      expect(exit).toHaveBeenCalledWith(0);
      log.mockRestore();
    });

    it('closes once when asked twice', async () => {
      const sut = new AppRepository();
      const close = vitest.fn(() => Promise.resolve());
      sut.setCloseFn(close);

      sut.stop(0);
      sut.stop(0);
      await vitest.advanceTimersByTimeAsync(0);

      expect(close).toHaveBeenCalledOnce();
    });

    it('stops with the configured grace period', async () => {
      const sut = new AppRepository();
      const close = vitest.fn((_graceMs: number) => Promise.resolve());
      sut.setCloseFn(close);

      sut.stop(0);
      await vitest.advanceTimersByTimeAsync(0);

      expect(close).toHaveBeenCalledWith(2000);
    });

    // a restart is not a stop: the supervisor starts the workers again at once, and maintenance mode
    // switches workers this way, so it keeps the old 2 s ceiling while still handing jobs back
    it('restarts with the short restart budget, handing back what is still running after 1 s', async () => {
      const sut = new AppRepository();
      const close = vitest.fn((_graceMs: number) => Promise.resolve());
      sut.setCloseFn(close);

      sut.exitApp();
      await vitest.advanceTimersByTimeAsync(0);

      expect(close).toHaveBeenCalledWith(RESTART_BUDGET.graceMs);
      expect(RESTART_BUDGET).toEqual({ graceMs: 1000, workerDeadlineMs: 2000 });
      expect(exit).toHaveBeenCalledWith(ExitCode.AppRestart);
    });

    it('exits a hanging restart at 2 s, not at the stop deadline', async () => {
      const sut = new AppRepository();
      sut.setCloseFn(() => new Promise<void>(() => {}));

      sut.exitApp();
      await vitest.advanceTimersByTimeAsync(1999);
      expect(exit).not.toHaveBeenCalled();
      await vitest.advanceTimersByTimeAsync(1);

      expect(exit).toHaveBeenCalledWith(ExitCode.AppRestart);
    });
  });
});
