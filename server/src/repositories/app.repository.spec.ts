import { afterEach, beforeEach, describe, expect, it, vitest } from 'vitest';
import { ExitCode } from 'src/enum.js';
import { AppRepository } from 'src/repositories/app.repository.js';

const mocks = vitest.hoisted(() => {
  const pubClient = {
    connect: vitest.fn(),
    disconnect: vitest.fn(),
    duplicate: vitest.fn(),
  };
  const subClient = {
    connect: vitest.fn(),
    disconnect: vitest.fn(),
  };
  const server = {
    adapter: vitest.fn(),
    emit: vitest.fn(),
    serverSideEmitWithAck: vitest.fn(),
    sockets: { adapter: { close: vitest.fn() } },
  };
  return { pubClient, server, subClient };
});

vitest.mock('@socket.io/redis-adapter', () => ({ createAdapter: vitest.fn(() => 'redis-adapter') }));
vitest.mock('ioredis', () => ({
  Redis: vitest.fn(function () {
    return mocks.pubClient;
  }),
}));
vitest.mock('socket.io', () => ({
  Server: vitest.fn(function () {
    return mocks.server;
  }),
}));
vitest.mock('src/repositories/config.repository.js', () => ({
  ConfigRepository: vitest.fn(function () {
    return {
      getEnv: () => ({ redis: {}, shutdown: { graceMs: 2000, deadlineMs: 4000, workerDeadlineMs: 3000 } }),
    };
  }),
}));

describe(AppRepository.name, () => {
  beforeEach(() => {
    vitest.resetAllMocks();
    mocks.pubClient.duplicate.mockReturnValue(mocks.subClient);
    mocks.pubClient.connect.mockImplementation(() => Promise.resolve());
    mocks.subClient.connect.mockImplementation(() => Promise.resolve());
    mocks.server.sockets.adapter.close.mockImplementation(() => Promise.resolve());
  });

  it('waits for the server-side restart acknowledgement before resolving', async () => {
    let clientAcknowledgement: (() => Promise<void>) | undefined;
    mocks.server.emit.mockImplementation((_event, _state, callback) => {
      clientAcknowledgement = callback;
    });
    mocks.server.serverSideEmitWithAck.mockResolvedValue(['ok']);
    const sut = new AppRepository();
    let settled = false;

    const restart = sut.sendOneShotAppRestart({ isMaintenanceMode: false }).finally(() => (settled = true));
    await vitest.waitFor(() => expect(clientAcknowledgement).toBeDefined());
    expect(settled).toBe(false);

    await clientAcknowledgement!();
    await restart;

    expect(mocks.server.serverSideEmitWithAck).toHaveBeenCalledWith('AppRestart', { isMaintenanceMode: false });
    expect(mocks.server.sockets.adapter.close).toHaveBeenCalledOnce();
    expect(mocks.pubClient.disconnect).toHaveBeenCalledOnce();
    expect(mocks.subClient.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects a non-ok server acknowledgement and closes every resource', async () => {
    mocks.server.emit.mockImplementation((_event, _state, callback) => void callback());
    mocks.server.serverSideEmitWithAck.mockResolvedValue(['not-ok']);
    const sut = new AppRepository();

    await expect(sut.sendOneShotAppRestart({ isMaintenanceMode: true })).rejects.toThrow("non-'ok'");

    expect(mocks.server.sockets.adapter.close).toHaveBeenCalledOnce();
    expect(mocks.pubClient.disconnect).toHaveBeenCalledOnce();
    expect(mocks.subClient.disconnect).toHaveBeenCalledOnce();
  });

  it('rejects an acknowledgement failure and closes every resource', async () => {
    mocks.server.emit.mockImplementation((_event, _state, callback) => void callback());
    mocks.server.serverSideEmitWithAck.mockRejectedValue(new Error('ack failed'));
    const sut = new AppRepository();

    await expect(sut.sendOneShotAppRestart({ isMaintenanceMode: true })).rejects.toThrow('ack failed');

    expect(mocks.server.sockets.adapter.close).toHaveBeenCalledOnce();
    expect(mocks.pubClient.disconnect).toHaveBeenCalledOnce();
    expect(mocks.subClient.disconnect).toHaveBeenCalledOnce();
  });

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
      sut.setCloseFn(() => Promise.reject(new Error('redis away')));

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

    it('restarts through the same graceful stop', async () => {
      const sut = new AppRepository();
      const close = vitest.fn(() => Promise.resolve());
      sut.setCloseFn(close);

      sut.exitApp();
      await vitest.advanceTimersByTimeAsync(0);

      expect(close).toHaveBeenCalledOnce();
      expect(exit).toHaveBeenCalledWith(ExitCode.AppRestart);
    });
  });
});
